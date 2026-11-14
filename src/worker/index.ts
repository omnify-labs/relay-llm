/** Global native-provider gateway. Account state and streaming take separate paths. */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Hyperdrive, Queue, MessageBatch, ExportedHandler } from '@cloudflare/workers-types';
import { createAuthMiddleware } from '../auth/jwt.js';
import { proxyHandler, type UsageObservation } from '../proxy/handler.js';
import type { ProviderName } from '../proxy/providers.js';
import * as database from './database.js';
import { openAccount, type RoutingEnv } from './routing.js';
import { googleTarget, type GoogleBindings } from './google.js';
export { AccountGate } from './account.js';

export interface WorkerEnv extends RoutingEnv, GoogleBindings {
  JWT_SECRET: string;
  DEEPSEEK_API_KEY: string;
  /** Explicit account IDs for the pilot; '*' enables general access after validation. */
  ALLOWED_USER_IDS: string;
  HYPERDRIVE: Hyperdrive;
  USAGE_QUEUE: Queue<UsageObservation>;
}

type WorkerServices = { openAccount: typeof openAccount };
type QueueServices = Pick<typeof database, 'connect' | 'settle'>;
const runIdValid = (id: string) => /^[a-zA-Z0-9._:-]{1,128}$/.test(id);
const admissionErrors: Record<string, { status: 402 | 403; error: string }> = {
  paid_required: {
    status: 403,
    error: 'Dassi Pro requires an active paid subscription. Choose Dassi Flash or Dassi Lite.',
  },
  missing_budget: {
    status: 403,
    error: 'No budget record found. Please set up billing.',
  },
  budget_exceeded: { status: 402, error: 'Budget exceeded' },
  member_limit: { status: 402, error: 'Member limit reached' },
};

/** Build the actual Worker router; injected services isolate external I/O in tests. */
export function createWorkerApp(services: WorkerServices = { openAccount }) {
  const app = new Hono<{
    Bindings: WorkerEnv;
    Variables: { userId: string };
  }>();
  app.use('*', cors({ origin: '*', exposeHeaders: ['x-relay-request-id'] }));
  app.get('/health', (c) => c.json({ status: 'ok', runtime: 'cloudflare-worker' }));
  app.use('/v1/*', async (c, next) => {
    if (!c.env.JWT_SECRET) return c.json({ error: 'Gateway is not configured' }, 503);
    return createAuthMiddleware(new TextEncoder().encode(c.env.JWT_SECRET))(c, next);
  });
  app.use('/v1/*', async (c, next) => {
    const allowed = (c.env.ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim());
    if (!allowed.includes('*') && !allowed.includes(c.get('userId')))
      return c.json({ error: 'Account is not enabled for this gateway' }, 403);
    await next();
  });

  const forward =
    (provider: Extract<ProviderName, 'google' | 'deepseek'>) =>
    async (c: Context<{ Bindings: WorkerEnv; Variables: { userId: string } }>) => {
      const runId = c.req.header('x-dassi-run-id') || null;
      if (runId && !runIdValid(runId)) return c.json({ error: 'Invalid run ID' }, 400);
      if (
        provider === 'google' &&
        !/^[a-zA-Z0-9._-]+:(streamGenerateContent|generateContent)$/.test(
          c.req.param('operation') ?? '',
        )
      ) {
        return c.json({ error: 'Unsupported provider endpoint' }, 404);
      }
      const requestId = crypto.randomUUID();
      const target =
        provider === 'google'
          ? googleTarget(c.env)
          : c.env.DEEPSEEK_API_KEY
            ? { apiKey: c.env.DEEPSEEK_API_KEY }
            : null;
      if (!target || !c.env.USAGE_QUEUE || !c.env.HYPERDRIVE || !c.env.ACCOUNTS)
        return c.json({ error: 'Gateway is not configured' }, 503);
      const started = Date.now();
      const cf = (c.req.raw as Request & { cf?: { country?: string } }).cf;
      const country = cf?.country;
      let account = await services
        .openAccount(c.env, c.executionCtx, c.get('userId'), country)
        .catch((error) => {
          console.error('[Relay] Payer routing failed');
          throw error;
        });
      const input = { userId: c.get('userId'), runId, provider, requestId };
      let admission = await account.stub
        .authorize({
          ...input,
          accountId: account.accountId,
        })
        .catch((error) => {
          console.error('[Relay] Account admission failed');
          throw error;
        });
      if (admission === 'payer_changed') {
        account = await services.openAccount(c.env, c.executionCtx, c.get('userId'), country, true);
        admission = await account.stub.authorize({
          ...input,
          accountId: account.accountId,
        });
      }
      if (admission !== 'allowed') {
        const denied = admissionErrors[admission];
        if (!denied) throw new Error('Unexpected admission result');
        return c.json({ error: denied.error }, denied.status);
      }
      console.log(
        JSON.stringify({
          event: 'admitted',
          requestId,
          provider,
          admissionMs: Date.now() - started,
        }),
      );
      const response = await proxyHandler(provider, {
        ...target,
        requestId,
        observe: (event) => account.stub.observe(event),
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      })(c, async () => {});
      if (!(response instanceof Response)) throw new Error('Missing provider response');
      if (!response.ok || !response.body) {
        c.executionCtx.waitUntil(
          account.stub
            .observe({
              requestId,
              userId: c.get('userId'),
              provider,
              statusCode: response.status,
              latencyMs: Date.now() - started,
              outcome: c.req.raw.signal.aborted ? 'interrupted' : 'unavailable',
              usage: null,
            })
            .catch(() => {
              console.error(`[Relay] Usage observation failed request=${requestId}`);
            }),
        );
      }
      response.headers.set('x-relay-request-id', requestId);
      return response;
    };
  app.post('/v1/deepseek/chat/completions', forward('deepseek'));
  app.post('/v1/google/v1beta/models/:operation', forward('google'));
  app.post('/v1/runs/:runId/:action', async (c) => {
    const { runId, action } = c.req.param();
    if (!runIdValid(runId) || !['end', 'keepalive'].includes(action))
      return c.json({ error: 'Invalid run operation' }, 400);
    const account = await services.openAccount(c.env, c.executionCtx, c.get('userId'));
    const alive = await account.stub.lifecycle(c.get('userId'), runId, action);
    return c.json(action === 'end' ? { ended: true } : { alive });
  });
  app.onError((error) => {
    // Driver messages may contain connection strings; stable error codes are safe to log.
    const code =
      'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
        ? error.code
        : undefined;
    console.error('[Relay] Edge request failed', { name: error.name, code });
    return Response.json(
      { error: 'Unable to authorize request. Please try again.' },
      { status: 503 },
    );
  });
  return app;
}

/** Consume each usage message independently; retry errors without acknowledging them. */
export async function consumeUsage(
  batch: MessageBatch<UsageObservation>,
  env: WorkerEnv,
  services: QueueServices = database,
): Promise<void> {
  const sql = services.connect(env.HYPERDRIVE);
  try {
    for (const message of batch.messages) {
      try {
        await services.settle(sql, message.body);
        message.ack();
      } catch {
        console.error('[Relay] Usage settlement failed');
        message.retry();
      }
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const app = createWorkerApp();
const queue: NonNullable<ExportedHandler<WorkerEnv, UsageObservation>['queue']> = (batch, env) =>
  consumeUsage(batch, env);
// Workers requires a default entrypoint; all reusable modules retain named exports.
export default {
  fetch: app.fetch,
  // Cloudflare passes ExecutionContext as argument three, not our test service overrides.
  queue,
};
