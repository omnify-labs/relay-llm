/// <reference types="@cloudflare/vitest-pool-workers" />
import { createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import worker, { createWorkerApp, consumeUsage, type WorkerEnv } from './index.js';
import type { UsageObservation } from '../proxy/handler.js';
import * as database from './database.js';
import type { MessageBatch } from '@cloudflare/workers-types';

const userId = '00000000-0000-4000-8000-000000000001';
const secret = 'edge-test-signing-key';
const encoder = new TextEncoder();
const usages: UsageObservation[] = [];
const end = vi.fn(async () => {});
const services = {
  connect: vi.fn(() => ({ end }) as unknown as ReturnType<typeof database.connect>),
  authorize: vi.fn(async () => 'allowed'),
  runLifecycle: vi.fn(async () => true),
  settle: vi.fn(async () => {}),
};
const bindings = {
  JWT_SECRET: secret,
  GOOGLE_API_KEY: 'google-secret',
  DEEPSEEK_API_KEY: 'deepseek-secret',
  ALLOWED_USER_IDS: userId,
  HYPERDRIVE: {},
  USAGE_QUEUE: {
    send: vi.fn(async (event: UsageObservation) => {
      usages.push(event);
    }),
  },
} as unknown as WorkerEnv;
let token: string;

beforeEach(async () => {
  vi.clearAllMocks();
  usages.length = 0;
  services.authorize.mockResolvedValue('allowed');
  fetchMock.activate();
  fetchMock.disableNetConnect();
  token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setExpirationTime('1h')
    .sign(encoder.encode(secret));
});
afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
});

async function request(
  path = '/v1/deepseek/chat/completions',
  body = '{ "model": "deepseek-flash", "stream": true }',
  auth = token,
) {
  const context = createExecutionContext();
  const response = await createWorkerApp(services).fetch(
    new Request('https://relay.test' + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth}`,
        'content-type': 'application/json',
        'x-dassi-run-id': 'run-1',
        cookie: 'private-cookie',
      },
      body,
    }),
    bindings,
    context,
  );
  const text = await response.text();
  await waitOnExecutionContext(context);
  return { response, text };
}

const deepseekSse =
  'data: {"model":"deepseek-flash","choices":[{"delta":{"reasoning_content":"想"}}]}\r\n\r\n' +
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"check","arguments":"{}"}}]}}]}\n\n' +
  'data: {"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_cache_hit_tokens":700}}\n\ndata: [DONE]\n\n';

describe('actual Worker routes', () => {
  it('streams provider-native DeepSeek content with server credentials and one usage event', async () => {
    const body = '{ "model": "deepseek-flash", "stream": true }';
    fetchMock
      .get('https://api.deepseek.com')
      .intercept({
        path: '/chat/completions',
        method: 'POST',
        body,
        headers: { authorization: 'Bearer deepseek-secret', 'accept-encoding': 'identity' },
      })
      .reply(200, deepseekSse, { headers: { 'content-type': 'text/event-stream' } });
    const result = await request();
    expect(result.response.status).toBe(200);
    expect(result.text).toBe(deepseekSse);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      userId,
      provider: 'deepseek',
      outcome: 'complete',
      usage: {
        model: 'deepseek-flash',
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 700,
      },
    });
    expect(result.response.headers.get('x-relay-request-id')).toBe(usages[0].requestId);
  });
  it('preserves Google query parameters but replaces user-supplied keys', async () => {
    const body = '{"contents":[{"parts":[{"inlineData":{"mimeType":"image/png","data":"AA=="}}]}]}';
    const sse =
      'data: {"modelVersion":"gemini-3.8-flash","usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":5}}\n\n';
    fetchMock
      .get('https://generativelanguage.googleapis.com')
      .intercept({
        path: '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=google-secret',
        method: 'POST',
        body,
      })
      .reply(200, sse, { headers: { 'content-type': 'text/event-stream' } });
    const result = await request(
      '/v1/google/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=attacker',
      body,
    );
    expect(result.text).toBe(sse);
    expect(usages[0].usage?.inputTokens).toBe(30);
  });
  it.each(['', 'tampered'])(
    'rejects invalid authentication before billing or provider I/O (%s)',
    async (auth) => {
      expect((await request(undefined, undefined, auth)).response.status).toBe(401);
      expect(services.authorize).not.toHaveBeenCalled();
    },
  );
  it('rejects expired tokens', async () => {
    const expired = await new SignJWT({})
      .setSubject(userId)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(1)
      .sign(encoder.encode(secret));
    expect((await request(undefined, undefined, expired)).response.status).toBe(401);
  });
  it.each([
    ['budget_exceeded', 402],
    ['paid_required', 403],
    ['missing_budget', 403],
  ])('rejects %s before provider access', async (reason, status) => {
    services.authorize.mockResolvedValue(String(reason));
    expect((await request()).response.status).toBe(status);
    expect(usages).toHaveLength(0);
  });
  it('fails closed on database errors without leaking exception secrets', async () => {
    services.authorize.mockRejectedValueOnce(new Error('postgres://secret'));
    const result = await request();
    expect(result.response.status).toBe(503);
    expect(result.text).not.toContain('secret');
  });
  it('passes provider rate limits through without a charge', async () => {
    fetchMock
      .get('https://api.deepseek.com')
      .intercept({ path: '/chat/completions', method: 'POST' })
      .reply(429, '{"error":"rate limited"}');
    const result = await request();
    expect(result.response.status).toBe(429);
    expect(result.text).toBe('{"error":"rate limited"}');
    expect(usages[0].usage).toBeNull();
  });
  it('rejects redirects instead of sending provider credentials to another host', async () => {
    fetchMock
      .get('https://api.deepseek.com')
      .intercept({ path: '/chat/completions', method: 'POST' })
      .reply(307, '', { headers: { location: 'https://attacker.test' } });
    expect((await request()).response.status).toBe(502);
  });
  it('keeps missing usage explicitly unresolved', async () => {
    fetchMock
      .get('https://api.deepseek.com')
      .intercept({ path: '/chat/completions', method: 'POST' })
      .reply(200, 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await request();
    expect(usages[0]).toMatchObject({ outcome: 'unavailable', usage: null });
  });
  it('forwards lifecycle calls for the authenticated user', async () => {
    const result = await request('/v1/runs/run-1/keepalive');
    expect(JSON.parse(result.text)).toEqual({ alive: true });
    expect(services.runLifecycle).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      'run-1',
      'keepalive',
    );
  });
  it('rejects unsupported provider routes', async () => {
    expect((await request('/v1/google/v1beta/models/gemini:delete')).response.status).toBe(404);
    expect(services.authorize).not.toHaveBeenCalled();
  });
});

it('acknowledges settled messages and retries only failed settlements', async () => {
  services.settle
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('database down'));
  const messages = [0, 1].map(() => ({
    body: {} as UsageObservation,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  await consumeUsage({ messages } as unknown as MessageBatch<UsageObservation>, bindings, services);
  expect(messages[0].ack).toHaveBeenCalledOnce();
  expect(messages[0].retry).not.toHaveBeenCalled();
  expect(messages[1].ack).not.toHaveBeenCalled();
  expect(messages[1].retry).toHaveBeenCalledOnce();
});

it('the deployed queue entrypoint ignores the runtime ExecutionContext as service overrides', async () => {
  vi.spyOn(database, 'connect').mockImplementation(services.connect);
  vi.spyOn(database, 'settle').mockResolvedValue(undefined);
  const message = { body: {} as UsageObservation, ack: vi.fn(), retry: vi.fn() };
  await Reflect.apply(worker.queue, undefined, [
    { messages: [message] },
    bindings,
    createExecutionContext(),
  ]);
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
});

it('delivers the first bytes before completion and observes split Unicode/SSE correctly', async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller;
    },
  });
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );
  const context = createExecutionContext();
  try {
    const response = await createWorkerApp(services).fetch(
      new Request('https://relay.test/v1/deepseek/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      }),
      bindings,
      context,
    );
    const reader = response.body!.getReader();
    const first = encoder.encode(
      'data: {"model":"deepseek-flash","choices":[{"delta":{"content":"你好"}}]}\n\n',
    );
    upstream.enqueue(first.slice(0, 10));
    expect((await reader.read()).value).toEqual(first.slice(0, 10));
    expect(usages).toHaveLength(0);
    for (const byte of first.slice(10)) upstream.enqueue(new Uint8Array([byte]));
    upstream.enqueue(
      encoder.encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'),
    );
    upstream.close();
    while (!(await reader.read()).done) {
      /* drain the client */
    }
    await waitOnExecutionContext(context);
    expect(usages[0]).toMatchObject({
      outcome: 'complete',
      usage: { model: 'deepseek-flash', inputTokens: 10, outputTokens: 2 },
    });
  } finally {
    fetchSpy.mockRestore();
  }
});

it('client cancellation aborts the provider once and records interrupted usage', async () => {
  let providerAborted = 0;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"model":"deepseek-flash"}\n\n'));
            init?.signal?.addEventListener(
              'abort',
              () => {
                providerAborted++;
                controller.error(new DOMException('Canceled', 'AbortError'));
              },
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const context = createExecutionContext();
  try {
    const response = await createWorkerApp(services).fetch(
      new Request('https://relay.test/v1/deepseek/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      }),
      bindings,
      context,
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitOnExecutionContext(context);
    expect(providerAborted).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(usages[0]).toMatchObject({ outcome: 'interrupted', usage: null });
  } finally {
    fetchSpy.mockRestore();
  }
});
