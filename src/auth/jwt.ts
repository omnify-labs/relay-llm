/**
 * JWT authentication middleware.
 * Validates HS256 JWTs and extracts user_id.
 */

import type { MiddlewareHandler } from 'hono';
import * as jose from 'jose';

let jwtSecret: Uint8Array | null = null;

/**
 * Get or create the JWT secret key for verification.
 */
function getJwtSecret(): Uint8Array {
  if (!jwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('[Relay] JWT_SECRET is not set');
    }
    jwtSecret = new TextEncoder().encode(secret);
  }
  return jwtSecret;
}

/**
 * Extract JWT token from request headers.
 * Reason: Different LLM SDKs send the API key in different headers.
 * Clients pass the JWT as the "apiKey" to each provider's native SDK,
 * which then places it in provider-specific headers:
 *   - OpenAI SDK:    Authorization: Bearer <jwt>
 *   - Anthropic SDK: x-api-key: <jwt>
 *   - Google SDK:    x-goog-api-key: <jwt>
 *
 * @param c - Hono context
 * @returns JWT token string or null if not found
 */
function extractToken(c: { req: { header: (name: string) => string | undefined } }): string | null {
  // OpenAI: Authorization: Bearer <token>
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Anthropic: x-api-key: <token>
  const xApiKey = c.req.header('x-api-key');
  if (xApiKey) return xApiKey;

  // Google: x-goog-api-key: <token>
  const xGoogKey = c.req.header('x-goog-api-key');
  if (xGoogKey) return xGoogKey;

  return null;
}

/**
 * Auth middleware that validates HS256 JWTs.
 * Extracts user_id (sub claim) and sets it on the context.
 *
 * Accepts JWT from multiple headers to support different LLM SDK auth methods.
 *
 * Rejects requests with:
 * - 401 if no token found in any supported header
 * - 401 if JWT is invalid, expired, or malformed
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const token = extractToken(c);

  if (!token) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret(), {
      algorithms: ['HS256'],
    });

    const userId = payload.sub;
    if (!userId) {
      return c.json({ error: 'JWT missing sub claim' }, 401);
    }

    // Set userId on context for downstream handlers
    c.set('userId', userId);

    await next();
  } catch (error) {
    const message =
      error instanceof jose.errors.JWTExpired
        ? 'Token expired'
        : error instanceof jose.errors.JWTClaimValidationFailed
          ? 'Token validation failed'
          : 'Invalid token';

    return c.json({ error: message }, 401);
  }
};
