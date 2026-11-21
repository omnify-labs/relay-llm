import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { proxyHandler } from '../proxy/handler.js';
import { requestTiming, TIMING_EXPOSE_HEADERS } from '../proxy/timing.js';

afterEach(() => vi.restoreAllMocks());

function app(runtime: 'node' | 'cloudflare-worker' = 'node') {
  const router = new Hono<{ Variables: { userId: string } }>();
  router.use('*', requestTiming(runtime));
  router.use('*', cors({ origin: '*', exposeHeaders: TIMING_EXPOSE_HEADERS }));
  return router;
}

describe('request timing', () => {
  it('includes admission, returns before stream completion and preserves request/response bytes', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const observe = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect(await new Response(init?.body).text()).toBe(' {"model":"deepseek-flash"} ');
      expect(new Headers(init?.headers).has('x-dassi-model')).toBe(false);
      clock += 150;
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const router = app();
    router.use('/v1/*', async (c, next) => {
      c.set('userId', 'test');
      clock += 50;
      await next();
    });
    router.post(
      '/v1/deepseek/chat/completions',
      proxyHandler('deepseek', { apiKey: 'test-key', observe }),
    );
    const response = await router.request('/v1/deepseek/chat/completions', {
      method: 'POST',
      body: ' {"model":"deepseek-flash"} ',
      headers: {
        'cf-ipcountry': 'DE',
        'x-request-id': 'dassi-test-123',
        'x-dassi-model': 'deepseek-flash',
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(response.headers.get('server-timing')).toBe(
      'relay_headers;dur=200.00, relay_pre_upstream;dur=50.00, upstream_headers;dur=150.00',
    );
    expect(response.headers.get('x-relay-country')).toBe('DE');
    expect(response.headers.get('x-relay-runtime')).toBe('node');
    expect(response.headers.get('access-control-expose-headers')).toContain('server-timing');
    expect(response.headers.get('timing-allow-origin')).toBe('*');
    const bytes = new TextEncoder().encode('data: {"text":"你好"}\n\n');
    controller.enqueue(bytes);
    controller.close();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"clientRequestId":"dassi-test-123"'));
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
  });

  it.each([undefined, 'not-a-country'])(
    'marks unavailable country unknown and times rejected requests',
    async (country) => {
      const router = app('cloudflare-worker');
      router.post('/denied', (c) => c.json({ error: 'denied' }, 401));
      const response = await router.request('/denied', {
        method: 'POST',
        headers: country ? { 'cf-ipcountry': country } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('x-relay-country')).toBe('unknown');
      expect(response.headers.get('server-timing')).toMatch(/^relay_headers;dur=\d+\.\d+$/);
      expect(response.headers.get('x-relay-request-id')).toBeTruthy();
    },
  );

  it('keeps health uncached and tolerates a broken log sink', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('logging unavailable');
    });
    const router = app();
    router.get('/health', (c) => c.json({ status: 'ok' }));
    const response = await router.request('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('times provider failures without fabricating an upstream-header measurement', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('private upstream URL'));
    const router = app();
    router.post('/v1/deepseek/chat/completions', proxyHandler('deepseek', { apiKey: 'test-key' }));
    const response = await router.request('/v1/deepseek/chat/completions', {
      method: 'POST',
    });
    expect(response.status).toBe(502);
    expect(response.headers.get('server-timing')).toContain('relay_pre_upstream');
    expect(response.headers.get('server-timing')).not.toContain('upstream_headers');
    expect(await response.text()).not.toContain('private');
  });
});
