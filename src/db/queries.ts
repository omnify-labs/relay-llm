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
 * Insert a usage log record.
 *
 * @param record - Usage data to log
 */
export async function insertUsageLog(record: UsageLogInsert): Promise<void> {
  const sql = getDb();
  await sql`
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
  `;
}

/**
 * Increment a user's spend by a given amount.
 * Uses atomic SQL increment to avoid race conditions.
 *
 * @param userId - User ID from JWT sub claim
 * @param costMicroUsd - Amount in integer micro-USD (1e-6 $) to add to spend
 */
export async function incrementUserSpend(userId: string, costMicroUsd: number): Promise<void> {
  const sql = getDb();
  // Reason: trunc(…, 4) rounds each charge DOWN to the ledger's $0.0001 quantum —
  // an explicit user-favoring policy, replacing the implicit half-up rounding the
  // NUMERIC(10,4) column would otherwise apply on store. The /1000000 division is
  // exact (power of ten) in NUMERIC.
  await sql`
    UPDATE user_budgets
    SET spend = spend + trunc(${costMicroUsd}::numeric / 1000000, 4), updated_at = NOW()
    WHERE user_id = ${userId}
  `;
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
