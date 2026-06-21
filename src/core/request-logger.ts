/**
 * Request Logger - Log all requests for history and statistics
 * Inspired by OpenCode-Proxy's comprehensive request logging
 */

import crypto from 'crypto';
import { config } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RequestLog {
  /** Unique request ID */
  id: string;
  /** Request timestamp */
  timestamp: number;

  // Request info
  /** Original model requested by client */
  originalModel: string;
  /** Model after mapping */
  mappedModel: string;
  /** Protocol used */
  protocol: 'openai' | 'anthropic' | 'gemini';
  /** API endpoint called */
  endpoint: string;
  /** Client IP address */
  clientIp: string;
  /** Client user agent */
  userAgent: string;

  // Content
  /** Whether thinking/reasoning mode was used */
  thinking: boolean;
  /** Thinking effort level */
  thinkingEffort?: string;
  /** Whether tools were provided */
  hasTools: boolean;
  /** List of tool names */
  toolNames?: string[];
  /** Whether streaming was enabled */
  streamMode: boolean;

  // Tokens
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cache tokens (if cached) */
  cacheTokens: number;
  /** Total tokens */
  totalTokens: number;

  // Performance
  /** Request start time */
  startTime: number;
  /** Request end time */
  endTime: number;
  /** Request duration in milliseconds */
  durationMs: number;

  // Status
  /** Whether request succeeded */
  success: boolean;
  /** HTTP status code */
  statusCode?: number;
  /** Error code */
  errorCode?: string;
  /** Error message */
  errorMessage?: string;

  // Account
  /** Account ID used */
  accountId: string;
  /** Account email */
  accountEmail?: string;

  // Metadata
  /** How the model was matched */
  matchedBy?: 'custom-route' | 'mapping' | 'alias' | 'passthrough';
  /** Custom route ID if matched */
  routeId?: string;
}

export interface RequestStats {
  /** Total requests */
  total: number;
  /** Successful requests */
  success: number;
  /** Failed requests */
  failed: number;
  /** Success rate (0-1) */
  successRate: number;

  /** Token statistics */
  tokens: {
    input: number;
    output: number;
    cache: number;
    total: number;
  };

  /** Average duration in milliseconds */
  avgDurationMs: number;
  /** Cache hit rate (0-1) */
  cacheHitRate: number;

  /** Stats by model */
  byModel: Record<string, {
    count: number;
    tokens: number;
    successRate: number;
    avgDuration: number;
  }>;

  /** Stats by protocol */
  byProtocol: Record<string, {
    count: number;
    tokens: number;
  }>;

  /** Stats by hour (for time series) */
  byHour: Array<{
    hour: number;
    count: number;
    tokens: number;
  }>;
}

// ─── RequestLogger Class ─────────────────────────────────────────────────────

export class RequestLogger {
  private enabled: boolean;
  private buffer: RequestLog[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private flushIntervalMs: number = 5000; // Flush every 5 seconds

  constructor() {
    this.enabled = config.logging?.enabled !== false;
    if (this.enabled) {
      this.startFlushInterval();
    }
  }

  /**
   * Start periodic flush interval
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Stop flush interval
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Final flush
    this.flush();
  }

  /**
   * Log a request
   */
  log(entry: Omit<RequestLog, 'id' | 'timestamp' | 'durationMs'>): void {
    if (!this.enabled) return;

    const logEntry: RequestLog = {
      ...entry,
      id: `req_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      durationMs: entry.endTime - entry.startTime,
    };

    this.buffer.push(logEntry);

    // Flush if buffer is getting large
    if (this.buffer.length >= 100) {
      this.flush();
    }
  }

  /**
   * Flush buffer to storage
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      // Import dynamically to avoid circular dependencies
      const { requestStore } = await import('./request-store.js');
      for (const entry of entries) {
        await requestStore.log(entry);
      }
    } catch (err: any) {
      console.error(`[RequestLogger] Failed to flush: ${err.message}`);
      // Re-add entries to buffer on failure
      this.buffer.unshift(...entries);
    }
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Check if logging is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const requestLogger = new RequestLogger();
