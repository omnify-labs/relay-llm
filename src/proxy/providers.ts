/**
 * Provider routing configuration.
 * Maps route prefixes to upstream provider URLs and auth methods.
 */

export type ProviderName = 'openai' | 'anthropic' | 'google';

export interface ProviderConfig {
  /** Base URL to forward requests to */
  upstream: string;
  /** Environment variable name for the API key */
  apiKeyEnvVar: string;
  /** How the API key is passed to the upstream provider */
  authMethod: 'bearer' | 'x-api-key' | 'query-param';
  /** Route prefix to strip before forwarding (e.g., '/v1/openai') */
  routePrefix: string;
}

/**
 * Provider configurations.
 * Relay strips the route prefix and forwards the rest of the path to the upstream.
 *
 * Example:
 *   Client:   POST /v1/openai/v1/chat/completions
 *   Upstream:  POST https://api.openai.com/v1/chat/completions
 */
export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  openai: {
    upstream: 'https://api.openai.com',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    authMethod: 'bearer',
    routePrefix: '/v1/openai',
  },
  anthropic: {
    upstream: 'https://api.anthropic.com',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    authMethod: 'x-api-key',
    routePrefix: '/v1/anthropic',
  },
  google: {
    upstream: 'https://generativelanguage.googleapis.com',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    authMethod: 'query-param',
    routePrefix: '/v1/google',
  },
};
