/**
 * Protocol Adapter Types - Shared types for all protocol adapters
 */

// ─── Normalized Request ──────────────────────────────────────────────────────

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | NormalizedContentPart[];
  tool_call_id?: string;
  tool_calls?: NormalizedToolCall[];
  name?: string;
  thinking?: string;
}

export interface NormalizedContentPart {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url' | 'file_url';
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  file_url?: { url: string };
}

export interface NormalizedTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface NormalizedRequest {
  /** Normalized model name */
  model: string;
  /** Original model name before mapping */
  originalModel: string;
  /** Messages in normalized format */
  messages: NormalizedMessage[];
  /** Whether streaming is enabled */
  stream: boolean;
  /** Tools available */
  tools?: NormalizedTool[];
  /** Tool choice */
  tool_choice?: string | { type: string; function?: { name: string } };
  /** Temperature */
  temperature?: number;
  /** Max tokens */
  max_tokens?: number;
  /** Top P */
  top_p?: number;
  /** Stop sequences */
  stop?: string[];
  /** Stop sequences (Anthropic) */
  stop_sequences?: string[];
  /** Thinking/reasoning mode */
  thinking?: boolean;
  /** Thinking effort */
  thinking_effort?: 'low' | 'medium' | 'high';
  /** Stream options (e.g., include_usage) */
  stream_options?: { include_usage?: boolean };
  /** Extra metadata from original request */
  metadata?: Record<string, unknown>;
}

// ─── Normalized Response ─────────────────────────────────────────────────────

export interface NormalizedResponse {
  /** Response ID */
  id: string;
  /** Object type */
  object: string;
  /** Creation timestamp */
  created: number;
  /** Model used */
  model: string;
  /** Response choices */
  choices: NormalizedChoice[];
  /** Usage statistics */
  usage?: NormalizedUsage;
}

export interface NormalizedChoice {
  /** Choice index */
  index: number;
  /** Message content */
  message: {
    role: 'assistant';
    content: string | null;
    thinking?: string;
    tool_calls?: NormalizedToolCall[];
  };
  /** Finish reason */
  finish_reason: string | null;
}

export interface NormalizedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface NormalizedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ─── Stream Events ───────────────────────────────────────────────────────────

export interface StreamChunk {
  /** Chunk ID */
  id: string;
  /** Object type */
  object: string;
  /** Creation timestamp */
  created: number;
  /** Model used */
  model: string;
  /** Choices */
  choices: StreamChoice[];
  /** Usage (if included) */
  usage?: NormalizedUsage;
}

export interface StreamChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: string | null;
}

// ─── Protocol Adapter Interface ──────────────────────────────────────────────

export interface ProtocolAdapter {
  /** Protocol name */
  name: string;

  /**
   * Detect if a request matches this protocol
   */
  detect(path: string, headers: Record<string, string>): boolean;

  /**
   * Normalize incoming request to internal format
   */
  normalizeRequest(raw: any, path: string): NormalizedRequest;

  /**
   * Format normalized response back to protocol format
   */
  formatResponse(normalized: NormalizedResponse, raw: any): any;

  /**
   * Format a stream chunk for this protocol
   */
  formatStreamChunk(chunk: StreamChunk): any;

  /**
   * Format the stream start event
   */
  formatStreamStart(model: string): any;

  /**
   * Format the stream end event
   */
  formatStreamEnd(usage?: NormalizedUsage): any;
}
