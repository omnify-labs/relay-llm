/**
 * Admin API authentication middleware.
 * Validates requests against RELAY_ADMIN_SECRET.
 */

import type { MiddlewareHandler } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../config/env.js';

// Reason: Cache the secret at module load so we don't call loadEnv() on every request.
// loadEnv() is designed for startup-time validation; calling it per-request wastes work
// and breaks the fail-fast-at-startup intent.
const { RELAY_ADMIN_SECRET: adminSecret } = loadEnv();

/**
 * Hash a string with SHA-256 to produce a fixed-length digest.
 * @param data - The string to hash
 * @returns SHA-256 digest as a Buffer
 */
function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Admin auth middleware.
 * Validates Bearer token matches RELAY_ADMIN_SECRET from env config.
 * Returns 401 on missing/invalid token.
 *
 * @remarks Hashes both values with SHA-256 before comparing via timingSafeEqual,
 * ensuring fixed-length inputs and preventing length-leaking timing side-channels.
 */
export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);

  // Reason: Hash both values to fixed-length digests before comparing,
  // preventing timing side-channel that leaks the secret's length.
  const a = sha256(token);
  const b = sha256(adminSecret);

  if (!timingSafeEqual(a, b)) {
    return c.json({ error: 'Invalid admin secret' }, 401);
  }

  await next();
};
