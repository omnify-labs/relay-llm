/** Default Relay LLM proxy URL */
export const RELAY_URL = 'https://relay.example.com';

/** Native provider types supported by Relay */
export type RelayNativeProvider = 'openai' | 'anthropic' | 'google';

/**
 * Relay endpoint URLs per native provider.
 * Each maps to the Relay route that strips the prefix and forwards to the upstream provider.
 *
 * @example
 * RELAY_PROVIDERS.anthropic
 * // → 'https://relay.example.com/v1/anthropic'
 * // Relay strips '/v1/anthropic', forwards rest to api.anthropic.com
 */
export const RELAY_PROVIDERS: Record<RelayNativeProvider, string> = {
  openai: `${RELAY_URL}/v1/openai/v1`,
  anthropic: `${RELAY_URL}/v1/anthropic`,
  google: `${RELAY_URL}/v1/google/v1beta`,
} as const;
