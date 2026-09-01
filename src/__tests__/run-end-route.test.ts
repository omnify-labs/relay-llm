import { describe, it, expect, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';
import {
  admitRun,
  isRunAdmitted,
  endRun,
  __resetAdmissionsForTests,
} from '../billing/run-admission.js';

/**
 * Route wiring for POST /v1/runs/:runId/end. Mirrors index.ts (a stub auth middleware
 * stands in for authMiddleware, which sets userId); the handler body is identical, so
 * this pins param extraction, user scoping, and the endRun call.
 */
function buildApp(authUserId: string | null) {
  const app = new Hono();
  app.post('/v1/runs/:runId/end', async (c: Context, next) => {
    if (authUserId) c.set('userId', authUserId);
    await next();
  }, (c: Context) => {
    const userId = c.get('userId') as string;
    const runId = c.req.param('runId');
    if (!runId) return c.json({ error: 'Missing runId' }, 400);
    endRun(userId, runId);
    return c.json({ ended: true });
  });
  return app;
}

beforeEach(() => __resetAdmissionsForTests());

describe('POST /v1/runs/:runId/end', () => {
  it('ends the caller\'s run and returns 200', async () => {
    admitRun('user-1', 'run-a', 0);
    expect(isRunAdmitted('user-1', 'run-a', 0)).toBe(true);

    const res = await buildApp('user-1').request('/v1/runs/run-a/end', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });
    expect(isRunAdmitted('user-1', 'run-a', 0)).toBe(false);
  });

  it('is idempotent for an already-ended run (still 200)', async () => {
    const res = await buildApp('user-1').request('/v1/runs/ghost/end', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('cannot end another user\'s run (scoped to the JWT user)', async () => {
    admitRun('user-2', 'run-shared', 0);
    const res = await buildApp('user-1').request('/v1/runs/run-shared/end', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(isRunAdmitted('user-2', 'run-shared', 0)).toBe(true); // untouched
  });
});
