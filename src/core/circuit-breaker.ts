/**
 * Circuit Breaker - Prevent cascading failures
 */

import { getDebugLogger } from './debug-logger.js';
import { configManager } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms to wait before trying half-open */
  resetTimeoutMs: number;
  /** Number of successes in half-open to close circuit */
  successThreshold: number;
  /** Monitor interval for half-open */
  monitorIntervalMs: number;
}

// ─── CircuitBreaker Class ────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private config: CircuitBreakerConfig;
  private name: string;

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    const cfg = configManager.config.circuitBreaker;
    this.config = {
      failureThreshold: config.failureThreshold || cfg?.failureThreshold || 5,
      resetTimeoutMs: config.resetTimeoutMs || cfg?.resetTimeoutMs || 60000,
      successThreshold: config.successThreshold || cfg?.successThreshold || 3,
      monitorIntervalMs: config.monitorIntervalMs || 1000,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    // Check circuit state
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.config.resetTimeoutMs) {
        console.log(`[CircuitBreaker:${this.name}] Transitioning to HALF_OPEN`);
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error(`Circuit breaker '${this.name}' is OPEN`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /**
   * Record a success
   */
  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        console.log(`[CircuitBreaker:${this.name}] Transitioning to CLOSED`);
        this.logTransition(this.state, CircuitState.CLOSED);
        this.state = CircuitState.CLOSED;
      }
    }
  }

  /**
   * Record a failure
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      console.log(`[CircuitBreaker:${this.name}] Transitioning to OPEN (half-open failure)`);
      this.logTransition(this.state, CircuitState.OPEN);
      this.state = CircuitState.OPEN;
    } else if (this.failureCount >= this.config.failureThreshold) {
      console.log(`[CircuitBreaker:${this.name}] Transitioning to OPEN (threshold reached)`);
      this.logTransition(this.state, CircuitState.OPEN);
      this.state = CircuitState.OPEN;
    }
  }

  private logTransition(from: CircuitState, to: CircuitState): void {
    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('INTERNAL', 'circuit-breaker', `Circuit "${this.name}": ${from} → ${to}`, {
        name: this.name,
        from,
        to,
        failureCount: this.failureCount,
        successCount: this.successCount,
      });
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get stats
   */
  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Force reset (for testing)
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}

// ─── Circuit Breaker Registry ────────────────────────────────────────────────

const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker
 */
export function getCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  let breaker = circuitBreakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, config);
    circuitBreakers.set(name, breaker);
  }
  return breaker;
}

/**
 * Get all circuit breakers
 */
export function getAllCircuitBreakers(): Map<string, CircuitBreaker> {
  return circuitBreakers;
}

/**
 * Get stats for all circuit breakers
 */
export function getAllCircuitBreakerStats(): Record<string, ReturnType<CircuitBreaker['getStats']>> {
  const stats: Record<string, ReturnType<CircuitBreaker['getStats']>> = {};
  for (const [name, breaker] of circuitBreakers) {
    stats[name] = breaker.getStats();
  }
  return stats;
}
