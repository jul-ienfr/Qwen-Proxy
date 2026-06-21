/**
 * Protocol Adapter Registry
 * Manages and detects protocol adapters
 */

import type { ProtocolAdapter } from './types.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';

// ─── Adapter Registry ────────────────────────────────────────────────────────

class AdapterRegistry {
  private adapters: ProtocolAdapter[] = [];
  private anthropic: AnthropicAdapter;
  private gemini: GeminiAdapter;

  constructor() {
    this.anthropic = new AnthropicAdapter();
    this.gemini = new GeminiAdapter();

    // Register built-in adapters (order matters - first match wins)
    this.adapters.push(this.anthropic);
    this.adapters.push(this.gemini);
  }

  /**
   * Detect which adapter to use for a request
   */
  detect(path: string, headers: Record<string, string>): ProtocolAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.detect(path, headers)) {
        return adapter;
      }
    }
    return null; // null = OpenAI format (default)
  }

  /**
   * Get adapter by name
   */
  get(name: string): ProtocolAdapter | undefined {
    return this.adapters.find(a => a.name === name);
  }

  /**
   * Get all registered adapters
   */
  getAll(): ProtocolAdapter[] {
    return [...this.adapters];
  }

  /**
   * Register a custom adapter
   */
  register(adapter: ProtocolAdapter): void {
    this.adapters.push(adapter);
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const adapterRegistry = new AdapterRegistry();

// Re-export types and adapters
export type { ProtocolAdapter } from './types.js';
export type {
  NormalizedRequest,
  NormalizedMessage,
  NormalizedResponse,
  NormalizedChoice,
  NormalizedTool,
  NormalizedToolCall,
  NormalizedUsage,
  StreamChunk,
  StreamChoice,
  NormalizedContentPart,
} from './types.js';
export { AnthropicAdapter } from './anthropic.js';
export { GeminiAdapter } from './gemini.js';
