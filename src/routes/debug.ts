/**
 * Debug Routes - API endpoints for debug mode control and log retrieval
 */

import { Hono } from 'hono';
import { getDebugState } from '../core/debug-state.js';
import { getDebugLogger } from '../core/debug-logger.js';

const app = new Hono();

// ─── GET /api/debug/status ────────────────────────────────────────────────────

/**
 * Get current debug mode state and buffer stats
 */
app.get('/api/debug/status', (c) => {
  const state = getDebugState();
  const logger = getDebugLogger();
  const stats = logger.getStats();

  return c.json({
    enabled: state.isEnabled(),
    updatedAt: state.toJSON().updatedAt,
    stats: {
      total: stats.total,
      maxSize: stats.maxSize,
    },
  });
});

// ─── POST /api/debug/toggle ───────────────────────────────────────────────────

/**
 * Toggle or explicitly set debug mode
 * Body (optional): { enabled: boolean }
 * If body is empty, toggles the current state
 */
app.post('/api/debug/toggle', async (c) => {
  const state = getDebugState();

  try {
    let body: { enabled?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // No body or invalid JSON — pure toggle
    }

    if (typeof body.enabled === 'boolean') {
      state.setEnabled(body.enabled);
    } else {
      state.toggle();
    }

    return c.json({
      success: true,
      enabled: state.isEnabled(),
      updatedAt: state.toJSON().updatedAt,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── GET /api/debug/logs ──────────────────────────────────────────────────────

/**
 * Get debug logs with filtering and pagination
 * Query params: category, component, search, limit, offset, since
 */
app.get('/api/debug/logs', (c) => {
  const logger = getDebugLogger();

  const query = {
    category: c.req.query('category') || undefined,
    component: c.req.query('component') || undefined,
    search: c.req.query('search') || undefined,
    limit: parseInt(c.req.query('limit') || '100'),
    offset: parseInt(c.req.query('offset') || '0'),
    since: c.req.query('since') ? parseInt(c.req.query('since')!) : undefined,
  };

  // Clamp limit
  query.limit = Math.min(Math.max(query.limit, 1), 500);

  const result = logger.getEntries(query);
  return c.json(result);
});

// ─── DELETE /api/debug/logs ───────────────────────────────────────────────────

/**
 * Clear all debug logs from the buffer
 */
app.delete('/api/debug/logs', (c) => {
  const logger = getDebugLogger();
  const cleared = logger.clear();

  return c.json({
    success: true,
    cleared,
  });
});

export { app };
