/**
 * Environment variable loading and validation.
 * Fails fast if required variables are missing.
 */

export interface Env {
  PORT: number;
  LOG_LEVEL: string;

  // Provider API keys
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  GOOGLE_API_KEY: string;

  // JWT validation (any HS256 secret — works with Supabase, Auth0, Firebase, etc.)
  JWT_SECRET: string;

  // Database
  DATABASE_URL: string | null;

  // Admin API secret for budget management endpoints
  RELAY_ADMIN_SECRET: string;
}

/**
 * Load and validate environment variables.
 * Throws on missing required vars so we fail at startup, not at request time.
 */
export function loadEnv(): Env {
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) {
      throw new Error(`[Relay] Missing required env var: ${key}`);
    }
    return value;
  };

  return {
    PORT: parseInt(process.env.PORT || '8080', 10),
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',

    OPENAI_API_KEY: required('OPENAI_API_KEY'),
    ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
    GOOGLE_API_KEY: required('GOOGLE_API_KEY'),

    JWT_SECRET: required('JWT_SECRET'),

    DATABASE_URL: process.env.DATABASE_URL || null,

    RELAY_ADMIN_SECRET: required('RELAY_ADMIN_SECRET'),
  };
}
