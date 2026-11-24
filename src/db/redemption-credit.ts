import type postgres from 'postgres';
import { getDb } from './client.js';
import { incrementUserBudget, type BudgetIncrementResult } from './queries.js';
import { RedemptionBudgetConflict } from './redemption.js';
import { settleAppsumoCredit } from './appsumo-credit.js';
import { revokeCredit } from './credit-revocation.js';
import type { RedemptionCard } from './redemption.js';
import { FREE_TIER_PLAN_BASE_CEILING } from '../billing/policy.js';

export type CreditSettlement = BudgetIncrementResult & {
  protocol?: 'appsumo-credit.v1';
  account_id: string;
  idempotency_key: string;
  revoked_user_ids?: string[];
};

type Card = RedemptionCard;

/** Lock the verified owner and code in the same order as the redemption claim RPC. */
async function lockCard(tx: postgres.TransactionSql, owner: string, code: string): Promise<Card> {
  const account = await tx`SELECT id FROM auth.users WHERE id=${owner}::uuid FOR UPDATE`;
  if (!account.length) throw new RedemptionBudgetConflict();
  const [card] = await tx<Card[]>`
    SELECT coalesce(c.workspace_id, c.user_id)::text AS account_id, b.credits, c.workspace_id, c.source, c.credits_granted_at
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

async function grantCredit(
  tx: postgres.TransactionSql,
  owner: string,
  card: Card,
  key: string,
  hasReceipt: boolean,
): Promise<CreditSettlement> {
  const payer = card.account_id;
  const ended = await tx`SELECT idempotency_key FROM budget_reset_receipts
    WHERE user_id=${payer} AND idempotency_key=${key.replace('redemption_credit_', 'redemption_credit_end_')}`;
  if (ended.length) throw new RedemptionBudgetConflict();
  if (!hasReceipt) await clearTrial(tx, owner, payer);
  const result = await incrementUserBudget(payer, card.credits, key, tx);
  if (owner === payer) {
    await tx`INSERT INTO public.user_billing(user_id,paid_credit_since,updated_at)
      VALUES (${owner}::uuid,now(),now()) ON CONFLICT(user_id) DO UPDATE
      SET paid_credit_since=coalesce(user_billing.paid_credit_since,EXCLUDED.paid_credit_since),updated_at=now()`;
  }
  return { ...result, account_id: payer, idempotency_key: key };
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
    if (card.source === 'appsumo') return settleAppsumoCredit(tx, owner, code, card, phase);
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
    return grantCredit(tx, owner, card, key, !!receipt);
  });
}
