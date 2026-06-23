// src/billing/litellm-pricing.ts
/**
 * Loads model pricing from the vendored LiteLLM price table and normalizes it
 * into relay's per-million ModelPricing shape.
 *
 * Source of truth: vendor/litellm/model_prices_and_context_window.json
 * (a vendored copy of BerriAI/litellm's price file, refreshed by the
 * litellm-prices-sync workflow). tsup inlines the JSON at build time, so there
 * is no runtime file dependency.
 *
 * Reason: LiteLLM stores cost PER TOKEN; relay bills PER MILLION tokens (×1e6).
 */
import rawPrices from '../../vendor/litellm/model_prices_and_context_window.json';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationPerMillion: number;
  inputPerMillionAbove200k?: number;
  outputPerMillionAbove200k?: number;
  cachedInputPerMillionAbove200k?: number;
}

/** Only the LiteLLM fields relay consumes; the file has many more we ignore. */
interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
}

const RAW = rawPrices as unknown as Record<string, LiteLLMEntry>; // Reason: the JSON import infers a deep literal type; `as unknown` widens it to a typed Record without @ts-ignore.
const M = 1_000_000;

/**
 * Model IDs relay serves (as returned by the provider in responses).
 * Every entry MUST resolve to a real LiteLLM price — missingServedModels() enforces it.
 */
export const SERVED_MODELS: readonly string[] = [
  'gpt-5.4', 'gpt-4.1', 'gpt-4o', 'o4-mini',
  'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
  // NOTE: gemini-2.0-flash is deprecated by Google (shutdown ~2026-06-01). Kept
  // here so any residual traffic is still priced correctly ($0.10/$0.40) rather
  // than falling to the conservative DEFAULT_PRICING; remove once upstream drops
  // it (missingServedModels() will flag it then).
  'gemini-2.5-pro-preview', 'gemini-2.0-flash',
];

/** relay model id -> LiteLLM key, for the few that don't match exactly. */
export const ALIASES: Record<string, string> = {
  'gemini-2.5-pro-preview': 'gemini-2.5-pro',
};

function toMillion(perToken: number | undefined): number {
  return perToken != null ? perToken * M : 0;
}

/**
 * Convert one LiteLLM entry to relay's per-million ModelPricing.
 * @param entry - Raw LiteLLM pricing entry for a single model.
 * @returns ModelPricing with all rates converted from per-token to per-million.
 */
export function normalizeEntry(entry: LiteLLMEntry): ModelPricing {
  const pricing: ModelPricing = {
    inputPerMillion: toMillion(entry.input_cost_per_token),
    outputPerMillion: toMillion(entry.output_cost_per_token),
    cachedInputPerMillion: toMillion(entry.cache_read_input_token_cost),
    cacheCreationPerMillion: toMillion(entry.cache_creation_input_token_cost),
  };
  if (entry.input_cost_per_token_above_200k_tokens != null) {
    pricing.inputPerMillionAbove200k = toMillion(entry.input_cost_per_token_above_200k_tokens);
  }
  if (entry.output_cost_per_token_above_200k_tokens != null) {
    pricing.outputPerMillionAbove200k = toMillion(entry.output_cost_per_token_above_200k_tokens);
  }
  if (entry.cache_read_input_token_cost_above_200k_tokens != null) {
    pricing.cachedInputPerMillionAbove200k = toMillion(entry.cache_read_input_token_cost_above_200k_tokens);
  }
  return pricing;
}

/**
 * Resolve a relay model id to its LiteLLM entry (via alias), or null.
 * @param model - Relay model ID (may be an alias for a LiteLLM key).
 * @returns The raw LiteLLM entry for the model, or null if not found.
 */
export function lookupRaw(model: string): LiteLLMEntry | null {
  const key = ALIASES[model] ?? model;
  return RAW[key] ?? null;
}

/**
 * Served models that have no usable LiteLLM price (input cost missing).
 * @returns Array of relay model IDs from SERVED_MODELS that lack a usable LiteLLM price entry.
 */
export function missingServedModels(): string[] {
  return SERVED_MODELS.filter((m) => {
    const e = lookupRaw(m);
    return !e || e.input_cost_per_token == null;
  });
}

/** Build the served-model pricing table, keyed by relay model id. */
function buildPricingTable(): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const model of SERVED_MODELS) {
    const entry = lookupRaw(model);
    if (entry && entry.input_cost_per_token != null) {
      table[model] = normalizeEntry(entry);
    }
  }
  const missing = missingServedModels();
  if (missing.length > 0) {
    // Reason: a missing served model falls to DEFAULT_PRICING (conservative) in
    // calculateCost — log loud so coverage gaps surface instead of silently mischarging.
    console.error(
      `[Relay] LiteLLM pricing MISSING for served models: ${missing.join(', ')} — falling back to DEFAULT_PRICING.`,
    );
  }
  return table;
}

export const PRICING: Record<string, ModelPricing> = buildPricingTable();
