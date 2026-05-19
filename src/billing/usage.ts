/**
 * Usage logging.
 * Records token usage per request to Postgres.
 * Runs asynchronously — never blocks the response stream.
 */

import { insertUsageLog, incrementUserSpend } from '../db/queries.js';
import { calculateCost } from './pricing.js';
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
  /**
   * When true the request is an audio transcription (e.g. Whisper).
   * Whisper responses carry no `usage` object, so token fields are meaningless.
   * Cost is logged as 0 for v1 (acceptable accounting gap; supplemented via audit log).
   */
  isTranscription?: boolean;
}

/**
 * Log usage for a completed request.
 * Calculates cost and writes to both usage_logs and user_budgets (spend increment).
 *
 * Spend increment and usage log are written independently with separate retries.
 * Reason: They must not share a retry loop — if incrementUserSpend succeeds but
 * insertUsageLog fails, retrying both would double-charge the user.
 *
 * Transcription requests (isTranscription=true) bypass token-based cost calculation
 * and log costUsd=0. Reason: Whisper responses contain only `{ text }` with no usage
 * object, so token counts are always 0. The spend increment is also 0 for v1.
 */
export async function logUsage(record: UsageRecord): Promise<void> {
  // Reason: Transcription models (Whisper) return { text } with no usage object.
  // Using token-based calculateCost would always produce $0.00 anyway since all
  // token counts are 0, but we skip the call explicitly to document the intent
  // and avoid relying on the DEFAULT_PRICING fallback for audio models.
  const costUsd = record.isTranscription
    ? 0
    : calculateCost(
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cachedInputTokens,
        record.cacheCreationTokens,
      );
  const totalTokens = record.inputTokens + record.outputTokens;

  // Run both independently so a failure in one doesn't block or duplicate the other
  const [spendResult, logResult] = await Promise.allSettled([
    retryAsync(() => incrementUserSpend(record.userId, costUsd), 3),
    retryAsync(
      () =>
        insertUsageLog({
          ...record,
          totalTokens,
          costUsd,
        }),
      3,
    ),
  ]);

  if (spendResult.status === 'fulfilled' && logResult.status === 'fulfilled') {
    const kind = record.isTranscription ? 'transcription' : 'chat';
    console.log(
      `[Relay] Usage logged (${kind}): user=${record.userId.slice(0, 8)} provider=${record.provider} model=${record.model} ` +
        `in=${record.inputTokens} cached=${record.cachedInputTokens} out=${record.outputTokens} cost=$${costUsd.toFixed(6)} latency=${record.latencyMs}ms`,
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
