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
  // Integer micro-USD (1e-6 $) per million tokens — the billing-path representation.
  // Reason: the ledger math must stay in exact integers; the float fields above are
  // display/test conveniences only and MUST NOT feed spend accounting.
  inputMicro: bigint;
  outputMicro: bigint;
  cachedInputMicro: bigint;
  cacheCreationMicro: bigint;
  inputMicroAbove200k?: bigint;
  outputMicroAbove200k?: bigint;
  cachedInputMicroAbove200k?: bigint;
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
  // 2026-07 lineup refresh: claude-sonnet-5 is at Anthropic's introductory
  // $2/$10 rate in LiteLLM (standard $3/$15 from 2026-09-01) — the price will
  // follow automatically on the next vendored-table sync.
  'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  // 2026-08 lineup: gemini-3.7-flash supersedes 3.6 as the managed default
  // (dassi). Google priced it at HALF of 3.6's original rate — $0.75/$3.75 with a
  // $0.075 cache read — and, in the same upstream refresh, halved 3.6 to match.
  // Serving 3.7 without this entry would bill it at DEFAULT_PRICING ($3.00/M
  // input, and $3.00/M on cached reads with no discount): 4x the real input rate
  // and 40x the real cached rate on exactly the long, heavily-cached browser
  // sessions it is meant for.
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  // 2026-08 lineup: gemini-3.5-flash-lite is the managed budget tier (dassi PR
  // #2541). At $0.30/$2.50 with a $0.03 cache read it is 5x cheaper on input
  // than gemini-3.5-flash — the point of adding it. Serving it WITHOUT this
  // entry would be worse than not serving it at all: buildPricingTable() only
  // covers SERVED_MODELS, so it would fall to DEFAULT_PRICING at $3.00/M input
  // and, critically, $3.00/M on cached reads (no discount) — ~100x the real
  // cached rate on the long, heavily-cached browser sessions it is meant for.
  'gemini-3.5-flash-lite',
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
 * Convert a LiteLLM per-token USD price to integer micro-USD per million tokens.
 * @param perToken - Per-token USD price from the LiteLLM table (or undefined).
 * @returns Integer µ$/Mtok as bigint (0n when the price is absent).
 */
function toMicro(perToken: number | undefined): bigint {
  // Reason: one exact translation of the published price at table-build time
  // (µ$/Mtok = $/tok × 1e12). Real prices have ≤12 decimal places per token, so
  // round() only strips binary-float noise, never real price digits.
  return perToken != null ? BigInt(Math.round(perToken * 1e12)) : 0n;
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
    inputMicro: toMicro(entry.input_cost_per_token),
    outputMicro: toMicro(entry.output_cost_per_token),
    cachedInputMicro: toMicro(entry.cache_read_input_token_cost),
    cacheCreationMicro: toMicro(entry.cache_creation_input_token_cost),
  };
  if (entry.input_cost_per_token_above_200k_tokens != null) {
    pricing.inputPerMillionAbove200k = toMillion(entry.input_cost_per_token_above_200k_tokens);
    pricing.inputMicroAbove200k = toMicro(entry.input_cost_per_token_above_200k_tokens);
  }
  if (entry.output_cost_per_token_above_200k_tokens != null) {
    pricing.outputPerMillionAbove200k = toMillion(entry.output_cost_per_token_above_200k_tokens);
    pricing.outputMicroAbove200k = toMicro(entry.output_cost_per_token_above_200k_tokens);
  }
  if (entry.cache_read_input_token_cost_above_200k_tokens != null) {
    pricing.cachedInputPerMillionAbove200k = toMillion(entry.cache_read_input_token_cost_above_200k_tokens);
    pricing.cachedInputMicroAbove200k = toMicro(entry.cache_read_input_token_cost_above_200k_tokens);
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
