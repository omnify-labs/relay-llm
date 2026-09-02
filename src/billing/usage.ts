/**
 * Usage logging.
 * Records token usage per request to Postgres.
 * Runs asynchronously — never blocks the response stream.
 */

import { recordUsage } from '../db/queries.js';
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
 * Log usage for a completed request and charge it — one atomic write, exactly once.
 *
 * `recordUsage` inserts the usage_logs row (unique on request_id) and increments spend
 * in the same statement, with the increment gated on the insert. A retry after a lost
 * ack therefore conflicts and charges nothing ('replay'); a failure rolls back both.
 *
 * Fail-open: nothing here throws. If the write cannot be made after 3 attempts the
 * request is neither logged nor charged; the only trace is the error log line.
 */
export async function logUsage(record: UsageRecord): Promise<void> {
  // Reason: sanitize the provider counts ONCE, here, and use the sanitized values for
  // BOTH the cost math and the audit row. usage_logs' token columns are INTEGER, so a
  // fractional/non-finite/string count would otherwise make the write fail.
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

  let outcome;
  try {
    outcome = await retryAsync(
      () =>
        recordUsage({
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
    console.error(`[Relay] Failed to record usage after 3 attempts (not logged, not charged): ${who}: ${msg}`);
    return;
  }

  if (outcome === 'replay') {
    // Reason: the earlier attempt's single statement committed row + charge together,
    // so this request is already charged. Charging again is the double-charge bug.
    console.warn(`[Relay] Usage replay ignored (already recorded and charged): ${who}`);
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
