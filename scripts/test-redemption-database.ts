/** Exercise the actual budget writer and row locks in a disposable local database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { setUserBudget } from '../src/db/queries.js';
import { settleRedemptionCredit } from '../src/db/redemption-credit.js';
import { getDb } from '../src/db/client.js';
import { RedemptionBudgetConflict } from '../src/db/redemption.js';

const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost:55487/postgres');
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('Use a disposable local Postgres');
const admin = postgres(url.toString(), { max: 1 });
const name = `redemption_test_${Date.now()}_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${name}`);
url.pathname = '/' + name;
process.env.DATABASE_URL = url.toString();
const sql = postgres(url.toString(), { max: 4 });
const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const batch = '10000000-0000-4000-8000-000000000001';
const card = '20000000-0000-4000-8000-000000000001';
const next = '20000000-0000-4000-8000-000000000002';
let passed = 0;
const transition = (phase: 'activate' | 'end', codeId = card, actor = user) =>
  setUserBudget(
    actor,
    phase === 'activate' ? 50 : 0,
    true,
    `redemption_${phase === 'end' ? 'end_' : ''}${codeId}`,
    { codeId, phase },
  );
const balance = async () => {
  const [row] = await sql`SELECT plan_base, budget, spend FROM user_budgets WHERE user_id=${user}`;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
};
async function check(label: string, run: () => Promise<void>) {
  await sql`TRUNCATE auth.users, redemption_batches, redemption_codes, subscriptions,
    test_seats, user_budgets, budget_increments, budget_reset_receipts, user_billing CASCADE`;
  await sql`INSERT INTO auth.users VALUES (${user}), (${other})`;
  await sql`INSERT INTO redemption_batches VALUES (${batch}, 'month', 'starter')`;
  await sql`INSERT INTO redemption_codes VALUES
    (${card}, ${batch}, ${user}, now()-interval '1 day', now()+interval '1 day', NULL)`;
  await sql`INSERT INTO user_budgets(user_id, plan_base, budget, spend) VALUES (${user},10,10,8)`;
  await run();
  passed++;
  console.log(`PASS ${label}`);
}
async function waitForBlockedActivation() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname=${name} AND wait_event_type='Lock'
        AND query LIKE '%SELECT id FROM auth.users%') AS waiting`;
    if (row.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Activation never waited on the account lock');
}
try {
  await sql.unsafe(
    await readFile(new URL('./fixtures/redemption-billing.sql', import.meta.url), 'utf8'),
  );
  await check('concurrent activation resets once and replay preserves later spend', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => transition('activate')));
    assert.equal(results.filter((result) => result.applied).length, 1);
    assert.deepEqual(await balance(), {
      plan_base: 50,
      budget: 50,
      spend: 0,
    });
    await sql`UPDATE user_budgets SET spend=7 WHERE user_id=${user}`;
    assert.deepEqual(await transition('activate'), {
      applied: false,
      protected: false,
    });
    assert.equal((await balance()).spend, 7);
  });
  await check(
    'expiry draws purchases once; a delayed activation cannot revive the allowance',
    async () => {
      await transition('activate');
      await sql`INSERT INTO budget_increments VALUES ('pi_test', ${user},1000,1000,now())`;
      await sql`UPDATE user_budgets SET budget=60,spend=55 WHERE user_id=${user}`;
      await sql`UPDATE redemption_codes SET ends_at=now()-interval '1 second' WHERE id=${card}`;
      assert.deepEqual(await transition('end'), {
        applied: true,
        protected: false,
      });
      assert.deepEqual(await balance(), { plan_base: 0, budget: 5, spend: 0 });
      await assert.rejects(transition('activate'), RedemptionBudgetConflict);
      await sql`UPDATE user_budgets SET spend=2 WHERE user_id=${user}`;
      assert.deepEqual(await transition('end'), {
        applied: false,
        protected: false,
      });
      assert.deepEqual(await balance(), { plan_base: 0, budget: 5, spend: 2 });
      assert.equal(
        (await sql`SELECT remaining_cents FROM budget_increments`)[0].remaining_cents,
        500,
      );
    },
  );
  await check(
    'revocation, future periods, owner mismatch and non-managed cards fail without receipts',
    async () => {
      await assert.rejects(transition('activate', card, other), RedemptionBudgetConflict);
      await assert.rejects(transition('end'), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET revoked_at=now() WHERE id=${card}`;
      await assert.rejects(transition('activate'), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET revoked_at=NULL,starts_at=now()+interval '1 hour' WHERE id=${card}`;
      await assert.rejects(transition('activate'), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET starts_at=now()-interval '1 day' WHERE id=${card}`;
      for (const [type, tier] of [
        ['lifetime', 'byok'],
        ['discount', null],
        ['month', 'byok'],
      ]) {
        await sql`UPDATE redemption_batches SET type=${type},tier=${tier} WHERE id=${batch}`;
        await assert.rejects(transition('activate'), RedemptionBudgetConflict);
      }
      assert.equal(Number((await sql`SELECT count(*) FROM budget_reset_receipts`)[0].count), 0);
      assert.deepEqual(await balance(), {
        plan_base: 10,
        budget: 10,
        spend: 8,
      });
    },
  );
  await check('a replacement period protects its budget and accumulated paid spend', async () => {
    await sql`UPDATE redemption_codes SET ends_at=now()-interval '1 second' WHERE id=${card}`;
    await sql`INSERT INTO redemption_codes VALUES
      (${next},${batch},${user},now()-interval '1 second',now()+interval '1 day',NULL)`;
    await transition('activate', next);
    await sql`UPDATE user_budgets SET spend=19 WHERE user_id=${user}`;
    assert.deepEqual(await transition('end'), {
      applied: false,
      protected: true,
    });
    assert.deepEqual(await balance(), {
      plan_base: 50,
      budget: 50,
      spend: 19,
    });
  });
  await check(
    'a funded personal subscription survives stale cleanup and blocks activation',
    async () => {
      await sql`INSERT INTO subscriptions(user_id,status) VALUES (${user},'active')`;
      await assert.rejects(transition('activate'), RedemptionBudgetConflict);
      await sql`UPDATE user_budgets SET plan_base=100,budget=100,spend=33 WHERE user_id=${user}`;
      await sql`UPDATE redemption_codes SET ends_at=now()-interval '1 second' WHERE id=${card}`;
      assert.deepEqual(await transition('end'), {
        applied: false,
        protected: true,
      });
      assert.deepEqual(await balance(), {
        plan_base: 100,
        budget: 100,
        spend: 33,
      });
    },
  );
  await check(
    'joining a workspace blocks activation but cannot retain an expired personal allowance',
    async () => {
      await transition('activate');
      await sql`INSERT INTO test_seats VALUES (${user},${other})`;
      await sql`INSERT INTO user_budgets(user_id,plan_base,budget,spend) VALUES (${other},1000,1000,321)`;
      await assert.rejects(transition('activate'), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET ends_at=now()-interval '1 second' WHERE id=${card}`;
      assert.deepEqual(await transition('end'), {
        applied: true,
        protected: false,
      });
      assert.deepEqual(await balance(), { plan_base: 0, budget: 0, spend: 0 });
      const [pool] =
        await sql`SELECT plan_base,budget,spend FROM user_budgets WHERE user_id=${other}`;
      assert.deepEqual(pool, {
        plan_base: '1000',
        budget: '1000',
        spend: '321',
      });
    },
  );
  await check('an expired one-time subscription does not block the redeemed period', async () => {
    await sql`INSERT INTO subscriptions VALUES (${user},NULL,'active',true,now()-interval '1 day')`;
    assert.equal((await transition('activate')).applied, true);
  });
  await check(
    'eligibility is re-read after a concurrent revocation releases the account lock',
    async () => {
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM auth.users WHERE id=${user} FOR UPDATE`;
        acquired();
        await proceed;
        await tx`UPDATE redemption_codes SET revoked_at=now() WHERE id=${card}`;
      });
      await ready;
      const activation = transition('activate').catch((error: unknown) => error);
      try {
        await waitForBlockedActivation();
      } finally {
        release();
      }
      await blocker;
      assert.ok((await activation) instanceof RedemptionBudgetConflict);
      assert.deepEqual(await balance(), {
        plan_base: 10,
        budget: 10,
        spend: 8,
      });
    },
  );
  await check(
    'clock expiry while waiting for a row lock rejects the old activation snapshot',
    async () => {
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM auth.users WHERE id=${user} FOR UPDATE`;
        await tx`UPDATE redemption_codes SET ends_at=clock_timestamp()+interval '200 milliseconds' WHERE id=${card}`;
        acquired();
        await proceed;
        await tx`SELECT pg_sleep(0.3)`;
      });
      await ready;
      const activation = transition('activate').catch((error: unknown) => error);
      try {
        await waitForBlockedActivation();
      } finally {
        release();
      }
      await blocker;
      assert.ok((await activation) instanceof RedemptionBudgetConflict);
      assert.deepEqual(await balance(), {
        plan_base: 10,
        budget: 10,
        spend: 8,
      });
    },
  );
  const gift = () => settleRedemptionCredit(user, card);
  async function prepareGift(credits = 750, workspace: string | null = null) {
    await sql`UPDATE redemption_batches SET type='lifetime',tier='byok',credits=${credits},seats=${workspace ? 3 : 1}`;
    await sql`UPDATE redemption_codes SET ends_at=NULL,workspace_id=${workspace}`;
    await sql`UPDATE user_budgets SET plan_base=2,budget=2,spend=3 WHERE user_id=${user}`;
  }
  await check(
    'gift eligibility is checked after a blocked transaction crosses expiry',
    async () => {
      await prepareGift();
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM auth.users WHERE id=${user} FOR UPDATE`;
        await tx`UPDATE redemption_codes SET ends_at=clock_timestamp()+interval '200 milliseconds' WHERE id=${card}`;
        acquired();
        await proceed;
        await tx`SELECT pg_sleep(0.3)`;
      });
      await ready;
      const pending = gift().catch((error: unknown) => error);
      try {
        await waitForBlockedActivation();
      } finally {
        release();
      }
      await blocker;
      assert.ok((await pending) instanceof RedemptionBudgetConflict);
      assert.equal(Number((await sql`SELECT count(*) FROM budget_increments`)[0].count), 0);
      assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
    },
  );
  await check(
    'one-time credit settles trial spend once across concurrent claims and lost replies',
    async () => {
      await prepareGift();
      const results = await Promise.all(Array.from({ length: 12 }, gift));
      assert.equal(results.filter((result) => result.applied).length, 1);
      assert.deepEqual(await balance(), {
        plan_base: 0,
        budget: 7.5,
        spend: 0,
      });
      await sql`UPDATE user_budgets SET spend=2 WHERE user_id=${user}`;
      assert.equal((await gift()).applied, false);
      assert.deepEqual(await balance(), {
        plan_base: 0,
        budget: 7.5,
        spend: 2,
      });
      assert.equal(Number((await sql`SELECT count(*) FROM budget_increments`)[0].count), 1);
      assert.ok(
        (await sql`SELECT paid_credit_since FROM user_billing WHERE user_id=${user}`)[0]
          .paid_credit_since,
      );
    },
  );
  await check(
    'a team gets one shared grant and never changes its owner personal balance',
    async () => {
      await prepareGift(2000, other);
      const result = await gift();
      assert.equal(result.account_id, other);
      assert.equal(result.budget, 20);
      assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
      assert.equal((await gift()).applied, false);
    },
  );
  await check(
    'team revocation identifies every seated user for immediate admission invalidation',
    async () => {
      await prepareGift(2000, other);
      await sql`INSERT INTO test_seats VALUES (${user},${other}), (${other},${other})`;
      await gift();
      await sql`UPDATE redemption_codes SET revoked_at=now() WHERE id=${card}`;
      const result = await settleRedemptionCredit(user, card, 'revoke');
      assert.deepEqual(new Set(result.revoked_user_ids), new Set([user, other]));
      assert.equal(result.budget, 0);
      assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
    },
  );
  await check(
    'redeemed credit preserves existing purchased credit and accounted usage',
    async () => {
      await prepareGift();
      await sql`INSERT INTO budget_increments VALUES ('pi_kept',${user},1000,1000,now())`;
      await sql`UPDATE user_budgets SET budget=12 WHERE user_id=${user}`;
      assert.equal((await gift()).clearedTrial, false);
      assert.deepEqual(await balance(), {
        plan_base: 2,
        budget: 19.5,
        spend: 3,
      });
      assert.equal(
        (
          await sql`SELECT remaining_cents FROM budget_increments WHERE idempotency_key='pi_kept'`
        )[0].remaining_cents,
        1000,
      );
    },
  );
  await check(
    'revoked, future, expired, wrong-owner and zero-credit grants fail without changing money',
    async () => {
      await prepareGift();
      await assert.rejects(settleRedemptionCredit(other, card), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET revoked_at=now()`;
      await assert.rejects(gift(), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET revoked_at=NULL,starts_at=now()+interval '1 day'`;
      await assert.rejects(gift(), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET starts_at=now()-interval '1 day',ends_at=now()-interval '1 hour'`;
      await assert.rejects(gift(), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET ends_at=NULL`;
      await sql`UPDATE redemption_batches SET credits=0`;
      await assert.rejects(gift(), RedemptionBudgetConflict);
      assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
      assert.equal(Number((await sql`SELECT count(*) FROM budget_increments`)[0].count), 0);
    },
  );
  await check(
    'funding-marker failures roll back the entire gift including its receipt and trial reset',
    async () => {
      await prepareGift();
      await sql.unsafe(`CREATE FUNCTION reject_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'marker unavailable'; END $$;
      CREATE TRIGGER reject_marker BEFORE INSERT OR UPDATE ON user_billing FOR EACH ROW EXECUTE FUNCTION reject_marker();`);
      await assert.rejects(gift());
      assert.equal(Number((await sql`SELECT count(*) FROM budget_increments`)[0].count), 0);
      assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
      await sql.unsafe(
        'DROP TRIGGER reject_marker ON user_billing; DROP FUNCTION reject_marker();',
      );
      assert.equal((await gift()).applied, true);
      assert.deepEqual(await balance(), {
        plan_base: 0,
        budget: 7.5,
        spend: 0,
      });
    },
  );
  await check('an inconsistent receipt cannot be acknowledged for another payer', async () => {
    await prepareGift();
    await sql`INSERT INTO budget_increments VALUES (${'redemption_credit_' + card},${other},750,750,now())`;
    await assert.rejects(gift(), RedemptionBudgetConflict);
    assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
  });
  await check(
    'gift revocation removes only unspent gift cents and preserves later paid purchases',
    async () => {
      await prepareGift();
      await sql`INSERT INTO budget_increments VALUES ('pi_before',${user},1000,1000,now()-interval '1 day')`;
      await sql`UPDATE user_budgets SET budget=12,spend=0 WHERE user_id=${user}`;
      await gift();
      await sql`UPDATE user_budgets SET spend=14.005 WHERE user_id=${user}`;
      await sql`INSERT INTO budget_increments VALUES ('pi_after',${user},500,500,now()+interval '1 second')`;
      await sql`UPDATE user_budgets SET budget=budget+5 WHERE user_id=${user}`;
      await assert.rejects(settleRedemptionCredit(user, card, 'revoke'), RedemptionBudgetConflict);
      await sql`UPDATE redemption_codes SET revoked_at=now() WHERE id=${card}`;
      const result = await settleRedemptionCredit(user, card, 'revoke');
      assert.equal(result.applied, true);
      assert.deepEqual(await balance(), {
        plan_base: 2,
        budget: 17,
        spend: 12,
      });
      assert.equal(
        (
          await sql`SELECT remaining_cents FROM budget_increments WHERE idempotency_key=${'redemption_credit_' + card}`
        )[0].remaining_cents,
        0,
      );
      assert.equal(
        (
          await sql`SELECT remaining_cents FROM budget_increments WHERE idempotency_key='pi_after'`
        )[0].remaining_cents,
        500,
      );
      await sql`UPDATE user_budgets SET spend=12.75 WHERE user_id=${user}`;
      assert.equal((await settleRedemptionCredit(user, card, 'revoke')).applied, false);
      assert.deepEqual(await balance(), {
        plan_base: 2,
        budget: 17,
        spend: 12.75,
      });
      await sql`UPDATE redemption_codes SET revoked_at=NULL WHERE id=${card}`;
      await assert.rejects(gift(), RedemptionBudgetConflict);
      await setUserBudget(user, 0, true, 'after_gift_refund');
      assert.deepEqual(await balance(), {
        plan_base: 0,
        budget: 4.25,
        spend: 0,
      });
    },
  );
  await check(
    'revocation before an acknowledged grant does not manufacture or debit any credit',
    async () => {
      await prepareGift();
      await sql`UPDATE redemption_codes SET revoked_at=now() WHERE id=${card}`;
      assert.equal((await settleRedemptionCredit(user, card, 'revoke')).applied, true);
      assert.deepEqual(await balance(), { plan_base: 2, budget: 2, spend: 3 });
      assert.equal(Number((await sql`SELECT count(*) FROM budget_increments`)[0].count), 0);
    },
  );
  console.log(`${passed} guarded redemption database tests passed`);
} finally {
  await getDb().end();
  await sql.end();
  await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
