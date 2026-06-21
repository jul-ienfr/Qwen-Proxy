/**
 * SessionManager - Manages persistent chat sessions for multi-turn conversations
 *
 * Maps client "windows" to Qwen chat sessions, preserving context across requests.
 * Supports both explicit session IDs (X-QwenProxy-Session-Id header) and
 * auto-detection by comparing message arrays.
 */

import crypto from 'crypto';
import { config } from './config.js';
import { getWarmedChat, releaseWarmChat } from '../services/warm-pool.js';
import { getDebugLogger } from './debug-logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChatSession {
  /** Client-provided or auto-generated session identifier */
  sessionId: string;
  /** Qwen chat_id from warm pool or creation */
  chatId: string;
  /** Current Qwen parent_id for message threading */
  parentId: string | null;
  /** Which Qwen account owns this session */
  accountId: string;
  /** HTTP headers for Qwen API calls */
  headers: Record<string, string>;
  /** When headers were last refreshed */
  headersTimestamp: number;
  /** Number of messages sent to Qwen (for delta computation) */
  messageCount: number;
  /** Model used in this session */
  model: string;
  /** Session creation timestamp */
  createdAt: number;
  /** Last request timestamp */
  lastUsedAt: number;
  /** Whether a request is currently in-flight for this session */
  inFlight: boolean;
}

export interface SessionCreateOptions {
  sessionId?: string;
  model: string;
  accountId?: string;
}

export interface SessionMatchResult {
  session: ChatSession;
  newMessageStartIndex: number;
}

// ─── Session Manager ──────────────────────────────────────────────────────────

class SessionManager {
  private sessions = new Map<string, ChatSession>();
  /** Per-session message fingerprints: sessionId -> Map<index, fingerprint> */
  private fingerprints = new Map<string, Map<number, string>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  // ─── Core Operations ──────────────────────────────────────────────────────

  /**
   * Get an existing session or create a new one.
   * For new sessions, leases a chat from the warm pool.
   */
  async getOrCreate(options: SessionCreateOptions): Promise<ChatSession> {
    if (config.session && !config.session.enabled) {
      throw new Error('Sessions are disabled via config');
    }
    const sessionId = options.sessionId || crypto.randomUUID();
    const existing = this.sessions.get(sessionId);

    if (existing) {
      // If model changed, close old session and create new
      if (existing.model !== options.model) {
        if (existing.inFlight) {
          // Can't remove an in-flight session — reject by returning a new session with different ID
          console.warn(`[Session] Model changed for session ${sessionId} but session is in-flight. Creating separate session.`);
          return this.getOrCreate({ ...options, sessionId: `${sessionId}-${Date.now()}` });
        }
        console.log(`[Session] Model changed for session ${sessionId}: ${existing.model} → ${options.model}. Creating new session.`);
        this.remove(sessionId);
      } else {
        existing.lastUsedAt = Date.now();
        return existing;
      }
    }

    // Create new session with warm pool chat
    const accountKey = options.accountId || undefined;
    const warmedChat = await getWarmedChat(accountKey);

    const session: ChatSession = {
      sessionId,
      chatId: warmedChat.chatId,
      parentId: null,
      accountId: warmedChat.accountId,
      headers: warmedChat.headers,
      headersTimestamp: Date.now(),
      messageCount: 0,
      model: options.model,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inFlight: false,
    };

    this.sessions.set(sessionId, session);
    console.log(`[Session] Created session ${sessionId} with chatId ${warmedChat.chatId} (account: ${warmedChat.accountId})`);

    return session;
  }

  /**
   * Get an existing session by ID.
   */
  get(sessionId: string): ChatSession | null {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsedAt = Date.now();
    }
    return session || null;
  }

  /**
   * Update the parent_id for a session (called when response.created arrives).
   */
  setParentId(sessionId: string, parentId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.parentId = parentId;
    }
  }

  /**
   * Update message count and store fingerprints after sending messages.
   */
  updateMessageState(sessionId: string, messageCount: number, fingerprints: Map<number, string>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messageCount = messageCount;
      this.fingerprints.set(sessionId, fingerprints);
    }
  }

  /**
   * Mark a session as in-flight (request in progress).
   * Returns false if the session is already in-flight (concurrent request).
   */
  acquireFlight(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.inFlight) return false;
    session.inFlight = true;
    return true;
  }

  /**
   * Release the in-flight lock on a session.
   */
  releaseFlight(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.inFlight = false;
    }
  }

  /**
   * Remove a session and release its warm chat lease.
   */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      releaseWarmChat(session.accountId, session.chatId);
      this.sessions.delete(sessionId);
      this.fingerprints.delete(sessionId);
      console.log(`[Session] Removed session ${sessionId}`);
    }
  }

  /**
   * Remove all sessions.
   */
  removeAll(): void {
    for (const [id, session] of this.sessions) {
      releaseWarmChat(session.accountId, session.chatId);
    }
    this.sessions.clear();
    this.fingerprints.clear();
    console.log('[Session] Removed all sessions');
  }

  // ─── Auto-Detection ─────────────────────────────────────────────────────

  /**
   * Try to match a request's messages array to an existing session.
   *
   * Logic: If the first N messages of the request match exactly the N messages
   * already sent for a session, and the request has more messages, it's the same
   * conversation continuing.
   */
  matchByMessages(
    messages: Array<{ role: string; content: any }>,
    model: string,
  ): SessionMatchResult | null {
    if (!config.session?.enabled || !config.session?.autoDetect) return null;

    let bestMatch: SessionMatchResult | null = null;
    let bestCount = 0;

    for (const session of this.sessions.values()) {
      // Skip sessions with different models
      if (session.model !== model) continue;

      // Skip in-flight sessions
      if (session.inFlight) continue;

      // The session must have fewer messages than the request
      if (session.messageCount >= messages.length) continue;

      // Check if the first session.messageCount messages match
      const sessionFps = this.fingerprints.get(session.sessionId);
      if (!sessionFps) continue;

      let matches = true;
      for (let i = 0; i < session.messageCount; i++) {
        const reqMsg = messages[i];
        const reqContent = extractTextContent(reqMsg.content);
        const fp = getMessageFingerprint(reqMsg.role, reqContent);
        const storedFp = sessionFps.get(i);

        if (storedFp !== fp) {
          matches = false;
          break;
        }
      }

      if (matches && session.messageCount > bestCount) {
        bestCount = session.messageCount;
        bestMatch = {
          session,
          newMessageStartIndex: session.messageCount,
        };
      }
    }

    return bestMatch;
  }

  // ─── Headers Refresh ────────────────────────────────────────────────────

  /**
   * Check if session headers need refresh and refresh them.
   * Returns the current (possibly refreshed) headers.
   */
  async refreshHeadersIfNeeded(session: ChatSession): Promise<Record<string, string>> {
    const refreshThreshold = config.session?.headerRefreshMs || 210000; // 3.5 min
    const age = Date.now() - session.headersTimestamp;

    if (age < refreshThreshold) {
      return session.headers;
    }

    // Headers are stale, need refresh
    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('SESSION', 'session-manager.ts', `Refreshing headers for session ${session.sessionId} (age: ${Math.round(age / 1000)}s)`);
    }

    try {
      const { getQwenHeaders } = await import('../services/playwright.js');
      const { headers: freshHeaders } = await getQwenHeaders(true, session.accountId === 'guest' ? undefined : session.accountId);
      session.headers = freshHeaders;
      session.headersTimestamp = Date.now();
      console.log(`[Session] Refreshed headers for session ${session.sessionId}`);
      return freshHeaders;
    } catch (err: any) {
      console.warn(`[Session] Failed to refresh headers for session ${session.sessionId}: ${err.message}. Using stale headers.`);
      return session.headers;
    }
  }

  // ─── Stats & Introspection ──────────────────────────────────────────────

  getStats() {
    return {
      active: this.sessions.size,
      sessions: Array.from(this.sessions.values()).map(s => ({
        sessionId: s.sessionId,
        chatId: s.chatId,
        model: s.model,
        accountId: s.accountId,
        messageCount: s.messageCount,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        inFlight: s.inFlight,
        ageSeconds: Math.round((Date.now() - s.createdAt) / 1000),
      })),
    };
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  private cleanup(): void {
    const ttlMs = config.session?.ttlMs || 1_800_000; // 30 min
    const maxSessions = config.session?.maxSessions || 200;
    const now = Date.now();
    let removed = 0;

    // Remove expired sessions
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt > ttlMs && !session.inFlight) {
        releaseWarmChat(session.accountId, session.chatId);
        this.sessions.delete(id);
        this.fingerprints.delete(id);
        removed++;
      }
    }

    // Evict oldest if over cap
    if (this.sessions.size > maxSessions) {
      const sorted = Array.from(this.sessions.values())
        .filter(s => !s.inFlight)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      const toEvict = this.sessions.size - maxSessions;
      for (let i = 0; i < toEvict && i < sorted.length; i++) {
        const session = sorted[i];
        releaseWarmChat(session.accountId, session.chatId);
        this.sessions.delete(session.sessionId);
        this.fingerprints.delete(session.sessionId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[Session] Cleaned up ${removed} expired/evicted session(s). Active: ${this.sessions.size}`);
    }
  }
}

// ─── Helpers (module-level) ─────────────────────────────────────────────────

function extractTextContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text' && p.text)
      .map((p: any) => p.text)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

export function getMessageFingerprint(role: string, content: string): string {
  return `${role}:${content.length}:${crypto.createHash('md5').update(content).digest('hex').slice(0, 16)}`;
}

/**
 * Build fingerprints for a messages array (for storing in session state).
 */
export function buildMessageFingerprints(
  messages: Array<{ role: string; content: any }>,
  startIndex: number,
  endIndex: number,
): Map<number, string> {
  const fps = new Map<number, string>();
  for (let i = startIndex; i < endIndex; i++) {
    const msg = messages[i];
    const text = extractTextContent(msg.content);
    fps.set(i, getMessageFingerprint(msg.role, text));
  }
  return fps;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!instance) {
    instance = new SessionManager();
  }
  return instance;
}

export { extractTextContent };
