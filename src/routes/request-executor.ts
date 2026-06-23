/**
 * request-executor.ts
 *
 * Shared request-execution helpers extracted from the duplicated session
 * management logic in chat.ts and multi-protocol.ts.
 */

import type { ChatSession } from '../core/session-manager.js';
import {
  getSessionManager,
  buildMessageFingerprints,
  extractTextContent,
  getMessageFingerprint,
} from '../core/session-manager.js';

// ---------------------------------------------------------------------------
// resolveSession
// ---------------------------------------------------------------------------

export interface SessionResolveOptions {
  sessionHeader: string | undefined;
  messages: Array<{ role: string; content: any }>;
  model: string;
  /** Protocol-specific busy-session response builder */
  busyResponse: (sessionId: string) => { body: any; status: number };
}

export type SessionResolveResult =
  | { resolved: false; busyResponse: { body: any; status: number }; activeSession: null; deltaStartIndex: 0 }
  | { resolved: true; busyResponse: { body: any; status: number }; activeSession: null; deltaStartIndex: 0 }
  | { resolved: true; activeSession: null; deltaStartIndex: 0 }
  | { resolved: true; activeSession: ChatSession; deltaStartIndex: number };

export async function resolveSession(opts: SessionResolveOptions): Promise<SessionResolveResult> {
  const sessionMgr = getSessionManager();
  const { sessionHeader, messages, model, busyResponse } = opts;

  if (sessionHeader) {
    try {
      const activeSession = await sessionMgr.getOrCreate({
        sessionId: sessionHeader,
        model,
      });
      if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
        return { resolved: false, busyResponse: busyResponse(sessionHeader), activeSession: null, deltaStartIndex: 0 };
      }
      return { resolved: true, activeSession, deltaStartIndex: activeSession.messageCount };
    } catch (err: any) {
      console.error(`[RequestExecutor] Failed to get/create session ${sessionHeader}:`, err.message);
    }
  } else if (messages.length > 0) {
    const match = sessionMgr.matchByMessages(messages, model);
    if (match) {
      if (!sessionMgr.acquireFlight(match.session.sessionId)) {
        return { resolved: false, busyResponse: busyResponse(match.session.sessionId), activeSession: null, deltaStartIndex: 0 };
      }
      return { resolved: true, activeSession: match.session, deltaStartIndex: match.newMessageStartIndex };
    }
  }

  return { resolved: true, activeSession: null, deltaStartIndex: 0 };
}

// ---------------------------------------------------------------------------
// buildSessionContext
// ---------------------------------------------------------------------------

export interface SessionContext {
  chatId: string;
  parentId: string | null;
  headers: Record<string, string>;
  accountId: string;
}

export async function buildSessionContext(
  activeSession: ChatSession | null,
): Promise<SessionContext | undefined> {
  if (!activeSession) return undefined;
  const sessionMgr = getSessionManager();
  return {
    chatId: activeSession.chatId,
    parentId: activeSession.parentId,
    headers: await sessionMgr.refreshHeadersIfNeeded(activeSession),
    accountId: activeSession.accountId,
  };
}

// ---------------------------------------------------------------------------
// updateSessionState
// ---------------------------------------------------------------------------

export function updateSessionState(
  activeSession: ChatSession | null,
  messages: Array<{ role: string; content: any }>,
  deltaStartIndex: number,
): void {
  if (!activeSession) return;
  const sessionMgr = getSessionManager();
  const newMsgCount = messages.length;
  const fps = buildMessageFingerprints(messages, deltaStartIndex, newMsgCount);
  const existingFps = new Map<number, string>();
  for (let i = 0; i < deltaStartIndex; i++) {
    const msg = messages[i];
    const text = extractTextContent(msg.content);
    existingFps.set(i, getMessageFingerprint(msg.role, text));
  }
  for (const [k, v] of fps) existingFps.set(k, v);
  sessionMgr.updateMessageState(activeSession.sessionId, newMsgCount, existingFps);
}

// ---------------------------------------------------------------------------
// releaseSessionFlight
// ---------------------------------------------------------------------------

export function releaseSessionFlight(activeSession: ChatSession | null): void {
  if (activeSession) {
    getSessionManager().releaseFlight(activeSession.sessionId);
  }
}
