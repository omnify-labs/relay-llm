import type { ProxyOptions } from '../proxy/handler.js';

export interface GoogleBindings {
  GOOGLE_API_KEY?: string;
  GOOGLE_VERTEX_PROJECT?: string;
  /** Short-lived service-account token for the staging evaluation, never a user token. */
  GOOGLE_VERTEX_ACCESS_TOKEN?: string;
  /** ISO timestamp. Production needs automatic token renewal before enabling this route. */
  GOOGLE_VERTEX_TOKEN_EXPIRES_AT?: string;
}

/** Select native Google auth from server bindings; partial or expired Cloud config fails closed. */
export function googleTarget(env: GoogleBindings, now = Date.now()): ProxyOptions | null {
  const project = env.GOOGLE_VERTEX_PROJECT;
  const accessToken = env.GOOGLE_VERTEX_ACCESS_TOKEN;
  const expiresAt = env.GOOGLE_VERTEX_TOKEN_EXPIRES_AT;
  if (!project && !accessToken && !expiresAt)
    return env.GOOGLE_API_KEY ? { apiKey: env.GOOGLE_API_KEY } : null;
  if (
    !project ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
    !accessToken ||
    !expiresAt ||
    !(Date.parse(expiresAt) > now + 60_000)
  )
    return null;
  return { googleCloud: { project, accessToken } };
}
