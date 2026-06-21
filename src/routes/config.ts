/**
 * Config Routes - API endpoints for model mapping configuration
 */

import { Hono } from 'hono';
import { modelMapper } from '../core/model-mapper.js';
import { configWatcher } from '../core/config-watcher.js';

const app = new Hono();

// ─── Mapping Endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/config/mapping - Get current mapping configuration
 */
app.get('/api/config/mapping', (c) => {
  const config = modelMapper.getConfig();
  return c.json(config);
});

/**
 * PUT /api/config/mapping - Update mapping configuration
 */
app.put('/api/config/mapping', async (c) => {
  try {
    const body = await c.req.json();
    modelMapper.setConfig(body);
    return c.json({ success: true, config: modelMapper.getConfig() });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * POST /api/config/mapping/reload - Force reload from file
 */
app.post('/api/config/mapping/reload', (c) => {
  modelMapper.reload();
  return c.json({ success: true, config: modelMapper.getConfig() });
});

// ─── Model Mappings Endpoints ────────────────────────────────────────────────

/**
 * GET /api/config/mappings - List all model mappings
 */
app.get('/api/config/mappings', (c) => {
  const mappings = modelMapper.getMappings();
  return c.json(mappings);
});

/**
 * POST /api/config/mappings - Add or update a model mapping
 */
app.post('/api/config/mappings', async (c) => {
  try {
    const body = await c.req.json();
    modelMapper.addMapping(body);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * DELETE /api/config/mappings/:source - Remove a model mapping
 */
app.delete('/api/config/mappings/:source', (c) => {
  const source = c.req.param('source');
  const removed = modelMapper.removeMapping(source);
  if (removed) {
    return c.json({ success: true });
  }
  return c.json({ error: 'Mapping not found' }, 404);
});

// ─── Custom Routes Endpoints ─────────────────────────────────────────────────

/**
 * GET /api/config/routes - List all custom routes
 */
app.get('/api/config/routes', (c) => {
  const routes = modelMapper.getRoutes();
  return c.json(routes);
});

/**
 * POST /api/config/routes - Add a new custom route
 */
app.post('/api/config/routes', async (c) => {
  try {
    const body = await c.req.json();
    const route = modelMapper.addRoute(body);
    return c.json({ success: true, route });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * PUT /api/config/routes/:id - Update a custom route
 */
app.put('/api/config/routes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const updated = modelMapper.updateRoute(id, body);
    if (updated) {
      return c.json({ success: true });
    }
    return c.json({ error: 'Route not found' }, 404);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * DELETE /api/config/routes/:id - Remove a custom route
 */
app.delete('/api/config/routes/:id', (c) => {
  const id = c.req.param('id');
  const removed = modelMapper.removeRoute(id);
  if (removed) {
    return c.json({ success: true });
  }
  return c.json({ error: 'Route not found' }, 404);
});

// ─── Aliases Endpoints ───────────────────────────────────────────────────────

/**
 * GET /api/config/aliases - List all aliases
 */
app.get('/api/config/aliases', (c) => {
  const aliases = modelMapper.getAliases();
  return c.json(aliases);
});

/**
 * POST /api/config/aliases - Add or update an alias
 */
app.post('/api/config/aliases', async (c) => {
  try {
    const { alias, target } = await c.req.json();
    if (!alias || !target) {
      return c.json({ error: 'alias and target are required' }, 400);
    }
    modelMapper.addAlias(alias, target);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

/**
 * DELETE /api/config/aliases/:alias - Remove an alias
 */
app.delete('/api/config/aliases/:alias', (c) => {
  const alias = c.req.param('alias');
  const removed = modelMapper.removeAlias(alias);
  if (removed) {
    return c.json({ success: true });
  }
  return c.json({ error: 'Alias not found' }, 404);
});

// ─── Test Endpoint ───────────────────────────────────────────────────────────

/**
 * POST /api/config/resolve - Test model resolution
 */
app.post('/api/config/resolve', async (c) => {
  try {
    const { model, tools, thinking, effort } = await c.req.json();
    if (!model) {
      return c.json({ error: 'model is required' }, 400);
    }
    const result = modelMapper.resolve(model, { tools, thinking, effort });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

export { app };
