/**
 * Proxy Admin Routes - CRUD endpoints for proxy management
 * Mounted under /v1, so paths are relative: /proxy/status → /v1/proxy/status
 */

import { Hono } from 'hono';
import { getProxyPool } from '../services/proxy-pool.js';

export const proxyAdminApp = new Hono();

// ─── GET /proxy/status ────────────────────────────────────────────────────────

proxyAdminApp.get('/proxy/status', async (c) => {
  const pool = getProxyPool();
  const stats = pool.getStats();
  const proxies = pool.getAll().map(p => ({
    url: p.url,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    status: p.status,
    failCount: p.failCount,
    activeRequests: p.activeRequests,
    totalRequests: p.totalRequests,
    lastFailTime: p.lastFailTime ? new Date(p.lastFailTime).toISOString() : null,
    lastSuccessTime: p.lastSuccessTime ? new Date(p.lastSuccessTime).toISOString() : null,
  }));

  return c.json({ stats, proxies });
});

// ─── POST /proxy/add ─────────────────────────────────────────────────────────

proxyAdminApp.post('/proxy/add', async (c) => {
  try {
    const body = await c.req.json();
    const { url } = body;

    if (!url) {
      return c.json({ error: 'url is required' }, 400);
    }

    const pool = getProxyPool();
    const result = pool.addProxy(url);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ success: true, proxy: result.proxy });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── DELETE /proxy ────────────────────────────────────────────────────────────

proxyAdminApp.delete('/proxy', async (c) => {
  try {
    const body = await c.req.json();
    const { host, port } = body;

    if (!host || !port) {
      return c.json({ error: 'host and port are required' }, 400);
    }

    const pool = getProxyPool();
    const result = pool.removeProxy(host, parseInt(port));

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── POST /proxy/reset-failed ────────────────────────────────────────────────

proxyAdminApp.post('/proxy/reset-failed', async (c) => {
  const pool = getProxyPool();
  const resetCount = pool.resetFailed();
  return c.json({ success: true, resetCount });
});
