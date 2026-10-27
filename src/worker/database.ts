import postgres from 'postgres';
import type { Hyperdrive } from '@cloudflare/workers-types';
import {
  DEFAULT_ADMISSION_TTL_MS,
  FREE_TIER_PLAN_BASE_CEILING,
  MAX_ADMITTED_RUNS_PER_USER,
  TRIAL_RUN_OVERRUN_USD,
} from '../billing/policy.js';
import { calculateCostMicroUsd, safeTokenCount } from '../billing/pricing.js';
import { recordUsage } from '../db/queries.js';
import type { UsageObservation } from '../proxy/handler.js';

/** Hyperdrive owns pooling; clients and sockets belong to a single invocation. */
export function connect(binding: Hyperdrive): postgres.Sql {
  return postgres(binding.connectionString, { max: 1, fetch_types: false, connect_timeout: 10 });
}

/** Serialize admission with billing writes in one database operation. */
export async function authorize(
  sql: postgres.Sql,
  userId: string,
  runId: string | null,
  provider: string,
  requestId: string,
): Promise<string> {
  const rows =
    await sql`SELECT relay_internal.authorize(${userId}, ${runId}, ${provider}, ${requestId}::uuid,
    ${DEFAULT_ADMISSION_TTL_MS}, ${MAX_ADMITTED_RUNS_PER_USER}, ${FREE_TIER_PLAN_BASE_CEILING}, ${TRIAL_RUN_OVERRUN_USD}) AS result`;
  if (!rows[0]?.result) throw new Error('Missing admission result');
  return rows[0].result;
}

/** End or refresh only the authenticated caller's existing run. */
export async function runLifecycle(
  sql: postgres.Sql,
  userId: string,
  runId: string,
  action: string,
): Promise<boolean> {
  const rows =
    await sql`SELECT relay_internal.run_lifecycle(${userId}, ${runId}, ${action}, ${DEFAULT_ADMISSION_TTL_MS}) AS alive`;
  return rows[0]?.alive === true;
}

/** Atomically settle an authorized request and its charge; queue redelivery is a no-op. */
export async function settle(sql: postgres.Sql, event: UsageObservation): Promise<void> {
  await sql.begin(async (tx) => {
    const rows =
      await tx`SELECT user_id, provider, settled_at FROM relay_internal.requests WHERE request_id = ${event.requestId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row || row.user_id !== event.userId || row.provider !== event.provider)
      throw new Error('Unknown usage request');
    if (row.settled_at) return;
    if (event.outcome === 'complete' && !event.usage)
      throw new Error('Completed request has no usage');
    if (event.outcome === 'complete' && event.usage) {
      const usage = event.usage;
      const inputTokens = safeTokenCount(usage.inputTokens);
      const outputTokens = safeTokenCount(usage.outputTokens);
      const cachedInputTokens = safeTokenCount(usage.cachedInputTokens);
      const cacheCreationTokens = safeTokenCount(usage.cacheCreationTokens);
      const model = usage.model || 'unknown';
      const result = await recordUsage(
        {
          userId: event.userId,
          provider: event.provider,
          requestId: event.requestId,
          statusCode: event.statusCode,
          latencyMs: event.latencyMs,
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheCreationTokens,
          totalTokens: inputTokens + outputTokens,
          costMicroUsd: Number(
            calculateCostMicroUsd(
              model,
              inputTokens,
              outputTokens,
              cachedInputTokens,
              cacheCreationTokens,
            ),
          ),
        },
        tx,
      );
      // Keep the request unsettled for retry/dead-letter inspection if its payer disappeared.
      if (result === 'uncharged') throw new Error('Usage has no billing account');
    }
    await tx`UPDATE relay_internal.requests SET outcome = ${event.outcome}, settled_at = clock_timestamp()
      WHERE request_id = ${event.requestId}::uuid`;
  });
}
