/**
 * Usage logging.
 * Records token usage per request to Postgres.
 * Runs asynchronously — never blocks the response stream.
 */

import { insertUsageLog, incrementUserSpend } from '../db/queries.js';
import { calculateCostMicroUsd, safeTokenCount } from './pricing.js';
import type { ProviderName } from '../proxy/providers.js';

export interface UsageRecord {
  userId: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  requestId: string;
  latencyMs: number;
  statusCode: number;
}

/**
 * Log usage for a completed request.
 * Writes the usage_logs row, then increments user_budgets.spend — and only then.
 *
 * The usage_logs row is the per-request idempotency record: its request_id is unique,
 * so a retried insert after a lost ack conflicts and inserts nothing, and the spend
 * increment is skipped. That is what makes billing exactly-once per request. (The
 * previous design ran both writes independently with separate retries, which could
 * not tell a lost ack from a failure and double-charged on retry.)
 *
 * Fail-open: nothing here throws. A request whose row cannot be inserted is not
 * charged either — spend and audit stay consistent, and the gap is reconcilable from
 * usage_logs rather than a silent overcharge.
 */
export async function logUsage(record: UsageRecord): Promise<void> {
  // Reason: sanitize the provider counts ONCE, here, and use the sanitized values for
  // BOTH the cost math and the audit row. usage_logs' token columns are INTEGER, so a
  // fractional/non-finite/string count would otherwise let the spend increment succeed
  // (it uses the cost, which sanitizes internally) while the INSERT fails — charging
  // the user but losing the audit row.
  const inputTokens = safeTokenCount(record.inputTokens);
  const outputTokens = safeTokenCount(record.outputTokens);
  const cachedInputTokens = safeTokenCount(record.cachedInputTokens);
  const cacheCreationTokens = safeTokenCount(record.cacheCreationTokens);

  // Reason: billing math stays in integer micro-USD end-to-end; the only float
  // rendering of this value is the log line below. Number() is safe — µ$ amounts
  // are far below 2^53.
  const costMicroUsd = Number(
    calculateCostMicroUsd(record.model, inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens),
  );
  const totalTokens = inputTokens + outputTokens;
  const who = `user=${record.userId.slice(0, 8)} request=${record.requestId}`;

  let inserted: boolean;
  try {
    inserted = await retryAsync(
      () =>
        insertUsageLog({
          ...record,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheCreationTokens,
          totalTokens,
          costMicroUsd,
        }),
      3,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Failed to insert usage log after 3 attempts (not charged): ${who}: ${msg}`);
    return;
  }

  if (!inserted) {
    // Reason: a replay — this request_id was already logged (and charged) by an
    // earlier attempt whose ack we lost. Charging again is the double-charge bug.
    console.warn(`[Relay] Usage log replay ignored (already charged): ${who}`);
    return;
  }

  try {
    await retryAsync(() => incrementUserSpend(record.userId, costMicroUsd), 3);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Relay] Failed to increment spend after 3 attempts (row logged): ${who}: ${msg}`);
    return;
  }

  console.log(
    `[Relay] Usage logged: user=${record.userId.slice(0, 8)} provider=${record.provider} model=${record.model} ` +
      `in=${inputTokens} cached=${cachedInputTokens} out=${outputTokens} cost=$${(costMicroUsd / 1e6).toFixed(6)} latency=${record.latencyMs}ms`,
  );
}

/**
 * Retry an async operation with exponential backoff (100ms, 200ms, 400ms).
 *
 * @param fn - Async function to retry
 * @param maxAttempts - Maximum number of attempts
 */
async function retryAsync<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}
