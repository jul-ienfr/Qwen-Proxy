export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private minLevel: LogLevel;
  private context?: string;
  private jsonMode: boolean;
  private buffer: LogEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(level: LogLevel = 'info', context?: string, jsonMode: boolean = false) {
    this.minLevel = level;
    this.context = context;
    this.jsonMode = jsonMode;

    // Start flush interval for JSON mode
    if (jsonMode) {
      this.flushInterval = setInterval(() => {
        this.flush();
      }, 5000);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatEntry(entry: LogEntry): string {
    if (this.jsonMode) {
      return JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        level: entry.level,
        message: entry.message,
        context: entry.context,
        ...entry.data,
      });
    }

    const timestamp = entry.timestamp.toISOString();
    const pad = (str: string): string => str.padStart(5, ' ');
    const colorCode = (
      entry.level === 'error' ? '\x1b[31m' :
      entry.level === 'warn' ? '\x1b[33m' :
      entry.level === 'debug' ? '\x1b[36m' : ''
    );
    const reset = '\x1b[0m';

    const coloredLevel = colorCode + pad(entry.level.toUpperCase()) + reset;
    const contextPart = entry.context ? ` [${entry.context}]` : '';

    let output = `${timestamp} ${coloredLevel}${contextPart} ${entry.message}`;

    if (entry.data) {
      output += '\n' + JSON.stringify(entry.data, null, 2);
    }

    return output;
  }

  private log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    if (this.jsonMode) {
      this.buffer.push(entry);
      if (this.buffer.length >= 50) {
        this.flush();
      }
    } else {
      const output = this.formatEntry(entry);
      switch (entry.level) {
        case 'error':
          console.error(output);
          break;
        case 'warn':
          console.warn(output);
          break;
        case 'debug':
          console.debug(output);
          break;
        default:
          console.log(output);
      }
    }
  }

  /**
   * Flush buffered logs (JSON mode only)
   */
  flush(): void {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    for (const entry of entries) {
      const output = this.formatEntry(entry);
      switch (entry.level) {
        case 'error':
          console.error(output);
          break;
        case 'warn':
          console.warn(output);
          break;
        case 'debug':
          console.debug(output);
          break;
        default:
          console.log(output);
      }
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      level: 'debug',
      message: this.context ? `[${this.context}] ${message}` : message,
      context: this.context,
      data,
    });
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      level: 'info',
      message: this.context ? `[${this.context}] ${message}` : message,
      context: this.context,
      data,
    });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      level: 'warn',
      message: this.context ? `[${this.context}] ${message}` : message,
      context: this.context,
      data,
    });
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      level: 'error',
      message: this.context ? `[${this.context}] ${message}` : message,
      context: this.context,
      data,
    });
  }

  child(context: string): Logger {
    return new Logger(this.minLevel, this.context ? `${this.context}.${context}` : context, this.jsonMode);
  }

  /**
   * Stop flush interval
   */
  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush();
  }
}

export const logger = new Logger('info');
