import type postgres from 'postgres';
import { getDb } from './client.js';
import { incrementUserBudget, type BudgetIncrementResult } from './queries.js';
import { RedemptionBudgetConflict } from './redemption.js';
import { FREE_TIER_PLAN_BASE_CEILING } from '../billing/policy.js';

type CreditSettlement = BudgetIncrementResult & {
  account_id: string;
  idempotency_key: string;
  revoked_user_ids?: string[];
};

type Card = { account_id: string; credits: number; workspace_id: string | null };

/** Lock the verified owner and code in the same order as the redemption claim RPC. */
async function lockCard(tx: postgres.TransactionSql, owner: string, code: string): Promise<Card> {
  const account = await tx`SELECT id FROM auth.users WHERE id=${owner}::uuid FOR UPDATE`;
  if (!account.length) throw new RedemptionBudgetConflict();
  const [card] = await tx<Card[]>`
    SELECT coalesce(c.workspace_id, c.user_id)::text AS account_id, b.credits, c.workspace_id
    FROM public.redemption_codes c JOIN public.redemption_batches b ON b.id=c.batch_id
    WHERE c.id=${code}::uuid AND c.user_id=${owner}::uuid AND b.type = 'lifetime' AND b.tier = 'byok' AND b.credits > 0
    FOR UPDATE OF c
  `;
  if (!card) throw new RedemptionBudgetConflict();
  return card;
}

/** A prior funding receipt or paid marker protects previously accounted spend. */
async function clearTrial(
  tx: postgres.TransactionSql,
  owner: string,
  payer: string,
): Promise<void> {
  if (owner !== payer) return;
  // Trial usage does not consume a purchased gift; usage_logs retain its history.
  await tx`
    UPDATE user_budgets SET plan_base=0, budget=0, spend=0, updated_at=now()
    WHERE user_id=${payer} AND plan_base <= ${FREE_TIER_PLAN_BASE_CEILING}
      AND NOT EXISTS (SELECT 1 FROM budget_increments WHERE user_id=${payer})
      AND NOT EXISTS (SELECT 1 FROM public.user_billing WHERE user_id=${owner}::uuid AND paid_credit_since IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id=${owner}::uuid
        AND canceled_at IS NULL AND status IN ('active','trialing','past_due')
        AND (NOT is_one_time OR current_period_end IS NULL OR current_period_end > clock_timestamp()))
  `;
}

/** Remove only this gift's unspent credit, settling its already-accounted FIFO usage. */
async function revokeCredit(tx: postgres.TransactionSql, payer: string, key: string) {
  const receipt = await tx`INSERT INTO budget_reset_receipts(user_id,idempotency_key)
    VALUES (${payer},${key.replace('redemption_credit_', 'redemption_credit_end_')})
    ON CONFLICT DO NOTHING RETURNING idempotency_key`;
  if (receipt.length) {
    // Keep the reset writer's FIFO order, but settle this gift in micro-USD before removing it.
    await tx`
      WITH gift AS MATERIALIZED (
        SELECT b.remaining_cents,
          least(b.remaining_cents::numeric * 10000, greatest(0,
            trunc((u.spend-u.plan_base)*1000000) - coalesce((
              SELECT sum(p.remaining_cents)::numeric * 10000 FROM budget_increments p
              WHERE p.user_id=${payer} AND (p.created_at,p.idempotency_key) < (b.created_at,b.idempotency_key)
            ),0))) AS consumed_micro
        FROM budget_increments b JOIN user_budgets u ON u.user_id=b.user_id
        WHERE b.idempotency_key=${key} AND b.user_id=${payer}
      ), voided AS (
        UPDATE budget_increments SET remaining_cents=0
        WHERE idempotency_key=${key} AND user_id=${payer} RETURNING idempotency_key
      )
      UPDATE user_budgets SET
        budget=budget-coalesce((SELECT remaining_cents FROM gift),0)::numeric/100,
        spend=greatest(0,spend-coalesce((SELECT consumed_micro FROM gift),0)/1000000),updated_at=now()
      WHERE user_id=${payer}
    `;
  }
  const [state] = await tx`SELECT budget,spend FROM user_budgets WHERE user_id=${payer}`;
  return {
    applied: receipt.length > 0,
    budget: Number(state.budget),
    spend: Number(state.spend),
  };
}

/**
 * Settle an immutable card's gift in one transaction. Eligibility is checked
 * after the payer lock; receipt replay never refills or re-voids later credit.
 * One Dassi credit is one USD cent. Revocation retains other purchases and usage.
 */
export async function settleRedemptionCredit(
  owner: string,
  code: string,
  phase: 'grant' | 'revoke' = 'grant',
): Promise<CreditSettlement> {
  return getDb().begin(async (tx) => {
    const card = await lockCard(tx, owner, code);
    const payer = card.account_id;
    const key = `redemption_credit_${code}`;
    await tx`INSERT INTO user_budgets(user_id) VALUES (${payer}) ON CONFLICT DO NOTHING`;
    await tx`SELECT user_id FROM user_budgets WHERE user_id=${payer} FOR UPDATE`;
    const [state] = await tx`
      WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT revoked_at IS NULL AND starts_at <= i.at AND (ends_at IS NULL OR ends_at > i.at) AS active,
        revoked_at IS NOT NULL OR ends_at <= i.at AS ended
      FROM public.redemption_codes CROSS JOIN instant i WHERE id=${code}::uuid
    `;
    if (!state || (phase === 'grant' ? !state.active : !state.ended))
      throw new RedemptionBudgetConflict();
    const [receipt] =
      await tx`SELECT user_id, delta_cents FROM budget_increments WHERE idempotency_key=${key}`;
    if (receipt && (receipt.user_id !== payer || Number(receipt.delta_cents) !== card.credits))
      throw new RedemptionBudgetConflict();
    if (phase === 'revoke') {
      const members = card.workspace_id
        ? await tx<
            { user_id: string }[]
          >`SELECT user_id::text FROM public.workspace_seats WHERE workspace_id=${card.workspace_id}::uuid`
        : [];
      return {
        ...(await revokeCredit(tx, payer, key)),
        revoked_user_ids: [...new Set([owner, ...members.map((member) => member.user_id)])],
        account_id: payer,
        idempotency_key: `redemption_credit_end_${code}`,
      };
    }
    const ended =
      await tx`SELECT idempotency_key FROM budget_reset_receipts WHERE user_id=${payer} AND idempotency_key=${'redemption_credit_end_' + code}`;
    if (ended.length) throw new RedemptionBudgetConflict();
    if (!receipt) await clearTrial(tx, owner, payer);
    const result = await incrementUserBudget(payer, card.credits, key, tx);
    if (owner === payer) {
      await tx`INSERT INTO public.user_billing(user_id,paid_credit_since,updated_at)
        VALUES (${owner}::uuid,now(),now()) ON CONFLICT(user_id) DO UPDATE
        SET paid_credit_since=coalesce(user_billing.paid_credit_since,EXCLUDED.paid_credit_since),updated_at=now()`;
    }
    return {
      ...result,
      account_id: payer,
      idempotency_key: key,
    };
  });
}
