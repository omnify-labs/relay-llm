/**
 * Admin API handlers for managing user budgets.
 * All routes require RELAY_ADMIN_SECRET auth (handled by admin middleware).
 */

import { Hono } from 'hono';
import { setUserBudget, deleteUserBudget } from '../db/queries.js';

export const adminApp = new Hono();

/**
 * PUT /users/:user_id/budget — Set or reset a user's budget.
 * Request body: { budget: number, reset_spend?: boolean }
 * Response: 200 { user_id: string, updated: true }
 *
 * @remarks Uses upsert — creates the budget record if it doesn't exist.
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
 * DELETE /users/:user_id — Remove a user's budget record.
 * Response: 200 { user_id: string, deleted: true }
 */
adminApp.delete('/users/:user_id', async (c) => {
  const userId = c.req.param('user_id');

  try {
    const deleted = await deleteUserBudget(userId);

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
