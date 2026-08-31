/**
 * Usage logging.
 * Records token usage per request to Postgres.
 * Runs asynchronously — never blocks the response stream.
 */

import { insertUsageLog, incrementUserSpend } from '../db/queries.js';
import { calculateCostMicroUsd, safeTokenCount } from './pricing.js';
import { chargeRun } from './run-admission.js';
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
  /** Run id from X-Dassi-Run-Id, or null for a request with no run. Debits admission headroom. */
  runId?: string | null;
}

/**
 * Log usage for a completed request.
 * Calculates cost and writes to both usage_logs and user_budgets (spend increment).
 *
 * Spend increment and usage log are written independently with separate retries.
 * Reason: They must not share a retry loop — if incrementUserSpend succeeds but
 * insertUsageLog fails, retrying both would double-charge the user.
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

  // Reason: debit the run's admission headroom by this request's cost regardless of the
  // DB writes below — the request was served and the cost incurred, so the in-memory
  // budget bound must shrink even if the ledger write later fails. Drops the run once
  // its headroom is spent so the next call is re-gated. No-op without a runId.
  if (record.runId) chargeRun(record.userId, record.runId, costMicroUsd);

  // Run both independently so a failure in one doesn't block or duplicate the other
  const [spendResult, logResult] = await Promise.allSettled([
    retryAsync(() => incrementUserSpend(record.userId, costMicroUsd), 3),
    retryAsync(
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
    ),
  ]);

  if (spendResult.status === 'fulfilled' && logResult.status === 'fulfilled') {
    console.log(
      `[Relay] Usage logged: user=${record.userId.slice(0, 8)} provider=${record.provider} model=${record.model} ` +
        `in=${inputTokens} cached=${cachedInputTokens} out=${outputTokens} cost=$${(costMicroUsd / 1e6).toFixed(6)} latency=${record.latencyMs}ms`,
    );
  } else {
    if (spendResult.status === 'rejected') {
      const msg = spendResult.reason instanceof Error ? spendResult.reason.message : 'Unknown error';
      console.error(`[Relay] Failed to increment spend after 3 attempts: ${msg}`);
    }
    if (logResult.status === 'rejected') {
      const msg = logResult.reason instanceof Error ? logResult.reason.message : 'Unknown error';
      console.error(`[Relay] Failed to insert usage log after 3 attempts: ${msg}`);
    }
  }
}

/**
 * Retry an async operation with exponential backoff (100ms, 200ms, 400ms).
 *
 * @param fn - Async function to retry
 * @param maxAttempts - Maximum number of attempts
 */
async function retryAsync(fn: () => Promise<void>, maxAttempts: number): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}
