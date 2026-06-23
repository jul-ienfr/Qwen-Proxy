/**
 * Account Routes - Cooldown management endpoints
 * Mounted under /v1, so paths are relative: /accounts/reset-cooldowns -> /v1/accounts/reset-cooldowns
 */

import { Hono } from 'hono';
import { clearAccountCooldown, getCooldownStatus } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';

export const accountsApp = new Hono();

// ─── POST /accounts/reset-cooldown - Clear a specific account cooldown ──────

accountsApp.post('/accounts/reset-cooldown', async (c) => {
  try {
    const body = await c.req.json();
    const { id } = body;

    if (!id) {
      return c.json({ error: 'id is required' }, 400);
    }

    // Verify account exists
    const accounts = loadAccounts();
    const account = accounts.find(a => a.id === id);
    if (!account) {
      return c.json({ error: 'Account not found' }, 404);
    }

    clearAccountCooldown(id);
    return c.json({ success: true, id, message: `Cooldown cleared for account ${account.email}` });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ─── POST /accounts/reset-cooldowns - Clear all cooldowns ──────────────────

accountsApp.post('/accounts/reset-cooldowns', async (c) => {
  try {
    const accounts = loadAccounts();
    const cooldownStatus = getCooldownStatus();

    let cleared = 0;
    for (const accountId of Object.keys(cooldownStatus)) {
      clearAccountCooldown(accountId);
      cleared++;
    }

    return c.json({ success: true, cleared, message: `Cleared ${cleared} active cooldown(s)` });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});
