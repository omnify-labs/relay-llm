/**
 * Budget enforcement middleware.
 * Per-RUN enforcement: a run is budget-gated once at its first call, then its
 * subsequent calls pass without re-checking (no mid-task 402). Requests with
 * no X-Dassi-Run-Id header keep the legacy per-call behavior.
 *
 * Design: Fail closed — if the budget check fails (DB error), reject the request
 * to prevent runaway spend. This is intentional.
 */

import type { MiddlewareHandler } from 'hono';
import { getUserBudget } from '../db/queries.js';
import { isRunAdmitted, admitRun } from './run-admission.js';

/**
 * Budget check middleware.
 *
 * Gates a run's FIRST call on the user's spend vs budget, then admits the rest of that
 * run without re-checking, so a task is never interrupted mid-flight when credit runs
 * out. Requests without an `X-Dassi-Run-Id` header keep legacy per-call enforcement.
 *
 * @param c - Hono context; requires `userId` set by auth, reads the `X-Dassi-Run-Id` header.
 * @param next - Downstream handler, invoked only when the request is allowed.
 * @returns 402 when budget is exceeded, 403 when the user has no budget record, else void.
 */
export const budgetMiddleware: MiddlewareHandler = async (c, next) => {
  const userId = c.get('userId') as string;
  const runId = c.req.header('x-dassi-run-id');

  try {
    // Reason: in-flight admitted run — allow without re-checking budget so a task is
    // never interrupted mid-run once it has been admitted.
    if (runId && isRunAdmitted(userId, runId)) {
      await next();
      return;
    }

    const budget = await getUserBudget(userId);

    if (!budget) {
      return c.json({ error: 'No budget record found. Please set up billing.' }, 403);
    }

    if (budget.spend >= budget.budget) {
      return c.json({ error: 'Budget exceeded' }, 402);
    }

    // Reason: new run (or one whose idle window lapsed) with budget available — admit it so
    // the rest of THIS run is not interrupted mid-task. It stays admitted until it ends
    // (endRun) or idles out; the gate lands on the NEXT run's first call.
    if (runId) admitRun(userId, runId);

    await next();
  } catch (error) {
    // Reason: Fail closed — reject request if budget check fails to prevent runaway spend.
    // Only log error.message to avoid leaking DATABASE_URL from postgres.js errors.
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Budget check failed for user ${userId}: ${msg}`);
    return c.json({ error: 'Budget check failed. Please try again.' }, 503);
  }
};
