/**
 * History Routes - API endpoints for request history and statistics
 */

import { Hono } from 'hono';
import { requestStore } from '../core/request-store.js';
import { requestLogger } from '../core/request-logger.js';

const app = new Hono();

// ─── History Endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/history - List requests with filters and pagination
 */
app.get('/api/history', (c) => {
  try {
    // Parse query parameters
    const from = c.req.query('from');
    const to = c.req.query('to');
    const model = c.req.query('model');
    const status = c.req.query('status') as 'success' | 'error' | undefined;
    const accountId = c.req.query('accountId');
    const protocol = c.req.query('protocol');
    const search = c.req.query('search');
    const page = parseInt(c.req.query('page') || '1');
    const perPage = parseInt(c.req.query('perPage') || '20');

    const result = requestStore.query(
      {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        model,
        status,
        accountId,
        protocol,
        search,
      },
      { page, perPage }
    );

    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * GET /api/history/:id - Get request details by ID
 */
app.get('/api/history/:id', (c) => {
  try {
    const id = c.req.param('id');
    const request = requestStore.getById(id);

    if (!request) {
      return c.json({ error: 'Request not found' }, 404);
    }

    return c.json(request);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * DELETE /api/history - Delete request logs
 */
app.delete('/api/history', (c) => {
  try {
    const olderThanDays = parseInt(c.req.query('olderThanDays') || '30');
    const deleted = requestStore.cleanup(olderThanDays);
    return c.json({ success: true, deleted });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * DELETE /api/history/all - Delete all request logs
 */
app.delete('/api/history/all', (c) => {
  try {
    const deleted = requestStore.deleteAll();
    return c.json({ success: true, deleted });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── Statistics Endpoints ────────────────────────────────────────────────────

/**
 * GET /api/stats - Get overall statistics
 */
app.get('/api/stats', (c) => {
  try {
    const period = c.req.query('period') as 'today' | '7d' | '30d' | 'custom' | undefined;
    const from = c.req.query('from');
    const to = c.req.query('to');

    const stats = requestStore.getStats(
      period,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined
    );

    return c.json(stats);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * GET /api/stats/model/:model - Get statistics for a specific model
 */
app.get('/api/stats/model/:model', (c) => {
  try {
    const model = c.req.param('model');
    const period = c.req.query('period') as 'today' | '7d' | '30d' | 'custom' | undefined;
    const from = c.req.query('from');
    const to = c.req.query('to');

    const stats = requestStore.getStats(
      period,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined
    );

    const modelStats = stats.byModel[model] || {
      count: 0,
      tokens: 0,
      successRate: 0,
      avgDuration: 0,
    };

    return c.json({
      model,
      ...modelStats,
      globalStats: {
        total: stats.total,
        successRate: stats.successRate,
        avgDurationMs: stats.avgDurationMs,
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/**
 * GET /api/stats/period - Get statistics for a time period
 */
app.get('/api/stats/period', (c) => {
  try {
    const period = c.req.query('period') as 'today' | '7d' | '30d' | 'custom';
    const from = c.req.query('from');
    const to = c.req.query('to');

    const stats = requestStore.getStats(
      period,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined
    );

    return c.json(stats);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── Health Endpoints ────────────────────────────────────────────────────────

/**
 * GET /api/history/status - Get logging status
 */
app.get('/api/history/status', (c) => {
  return c.json({
    enabled: requestLogger.isEnabled(),
    bufferSize: requestLogger.getBufferSize(),
  });
});

export { app };
