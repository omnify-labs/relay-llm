import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { openAccount, type RoutingEnv } from './routing.js';
import * as database from './database.js';

let userId: string;
let env: RoutingEnv;
let background: Promise<unknown>[];
const context = {
  waitUntil: (promise: Promise<unknown>) => {
    background.push(promise);
  },
};

beforeEach(() => {
  userId = crypto.randomUUID();
  background = [];
  env = {
    HYPERDRIVE: {},
    ACCOUNTS: { idFromName: vi.fn((id) => id), get: vi.fn(() => ({})) },
  } as unknown as RoutingEnv;
  vi.spyOn(database, 'connect').mockReturnValue({
    end: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof database.connect>);
  vi.spyOn(database, 'resolvePayer').mockResolvedValue('payer');
});
afterEach(() => vi.restoreAllMocks());

async function seed(age: number) {
  const cache = await caches.open('relay-account-routing-v1');
  await cache.put(
    new Request(`https://relay-routing.invalid/${userId}`),
    Response.json(
      { accountId: 'old-payer', readAt: Date.now() - age },
      { headers: { 'cache-control': 'max-age=30' } },
    ),
  );
}

it('resolves a cold payer once, caches it and hints East Asia placement', async () => {
  expect((await openAccount(env, context, userId, 'JP')).accountId).toBe('payer');
  await openAccount(env, context, userId, 'JP');
  expect(database.resolvePayer).toHaveBeenCalledTimes(1);
  expect(env.ACCOUNTS.get).toHaveBeenLastCalledWith('payer', {
    locationHint: 'apac-ne',
  });
});

it('serves a fresh route while refreshing an older one in the background', async () => {
  await seed(11_000);
  expect((await openAccount(env, context, userId)).accountId).toBe('old-payer');
  await Promise.all(background);
  expect((await openAccount(env, context, userId)).accountId).toBe('payer');
});

it('fails closed after hard expiry even when Cache API still contains a value', async () => {
  await seed(31_000);
  vi.mocked(database.resolvePayer).mockRejectedValue(new Error('offline'));
  await expect(openAccount(env, context, userId)).rejects.toThrow('offline');
  expect(env.ACCOUNTS.get).not.toHaveBeenCalled();
});

it('forces a fresh lookup when an account reports changed membership', async () => {
  await seed(0);
  expect((await openAccount(env, context, userId, 'SG', true)).accountId).toBe('payer');
  expect(database.resolvePayer).toHaveBeenCalledTimes(1);
  expect(env.ACCOUNTS.get).toHaveBeenLastCalledWith('payer', {
    locationHint: 'apac-se',
  });
});

it('coalesces concurrent cold lookups', async () => {
  await Promise.all(Array.from({ length: 20 }, () => openAccount(env, context, userId)));
  expect(database.resolvePayer).toHaveBeenCalledTimes(1);
});
