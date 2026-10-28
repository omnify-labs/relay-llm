import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { proxyHandler, type ProxyOptions } from '../proxy/handler.js';
import { googleTarget } from '../worker/google.js';

const now = Date.parse('2026-10-28T22:00:00Z');
const cloud = {
  GOOGLE_VERTEX_PROJECT: 'relay-test-project',
  GOOGLE_VERTEX_ACCESS_TOKEN: 'short-lived-secret',
  GOOGLE_VERTEX_TOKEN_EXPIRES_AT: '2026-10-28T23:00:00Z',
};
afterEach(() => vi.unstubAllGlobals());

describe('Google Cloud staging credentials', () => {
  it('uses AI Studio only when Cloud is not configured', () => {
    expect(googleTarget({ GOOGLE_API_KEY: 'studio' }, now)).toEqual({
      apiKey: 'studio',
    });
    expect(googleTarget({}, now)).toBeNull();
    expect(googleTarget({ ...cloud, GOOGLE_API_KEY: 'studio' }, now)).toEqual({
      googleCloud: {
        project: 'relay-test-project',
        accessToken: 'short-lived-secret',
      },
    });
  });
  it.each([
    { GOOGLE_VERTEX_PROJECT: '' },
    { GOOGLE_VERTEX_PROJECT: 'project/../../attacker' },
    { GOOGLE_VERTEX_ACCESS_TOKEN: '' },
    { GOOGLE_VERTEX_TOKEN_EXPIRES_AT: '' },
    { GOOGLE_VERTEX_TOKEN_EXPIRES_AT: 'invalid' },
    { GOOGLE_VERTEX_TOKEN_EXPIRES_AT: '2026-10-28T21:59:59Z' },
    { GOOGLE_VERTEX_TOKEN_EXPIRES_AT: '2026-10-28T22:01:00Z' },
  ])('fails closed without falling back for %j', (override) => {
    expect(googleTarget({ ...cloud, ...override, GOOGLE_API_KEY: 'studio' }, now)).toBeNull();
  });
});

describe('native Google Cloud forwarding', () => {
  const body = ' { "contents": [{"parts":[{"text":"你好"}]}], "tools": [] } ';
  const native =
    '{"modelVersion":"gemini-3.8-flash","usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"thoughtsTokenCount":12}}';
  const target = googleTarget(cloud, now)!;
  function app(options: ProxyOptions = target) {
    const app = new Hono();
    app.post('/v1/google/*', proxyHandler('google', options));
    return app;
  }
  it.each([true, false])('preserves bytes and observes once (stream=%s)', async (stream) => {
    const output = stream ? `data: ${native}\n\n` : native;
    const operation = stream ? 'streamGenerateContent' : 'generateContent';
    const observe = vi.fn(async () => {});
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      expect(await new Response(init?.body).text()).toBe(body);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer short-lived-secret');
      for (const name of [
        'cookie',
        'x-goog-api-key',
        'x-goog-user-project',
        'x-dassi-run-id',
        'x-forwarded-for',
      ])
        expect(headers.get(name)).toBeNull();
      return new Response(output, {
        headers: {
          'content-type': stream ? 'text/event-stream' : 'application/json',
          authorization: 'Bearer provider-secret',
        },
      });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await app({ ...target, observe }).request(
      `/v1/google/v1beta/models/gemini-3.8-flash:${operation}?alt=sse&key=evil&api_key=evil&access_token=evil`,
      {
        method: 'POST',
        body,
        headers: {
          authorization: 'Bearer client-jwt',
          cookie: 'private',
          'x-goog-api-key': 'evil',
          'x-goog-user-project': 'evil',
          'x-dassi-run-id': 'run',
          'x-forwarded-for': '127.0.0.1',
        },
      },
    );
    expect(await response.text()).toBe(output);
    expect(response.headers.get('authorization')).toBeNull();
    expect(upstream.mock.calls[0][0]).toBe(
      `https://aiplatform.googleapis.com/v1/projects/relay-test-project/locations/global/publishers/google/models/gemini-3.8-flash:${operation}?alt=sse`,
    );
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        outcome: 'complete',
        usage: expect.objectContaining({ inputTokens: 20, outputTokens: 17 }),
      }),
    );
  });
  it('returns provider auth errors without retries or usage charges', async () => {
    const observe = vi.fn(async () => {});
    const upstream = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', upstream);
    const response = await app({ ...target, observe }).request(
      '/v1/google/v1beta/models/gemini-3.8-flash:generateContent',
      { method: 'POST', body },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('unauthorized');
    expect(upstream).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
  });
  it('rejects invalid destinations and unsupported operations before fetch', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await app({
      googleCloud: { project: 'evil/host', accessToken: 'secret' },
    }).request('/v1/google/v1beta/models/gemini:generateContent', {
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(
      (
        await app().request('/v1/google/v1beta/models/gemini:delete', {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
