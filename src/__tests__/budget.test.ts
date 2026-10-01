import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Unit tests for budget enforcement middleware.
 * Verifies fail-closed behavior, budget exceeded rejection, and no-record handling.
 */

const mockGetUserBudget = vi.fn();

vi.mock('../db/queries.js', () => ({
  getUserBudget: (...args: unknown[]) => mockGetUserBudget(...args),
}));

import { budgetMiddleware, TRIAL_RUN_OVERRUN_USD } from '../billing/budget.js';
import {
  admitRun,
  isRunAdmitted,
  __resetAdmissionsForTests,
} from '../billing/run-admission.js';

/**
 * Build a test app with budget middleware.
 * Sets userId on context to simulate prior auth middleware.
 */
function buildTestApp(): Hono {
  const app = new Hono();
  // Simulate auth middleware setting userId
  app.use('*', async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('userId', 'user-42');
    await next();
  });
  app.use('*', budgetMiddleware);
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  mockGetUserBudget.mockReset();
});

beforeEach(() => __resetAdmissionsForTests());

describe('budgetMiddleware', () => {
  it('allows request when spend is under budget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 10, planBase: 50, memberBlocked: false });
    const app = buildTestApp();

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('rejects with 402 when spend equals budget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 25, planBase: 50 });
    const app = buildTestApp();

    const res = await app.request('/test');
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('Budget exceeded');
  });

  it('rejects a member over their monthly limit with its own reason while the pool still has budget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 500, spend: 10, planBase: 500, memberBlocked: true });
    const res = await buildTestApp().request('/test');
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('Member limit reached');
  });

  it('reports the empty pool, not the member limit, when both apply', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 500, spend: 500, planBase: 500, memberBlocked: true });
    const res = await buildTestApp().request('/test');
    expect((await res.json()).error).toBe('Budget exceeded');
  });

  it('rejects with 402 when spend exceeds budget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 15, planBase: 50 });
    const app = buildTestApp();

    const res = await app.request('/test');
    expect(res.status).toBe(402);
  });

  it('rejects with 403 when user has no budget record', async () => {
    mockGetUserBudget.mockResolvedValueOnce(null);
    const app = buildTestApp();

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/No budget record found/);
  });

  it('rejects with 503 when DB query fails (fail-closed)', async () => {
    mockGetUserBudget.mockRejectedValueOnce(new Error('connection lost'));
    const app = buildTestApp();

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request('/test');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Budget check failed/);

    consoleSpy.mockRestore();
  });

  it('passes correct userId to getUserBudget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 100, spend: 0, planBase: 50 });
    const app = buildTestApp();

    await app.request('/test');
    expect(mockGetUserBudget).toHaveBeenCalledWith('user-42');
  });
});

/**
 * Build a test app that also forwards the X-Dassi-Run-Id header, so the
 * middleware sees run ids exactly as in production.
 */
describe('budgetMiddleware — per-run admission', () => {
  it('admits a new run when budget is available (first call passes)', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 10, planBase: 50 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-1' } });
    expect(res.status).toBe(200);
  });

  it('admits a run under budget so the first call passes and it is tracked', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 10, planBase: 50 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-hr' } });
    expect(res.status).toBe(200);
    expect(isRunAdmitted('user-42', 'run-hr')).toBe(true);
  });

  it('does NOT admit a run that was refused with 402', async () => {
    // Reason: admission must happen only AFTER the spend >= budget check passes. A
    // mutant that admits before the check would leave a refused run admitted, so its
    // next call would bypass the gate — the exact bug this test exists to catch.
    mockGetUserBudget.mockResolvedValueOnce({ budget: 5, spend: 5, planBase: 50 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-refused' } });
    expect(res.status).toBe(402);
    expect(isRunAdmitted('user-42', 'run-refused')).toBe(false);
  });

  it('bypasses the budget query for an already-admitted in-flight run', async () => {
    // Pre-admit the run; even though spend >= budget, the in-flight call must pass.
    admitRun('user-42', 'run-1');
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-1' } });
    expect(res.status).toBe(200);
    // The core guarantee: no budget check happened for the in-flight call.
    expect(mockGetUserBudget).not.toHaveBeenCalled();
  });

  it('blocks a NEW run at its first call when spend is exhausted', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 15, planBase: 50 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-2' } });
    expect(res.status).toBe(402);
  });

  it('keeps legacy per-call behavior when no run-id header is present', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 15, planBase: 50 });
    const app = buildTestApp();
    const res = await app.request('/test');
    expect(res.status).toBe(402);
  });
});

/**
 * Free/trial tier (plan base ≤ ceiling): a run admitted under budget may finish, but the
 * account's total spend stops at budget + TRIAL_RUN_OVERRUN_USD, so a runaway loop is still
 * bounded while a real user's crossing task is not cut off mid-run.
 */
describe('budgetMiddleware — free/trial bounded overrun', () => {
  const trial = (spend: number) => ({ budget: 2, spend, planBase: 2, memberBlocked: false });
  const call = (app: Hono, runId: string) => app.request('/test', { headers: { 'X-Dassi-Run-Id': runId } });

  it('lets the trial run that crosses its budget keep going within the allowance', async () => {
    const app = buildTestApp();
    mockGetUserBudget.mockResolvedValueOnce(trial(1.9));
    expect((await call(app, 'trial-run')).status).toBe(200);
    mockGetUserBudget.mockResolvedValueOnce(trial(2 + TRIAL_RUN_OVERRUN_USD - 0.01));
    expect((await call(app, 'trial-run')).status).toBe(200);
  });

  it('stops the same trial run once total spend reaches budget + allowance', async () => {
    const app = buildTestApp();
    mockGetUserBudget.mockResolvedValueOnce(trial(1.9));
    await call(app, 'trial-run');
    mockGetUserBudget.mockResolvedValueOnce(trial(2 + TRIAL_RUN_OVERRUN_USD));
    expect((await call(app, 'trial-run')).status).toBe(402);
  });

  it('re-checks every call of an admitted trial run against the database', async () => {
    const app = buildTestApp();
    mockGetUserBudget.mockResolvedValue(trial(1));
    await call(app, 'trial-run');
    await call(app, 'trial-run');
    expect(mockGetUserBudget).toHaveBeenCalledTimes(2);
  });

  it('refuses a NEW trial run while over budget, even with another run still in its allowance', async () => {
    const app = buildTestApp();
    mockGetUserBudget.mockResolvedValueOnce(trial(1.9));
    await call(app, 'first-run');
    mockGetUserBudget.mockResolvedValueOnce(trial(2.5));
    expect((await call(app, 'second-run')).status).toBe(402);
    expect(isRunAdmitted('user-42', 'second-run')).toBe(false);
  });

  it('treats a plan base exactly at the ceiling as trial: bounded, not unlimited', async () => {
    const app = buildTestApp();
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 0, planBase: 10, memberBlocked: false });
    await call(app, 'edge-run');
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 10 + TRIAL_RUN_OVERRUN_USD, planBase: 10, memberBlocked: false });
    expect((await call(app, 'edge-run')).status).toBe(402);
  });

  it('a paid run keeps the unlimited grace: admitted, then never re-checked', async () => {
    const app = buildTestApp();
    mockGetUserBudget.mockResolvedValueOnce({ budget: 200, spend: 10, planBase: 200, memberBlocked: false });
    expect((await call(app, 'paid-run')).status).toBe(200);
    expect((await call(app, 'paid-run')).status).toBe(200);
    expect(mockGetUserBudget).toHaveBeenCalledTimes(1);
  });
});
