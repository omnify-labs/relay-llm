/**
 * Database queries for usage logging and budget enforcement.
 */

import { getDb } from './client.js';

export interface UserBudget {
  spend: number;
  budget: number;
}

export interface UsageLogInsert {
  userId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /** Request cost in integer micro-USD (1e-6 $) — converted to USD in SQL. */
  costMicroUsd: number;
  requestId: string;
  latencyMs: number;
  statusCode: number;
}

/**
 * Get a user's current spend and budget from user_budgets table.
 * Returns null if user has no budget record.
 *
 * @param userId - User ID from JWT sub claim
 * @returns Budget record or null
 */
export async function getUserBudget(userId: string): Promise<UserBudget | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT budget, spend
    FROM user_budgets
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    budget: parseFloat(rows[0].budget) || 0,
    spend: parseFloat(rows[0].spend) || 0,
  };
}

/**
 * Outcome of recordUsage: the request was charged now; it had already been recorded
 * (and charged) earlier; or it was recorded but the user has no user_budgets row to
 * charge — the row is kept so the request is never billed later either.
 */
export type RecordUsageOutcome = 'charged' | 'replay' | 'uncharged';

/**
 * Record a request's usage AND charge it, atomically, exactly once.
 *
 * One statement: the usage_logs INSERT (unique on request_id — the idempotency key)
 * and the user_budgets spend UPDATE run in the same transaction, and the UPDATE is
 * gated on the INSERT having actually inserted a row. So:
 *   - first attempt: row + charge commit together;
 *   - retry after a lost ack: the INSERT conflicts, inserts nothing, the UPDATE is
 *     skipped → 'replay', and nothing is charged twice;
 *   - a failure anywhere rolls back both → nothing is half-applied.
 * Two separate writes (the previous design) could never distinguish a lost ack from
 * a failure and either double-charged or silently under-charged.
 *
 * @param record - Usage data to log; costMicroUsd is the integer micro-USD charge.
 * @returns 'charged' when this call inserted the row and charged spend; 'replay' when
 *   the request_id was already recorded (and therefore already charged); 'uncharged'
 *   when the row was inserted but no user_budgets row exists to charge.
 */
export async function recordUsage(record: UsageLogInsert): Promise<RecordUsageOutcome> {
  const sql = getDb();
  // Reason: trunc(…, 6) keeps the "never round up" guarantee explicit; the /1000000
  // division is exact in NUMERIC (see the 2026-08-25 spend precision migration).
  const rows = await sql`
    WITH ins AS (
      INSERT INTO usage_logs (
        user_id, provider, model,
        input_tokens, output_tokens, total_tokens,
        cached_input_tokens, cache_creation_tokens,
        cost_usd, request_id, latency_ms, status_code
      ) VALUES (
        ${record.userId}, ${record.provider}, ${record.model},
        ${record.inputTokens}, ${record.outputTokens}, ${record.totalTokens},
        ${record.cachedInputTokens}, ${record.cacheCreationTokens},
        ${record.costMicroUsd}::numeric / 1000000, ${record.requestId}, ${record.latencyMs}, ${record.statusCode}
      )
      ON CONFLICT (request_id) DO NOTHING
      RETURNING id
    ),
    charged AS (
      UPDATE user_budgets
      SET spend = spend + trunc(${record.costMicroUsd}::numeric / 1000000, 6), updated_at = NOW()
      WHERE user_id = ${record.userId} AND EXISTS (SELECT 1 FROM ins)
      RETURNING user_id
    )
    SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT count(*) FROM charged) AS charged
  `;
  const row = rows[0];
  // The outer SELECT always yields exactly one row; anything else is a driver fault
  // and must surface as a failure (retried, then logged), never as a silent 'replay'.
  if (!row) throw new Error('recordUsage returned no rows');
  if (Number(row.inserted) === 0) return 'replay';
  return Number(row.charged) > 0 ? 'charged' : 'uncharged';
}

/**
 * Set or create a user's budget. Optionally reset spend to 0.
 * Uses upsert — creates the record if it doesn't exist.
 *
 * @param userId - User ID
 * @param budget - Budget ceiling in USD
 * @param resetSpend - If true, resets spend to 0 (for subscription renewal)
 * @returns True if the record was created or updated
 */
export async function setUserBudget(
  userId: string,
  budget: number,
  resetSpend: boolean,
): Promise<boolean> {
  const sql = getDb();
  if (resetSpend) {
    const result = await sql`
      INSERT INTO user_budgets (user_id, budget, spend)
      VALUES (${userId}, ${budget}, 0)
      ON CONFLICT (user_id) DO UPDATE
      SET budget = ${budget}, spend = 0, updated_at = NOW()
      RETURNING user_id
    `;
    return result.length > 0;
  } else {
    const result = await sql`
      INSERT INTO user_budgets (user_id, budget)
      VALUES (${userId}, ${budget})
      ON CONFLICT (user_id) DO UPDATE
      SET budget = ${budget}, updated_at = NOW()
      RETURNING user_id
    `;
    return result.length > 0;
  }
}

/** Post-increment ledger state, plus whether THIS call applied the delta. */
export interface BudgetIncrementResult {
  /** False when the idempotency key had already been applied (a replay). */
  applied: boolean;
  budget: number;
  spend: number;
}

/**
 * Raise a user's budget by an integer number of cents, exactly once per
 * idempotency key (a purchase's Stripe payment_intent).
 *
 * One statement: the key is claimed in budget_increments (`ON CONFLICT DO NOTHING`)
 * and the user_budgets upsert is fed FROM that claim, so a replayed key inserts
 * nothing, adds nothing, and still returns the current ledger — the caller (a
 * Stripe webhook that will be redelivered) can retry freely. Cents become dollars
 * once, inside SQL, so no float ever carries the amount. A user with no budget row
 * gets one holding just the delta.
 *
 * @param userId - User whose budget grows.
 * @param deltaCents - Positive integer cents to add.
 * @param idempotencyKey - Unique per purchase; a repeat is a no-op.
 * @returns Post-increment budget/spend and whether this call applied the delta.
 */
export async function incrementUserBudget(
  userId: string,
  deltaCents: number,
  idempotencyKey: string,
): Promise<BudgetIncrementResult> {
  const sql = getDb();
  const rows = await sql`
    WITH ins AS (
      INSERT INTO budget_increments (idempotency_key, user_id, delta_cents)
      VALUES (${idempotencyKey}, ${userId}, ${deltaCents})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING delta_cents
    ),
    applied AS (
      INSERT INTO user_budgets (user_id, budget, spend)
      SELECT ${userId}, delta_cents::numeric / 100, 0 FROM ins
      ON CONFLICT (user_id) DO UPDATE
      SET budget = user_budgets.budget + EXCLUDED.budget, updated_at = NOW()
      RETURNING budget, spend
    )
    SELECT
      (SELECT count(*) FROM ins) AS applied,
      COALESCE((SELECT budget FROM applied), (SELECT budget FROM user_budgets WHERE user_id = ${userId})) AS budget,
      COALESCE((SELECT spend FROM applied), (SELECT spend FROM user_budgets WHERE user_id = ${userId})) AS spend
  `;
  const row = rows[0];
  if (!row) throw new Error('incrementUserBudget returned no rows');
  return {
    applied: Number(row.applied) > 0,
    budget: parseFloat(row.budget) || 0,
    spend: parseFloat(row.spend) || 0,
  };
}

/**
 * Delete a user's budget record.
 *
 * @param userId - User ID to remove
 * @returns True if the record existed and was deleted
 */
export async function deleteUserBudget(userId: string): Promise<boolean> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM user_budgets
    WHERE user_id = ${userId}
    RETURNING user_id
  `;
  return result.length > 0;
}
