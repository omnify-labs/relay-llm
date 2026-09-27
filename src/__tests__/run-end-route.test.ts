import { describe, it, expect, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';
import { runRoutes } from '../billing/run-routes.js';
import {
  admitRun,
  isRunAdmitted,
  __resetAdmissionsForTests,
  admissionCountForTests,
} from '../billing/run-admission.js';

/**
 * Mounts the REAL runRoutes sub-app (the same object index.ts mounts) behind a stub
 * auth middleware that sets userId — so wiring drift in run-routes.ts (a dropped
 * handler, a changed userId source) fails here, unlike a re-implemented handler.
 */
function buildApp(authUserId: string) {
  const app = new Hono();
  app.use('/v1/runs/*', async (c: Context, next) => {
    c.set('userId', authUserId);
    await next();
  });
  app.route('/', runRoutes);
  return app;
}
const TTL = 1_800_000;

beforeEach(() => __resetAdmissionsForTests());

describe('POST /v1/runs/:runId/end (real route)', () => {
  it('ends the caller\'s run and returns 200', async () => {
    admitRun('user-1', 'run-a');
    const res = await buildApp('user-1').request('/v1/runs/run-a/end', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });
    expect(isRunAdmitted('user-1', 'run-a')).toBe(false);
  });

  it('is idempotent for an unknown run (still 200)', async () => {
    const res = await buildApp('user-1').request('/v1/runs/ghost/end', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('cannot end another user\'s run', async () => {
    admitRun('user-2', 'run-shared');
    await buildApp('user-1').request('/v1/runs/run-shared/end', { method: 'POST' });
    expect(isRunAdmitted('user-2', 'run-shared')).toBe(true);
  });
});

describe('POST /v1/runs/:runId/keepalive (real route)', () => {
  it('refreshes an admitted run and reports alive:true', async () => {
    admitRun('user-1', 'run-a');
    const res = await buildApp('user-1').request('/v1/runs/run-a/keepalive', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alive: true });
    expect(isRunAdmitted('user-1', 'run-a')).toBe(true);
  });

  it('never admits: an unknown run stays unadmitted and reports alive:false', async () => {
    // Reason: THE gate-bypass check — a client must not be able to conjure an
    // admission by pinging keepalive with a fresh id.
    const res = await buildApp('user-1').request('/v1/runs/never-admitted/keepalive', { method: 'POST' });
    expect(await res.json()).toEqual({ alive: false });
    expect(isRunAdmitted('user-1', 'never-admitted')).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });

  it('is scoped to the caller (cannot keep another user\'s run alive)', async () => {
    admitRun('user-2', 'run-x', 0);
    const res = await buildApp('user-1').request('/v1/runs/run-x/keepalive', { method: 'POST' });
    expect(await res.json()).toEqual({ alive: false });
    // user-2's run is untouched (still on its original clock: alive at TTL-1 only).
    expect(isRunAdmitted('user-2', 'run-x', TTL - 1)).toBe(true);
  });
});
