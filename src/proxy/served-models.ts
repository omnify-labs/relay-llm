/**
 * The Google models Relay forwards.
 *
 * Every free trial account holds a valid Dassi JWT, so whatever Relay forwards is open to
 * anyone who signs up. Relay therefore serves only the models Dassi offers on managed
 * credit (Dassi Flash and Dassi Lite on Google), mirroring MANAGED_MODELS in Dassi's
 * get-available-models function.
 */

import type { MiddlewareHandler } from 'hono';

const SERVED_GOOGLE_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Reason: Gemini names the model in the URL, so the check needs no request body (the
// zero-translation rule). It matches the whole path that buildUpstreamUrl forwards, so an
// extra segment, a dot-segment or an encoded separator cannot carry a second model name
// past it; anything unexpected is rejected.
const SERVED_GOOGLE_PATH = new RegExp(
  `^/v1/google/v1beta/models/(?:${SERVED_GOOGLE_MODELS.map(escapeRegExp).join('|')})` +
    ':(?:streamGenerateContent|generateContent)$',
);

/**
 * Reject a Google request unless it generates content with a model Dassi offers.
 * Runs after auth (so a bad token is still a 401) and before the budget check.
 *
 * @param c - Hono context for a `/v1/google/*` request.
 * @param next - Budget and proxy middleware, invoked only for a served model.
 * @returns 403 for any other model or endpoint (files, cachedContents, model listing, …).
 */
export const servedGoogleModelMiddleware: MiddlewareHandler = async (c, next) => {
  if (!SERVED_GOOGLE_PATH.test(c.req.path)) {
    return c.json({ error: 'Model not available on Dassi credit' }, 403);
  }
  await next();
};
