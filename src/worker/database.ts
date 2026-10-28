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
  return postgres(binding.connectionString, {
    max: 1,
    fetch_types: false,
    connect_timeout: 10,
  });
}

export interface ActorSnapshot {
  payer: string;
  paid: boolean;
  memberLimit: number | null;
  memberSpend: number;
}

export interface AccountSnapshot {
  budget: number | null;
  spend: number;
  planBase: number;
  revision: string;
  actors: Record<string, ActorSnapshot>;
  settled: string[];
}

/** Resolve only the routing identity; the account object owns credit decisions. */
export async function resolvePayer(sql: postgres.Sql, userId: string): Promise<string> {
  const rows = await sql`SELECT public.billing_account_id(${userId}::text) AS payer`;
  if (typeof rows[0]?.payer !== 'string' || !rows[0].payer) throw new Error('Missing payer');
  return rows[0].payer;
}

/** Read balances, entitlements and included usage from one consistent SQL snapshot. */
export async function snapshot(
  sql: postgres.Sql,
  accountId: string,
  actors: string[],
  pending: string[],
): Promise<AccountSnapshot> {
  const rows = await sql`
    SELECT jsonb_build_object(
      'budget', trunc(b.budget * 1000000),
      'spend', CASE WHEN b.user_id IS NULL THEN 0 ELSE trunc(b.spend * 1000000) END,
      'planBase', CASE WHEN b.user_id IS NULL THEN 0 ELSE trunc(b.plan_base * 1000000) END,
      'revision', coalesce(v.revision, 0)::text,
      'actors', (SELECT coalesce(jsonb_object_agg(actor, jsonb_build_object(
        'payer', public.billing_account_id(actor),
        'paid', public.has_paid_subscription(actor::uuid) IS TRUE,
        'memberLimit', trunc(w.monthly_cap_usd * 1000000),
        'memberSpend', coalesce(trunc(w.month_spend_usd * 1000000), 0)
      )), '{}'::jsonb)
        FROM jsonb_array_elements_text(${sql.json(actors)}::jsonb) AS a(actor)
        LEFT JOIN LATERAL public.workspace_of(actor::uuid) w ON true),
      'settled', (SELECT coalesce(jsonb_agg(request_id::text), '[]'::jsonb) FROM relay_internal.requests
        WHERE settled_at IS NOT NULL AND request_id::text IN
          (SELECT jsonb_array_elements_text(${sql.json(pending)}::jsonb)))
    ) AS value
    FROM (SELECT ${accountId}::text AS id) a
    LEFT JOIN public.user_budgets b ON b.user_id = a.id
    LEFT JOIN relay_internal.budget_versions v ON v.account_id = a.id`;
  const value = rows[0]?.value as AccountSnapshot;
  if (!Number.isSafeInteger(value?.spend) || !Number.isSafeInteger(value?.planBase))
    throw new Error('Incomplete account amount');
  for (const amount of [
    value?.budget,
    value?.spend,
    value?.planBase,
    ...Object.values(value?.actors ?? {}).flatMap((actor) => [
      actor.memberLimit,
      actor.memberSpend,
    ]),
  ]) {
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
      throw new Error('Invalid account amount');
  }
  if (!value || actors.some((actor) => !value.actors[actor]))
    throw new Error('Incomplete snapshot');
  return value;
}

/** Convert observed provider usage using the shared integer billing tariff. */
export function observationCost(event: UsageObservation): number {
  if (event.outcome !== 'complete') return 0;
  if (!event.usage) throw new Error('Completed request has no usage');
  const usage = event.usage;
  const amount = Number(
    calculateCostMicroUsd(
      usage.model || 'unknown',
      safeTokenCount(usage.inputTokens),
      safeTokenCount(usage.outputTokens),
      safeTokenCount(usage.cachedInputTokens),
      safeTokenCount(usage.cacheCreationTokens),
    ),
  );
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid usage amount');
  return amount;
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
    // Admissions are durable at the edge. The trusted queue creates their ledger row.
    await tx`INSERT INTO relay_internal.requests(request_id, user_id, provider)
      VALUES (${event.requestId}::uuid, ${event.userId}, ${event.provider}) ON CONFLICT DO NOTHING`;
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
          costMicroUsd: observationCost(event),
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
