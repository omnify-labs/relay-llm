/**
 * Budget enforcement middleware.
 * Checks per-user spend against their budget before forwarding requests.
 *
 * Design: Fail closed — if the budget check fails (DB error), reject the request
 * to prevent runaway spend. This is intentional.
 */

import type { MiddlewareHandler } from 'hono';
import { getUserBudget } from '../db/queries.js';

/**
 * Budget check middleware.
 * Queries the user's current spend and budget.
 * Rejects with 402 if budget exceeded, 403 if no budget record.
 */
export const budgetMiddleware: MiddlewareHandler = async (c, next) => {
  const userId = c.get('userId') as string;

  try {
    const budget = await getUserBudget(userId);

    if (!budget) {
      return c.json({ error: 'No budget record found. Please set up billing.' }, 403);
    }

    if (budget.spend >= budget.budget) {
      return c.json({ error: 'Budget exceeded' }, 402);
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
