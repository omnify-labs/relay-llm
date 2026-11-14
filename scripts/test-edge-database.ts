/** Disposable local SQL integration tests. Never accepts a remote database URL. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { authorize, runLifecycle, settle, resolvePayer, snapshot } from '../src/worker/database.js';
import type { UsageObservation } from '../src/proxy/handler.js';

const url = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://edge_test@127.0.0.1:55487/postgres',
);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('Use a disposable local Postgres');
const admin = postgres(url.toString(), { max: 1 });
const name = `edge_test_${Date.now()}`;
await admin.unsafe(`CREATE DATABASE ${name}`);
url.pathname = '/' + name;
const sql = postgres(url.toString(), { max: 10, fetch_types: false });
const actor = '00000000-0000-4000-8000-000000000001';
const member = '00000000-0000-4000-8000-000000000002';
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  await sql`TRUNCATE relay_internal.requests, relay_internal.run_admissions, relay_internal.budget_versions, usage_logs, user_budgets, test_accounts CASCADE`;
  await sql`INSERT INTO test_accounts VALUES (${actor}::uuid, true, ${actor}, false), (${member}::uuid, true, ${actor}, false)`;
  await sql`INSERT INTO user_budgets(user_id,budget,spend,plan_base) VALUES (${actor},10,0,50)`;
  await run();
  passed++;
  console.log(`PASS ${name}`);
}
const admit = (run: string | null, provider = 'google', user = actor, id = crypto.randomUUID()) =>
  authorize(sql, user, run, provider, id);
try {
  await sql.unsafe(await readFile(new URL('./fixtures/edge-billing.sql', import.meta.url), 'utf8'));
  const migrationConnection = await sql.reserve();
  try {
    await migrationConnection.unsafe(
      await readFile(
        new URL('../docs/migrations/20261027_edge_admission.sql', import.meta.url),
        'utf8',
      ),
    );
    await migrationConnection.unsafe(
      await readFile(
        new URL('../docs/migrations/20261028_edge_snapshots.sql', import.meta.url),
        'utf8',
      ),
    );
  } finally {
    migrationConnection.release();
  }
  await check('paid run continues past credit; new and untagged requests stop', async () => {
    assert.equal(await admit('paid'), 'allowed');
    await sql`UPDATE user_budgets SET spend=20 WHERE user_id=${actor}`;
    assert.equal(await admit('paid'), 'allowed');
    assert.equal(await admit('new'), 'budget_exceeded');
    assert.equal(await admit(null), 'budget_exceeded');
  });
  await check('trial overrun is bounded and cannot admit a new run', async () => {
    await sql`UPDATE user_budgets SET budget=1,plan_base=1 WHERE user_id=${actor}`;
    assert.equal(await admit('trial'), 'allowed');
    await sql`UPDATE user_budgets SET spend=2 WHERE user_id=${actor}`;
    assert.equal(await admit('trial'), 'allowed');
    assert.equal(await admit('new'), 'budget_exceeded');
    await sql`UPDATE user_budgets SET spend=3 WHERE user_id=${actor}`;
    assert.equal(await admit('trial'), 'budget_exceeded');
  });
  await check('twenty concurrent requests share one persisted admission', async () => {
    assert.deepEqual(
      await Promise.all(Array.from({ length: 20 }, () => admit('same'))),
      Array(20).fill('allowed'),
    );
    assert.equal(
      Number((await sql`SELECT count(*) FROM relay_internal.run_admissions`)[0].count),
      1,
    );
    assert.equal(Number((await sql`SELECT count(*) FROM relay_internal.requests`)[0].count), 20);
  });
  await check('concurrent run cap stays bounded across database connections', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => admit(`run-${i}`)));
    assert.equal(
      Number((await sql`SELECT count(*) FROM relay_internal.run_admissions`)[0].count),
      8,
    );
  });
  await check('budget revocation applies to the workspace member too', async () => {
    assert.equal(await admit('member', 'google', member), 'allowed');
    await sql`UPDATE user_budgets SET budget=0 WHERE user_id=${actor}`;
    assert.equal(await admit('member', 'google', member), 'budget_exceeded');
  });
  await check('paid model access is checked even for an admitted run', async () => {
    assert.equal(await admit('paid', 'deepseek'), 'allowed');
    await sql`UPDATE test_accounts SET paid=false WHERE id=${actor}::uuid`;
    assert.equal(await admit('paid', 'deepseek'), 'paid_required');
  });
  await check('incomplete billing or eligibility data fails closed', async () => {
    await sql`UPDATE test_accounts SET paid=NULL WHERE id=${actor}::uuid`;
    assert.equal(await admit('paid', 'deepseek'), 'paid_required');
    await sql`UPDATE user_budgets SET budget=NULL WHERE user_id=${actor}`;
    await assert.rejects(() => admit('missing-balance'), /Incomplete budget record/);
  });
  await check('absolute admin writes revoke even when the plan base is unchanged', async () => {
    await admit('reset');
    await sql`UPDATE user_budgets SET plan_base=plan_base,budget=budget+10 WHERE user_id=${actor}`;
    assert.equal(
      Number((await sql`SELECT count(*) FROM relay_internal.run_admissions`)[0].count),
      0,
    );
  });
  await check('topups preserve existing admissions; budget deletion removes them', async () => {
    await admit('run');
    await sql`UPDATE user_budgets SET budget=budget+10 WHERE user_id=${actor}`;
    assert.equal(
      Number((await sql`SELECT count(*) FROM relay_internal.run_admissions`)[0].count),
      1,
    );
    await sql`DELETE FROM user_budgets WHERE user_id=${actor}`;
    assert.equal(await admit('run'), 'missing_budget');
    assert.equal(
      Number((await sql`SELECT count(*) FROM relay_internal.run_admissions`)[0].count),
      0,
    );
  });
  await check('keepalive/end are scoped and cannot revive expired admissions', async () => {
    await admit('run');
    assert.equal(await runLifecycle(sql, member, 'run', 'keepalive'), false);
    assert.equal(await runLifecycle(sql, actor, 'run', 'keepalive'), true);
    await sql`UPDATE relay_internal.run_admissions SET expires_at=clock_timestamp()-interval '1 second'`;
    assert.equal(await runLifecycle(sql, actor, 'run', 'keepalive'), false);
    assert.equal(await runLifecycle(sql, actor, 'run', 'end'), true);
    assert.equal(await runLifecycle(sql, actor, 'run', 'keepalive'), false);
  });
  await check(
    'duplicate/concurrent queue settlement charges once, including cached tokens',
    async () => {
      const id = crypto.randomUUID();
      await admit('billing', 'deepseek', actor, id);
      const event: UsageObservation = {
        requestId: id,
        userId: actor,
        provider: 'deepseek',
        statusCode: 200,
        latencyMs: 10,
        outcome: 'complete',
        usage: {
          model: 'deepseek-flash',
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 700,
          cacheCreationTokens: 0,
        },
      };
      await Promise.all(Array.from({ length: 10 }, () => settle(sql, event)));
      assert.equal(Number((await sql`SELECT count(*) FROM usage_logs`)[0].count), 1);
      assert.equal(
        (await sql`SELECT spend FROM user_budgets WHERE user_id=${actor}`)[0].spend,
        '0.000574',
      );
      assert.equal((await sql`SELECT outcome FROM relay_internal.requests`)[0].outcome, 'complete');
    },
  );
  await check(
    'interrupted output is explicit and never fabricated as zero-token success',
    async () => {
      const id = crypto.randomUUID();
      await admit('stop', 'google', actor, id);
      await settle(sql, {
        requestId: id,
        userId: actor,
        provider: 'google',
        statusCode: 200,
        latencyMs: 5,
        outcome: 'interrupted',
        usage: null,
      });
      assert.equal(Number((await sql`SELECT count(*) FROM usage_logs`)[0].count), 0);
      assert.equal(
        (await sql`SELECT outcome FROM relay_internal.requests`)[0].outcome,
        'interrupted',
      );
    },
  );
  await check(
    'snapshot resolves shared payer, entitlements and integer account values',
    async () => {
      assert.equal(await resolvePayer(sql, member), actor);
      const value = await snapshot(sql, actor, [actor, member], []);
      assert.equal(value.budget, 10_000_000);
      assert.equal(value.spend, 0);
      assert.equal(value.planBase, 50_000_000);
      assert.equal(value.actors[member].payer, actor);
      assert.equal(value.actors[member].paid, true);
      assert.deepEqual(value.settled, []);
      await sql`UPDATE test_accounts SET paid=false,blocked=true WHERE id=${member}::uuid`;
      const changed = await snapshot(sql, actor, [member], []);
      assert.equal(changed.actors[member].paid, false);
      assert.equal(changed.actors[member].memberLimit, 0);
    },
  );
  await check(
    'snapshot revisions distinguish credit purchases from revoking budget writes',
    async () => {
      const read = () => snapshot(sql, actor, [actor], []);
      const initial = (await read()).revision;
      await sql`UPDATE user_budgets SET budget=budget+1 WHERE user_id=${actor}`;
      assert.equal((await read()).revision, initial);
      await sql`UPDATE user_budgets SET plan_base=plan_base WHERE user_id=${actor}`;
      assert.notEqual((await read()).revision, initial);
      const rev = (await read()).revision;
      await sql`DELETE FROM user_budgets WHERE user_id=${actor}`;
      const missing = await read();
      assert.equal(missing.budget, null);
      assert.notEqual(missing.revision, rev);
    },
  );
  await check('missing numeric billing values fail closed during snapshot load', async () => {
    await sql`UPDATE user_budgets SET spend=null WHERE user_id=${actor}`;
    await assert.rejects(snapshot(sql, actor, [actor], []), /Incomplete account amount/);
  });
  await check(
    'queue settlement creates the deferred ledger row and snapshots include interruptions',
    async () => {
      const id = crypto.randomUUID();
      await settle(sql, {
        requestId: id,
        userId: actor,
        provider: 'google',
        statusCode: 200,
        latencyMs: 5,
        outcome: 'interrupted',
        usage: null,
      });
      assert.deepEqual((await snapshot(sql, actor, [actor], [id])).settled, [id]);
      assert.equal(Number((await sql`SELECT count(*) FROM usage_logs`)[0].count), 0);
    },
  );
  console.log(`${passed} database tests passed`);
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
