import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { authMiddleware } from '../auth/jwt.js';
import { budgetMiddleware } from '../billing/budget.js';
import { revokeUser } from '../billing/run-admission.js';
import { getUserBudget } from '../db/queries.js';
import { proxyHandler } from '../proxy/handler.js';
import { servedGoogleModelMiddleware } from '../proxy/served-models.js';

vi.mock('../db/queries.js', () => ({
  getUserBudget: vi.fn(),
  hasPaidSubscription: vi.fn(),
  recordUsage: vi.fn().mockResolvedValue('charged'),
}));

const GOOGLE = '/v1/google/v1beta';

describe('Google route serves only Dassi models', () => {
  let token: string;
  let app: Hono;
  const upstream = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.clearAllMocks();
    revokeUser('trial-user');
    vi.stubEnv('JWT_SECRET', 'test-served-models-secret');
    vi.stubEnv('GOOGLE_API_KEY', 'test-google-key');
    vi.stubGlobal('fetch', upstream);
    upstream.mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    vi.mocked(getUserBudget).mockResolvedValue({ budget: 2, spend: 0, planBase: 2, memberBlocked: false });
    token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('trial-user')
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    app = new Hono();
    app.all('/v1/google/*', authMiddleware, servedGoogleModelMiddleware, budgetMiddleware, proxyHandler('google'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function post(path: string, auth = `Bearer ${token}`) {
    return app.request(path, { method: 'POST', body: '{"contents":[]}', headers: { Authorization: auth } });
  }

  it.each([
    'gemini-3.8-flash:streamGenerateContent',
    'gemini-3.5-flash-lite:streamGenerateContent',
    'gemini-3.8-flash:generateContent',
  ])('forwards %s to Google unchanged', async (target) => {
    const response = await post(`${GOOGLE}/models/${target}?alt=sse`);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const url = new URL(upstream.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${target}`);
    expect(url.searchParams.get('alt')).toBe('sse');
  });

  it.each([
    'gemini-4-argon:streamGenerateContent',
    'gemini-3.1-pro-preview:generateContent',
    'gemini-3.1-flash-lite-preview:streamGenerateContent',
    'gemini-3.8-flash-exp:streamGenerateContent',
    'xgemini-3.8-flash:streamGenerateContent',
  ])('rejects %s before checking budget or calling Google', async (target) => {
    const response = await post(`${GOOGLE}/models/${target}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Model not available on Dassi credit' });
    expect(getUserBudget).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    `${GOOGLE}/models`,
    `${GOOGLE}/cachedContents`,
    '/v1/google/upload/v1beta/files',
    `${GOOGLE}/models/gemini-3.8-flash:countTokens`,
    `${GOOGLE}/models/gemini-3.8-flash:embedContent`,
    '/v1/google/v1/models/gemini-3.8-flash:streamGenerateContent',
    `${GOOGLE}/models/gemini-3.8-flash:streamGenerateContent/`,
  ])('rejects other Google endpoints: %s', async (path) => {
    expect((await post(path)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    `${GOOGLE}/models/gemini-3.8-flash:streamGenerateContent%2F..%2F..%2Fmodels%2Fgemini-4-argon:generateContent`,
    `${GOOGLE}/models/gemini-3.8-flash:streamGenerateContent/../../models/gemini-4-argon:generateContent`,
    `${GOOGLE}/models/gemini-4-argon%3AstreamGenerateContent`,
    `${GOOGLE}/models/gemini-3.8-flash%2Fgemini-4-argon:streamGenerateContent`,
  ])('cannot smuggle another model past a served name: %s', async (path) => {
    expect((await post(path)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('still answers a bad token with 401, so the auth-drift probe keeps working', async () => {
    const response = await post(`${GOOGLE}/models/gemini-3.8-flash:streamGenerateContent`, 'Bearer not-a-jwt');
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
