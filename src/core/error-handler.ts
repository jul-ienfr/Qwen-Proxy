/**
 * Error Handler - Centralized error handling with typed errors
 */

// ─── Error Codes ─────────────────────────────────────────────────────────────

export enum ErrorCode {
  // Browser errors
  BROWSER_LAUNCH_FAILED = 'BROWSER_LAUNCH_FAILED',
  BROWSER_DISCONNECTED = 'BROWSER_DISCONNECTED',
  PAGE_NAVIGATION_FAILED = 'PAGE_NAVIGATION_FAILED',

  // Session errors
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_INVALID = 'SESSION_INVALID',
  LOGIN_FAILED = 'LOGIN_FAILED',

  // Rate limiting
  RATE_LIMITED = 'RATE_LIMITED',
  ACCOUNT_COOLDOWN = 'ACCOUNT_COOLDOWN',

  // Captcha
  CAPTCHA_DETECTED = 'CAPTCHA_DETECTED',
  CAPTCHA_SOLVER_FAILED = 'CAPTCHA_SOLVER_FAILED',

  // Account
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  NO_ACCOUNTS_AVAILABLE = 'NO_ACCOUNTS_AVAILABLE',

  // Upstream errors
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT',
  UPSTREAM_RATE_LIMITED = 'UPSTREAM_RATE_LIMITED',

  // Validation
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_REQUEST = 'INVALID_REQUEST',

  // Internal
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
}

// ─── ProxyError Class ────────────────────────────────────────────────────────

export class ProxyError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public readonly statusCode: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      statusCode?: number;
      cause?: Error;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProxyError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.statusCode = options.statusCode ?? 500;
  }

  /**
   * Convert to JSON response
   */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        retryAfterMs: this.retryAfterMs,
      },
    };
  }
}

// ─── Retry Helper ────────────────────────────────────────────────────────────

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      // Check if error is retryable
      if (err instanceof ProxyError && !err.retryable) {
        throw err;
      }

      // Don't retry on last attempt
      if (attempt === opts.maxRetries) {
        throw err;
      }

      // Calculate delay with exponential backoff
      let delay = opts.baseDelay * Math.pow(opts.backoffMultiplier, attempt);
      delay = Math.min(delay, opts.maxDelay);

      // Add jitter if enabled
      if (opts.jitter) {
        delay += Math.random() * opts.baseDelay;
      }

      // Use retry-after from ProxyError if available
      if (err instanceof ProxyError && err.retryAfterMs) {
        delay = Math.max(delay, err.retryAfterMs);
      }

      console.log(`[Retry] Attempt ${attempt + 1}/${opts.maxRetries} failed, retrying in ${Math.round(delay)}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Retry failed');
}

// ─── Error Mapping ───────────────────────────────────────────────────────────

/**
 * Map upstream errors to ProxyError
 */
export function mapUpstreamError(status: number, message: string): ProxyError {
  if (status === 429) {
    return new ProxyError(ErrorCode.UPSTREAM_RATE_LIMITED, message, {
      retryable: true,
      retryAfterMs: 60000,
      statusCode: 429,
    });
  }

  if (status === 408 || status === 504) {
    return new ProxyError(ErrorCode.UPSTREAM_TIMEOUT, message, {
      retryable: true,
      statusCode: status,
    });
  }

  if (status >= 500) {
    return new ProxyError(ErrorCode.UPSTREAM_ERROR, message, {
      retryable: true,
      statusCode: status,
    });
  }

  return new ProxyError(ErrorCode.UPSTREAM_ERROR, message, {
    retryable: false,
    statusCode: status,
  });
}

/**
 * Create a ProxyError from a generic error
 */
export function toProxyError(err: Error): ProxyError {
  if (err instanceof ProxyError) {
    return err;
  }

  const message = err.message || 'Unknown error';

  // Check for common error patterns
  if (message.includes('rate limit') || message.includes('429')) {
    return new ProxyError(ErrorCode.RATE_LIMITED, message, {
      retryable: true,
      retryAfterMs: 60000,
      statusCode: 429,
    });
  }

  if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
    return new ProxyError(ErrorCode.UPSTREAM_TIMEOUT, message, {
      retryable: true,
      statusCode: 504,
    });
  }

  if (message.includes('captcha') || message.includes('baxia')) {
    return new ProxyError(ErrorCode.CAPTCHA_DETECTED, message, {
      retryable: false,
      statusCode: 403,
    });
  }

  if (message.includes('session') || message.includes('expired')) {
    return new ProxyError(ErrorCode.SESSION_EXPIRED, message, {
      retryable: false,
      statusCode: 401,
    });
  }

  return new ProxyError(ErrorCode.INTERNAL_ERROR, message, {
    retryable: false,
    statusCode: 500,
    cause: err,
  });
}
