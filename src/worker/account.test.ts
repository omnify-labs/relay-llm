/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { DurableObjectNamespace, DurableObjectStub, Queue } from '@cloudflare/workers-types';
import { AccountGate, type AdmissionInput, type AccountEnv } from './account.js';
import * as database from './database.js';
import type { UsageObservation } from '../proxy/handler.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    ACCOUNTS: DurableObjectNamespace<AccountGate>;
  }
}
const actor = '00000000-0000-4000-8000-000000000001';
const member = '00000000-0000-4000-8000-000000000002';
const accountId = '00000000-0000-4000-8000-000000000003';
let stub: DurableObjectStub<AccountGate>;
let value: database.AccountSnapshot;
let send: ReturnType<typeof vi.fn>;
const request = (runId: string | null = 'run', userId = actor): AdmissionInput => ({
  accountId,
  userId,
  runId,
  provider: 'google',
  requestId: crypto.randomUUID(),
});
const observation = (input: AdmissionInput): UsageObservation => ({
  userId: input.userId,
  provider: 'google',
  requestId: input.requestId,
  statusCode: 200,
  latencyMs: 10,
  outcome: 'complete',
  usage: {
    model: 'gemini-3.8-flash',
    inputTokens: 20_000_000,
    outputTokens: 20_000_000,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
  },
});

beforeEach(async () => {
  value = {
    budget: 5_000_000,
    spend: 0,
    planBase: 50_000_000,
    revision: '0',
    settled: [],
    actors: Object.fromEntries(
      [actor, member].map((id) => [
        id,
        { payer: accountId, paid: true, memberLimit: null, memberSpend: 0 },
      ]),
    ),
  };
  vi.spyOn(database, 'connect').mockReturnValue({
    end: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof database.connect>);
  vi.spyOn(database, 'snapshot').mockImplementation(async (_sql, _account, actors) =>
    structuredClone({
      ...value,
      actors: Object.fromEntries(actors.map((id) => [id, value.actors[id]])),
    }),
  );
  send = vi.fn(async () => {});
  stub = env.ACCOUNTS.get(env.ACCOUNTS.newUniqueId());
  await runInDurableObject(stub, (instance) => {
    Object.assign(instance, {
      env: {
        HYPERDRIVE: {},
        USAGE_QUEUE: { sendBatch: send } as unknown as Queue<UsageObservation>,
      },
    });
  });
});
afterEach(() => vi.restoreAllMocks());
// This pool pops isolated storage before afterEach. Drain work inside the test.
const it = (name: string, run: () => Promise<void>) =>
  test(name, async () => {
    try {
      await run();
    } finally {
      await runInDurableObject(stub, async (instance, state) => {
        await Promise.allSettled([
          Reflect.get(instance, 'refreshing'),
          Reflect.get(instance, 'flushing'),
        ]);
        await state.storage.deleteAlarm();
      });
    }
  });

it('twenty concurrent calls share one snapshot and keep the warm path off Postgres', async () => {
  expect(await Promise.all(Array.from({ length: 20 }, () => stub.authorize(request())))).toEqual(
    Array(20).fill('allowed'),
  );
  expect(database.snapshot).toHaveBeenCalledTimes(1);
  expect(await stub.authorize(request())).toBe('allowed');
  expect(database.snapshot).toHaveBeenCalledTimes(1);
});

it('a member arriving during another actor refresh loads its own policy', async () => {
  expect(
    await Promise.all([stub.authorize(request()), stub.authorize(request('member', member))]),
  ).toEqual(['allowed', 'allowed']);
  expect(database.snapshot).toHaveBeenCalledTimes(2);
});

it('defers new queue charges until an in-flight snapshot finishes', async () => {
  const input = request();
  await stub.authorize(input);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(database.snapshot).mockImplementationOnce(async () => {
    await paused;
    return structuredClone(value);
  });
  const alarm = runDurableObjectAlarm(stub);
  await vi.waitFor(() => expect(database.snapshot).toHaveBeenCalledTimes(2));
  await stub.observe(observation(input));
  expect(send).not.toHaveBeenCalled();
  release();
  await alarm;
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
});

it('paid runs continue while local usage immediately blocks the next run, without double debits', async () => {
  value.budget = 1;
  const input = request();
  expect(await stub.authorize(input)).toBe('allowed');
  const event = observation(input);
  await stub.observe(event);
  await stub.observe(event);
  expect(await stub.authorize(request())).toBe('allowed');
  expect(await stub.authorize(request('next'))).toBe('budget_exceeded');
  const cost = await runInDurableObject(
    stub,
    (_instance, state) =>
      state.storage.sql.exec('SELECT sum(cost) AS cost FROM requests').one().cost,
  );
  expect(cost).toBe(database.observationCost(event));
});

it('trial runs share the bounded two-dollar overrun, including concurrent workspace members', async () => {
  const first = request();
  const cost = database.observationCost(observation(first));
  expect(cost).toBeGreaterThan(1_000_000);
  value.budget = cost - 1_000_000;
  value.planBase = 5_000_000;
  expect(await stub.authorize(first)).toBe('allowed');
  await stub.observe(observation(first));
  expect(await stub.authorize(request('member', member))).toBe('budget_exceeded');
  const second = request();
  expect(await stub.authorize(second)).toBe('allowed');
  await stub.observe(observation(second));
  expect(await stub.authorize(request())).toBe('budget_exceeded');
});

it('reconciles a committed charge without counting it twice after refresh', async () => {
  const input = request();
  const event = observation(input);
  const cost = database.observationCost(event);
  value.budget = cost + 1;
  expect(await stub.authorize(input)).toBe('allowed');
  await stub.observe(event);
  value.spend = cost;
  value.settled = [input.requestId];
  await runDurableObjectAlarm(stub);
  expect(await stub.authorize(request('next'))).toBe('allowed');
});

it('retains a failed enqueue durably and retries it from the alarm', async () => {
  send.mockRejectedValueOnce(new Error('queue unavailable'));
  const input = request();
  await stub.authorize(input);
  await stub.observe(observation(input));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql.exec('SELECT enqueued FROM requests').one().enqueued,
    ),
  ).toBe(0);
  await runDurableObjectAlarm(stub);
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) => state.storage.sql.exec('SELECT enqueued FROM requests').one().enqueued,
    ),
  ).toBe(1);
});

it('fails closed after snapshot expiry when the database is unavailable', async () => {
  await stub.authorize(request());
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('UPDATE account SET read_at=?', Date.now() - 31_000);
  });
  vi.mocked(database.snapshot).mockRejectedValueOnce(new Error('database unavailable'));
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.authorize(request())).rejects.toThrow('database unavailable');
  });
});

it('budget revision changes revoke existing runs on refresh', async () => {
  await stub.authorize(request());
  value.budget = 0;
  value.revision = '1';
  await runDurableObjectAlarm(stub);
  expect(await stub.authorize(request())).toBe('budget_exceeded');
});

it('paid eligibility and payer changes apply when the snapshot refreshes', async () => {
  const input = { ...request(), provider: 'deepseek' };
  expect(await stub.authorize(input)).toBe('allowed');
  value.actors[actor].paid = false;
  await runDurableObjectAlarm(stub);
  expect(await stub.authorize({ ...request(), provider: 'deepseek' })).toBe('paid_required');
  value.actors[actor].payer = 'another-account';
  await runDurableObjectAlarm(stub);
  expect(await stub.authorize(request())).toBe('payer_changed');
});

it('member caps include local unsettled usage', async () => {
  value.planBase = 5_000_000;
  value.budget = 1_000_000_000;
  value.actors[member].memberLimit = 1;
  const input = request('member', member);
  expect(await stub.authorize(input)).toBe('allowed');
  await stub.observe(observation(input));
  expect(await stub.authorize(request('member', member))).toBe('member_limit');
});

it('run end, keepalive and the per-user cap preserve admission boundaries', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => stub.authorize(request(`run-${i}`))));
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec('SELECT count(*) AS count FROM runs').one().count,
    ),
  ).toBe(8);
  expect(await stub.lifecycle(actor, 'unknown', 'keepalive')).toBe(false);
  expect(await stub.lifecycle(actor, 'run-0', 'keepalive')).toBe(true);
  await stub.lifecycle(actor, 'run-0', 'end');
  expect(await stub.lifecycle(actor, 'run-0', 'keepalive')).toBe(false);
});

it('rejects fabricated observations before debiting or enqueueing', async () => {
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.observe(observation(request()))).rejects.toThrow('Unknown usage request');
  });
  expect(send).not.toHaveBeenCalled();
});

it('a new object instance retains its local debits and run state', async () => {
  value.budget = 1;
  const input = request();
  await stub.authorize(input);
  await stub.observe(observation(input));
  const result = await runInDurableObject(stub, (_instance, state) => {
    const instance = new AccountGate(state, {
      HYPERDRIVE: {},
      USAGE_QUEUE: { sendBatch: send },
    } as unknown as AccountEnv);
    return instance.authorize(request('next'));
  });
  expect(result).toBe('budget_exceeded');
  expect(database.snapshot).toHaveBeenCalledTimes(1);
});
