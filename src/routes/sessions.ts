/**
 * Sessions API - Admin endpoints for session management
 *
 * GET    /api/sessions       - List active sessions
 * DELETE /api/sessions       - Close all sessions
 * DELETE /api/sessions/:id   - Close a specific session
 */

import { Hono } from 'hono';
import { getSessionManager } from '../core/session-manager.js';

const sessionsApp = new Hono();

// List active sessions
sessionsApp.get('/', (c) => {
  const manager = getSessionManager();
  const stats = manager.getStats();
  return c.json({
    success: true,
    active: stats.active,
    sessions: stats.sessions,
  });
});

// Close all sessions
sessionsApp.delete('/', (c) => {
  const manager = getSessionManager();
  const before = manager.getStats().active;
  manager.removeAll();
  return c.json({
    success: true,
    message: `Closed ${before} session(s)`,
    closed: before,
  });
});

// Close a specific session
sessionsApp.delete('/:id', (c) => {
  const manager = getSessionManager();
  const sessionId = c.req.param('id');
  const session = manager.get(sessionId);

  if (!session) {
    return c.json({ success: false, error: `Session ${sessionId} not found` }, 404);
  }

  manager.remove(sessionId);
  return c.json({
    success: true,
    message: `Session ${sessionId} closed`,
    chatId: session.chatId,
  });
});

export { sessionsApp };
