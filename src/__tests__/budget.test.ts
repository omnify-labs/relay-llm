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

import { budgetMiddleware } from '../billing/budget.js';
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
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 10 });
    const app = buildTestApp();

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('rejects with 402 when spend equals budget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 25 });
    const app = buildTestApp();

    const res = await app.request('/test');
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('Budget exceeded');
  });

  it('rejects with 402 when spend exceeds budget', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 15 });
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
    mockGetUserBudget.mockResolvedValueOnce({ budget: 100, spend: 0 });
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
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 10 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-1' } });
    expect(res.status).toBe(200);
  });

  it('admits a run under budget so the first call passes and it is tracked', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 25, spend: 10 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-hr' } });
    expect(res.status).toBe(200);
    expect(isRunAdmitted('user-42', 'run-hr')).toBe(true);
  });

  it('does NOT admit a run that was refused with 402', async () => {
    // Reason: admission must happen only AFTER the spend >= budget check passes. A
    // mutant that admits before the check would leave a refused run admitted, so its
    // next call would bypass the gate — the exact bug this test exists to catch.
    mockGetUserBudget.mockResolvedValueOnce({ budget: 5, spend: 5 });
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
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 15 });
    const app = buildTestApp();
    const res = await app.request('/test', { headers: { 'X-Dassi-Run-Id': 'run-2' } });
    expect(res.status).toBe(402);
  });

  it('keeps legacy per-call behavior when no run-id header is present', async () => {
    mockGetUserBudget.mockResolvedValueOnce({ budget: 10, spend: 15 });
    const app = buildTestApp();
    const res = await app.request('/test');
    expect(res.status).toBe(402);
  });
});
