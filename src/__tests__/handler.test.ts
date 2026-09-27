import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { authMiddleware } from '../auth/jwt.js';
import { budgetMiddleware } from '../billing/budget.js';
import { loadEnv } from '../config/env.js';
import { getUserBudget, incrementUserSpend, insertUsageLog } from '../db/queries.js';

vi.mock('../db/queries.js', () => ({
  getUserBudget: vi.fn(),
  incrementUserSpend: vi.fn().mockResolvedValue(undefined),
  insertUsageLog: vi.fn().mockResolvedValue(undefined),
}));

import { parseUsageFromBody, parseUsageFromSSE, proxyHandler } from '../proxy/handler.js';

describe('DeepSeek managed requests', () => {
  let token: string;
  let app: Hono;
  const upstream = vi.fn<typeof fetch>();
  const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 700, completion_tokens_details: { reasoning_tokens: 60 } };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('JWT_SECRET', 'test-deepseek-jwt-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-provider-key');
    vi.stubGlobal('fetch', upstream);
    vi.mocked(getUserBudget).mockResolvedValue({ budget: 10, spend: 0 });
    token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('test-user')
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    app = new Hono();
    app.all('/v1/deepseek/*', authMiddleware, budgetMiddleware, proxyHandler('deepseek'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function request(body = '{ "model": "deepseek-flash", "stream": true }') {
    return app.request('/v1/deepseek/chat/completions', {
      method: 'POST', body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  it.each([true, false])('forwards bytes unchanged and charges cached/reasoning usage once (stream=%s)', async (stream) => {
    const payload = { model: 'deepseek-flash', usage };
    const responseBody = stream
      ? `: keep-alive\n\ndata: ${JSON.stringify({ model: 'deepseek-flash', choices: [] })}\n\ndata: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`
      : JSON.stringify(payload);
    let forwarded = '';
    upstream.mockImplementationOnce(async (_input, init) => {
      forwarded = await new Response(init?.body).text();
      return new Response(responseBody, { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } });
    });
    const requestBody = ` { "model": "deepseek-flash", "stream": ${stream}, "messages": [], "thinking": {"type":"enabled"} } `;
    const response = await request(requestBody);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(responseBody);
    expect(forwarded).toBe(requestBody);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-provider-key');
    expect(response.headers.get('Authorization')).toBeNull();
    await vi.waitFor(() => expect(incrementUserSpend).toHaveBeenCalledOnce());
    expect(incrementUserSpend).toHaveBeenCalledWith('test-user', expect.closeTo(0.0002142, 10));
    expect(insertUsageLog).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'deepseek', model: 'deepseek-flash', inputTokens: 1000,
      outputTokens: 100, cachedInputTokens: 700, cacheCreationTokens: 0,
    }));
  });

  it('rejects missing authentication before accessing the upstream', async () => {
    const response = await app.request('/v1/deepseek/chat/completions', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects exhausted credits before accessing the upstream', async () => {
    vi.mocked(getUserBudget).mockResolvedValueOnce({ budget: 10, spend: 10 });
    expect((await request()).status).toBe(402);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fails closed on a budget database error', async () => {
    vi.mocked(getUserBudget).mockRejectedValueOnce(new Error('database unavailable'));
    expect((await request()).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes upstream rate-limit errors through without charging', async () => {
    const body = '{"error":{"message":"Rate limit reached"}}';
    upstream.mockResolvedValueOnce(new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const response = await request();
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(body);
    expect(incrementUserSpend).not.toHaveBeenCalled();
  });

  it('requires a server-side DeepSeek key at startup', () => {
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'RELAY_ADMIN_SECRET']) vi.stubEnv(key, 'test');
    expect(loadEnv().DEEPSEEK_API_KEY).toBe('test-provider-key');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    expect(() => loadEnv()).toThrow('Missing required env var: DEEPSEEK_API_KEY');
  });

  it('ignores incomplete streams and malformed usage responses', () => {
    expect(parseUsageFromSSE(': keep-alive\n\ndata: invalid\n\ndata: [DONE]\n', 'deepseek')).toBeNull();
    expect(parseUsageFromBody('{"error":"unavailable"}', 'deepseek')).toBeNull();
    expect(parseUsageFromBody('invalid', 'deepseek')).toBeNull();
  });
});

describe('parseUsageFromBody', () => {
  it('parses OpenAI response usage', () => {
    const body = JSON.stringify({
      model: 'gpt-5.4',
      choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const usage = parseUsageFromBody(body, 'openai');
    expect(usage).toEqual({
      model: 'gpt-5.4',
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('parses Anthropic response usage', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Hello!' }],
      usage: { input_tokens: 20, output_tokens: 15 },
    });

    const usage = parseUsageFromBody(body, 'anthropic');
    expect(usage).toEqual({
      model: 'claude-sonnet-4-5',
      inputTokens: 20,
      outputTokens: 15,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('parses Google Gemini response usage', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 },
      modelVersion: 'gemini-2.0-flash',
    });

    const usage = parseUsageFromBody(body, 'google');
    expect(usage).toEqual({
      model: 'gemini-2.0-flash',
      inputTokens: 8,
      outputTokens: 12,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('handles missing usage gracefully', () => {
    const body = JSON.stringify({ model: 'gpt-5.4', choices: [] });
    const usage = parseUsageFromBody(body, 'openai');
    expect(usage).toEqual({
      model: 'gpt-5.4',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('handles invalid JSON gracefully', () => {
    const usage = parseUsageFromBody('not json', 'openai');
    expect(usage).toBeNull();
  });

  it('handles empty body gracefully', () => {
    const usage = parseUsageFromBody('', 'openai');
    expect(usage).toBeNull();
  });

  it('extracts OpenAI cached tokens from prompt_tokens_details', () => {
    const body = JSON.stringify({
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 2048,
        completion_tokens: 100,
        total_tokens: 2148,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });

    const usage = parseUsageFromBody(body, 'openai');
    expect(usage).toEqual({
      model: 'gpt-4o',
      inputTokens: 2048,
      outputTokens: 100,
      cachedInputTokens: 1920,
      cacheCreationTokens: 0,
    });
  });

  it('extracts Anthropic cache_read and cache_creation tokens', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Hello!' }],
      usage: {
        input_tokens: 500,
        output_tokens: 80,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300,
      },
    });

    const usage = parseUsageFromBody(body, 'anthropic');
    // Reason: Anthropic input_tokens does NOT include cache tokens, so inputTokens = 500 + 1200 + 300 = 2000
    expect(usage).toEqual({
      model: 'claude-sonnet-4-5',
      inputTokens: 2000,
      outputTokens: 80,
      cachedInputTokens: 1200,
      cacheCreationTokens: 300,
    });
  });

  it('extracts Google cachedContentTokenCount', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Hello!' }] } }],
      usageMetadata: {
        promptTokenCount: 258000,
        candidatesTokenCount: 500,
        totalTokenCount: 258500,
        cachedContentTokenCount: 257955,
      },
      modelVersion: 'gemini-2.5-pro-preview',
    });

    const usage = parseUsageFromBody(body, 'google');
    expect(usage).toEqual({
      model: 'gemini-2.5-pro-preview',
      inputTokens: 258000,
      outputTokens: 500,
      cachedInputTokens: 257955,
      cacheCreationTokens: 0,
    });
  });
});

describe('parseUsageFromSSE — cache token extraction', () => {
  it('extracts OpenAI cached tokens from streaming final chunk', () => {
    const sse = [
      'data: {"model":"gpt-4.1","choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"usage":{"prompt_tokens":2006,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":1920}}}',
      'data: [DONE]',
    ].join('\n');

    const usage = parseUsageFromSSE(sse, 'openai');
    expect(usage).toEqual({
      model: 'gpt-4.1',
      inputTokens: 2006,
      outputTokens: 300,
      cachedInputTokens: 1920,
      cacheCreationTokens: 0,
    });
  });

  it('Anthropic message_delta does NOT overwrite cache fields from message_start', () => {
    const sse = [
      'data: {"type":"message_start","message":{"model":"claude-opus-4-6","usage":{"input_tokens":500,"cache_read_input_tokens":4000,"cache_creation_input_tokens":100,"output_tokens":1}}}',
      'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}',
    ].join('\n');

    const usage = parseUsageFromSSE(sse, 'anthropic');
    expect(usage).toEqual({
      model: 'claude-opus-4-6',
      // inputTokens = 500 + 4000 + 100 = 4600 (from message_start, NOT overwritten)
      inputTokens: 4600,
      outputTokens: 50,
      cachedInputTokens: 4000,
      cacheCreationTokens: 100,
    });
  });

  it('extracts Google cachedContentTokenCount from SSE chunk', () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":150000,"candidatesTokenCount":200,"cachedContentTokenCount":140000},"modelVersion":"gemini-3.1-pro-preview"}',
    ].join('\n');

    const usage = parseUsageFromSSE(sse, 'google');
    expect(usage).toEqual({
      model: 'gemini-3.1-pro-preview',
      inputTokens: 150000,
      outputTokens: 200,
      cachedInputTokens: 140000,
      cacheCreationTokens: 0,
    });
  });

  it('returns null for stream with only [DONE]', () => {
    expect(parseUsageFromSSE('data: [DONE]\n', 'openai')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseUsageFromSSE('', 'openai')).toBeNull();
  });

  it('handles malformed JSON in SSE gracefully', () => {
    const sse = 'data: {not valid json}\ndata: [DONE]\n';
    expect(parseUsageFromSSE(sse, 'openai')).toBeNull();
  });
});
