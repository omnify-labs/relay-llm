import { PRICING, type ModelPricing } from './litellm-pricing.js';

/**
 * Default pricing for unknown models — intentionally conservative (overestimates cost)
 * so we never undercharge for unrecognized models.
 */
// Reason: charge cached tokens at the full input rate (no discount) for unknown models.
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0, outputPerMillion: 15.0,
  cachedInputPerMillion: 3.0, cacheCreationPerMillion: 3.0,
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
