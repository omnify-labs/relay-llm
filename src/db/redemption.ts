import type postgres from 'postgres';

export interface RedemptionBudgetGuard {
  codeId: string;
  phase: 'activate' | 'end';
}

export interface RedemptionBudgetResult {
  applied: boolean;
  protected: boolean;
}

export class RedemptionBudgetConflict extends Error {
  constructor() {
    super('The redeemed period no longer permits this budget transition');
  }
}

/** Lock the account and claimed card in the same order as Dassi's claim RPC. */
export async function lockRedemption(
  tx: postgres.TransactionSql,
  userId: string,
  guard: RedemptionBudgetGuard,
): Promise<void> {
  const account = await tx`SELECT id FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE`;
  if (!account.length) throw new RedemptionBudgetConflict();
  const card = await tx`
    SELECT c.id FROM public.redemption_codes c
    JOIN public.redemption_batches b ON b.id = c.batch_id
    WHERE c.id = ${guard.codeId}::uuid AND c.user_id = ${userId}::uuid
      AND b.type = 'month' AND b.tier <> 'byok'
    FOR UPDATE OF c
  `;
  if (!card.length) throw new RedemptionBudgetConflict();
}

/** Check current entitlement after account, card and budget locks have been acquired. */
export async function preserveRedemptionBudget(
  tx: postgres.TransactionSql,
  userId: string,
  guard: RedemptionBudgetGuard,
): Promise<boolean> {
  const [state] = await tx`
    WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT
      c.revoked_at IS NULL AND c.starts_at <= i.at AND c.ends_at > i.at AS active,
      c.revoked_at IS NOT NULL OR c.ends_at <= i.at AS ended,
      EXISTS (
        SELECT 1 FROM public.subscriptions s
        WHERE s.user_id = ${userId}::uuid AND s.canceled_at IS NULL
          AND s.status IN ('active', 'trialing', 'past_due')
          AND (NOT s.is_one_time OR s.current_period_end IS NULL OR s.current_period_end > i.at)
      ) AS subscribed,
      EXISTS (SELECT 1 FROM public.workspace_of(${userId}::uuid)) AS seated,
      EXISTS (
        SELECT 1 FROM public.redemption_codes other
        JOIN public.redemption_batches b ON b.id = other.batch_id
        WHERE other.user_id = ${userId}::uuid AND other.id <> c.id
          AND b.type = 'month' AND b.tier <> 'byok' AND other.revoked_at IS NULL
          AND other.starts_at <= i.at AND other.ends_at > i.at
      ) AS replacement,
      (SELECT plan_base > 0 FROM user_budgets WHERE user_id = ${userId}) AS funded
    FROM public.redemption_codes c CROSS JOIN instant i WHERE c.id = ${guard.codeId}::uuid
  `;
  if (
    !state ||
    (guard.phase === 'activate' ? !state.active || state.subscribed || state.seated : !state.ended)
  ) {
    throw new RedemptionBudgetConflict();
  }
  return guard.phase === 'end' && (state.replacement || (state.subscribed && state.funded));
}

/** A locked redemption card and the payer authorized by its stored ownership. */
export interface RedemptionCard {
  account_id: string;
  credits: number;
  workspace_id: string | null;
  source: 'internal' | 'appsumo';
  credits_granted_at: string | null;
}
