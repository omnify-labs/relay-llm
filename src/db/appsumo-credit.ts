import type postgres from 'postgres';
import { incrementUserBudget } from './queries.js';
import { revokeCredit } from './credit-revocation.js';
import type { RedemptionCard } from './redemption.js';

/**
 * Settle the root license's cumulative gift under the caller's owner/card/payer locks.
 * Upgrade deltas use the immutable issuance ledger, so spent credit and re-upgrades
 * never refill a gift. A refund ends this root's gifts and preserves other purchases.
 */
export async function settleAppsumoCredit(
  tx: postgres.TransactionSql,
  owner: string,
  code: string,
  card: RedemptionCard,
  phase: 'grant' | 'revoke',
) {
  const payer = card.account_id;
  const prefix = `appsumo_credit_${code}_`;
  const end = `appsumo_credit_end_${code}`;
  const pending = !card.credits_granted_at;
  let applied = false;
  if (phase === 'revoke') {
    const ended = await tx`INSERT INTO budget_reset_receipts(user_id,idempotency_key)
      VALUES (${payer},${end}) ON CONFLICT DO NOTHING RETURNING idempotency_key`;
    applied = ended.length > 0;
    const gifts = await tx`SELECT idempotency_key FROM budget_increments
      WHERE user_id=${payer} AND left(idempotency_key,${prefix.length})=${prefix}
      ORDER BY created_at,idempotency_key`;
    for (const gift of gifts)
      await revokeCredit(tx, payer, gift.idempotency_key, `appsumo_end_${gift.idempotency_key}`);
    await tx`UPDATE redemption_codes SET credits_ended_at=coalesce(credits_ended_at,now()) WHERE id=${code}::uuid`;
  } else {
    const [ended] = await tx`SELECT idempotency_key FROM budget_reset_receipts
      WHERE user_id=${payer} AND idempotency_key=${end}`;
    if (!ended) {
      const [issued] = await tx`SELECT coalesce(sum(delta_cents),0) AS total FROM budget_increments
        WHERE user_id=${payer} AND left(idempotency_key,${prefix.length})=${prefix}`;
      const delta = Math.max(0, card.credits - Number(issued.total));
      if (delta > 0) {
        const result = await incrementUserBudget(payer, delta, prefix + card.credits, tx);
        applied = result.applied;
      }
    }
    await tx`UPDATE redemption_codes SET credits_granted_at=coalesce(credits_granted_at,now()) WHERE id=${code}::uuid`;
  }
  const members =
    phase === 'revoke' || pending
      ? await tx<{ user_id: string }[]>`SELECT user_id::text FROM public.resource_workspace_members
        WHERE workspace_id=${card.workspace_id}::uuid`
      : [];
  const [state] = await tx`SELECT budget,spend FROM user_budgets WHERE user_id=${payer}`;
  return {
    protocol: 'appsumo-credit.v1' as const,
    account_id: payer,
    idempotency_key: phase === 'revoke' ? end : `appsumo_credit_grant_${code}`,
    applied,
    budget: Number(state.budget),
    spend: Number(state.spend),
    revoked_user_ids:
      phase === 'revoke' || pending ? [...new Set([owner, ...members.map((m) => m.user_id)])] : [],
  };
}
