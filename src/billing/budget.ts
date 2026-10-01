/**
 * Budget enforcement middleware.
 * A run is budget-gated at its first call. Once admitted it may finish: a paid run is
 * never re-checked, and a free/trial run is re-checked against budget plus a bounded
 * allowance. Requests with no X-Dassi-Run-Id header keep the legacy per-call behavior.
 *
 * Design: Fail closed — if the budget check fails (DB error), reject the request
 * to prevent runaway spend. This is intentional.
 */

import type { MiddlewareHandler } from 'hono';
import { getUserBudget, hasPaidSubscription } from '../db/queries.js';
import { admittedOverrunUsd, admitRun } from './run-admission.js';

/**
 * Plan base at or below this (USD) is a free/trial user — the small starter grant
 * ($2–$5); the cheapest paid tier (Starter) is $50.
 */
const FREE_TIER_PLAN_BASE_CEILING = 10;

/**
 * USD a free/trial account may spend past its budget so the run that crosses it can
 * finish (200 credits). The ceiling is on the account's total spend, so a runaway loop or
 * concurrent runs share it and stop at budget + this amount.
 */
export const TRIAL_RUN_OVERRUN_USD = 2;

/**
 * Require a current paid subscription for premium provider routes.
 * Runs before budget admission so an admitted run cannot bypass a downgrade.
 * @param c - Hono context with the authenticated userId.
 * @param next - Budget and provider middleware, invoked only for paid accounts.
 * @returns 403 for unpaid accounts or 503 when eligibility cannot be verified.
 */
export const paidModelMiddleware: MiddlewareHandler = async (c, next) => {
  try {
    if (!(await hasPaidSubscription(c.get('userId') as string))) {
      return c.json({ error: 'Dassi Pro requires an active paid subscription. Choose Dassi Flash or Dassi Lite.' }, 403);
    }
  } catch {
    return c.json({ error: 'Unable to verify paid model access. Please try again.' }, 503);
  }
  await next();
};

/**
 * Budget check middleware.
 *
 * Gates a run's FIRST call on the user's spend vs budget, then admits the run so it can
 * finish: a paid run is never re-checked, and a free/trial run may spend up to
 * {@link TRIAL_RUN_OVERRUN_USD} past the budget before it is stopped. A new run is only
 * admitted while spend is under budget. Requests without an `X-Dassi-Run-Id` header keep
 * legacy per-call enforcement.
 *
 * @param c - Hono context; requires `userId` set by auth, reads the `X-Dassi-Run-Id` header.
 * @param next - Downstream handler, invoked only when the request is allowed.
 * @returns 402 when budget is exceeded, 403 when the user has no budget record, else void.
 */
export const budgetMiddleware: MiddlewareHandler = async (c, next) => {
  const userId = c.get('userId') as string;
  const runId = c.req.header('x-dassi-run-id');

  try {
    const overrunUsd = runId ? admittedOverrunUsd(userId, runId) : null;
    if (overrunUsd === Infinity) {
      await next();
      return;
    }

    const budget = await getUserBudget(userId);

    if (!budget) {
      return c.json({ error: 'No budget record found. Please set up billing.' }, 403);
    }

    if (budget.spend >= budget.budget + (overrunUsd ?? 0)) {
      return c.json({ error: 'Budget exceeded' }, 402);
    }

    if (budget.memberBlocked) {
      return c.json({ error: 'Member limit reached' }, 402);
    }

    if (runId && overrunUsd === null) {
      const allowance = budget.planBase > FREE_TIER_PLAN_BASE_CEILING ? Infinity : TRIAL_RUN_OVERRUN_USD;
      admitRun(userId, runId, Date.now(), allowance);
    }

    await next();
  } catch (error) {
    // Reason: Fail closed — reject request if budget check fails to prevent runaway spend.
    // Only log error.message to avoid leaking DATABASE_URL from postgres.js errors.
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Budget check failed for user ${userId}: ${msg}`);
    return c.json({ error: 'Budget check failed. Please try again.' }, 503);
  }
};
