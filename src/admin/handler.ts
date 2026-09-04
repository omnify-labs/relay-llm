/**
 * Admin API handlers for managing user budgets.
 * All routes require RELAY_ADMIN_SECRET auth (handled by admin middleware).
 */

import { Hono } from 'hono';
import { setUserBudget, deleteUserBudget, incrementUserBudget } from '../db/queries.js';
import { revokeUser } from '../billing/run-admission.js';

export const adminApp = new Hono();

/**
 * PUT /users/:user_id/budget — Set or reset a user's PLAN budget.
 * Request body: { budget: number, reset_spend?: boolean }
 * Response: 200 { user_id: string, updated: true }
 *
 * @remarks Uses upsert — creates the budget record if it doesn't exist. `budget` is
 * the plan base; purchased credit (budget/increment) is kept on top of it, and a
 * reset first draws the over-base spend down from those purchases.
 */
adminApp.put('/users/:user_id/budget', async (c) => {
  const userId = c.req.param('user_id');
  let body: { budget: number; reset_spend?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.budget !== 'number' || !Number.isFinite(body.budget) || body.budget < 0) {
    return c.json({ error: 'Invalid budget: must be a non-negative number' }, 400);
  }

  try {
    await setUserBudget(userId, body.budget, body.reset_spend ?? false);
    // Reason: drop any in-flight run admission so the new budget is enforced on the
    // user's very next call. An admitted run skips the budget check until it ends (its
    // window slides while it is alive), so lowering a budget to halt spend would
    // otherwise not bite until the run finished.
    revokeUser(userId);

    console.log(
      `[Relay] Admin: set budget for user=${userId} budget=$${body.budget} reset_spend=${body.reset_spend ?? false}`,
    );

    return c.json({ user_id: userId, updated: true });
  } catch (error) {
    // Reason: Only log error.message, not the full object — DB driver errors
    // can contain the DATABASE_URL connection string with credentials.
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Admin: failed to set budget for user ${userId}: ${msg}`);
    return c.json({ error: 'Failed to set budget' }, 500);
  }
});

/**
 * POST /users/:user_id/budget/increment — Add purchased credit to a user's budget.
 * Request body: { delta_cents: number, idempotency_key: string }
 * Response: 200 { user_id, applied, budget, spend }
 *
 * @remarks Increment semantics, not absolute: it composes with concurrent spend and
 * with the monthly reset. Exactly-once per idempotency_key — a replay returns 200 with
 * `applied: false` and the current ledger, so the caller may retry until acknowledged.
 * Deliberately does NOT revoke admissions: a larger budget never needs to interrupt
 * a run, and a run the gate refused simply re-checks on its next admission.
 */
adminApp.post('/users/:user_id/budget/increment', async (c) => {
  const userId = c.req.param('user_id');
  let body: { delta_cents?: unknown; idempotency_key?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const delta = body.delta_cents;
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta <= 0) {
    return c.json({ error: 'Invalid delta_cents: must be a positive integer' }, 400);
  }
  const key = body.idempotency_key;
  if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
    return c.json({ error: 'Invalid idempotency_key: must be a non-empty string (max 255)' }, 400);
  }

  try {
    const result = await incrementUserBudget(userId, delta, key);
    console.log(
      `[Relay] Admin: increment budget for user=${userId} delta_cents=${delta} key=${key} applied=${result.applied} budget=$${result.budget}`,
    );
    return c.json({ user_id: userId, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Admin: failed to increment budget for user ${userId}: ${msg}`);
    return c.json({ error: 'Failed to increment budget' }, 500);
  }
});

/**
 * DELETE /users/:user_id — Remove a user's budget record.
 * Response: 200 { user_id: string, deleted: true }
 */
adminApp.delete('/users/:user_id', async (c) => {
  const userId = c.req.param('user_id');

  try {
    const deleted = await deleteUserBudget(userId);

    // Reason: revoke regardless of `deleted` — the goal is that no admission outlives
    // the record. A 404 here means there was no budget row, but a stale admission for
    // that id must still not keep skipping the budget check.
    revokeUser(userId);

    if (!deleted) {
      return c.json({ error: 'User not found' }, 404);
    }

    console.log(`[Relay] Admin: deleted budget for user=${userId}`);

    return c.json({ user_id: userId, deleted: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Admin: failed to delete budget for user ${userId}: ${msg}`);
    return c.json({ error: 'Failed to delete user budget' }, 500);
  }
});
