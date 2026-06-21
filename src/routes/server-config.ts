/**
 * Server Config Routes - API endpoints for hot-reloadable server configuration
 */

import { Hono } from 'hono';
import { getConfigManager } from '../core/config-manager.js';

const app = new Hono();

// ─── GET /api/config/server ──────────────────────────────────────────────────

/**
 * Get full server config with metadata
 * Query params: ?section=timeouts (optional, filters by section)
 */
app.get('/api/config/server', (c) => {
  const manager = getConfigManager();
  const section = c.req.query('section');

  if (section) {
    const config = manager.getSanitizedConfig();
    const sectionConfig = config[section];
    if (!sectionConfig) {
      return c.json({ error: `Unknown section: ${section}` }, 404);
    }
    return c.json({ config: sectionConfig, section });
  }

  const info = manager.getFullConfigInfo();
  return c.json(info);
});

// ─── GET /api/config/server/defaults ─────────────────────────────────────────

/**
 * Get default config values (from env vars)
 */
app.get('/api/config/server/defaults', (c) => {
  const manager = getConfigManager();
  return c.json({ defaults: manager.configDefaults });
});

// ─── PUT /api/config/server ──────────────────────────────────────────────────

/**
 * Update a single config value
 * Body: { path: string, value: any }
 */
app.put('/api/config/server', async (c) => {
  try {
    const body = await c.req.json();
    const { path, value } = body;

    if (!path) {
      return c.json({ error: 'Missing "path" in request body' }, 400);
    }

    const manager = getConfigManager();
    const result = manager.updateConfig(path, value);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      path,
      oldValue: result.oldValue,
      newValue: result.newValue,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── PUT /api/config/server/batch ────────────────────────────────────────────

/**
 * Update multiple config values atomically
 * Body: { updates: Array<{ path: string, value: any }> }
 */
app.put('/api/config/server/batch', async (c) => {
  try {
    const body = await c.req.json();
    const { updates } = body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return c.json({ error: 'Missing or empty "updates" array' }, 400);
    }

    const manager = getConfigManager();
    const result = manager.batchUpdate(updates);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      changes: result.changes,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── POST /api/config/server/reset ───────────────────────────────────────────

/**
 * Reset config to defaults
 * Body (optional): { path: string } — resets specific path or all
 */
app.post('/api/config/server/reset', async (c) => {
  try {
    let body: { path?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // No body — reset all
    }

    const manager = getConfigManager();
    const result = manager.resetConfig(body.path);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      reset: body.path || 'all',
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export { app };
