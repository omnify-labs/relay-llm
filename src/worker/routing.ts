/** Cache only the payer lookup; credit and usage remain serialized by AccountGate. */
import type {
  DurableObjectNamespace,
  DurableObjectStub,
  DurableObjectLocationHint,
} from '@cloudflare/workers-types';
import {
  type AccountGate,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_REFRESH_MS,
  type AccountEnv,
} from './account.js';
import * as database from './database.js';

export interface RoutingEnv extends AccountEnv {
  ACCOUNTS: DurableObjectNamespace<AccountGate>;
}
export interface AccountHandle {
  accountId: string;
  stub: DurableObjectStub<AccountGate>;
}
interface PayerRoute {
  accountId: string;
  readAt: number;
}
const refreshing = new Map<string, Promise<PayerRoute>>();

function hint(country?: string): DurableObjectLocationHint | undefined {
  if (country && ['CN', 'JP', 'KR', 'TW', 'HK', 'MO'].includes(country)) return 'apac-ne';
  if (country && ['SG', 'IN', 'ID', 'MY', 'TH', 'VN', 'PH'].includes(country)) return 'apac-se';
  return undefined;
}

/** Route a user to one globally unique payer object, with bounded membership staleness. */
export async function openAccount(
  env: RoutingEnv,
  context: { waitUntil(promise: Promise<unknown>): void },
  userId: string,
  country?: string,
  force = false,
): Promise<AccountHandle> {
  const cache = await caches.open('relay-account-routing-v1');
  const key = new Request(`https://relay-routing.invalid/${encodeURIComponent(userId)}`);
  const refresh = (): Promise<PayerRoute> => {
    const existing = refreshing.get(userId);
    if (existing) return existing;
    const promise = (async () => {
      const readAt = Date.now();
      const sql = database.connect(env.HYPERDRIVE);
      try {
        const accountId = await database.resolvePayer(sql, userId);
        const value = { accountId, readAt };
        await cache.put(key, Response.json(value, { headers: { 'cache-control': 'max-age=30' } }));
        return value;
      } finally {
        await sql.end({ timeout: 1 });
      }
    })().finally(() => {
      refreshing.delete(userId);
    });
    refreshing.set(userId, promise);
    return promise;
  };
  const cached = force ? undefined : await cache.match(key);
  let route = cached ? ((await cached.json()) as PayerRoute) : null;
  if (!route || Date.now() - route.readAt >= SNAPSHOT_MAX_AGE_MS) route = await refresh();
  else if (Date.now() - route.readAt >= SNAPSHOT_REFRESH_MS)
    context.waitUntil(
      refresh().catch(() => {
        console.error('[Relay] Payer route refresh failed');
      }),
    );
  if (Date.now() - route.readAt >= SNAPSHOT_MAX_AGE_MS) throw new Error('Payer route expired');
  const id = env.ACCOUNTS.idFromName(route.accountId);
  return {
    accountId: route.accountId,
    stub: env.ACCOUNTS.get(id, { locationHint: hint(country) }),
  };
}
