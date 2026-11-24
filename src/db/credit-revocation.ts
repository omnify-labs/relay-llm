import type postgres from 'postgres';

/** Remove only this gift's unspent credit, settling its already-accounted FIFO usage. */
export async function revokeCredit(
  tx: postgres.TransactionSql,
  payer: string,
  key: string,
  endKey = key.replace('redemption_credit_', 'redemption_credit_end_'),
) {
  const receipt = await tx`INSERT INTO budget_reset_receipts(user_id,idempotency_key)
    VALUES (${payer},${endKey})
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
