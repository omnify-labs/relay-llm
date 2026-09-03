import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Unit tests for admin middleware (auth) and handler (budget routes).
 */

// Mock loadEnv before importing middleware
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    RELAY_ADMIN_SECRET: 'test-secret-123',
    PORT: 8080,
    LOG_LEVEL: 'info',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    GOOGLE_API_KEY: 'goog-test',
    JWT_SECRET: 'jwt-secret',
    DATABASE_URL: null,
  }),
}));

// Mock db queries
vi.mock('../db/queries.js', () => ({
  setUserBudget: vi.fn().mockResolvedValue(undefined),
  deleteUserBudget: vi.fn().mockResolvedValue(true),
  incrementUserBudget: vi.fn().mockResolvedValue({ applied: true, budget: 60, spend: 50.0214 }),
}));

import { adminAuthMiddleware } from '../admin/middleware.js';
import { adminApp } from '../admin/handler.js';
import { setUserBudget, deleteUserBudget, incrementUserBudget } from '../db/queries.js';

/**
 * Build a test app matching production route structure:
 * /admin/* protected by adminAuthMiddleware, delegating to adminApp.
 */
function buildTestApp(): Hono {
  const app = new Hono();
  const adminRoutes = new Hono();
  adminRoutes.use('*', adminAuthMiddleware);
  adminRoutes.route('/', adminApp);
  app.route('/admin', adminRoutes);
  return app;
}

describe('adminAuthMiddleware', () => {
  let app: Hono;

  beforeEach(() => {
    app = buildTestApp();
  });

  it('allows requests with valid admin secret', async () => {
    const res = await app.request('/admin/users/u1/budget', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-secret-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ budget: 10 }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects requests with invalid admin secret', async () => {
    const res = await app.request('/admin/users/u1/budget', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer wrong-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ budget: 10 }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid admin secret');
  });

  it('rejects requests with missing Authorization header', async () => {
    const res = await app.request('/admin/users/u1/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget: 10 }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Missing or invalid Authorization header');
  });

  it('rejects requests without Bearer prefix', async () => {
    const res = await app.request('/admin/users/u1/budget', {
      method: 'PUT',
      headers: {
        Authorization: 'Basic test-secret-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ budget: 10 }),
    });
    expect(res.status).toBe(401);
  });
});

describe('adminApp handlers', () => {
  let app: Hono;
  const authHeaders = {
    Authorization: 'Bearer test-secret-123',
    'Content-Type': 'application/json',
  };

  beforeEach(() => {
    app = buildTestApp();
    vi.clearAllMocks();
  });

  describe('POST /admin/users/:user_id/budget/increment', () => {
    const post = (body: unknown) =>
      app.request('/admin/users/user-42/budget/increment', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(body),
      });

    it('applies a purchase once and returns the post-increment ledger', async () => {
      const res = await post({ delta_cents: 1000, idempotency_key: 'pi_1' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user_id: 'user-42', applied: true, budget: 60, spend: 50.0214 });
      expect(incrementUserBudget).toHaveBeenCalledWith('user-42', 1000, 'pi_1');
    });

    it('reports a replayed key as applied:false with 200 so the caller can stop retrying', async () => {
      vi.mocked(incrementUserBudget).mockResolvedValueOnce({ applied: false, budget: 60, spend: 50.0214 });
      const res = await post({ delta_cents: 1000, idempotency_key: 'pi_1' });
      expect(res.status).toBe(200);
      expect((await res.json()).applied).toBe(false);
    });

    it.each<[unknown, string]>([
      [{ delta_cents: 0, idempotency_key: 'pi' }, 'zero'],
      [{ delta_cents: -500, idempotency_key: 'pi' }, 'negative'],
      [{ delta_cents: 10.5, idempotency_key: 'pi' }, 'fractional'],
      [{ delta_cents: '1000', idempotency_key: 'pi' }, 'string'],
      [{ delta_cents: Number.MAX_SAFE_INTEGER + 2, idempotency_key: 'pi' }, 'unsafe'],
      [{ delta_cents: 1000 }, 'missing key'],
      [{ delta_cents: 1000, idempotency_key: '' }, 'empty key'],
      [{ delta_cents: 1000, idempotency_key: 'x'.repeat(256) }, 'oversized key'],
    ])('rejects %j (%s) with 400 and never touches the ledger', async (body: unknown) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(incrementUserBudget).not.toHaveBeenCalled();
    });

    it('rejects a malformed JSON body with 400', async () => {
      const res = await app.request('/admin/users/user-42/budget/increment', {
        method: 'POST',
        headers: authHeaders,
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('returns 500 (so the webhook retries) when the ledger write fails', async () => {
      vi.mocked(incrementUserBudget).mockRejectedValueOnce(new Error('db down'));
      const res = await post({ delta_cents: 1000, idempotency_key: 'pi_1' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to increment budget' });
    });
  });

  describe('PUT /admin/users/:user_id/budget', () => {
    it('sets a valid budget', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: 25.0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ user_id: 'user-42', updated: true });
    });

    it('rejects negative budget', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: -5 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/non-negative/);
    });

    it('rejects non-numeric budget', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: 'lots' }),
      });
      expect(res.status).toBe(400);
    });

    it('passes reset_spend: true to setUserBudget', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: 25.0, reset_spend: true }),
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(setUserBudget)).toHaveBeenCalledWith('user-42', 25.0, true);
    });

    it('defaults reset_spend to false', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: 10.0 }),
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(setUserBudget)).toHaveBeenCalledWith('user-42', 10.0, false);
    });

    it('rejects Infinity budget', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: 1e999 }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid JSON body', async () => {
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: { ...authHeaders },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body');
    });

    it('returns 500 when setUserBudget throws a DB error', async () => {
      vi.mocked(setUserBudget).mockRejectedValueOnce(new Error('DB down'));
      const res = await app.request('/admin/users/user-42/budget', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ budget: 10 }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /admin/users/:user_id', () => {
    it('deletes an existing user budget', async () => {
      const res = await app.request('/admin/users/user-42', {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ user_id: 'user-42', deleted: true });
    });

    it('returns 404 for nonexistent user', async () => {
      vi.mocked(deleteUserBudget).mockResolvedValueOnce(false);
      const res = await app.request('/admin/users/nobody', {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('User not found');
    });

    it('returns 500 when deleteUserBudget throws a DB error', async () => {
      vi.mocked(deleteUserBudget).mockRejectedValueOnce(new Error('DB down'));
      const res = await app.request('/admin/users/user-42', {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(500);
    });
  });
});
