/**
 * Model pricing table with cache and tiered pricing support.
 * Prices are per 1 million tokens.
 *
 * TODO: Move to database table (model_pricing) for runtime updates without redeploy.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationPerMillion: number;
  /** When defined, ALL tokens use this rate if total prompt tokens > 200K. */
  inputPerMillionAbove200k?: number;
  outputPerMillionAbove200k?: number;
  cachedInputPerMillionAbove200k?: number;
}

/**
 * Pricing table — update as providers change prices.
 * Key format: model ID as returned by the provider in the response.
 *
 * Sources (verified 2026-03-30):
 *   OpenAI:    https://developers.openai.com/api/docs/pricing
 *   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   Google:    https://ai.google.dev/gemini-api/docs/pricing
 */
const PRICING: Record<string, ModelPricing> = {
  // OpenAI — cache discount: 90% (5.4), 75% (4.1, o4-mini), 50% (4o)
  'gpt-5.4': {
    inputPerMillion: 2.50, outputPerMillion: 15.00,
    cachedInputPerMillion: 0.25, cacheCreationPerMillion: 0,
  },
  'gpt-4.1': {
    inputPerMillion: 2.00, outputPerMillion: 8.00,
    cachedInputPerMillion: 0.50, cacheCreationPerMillion: 0,
  },
  'gpt-4o': {
    inputPerMillion: 2.50, outputPerMillion: 10.00,
    cachedInputPerMillion: 1.25, cacheCreationPerMillion: 0,
  },
  'o4-mini': {
    inputPerMillion: 1.10, outputPerMillion: 4.40,
    cachedInputPerMillion: 0.275, cacheCreationPerMillion: 0,
  },

  // Anthropic — cache read: 0.1x, cache write (5min): 1.25x
  'claude-opus-4-6': {
    inputPerMillion: 5.00, outputPerMillion: 25.00,
    cachedInputPerMillion: 0.50, cacheCreationPerMillion: 6.25,
  },
  'claude-sonnet-4-5': {
    inputPerMillion: 3.00, outputPerMillion: 15.00,
    cachedInputPerMillion: 0.30, cacheCreationPerMillion: 3.75,
  },
  'claude-haiku-4-5': {
    inputPerMillion: 1.00, outputPerMillion: 5.00,
    cachedInputPerMillion: 0.10, cacheCreationPerMillion: 1.25,
  },

  // Google — cache read: 0.1x, Pro models have above-200K tiers
  'gemini-3.1-pro-preview': {
    inputPerMillion: 2.00, outputPerMillion: 12.00,
    cachedInputPerMillion: 0.20, cacheCreationPerMillion: 0,
    inputPerMillionAbove200k: 4.00, outputPerMillionAbove200k: 18.00,
    cachedInputPerMillionAbove200k: 0.40,
  },
  'gemini-3-flash-preview': {
    inputPerMillion: 0.50, outputPerMillion: 3.00,
    cachedInputPerMillion: 0.05, cacheCreationPerMillion: 0,
  },
  'gemini-2.5-pro-preview': {
    inputPerMillion: 1.25, outputPerMillion: 10.00,
    cachedInputPerMillion: 0.125, cacheCreationPerMillion: 0,
    inputPerMillionAbove200k: 2.50, outputPerMillionAbove200k: 15.00,
    cachedInputPerMillionAbove200k: 0.25,
  },
  'gemini-2.0-flash': {
    inputPerMillion: 0.10, outputPerMillion: 0.40,
    cachedInputPerMillion: 0.025, cacheCreationPerMillion: 0,
  },

  // DeepSeek
  'deepseek-v3.2': {
    inputPerMillion: 0.28, outputPerMillion: 0.42,
    cachedInputPerMillion: 0.07, cacheCreationPerMillion: 0,
  },
};

/**
 * Default pricing for unknown models — intentionally conservative (overestimates cost)
 * so we never undercharge for unrecognized models.
 */
// Reason: For unknown models, charge cached tokens at the full input rate (no discount).
// This avoids undercharging if the model doesn't actually offer cache pricing.
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.00, outputPerMillion: 15.00,
  cachedInputPerMillion: 3.00, cacheCreationPerMillion: 3.00,
};

/**
 * Calculate USD cost for a request based on token counts.
 * Applies cache read/write discounts and above-200K tiered pricing where applicable.
 *
 * @param model - Model ID from the provider's response
 * @param inputTokens - Total prompt tokens (includes cached + cache-creation for Anthropic)
 * @param outputTokens - Number of output/completion tokens
 * @param cachedInputTokens - Tokens served from cache (billed at reduced rate)
 * @param cacheCreationTokens - Tokens written to cache (Anthropic: billed at 1.25x)
 * @returns Cost in USD
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
): number {
  const pricing = PRICING[model] || DEFAULT_PRICING;

  // Reason: Google Pro models charge 2x input / 1.5x output above 200K prompt tokens.
  // When above threshold, ALL tokens (not just the excess) use the high-tier rate.
  const useHighTier = inputTokens > 200_000;

  const inputRate = (useHighTier && pricing.inputPerMillionAbove200k != null)
    ? pricing.inputPerMillionAbove200k : pricing.inputPerMillion;
  const outputRate = (useHighTier && pricing.outputPerMillionAbove200k != null)
    ? pricing.outputPerMillionAbove200k : pricing.outputPerMillion;
  const cachedReadRate = (useHighTier && pricing.cachedInputPerMillionAbove200k != null)
    ? pricing.cachedInputPerMillionAbove200k : pricing.cachedInputPerMillion;

  // Reason: Guard against provider bugs where cached counts exceed total input.
  const safeCachedInput = Math.min(cachedInputTokens, inputTokens);
  const safeCacheCreation = Math.min(cacheCreationTokens, inputTokens - safeCachedInput);
  const nonCachedInput = Math.max(0, inputTokens - safeCachedInput - safeCacheCreation);

  const inputCost = (nonCachedInput / 1_000_000) * inputRate;
  const cachedReadCost = (safeCachedInput / 1_000_000) * cachedReadRate;
  const cacheWriteCost = (safeCacheCreation / 1_000_000) * pricing.cacheCreationPerMillion;
  const outputCost = (outputTokens / 1_000_000) * outputRate;

  return inputCost + cachedReadCost + cacheWriteCost + outputCost;
}
