import type { Model } from '@mariozechner/pi-ai';
import { getModel } from '@mariozechner/pi-ai';
import type { RelayNativeProvider } from './constants';
import { RELAY_PROVIDERS } from './constants';

/**
 * Options for Relay model resolution.
 */
export interface RelayOptions {
  /** Override Relay base URL. Default: https://relay.example.com */
  relayUrl?: string;
}

/**
 * Detect the native provider from a model ID.
 * Strips any "provider/" prefix before matching.
 *
 * @param modelId - Model ID (e.g., 'claude-sonnet-4-5', 'gpt-5.4', 'anthropic/claude-opus-4-6')
 * @returns Native provider name
 */
export function detectProvider(modelId: string): RelayNativeProvider {
  const name = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  if (name.startsWith('claude-')) return 'anthropic';
  if (name.startsWith('gemini-')) return 'google';
  return 'openai';
}

/**
 * Detect the native provider from a pi-ai Model's api field.
 * Used by relay() when given an existing Model object.
 *
 * @param api - pi-ai api type (e.g., 'anthropic-messages', 'openai-responses')
 * @returns Native provider name
 */
export function detectProviderFromApi(api: string): RelayNativeProvider {
  if (api.startsWith('anthropic')) return 'anthropic';
  if (api.startsWith('google')) return 'google';
  return 'openai';
}

/**
 * Build Relay provider base URLs from a custom Relay URL.
 */
function buildRelayProviders(relayUrl: string): Record<RelayNativeProvider, string> {
  const base = relayUrl.replace(/\/$/, '');
  return {
    openai: `${base}/v1/openai/v1`,
    anthropic: `${base}/v1/anthropic`,
    google: `${base}/v1/google/v1beta`,
  };
}

/**
 * Route a pi-ai model through Relay.
 *
 * Accepts either a model ID string or an existing pi-ai Model object.
 * Returns a new Model with baseUrl pointing to the Relay proxy.
 *
 * @example
 * // From model ID — detects provider automatically
 * const model = relay('claude-sonnet-4-5');
 *
 * // From existing pi-ai Model
 * const model = relay(getModel('anthropic', 'claude-sonnet-4-5'));
 *
 * // With custom Relay URL
 * const model = relay('gpt-4o', { relayUrl: 'https://my-relay.example.com' });
 *
 * // Use with pi-ai streaming (caller provides JWT)
 * stream(model, context, { apiKey: jwt });
 *
 * @param modelOrId - A model ID string (e.g., 'claude-sonnet-4-5', 'gpt-4o') or an existing pi-ai Model
 * @param options - Optional configuration (custom relayUrl)
 * @returns A new Model with baseUrl pointing to Relay
 * @throws If model ID is not found in pi-ai's model registry
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function relay(modelOrId: string | Model<any>, options?: RelayOptions): Model<any> {
  const providers = options?.relayUrl
    ? buildRelayProviders(options.relayUrl)
    : RELAY_PROVIDERS;

  if (typeof modelOrId === 'string') {
    const provider = detectProvider(modelOrId);
    const normalizedId = modelOrId.includes('/') ? modelOrId.split('/').pop()! : modelOrId;

    // Reason: pi-ai's getModel is strongly typed with known providers and model IDs.
    // We use 'any' cast because user may reference models not in the static type map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (getModel as any)(provider, normalizedId);
    if (!model) {
      throw new Error(`Model "${normalizedId}" not found in pi-ai registry for provider "${provider}"`);
    }

    return { ...model, baseUrl: providers[provider] };
  }

  // Existing Model object — detect provider from api field
  const provider = detectProviderFromApi(modelOrId.api);
  return { ...modelOrId, baseUrl: providers[provider] };
}
