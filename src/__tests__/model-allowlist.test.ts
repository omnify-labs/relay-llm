import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { isManagedModelRequest, modelAllowlistMiddleware } from '../proxy/model-allowlist.js';

const stream = (model: string) => `/v1/google/v1beta/models/${model}:streamGenerateContent`;

describe('isManagedModelRequest', () => {
  it('allows the managed Gemini models on the generate methods Dassi calls', () => {
    expect(isManagedModelRequest('google', stream('gemini-3.8-flash'))).toBe(true);
    expect(isManagedModelRequest('google', stream('gemini-3.5-flash-lite'))).toBe(true);
    expect(isManagedModelRequest('google', '/v1/google/v1beta/models/gemini-3.8-flash:generateContent')).toBe(true);
  });

  it('rejects Gemini models outside the managed lineup', () => {
    for (const model of ['gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-3.8-flash-x']) {
      expect(isManagedModelRequest('google', stream(model))).toBe(false);
    }
  });

  it('rejects other Google endpoints that could reach a non-managed model', () => {
    for (const path of [
      '/v1/google/v1beta/cachedContents',
      '/v1/google/v1beta/models',
      '/v1/google/v1beta/models/gemini-3.8-flash:batchGenerateContent',
      '/v1/google/v1beta/models/gemini-3.8-flash:streamGenerateContent/extra',
      '/v1/google/v1beta/models/gemini-3.1-pro-preview%3AstreamGenerateContent',
      '/v1/google/v1/models/gemini-3.8-flash:streamGenerateContent',
    ]) {
      expect(isManagedModelRequest('google', path)).toBe(false);
    }
  });

  it('rejects every OpenAI and Anthropic call because no managed model uses them', () => {
    expect(isManagedModelRequest('openai', '/v1/openai/v1/chat/completions')).toBe(false);
    expect(isManagedModelRequest('anthropic', '/v1/anthropic/v1/messages')).toBe(false);
  });

  it('leaves DeepSeek to the paid-subscription gate', () => {
    expect(isManagedModelRequest('deepseek', '/v1/deepseek/chat/completions')).toBe(true);
  });
});

describe('modelAllowlistMiddleware', () => {
  function app(): Hono {
    const a = new Hono();
    a.all('/v1/google/*', modelAllowlistMiddleware('google'), (c) => c.json({ ok: true }));
    return a;
  }

  it('passes managed requests through to the next handler', async () => {
    const res = await app().request(stream('gemini-3.8-flash'), { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('returns 403 without calling the next handler for a non-managed model', async () => {
    const res = await app().request(stream('gemini-3.1-pro-preview'), { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This model is not available through Dassi.' });
  });
});
