/**
 * Request Store - SQLite storage for request logs
 * Provides persistence and querying capabilities
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';
import type { RequestLog, RequestStats } from './request-logger.js';

// ─── RequestStore Class ──────────────────────────────────────────────────────

export class RequestStore {
  private db: Database.Database | null = null;
  private dbPath: string;
  private initialized = false;

  constructor() {
    this.dbPath = config.logging?.dbPath || './data/requests.db';
    this.init();
  }

  /**
   * Initialize SQLite database
   */
  private init(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);

      // Enable WAL mode for better performance
      this.db.pragma('journal_mode = WAL');

      // Create tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS request_logs (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          original_model TEXT NOT NULL,
          mapped_model TEXT NOT NULL,
          protocol TEXT NOT NULL,
          endpoint TEXT,
          client_ip TEXT,
          user_agent TEXT,
          thinking INTEGER DEFAULT 0,
          thinking_effort TEXT,
          has_tools INTEGER DEFAULT 0,
          tool_names TEXT,
          stream_mode INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          success INTEGER NOT NULL,
          status_code INTEGER,
          error_code TEXT,
          error_message TEXT,
          account_id TEXT,
          account_email TEXT,
          matched_by TEXT,
          route_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_original_model ON request_logs(original_model);
        CREATE INDEX IF NOT EXISTS idx_mapped_model ON request_logs(mapped_model);
        CREATE INDEX IF NOT EXISTS idx_success ON request_logs(success);
        CREATE INDEX IF NOT EXISTS idx_account_id ON request_logs(account_id);
        CREATE INDEX IF NOT EXISTS idx_protocol ON request_logs(protocol);
      `);

      this.initialized = true;
      console.log(`[RequestStore] Initialized at ${this.dbPath}`);
    } catch (err: any) {
      console.error(`[RequestStore] Failed to initialize: ${err.message}`);
      this.initialized = false;
    }
  }

  /**
   * Log a request to the database
   */
  async log(entry: RequestLog): Promise<void> {
    if (!this.initialized || !this.db) return;

    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO request_logs (
          id, timestamp, original_model, mapped_model, protocol, endpoint,
          client_ip, user_agent, thinking, thinking_effort, has_tools,
          tool_names, stream_mode, input_tokens, output_tokens, cache_tokens,
          total_tokens, start_time, end_time, duration_ms, success,
          status_code, error_code, error_message, account_id, account_email,
          matched_by, route_id
        ) VALUES (
          @id, @timestamp, @originalModel, @mappedModel, @protocol, @endpoint,
          @clientIp, @userAgent, @thinking, @thinkingEffort, @hasTools,
          @toolNames, @streamMode, @inputTokens, @outputTokens, @cacheTokens,
          @totalTokens, @startTime, @endTime, @durationMs, @success,
          @statusCode, @errorCode, @errorMessage, @accountId, @accountEmail,
          @matchedBy, @routeId
        )
      `);

      stmt.run({
        id: entry.id,
        timestamp: entry.timestamp,
        originalModel: entry.originalModel,
        mappedModel: entry.mappedModel,
        protocol: entry.protocol,
        endpoint: entry.endpoint || null,
        clientIp: entry.clientIp || null,
        userAgent: entry.userAgent || null,
        thinking: entry.thinking ? 1 : 0,
        thinkingEffort: entry.thinkingEffort || null,
        hasTools: entry.hasTools ? 1 : 0,
        toolNames: entry.toolNames ? JSON.stringify(entry.toolNames) : null,
        streamMode: entry.streamMode ? 1 : 0,
        inputTokens: entry.inputTokens || 0,
        outputTokens: entry.outputTokens || 0,
        cacheTokens: entry.cacheTokens || 0,
        totalTokens: entry.totalTokens || 0,
        startTime: entry.startTime,
        endTime: entry.endTime,
        durationMs: entry.durationMs,
        success: entry.success ? 1 : 0,
        statusCode: entry.statusCode || null,
        errorCode: entry.errorCode || null,
        errorMessage: entry.errorMessage || null,
        accountId: entry.accountId || null,
        accountEmail: entry.accountEmail || null,
        matchedBy: entry.matchedBy || null,
        routeId: entry.routeId || null,
      });
    } catch (err: any) {
      console.error(`[RequestStore] Failed to log request: ${err.message}`);
    }
  }

  /**
   * Query requests with filters
   */
  query(
    filters: {
      from?: Date;
      to?: Date;
      model?: string;
      status?: 'success' | 'error';
      accountId?: string;
      protocol?: string;
      search?: string;
    } = {},
    pagination: { page: number; perPage: number } = { page: 1, perPage: 20 }
  ): { data: RequestLog[]; total: number; page: number; perPage: number } {
    if (!this.initialized || !this.db) {
      return { data: [], total: 0, page: pagination.page, perPage: pagination.perPage };
    }

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (filters.from) {
      conditions.push('timestamp >= @from');
      params.from = filters.from.getTime();
    }
    if (filters.to) {
      conditions.push('timestamp <= @to');
      params.to = filters.to.getTime();
    }
    if (filters.model) {
      conditions.push('(original_model LIKE @model OR mapped_model LIKE @model)');
      params.model = `%${filters.model}%`;
    }
    if (filters.status) {
      conditions.push('success = @success');
      params.success = filters.status === 'success' ? 1 : 0;
    }
    if (filters.accountId) {
      conditions.push('account_id = @accountId');
      params.accountId = filters.accountId;
    }
    if (filters.protocol) {
      conditions.push('protocol = @protocol');
      params.protocol = filters.protocol;
    }
    if (filters.search) {
      conditions.push('(original_model LIKE @search OR mapped_model LIKE @search OR error_message LIKE @search)');
      params.search = `%${filters.search}%`;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (pagination.page - 1) * pagination.perPage;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM request_logs ${whereClause}`;
    const { total } = this.db.prepare(countQuery).get(params) as { total: number };

    // Get paginated results
    const dataQuery = `
      SELECT * FROM request_logs ${whereClause}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `;
    const rows = this.db.prepare(dataQuery).all({ ...params, limit: pagination.perPage, offset });

    // Convert rows to RequestLog objects
    const data: RequestLog[] = rows.map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      originalModel: row.original_model,
      mappedModel: row.mapped_model,
      protocol: row.protocol,
      endpoint: row.endpoint,
      clientIp: row.client_ip,
      userAgent: row.user_agent,
      thinking: row.thinking === 1,
      thinkingEffort: row.thinking_effort,
      hasTools: row.has_tools === 1,
      toolNames: row.tool_names ? JSON.parse(row.tool_names) : undefined,
      streamMode: row.stream_mode === 1,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens,
      totalTokens: row.total_tokens,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMs: row.duration_ms,
      success: row.success === 1,
      statusCode: row.status_code,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      accountId: row.account_id,
      accountEmail: row.account_email,
      matchedBy: row.matched_by,
      routeId: row.route_id,
    }));

    return { data, total, page: pagination.page, perPage: pagination.perPage };
  }

  /**
   * Get request by ID
   */
  getById(id: string): RequestLog | null {
    if (!this.initialized || !this.db) return null;

    const row = this.db.prepare('SELECT * FROM request_logs WHERE id = ?').get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      timestamp: row.timestamp,
      originalModel: row.original_model,
      mappedModel: row.mapped_model,
      protocol: row.protocol,
      endpoint: row.endpoint,
      clientIp: row.client_ip,
      userAgent: row.user_agent,
      thinking: row.thinking === 1,
      thinkingEffort: row.thinking_effort,
      hasTools: row.has_tools === 1,
      toolNames: row.tool_names ? JSON.parse(row.tool_names) : undefined,
      streamMode: row.stream_mode === 1,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens,
      totalTokens: row.total_tokens,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMs: row.duration_ms,
      success: row.success === 1,
      statusCode: row.status_code,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      accountId: row.account_id,
      accountEmail: row.account_email,
      matchedBy: row.matched_by,
      routeId: row.route_id,
    };
  }

  /**
   * Get statistics
   */
  getStats(
    period?: 'today' | '7d' | '30d' | 'custom',
    from?: Date,
    to?: Date
  ): RequestStats {
    if (!this.initialized || !this.db) {
      return {
        total: 0,
        success: 0,
        failed: 0,
        successRate: 0,
        tokens: { input: 0, output: 0, cache: 0, total: 0 },
        avgDurationMs: 0,
        cacheHitRate: 0,
        byModel: {},
        byProtocol: {},
        byHour: [],
      };
    }

    // Calculate date range
    let startDate: Date | undefined;
    const endDate = to || new Date();

    if (period === 'today') {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
    } else if (period === '7d') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === '30d') {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
    } else if (from) {
      startDate = from;
    }

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (startDate) {
      conditions.push('timestamp >= @startDate');
      params.startDate = startDate.getTime();
    }
    if (endDate) {
      conditions.push('timestamp <= @endDate');
      params.endDate = endDate.getTime();
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get basic stats
    const statsQuery = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed,
        AVG(duration_ms) as avgDurationMs,
        SUM(input_tokens) as inputTokens,
        SUM(output_tokens) as outputTokens,
        SUM(cache_tokens) as cacheTokens,
        SUM(total_tokens) as totalTokens
      FROM request_logs ${whereClause}
    `;
    const stats = this.db.prepare(statsQuery).get(params) as any;

    // Get stats by model
    const byModelQuery = `
      SELECT
        mapped_model,
        COUNT(*) as count,
        SUM(total_tokens) as tokens,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as successRate,
        AVG(duration_ms) as avgDuration
      FROM request_logs ${whereClause}
      GROUP BY mapped_model
    `;
    const byModelRows = this.db.prepare(byModelQuery).all(params) as any[];
    const byModel: Record<string, any> = {};
    for (const row of byModelRows) {
      byModel[row.mapped_model] = {
        count: row.count,
        tokens: row.tokens,
        successRate: row.successRate,
        avgDuration: row.avgDuration,
      };
    }

    // Get stats by protocol
    const byProtocolQuery = `
      SELECT
        protocol,
        COUNT(*) as count,
        SUM(total_tokens) as tokens
      FROM request_logs ${whereClause}
      GROUP BY protocol
    `;
    const byProtocolRows = this.db.prepare(byProtocolQuery).all(params) as any[];
    const byProtocol: Record<string, any> = {};
    for (const row of byProtocolRows) {
      byProtocol[row.protocol] = {
        count: row.count,
        tokens: row.tokens,
      };
    }

    // Get stats by hour (last 24 hours or custom range)
    const byHourQuery = `
      SELECT
        (timestamp / 3600000) * 3600000 as hour,
        COUNT(*) as count,
        SUM(total_tokens) as tokens
      FROM request_logs ${whereClause}
      GROUP BY hour
      ORDER BY hour DESC
      LIMIT 24
    `;
    const byHourRows = this.db.prepare(byHourQuery).all(params) as any[];
    const byHour = byHourRows.map((row: any) => ({
      hour: new Date(row.hour).getHours(),
      count: row.count,
      tokens: row.tokens,
    }));

    const total = stats.total || 0;
    const success = stats.success || 0;
    const totalTokens = stats.totalTokens || 0;
    const cacheTokens = stats.cacheTokens || 0;

    return {
      total,
      success,
      failed: stats.failed || 0,
      successRate: total > 0 ? success / total : 0,
      tokens: {
        input: stats.inputTokens || 0,
        output: stats.outputTokens || 0,
        cache: cacheTokens,
        total: totalTokens,
      },
      avgDurationMs: stats.avgDurationMs || 0,
      cacheHitRate: totalTokens > 0 ? cacheTokens / totalTokens : 0,
      byModel,
      byProtocol,
      byHour,
    };
  }

  /**
   * Delete old logs
   */
  cleanup(olderThanDays: number): number {
    if (!this.initialized || !this.db) return 0;

    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  /**
   * Delete all logs
   */
  deleteAll(): number {
    if (!this.initialized || !this.db) return 0;

    const result = this.db.prepare('DELETE FROM request_logs').run();
    return result.changes;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const requestStore = new RequestStore();
