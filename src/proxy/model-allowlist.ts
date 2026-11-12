/**
 * Managed-model allowlist.
 *
 * A relay JWT is an ordinary Supabase session token, so anyone who signs up can call
 * relay directly. Relay therefore forwards only the calls Dassi's managed lineup makes
 * (dassi `supabase/functions/get-available-models`); everything else is rejected before
 * it reaches a provider or touches the budget.
 */

import type { MiddlewareHandler } from 'hono';
import type { ProviderName } from './providers.js';

/** Gemini models in Dassi's managed lineup. */
export const MANAGED_GOOGLE_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
]);

/** The methods pi-ai's Google client calls: `models.generateContent[Stream]`. */
const GOOGLE_GENERATE_PATH = /^\/v1\/google\/v1beta\/models\/([^/:]+):(?:generateContent|streamGenerateContent)$/;

/**
 * Decide whether a request path targets a managed model.
 * DeepSeek is gated by paid subscription instead: its route only reaches DeepSeek models.
 * OpenAI and Anthropic serve no managed model.
 *
 * @param provider - Relay route the request arrived on.
 * @param path - Request path, including the `/v1/<provider>` prefix.
 */
export function isManagedModelRequest(provider: ProviderName, path: string): boolean {
  if (provider === 'deepseek') return true;
  if (provider !== 'google') return false;
  const model = GOOGLE_GENERATE_PATH.exec(path)?.[1];
  return model !== undefined && MANAGED_GOOGLE_MODELS.has(model);
}

/**
 * Reject requests for models outside the managed lineup with 403.
 * Runs before budget admission so a rejected call never admits a run.
 *
 * @param provider - Relay route this middleware guards.
 */
export function modelAllowlistMiddleware(provider: ProviderName): MiddlewareHandler {
  return async (c, next) => {
    if (!isManagedModelRequest(provider, c.req.path)) {
      console.warn('[Relay] Rejected non-managed model request', { provider, path: c.req.path });
      return c.json({ error: 'This model is not available through Dassi.' }, 403);
    }
    await next();
  };
}
