import { PRICING, type ModelPricing } from './litellm-pricing.js';

/**
 * Default pricing for unknown models — intentionally conservative (overestimates cost)
 * so we never undercharge for unrecognized models.
 */
// Reason: charge cached tokens at the full input rate (no discount) for unknown models.
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0, outputPerMillion: 15.0,
  cachedInputPerMillion: 3.0, cacheCreationPerMillion: 3.0,
  inputMicro: 3_000_000n, outputMicro: 15_000_000n,
  cachedInputMicro: 3_000_000n, cacheCreationMicro: 3_000_000n,
};

/**
 * Calculate the cost of a request in integer micro-USD (1e-6 $).
 * Applies cache read/write discounts and above-200K tiered pricing where applicable.
 *
 * This is the billing-path implementation: token counts and rates are exact integers,
 * the multiply-adds run in BigInt, and the single division at the end floors — the
 * sub-micro-dollar remainder is discarded in the user's favor.
 *
 * @param model - Model ID from the provider's response
 * @param inputTokens - Total prompt tokens (includes cached + cache-creation for Anthropic)
 * @param outputTokens - Number of output/completion tokens
 * @param cachedInputTokens - Tokens served from cache (billed at reduced rate)
 * @param cacheCreationTokens - Tokens written to cache (Anthropic: billed at 1.25x)
 * @returns Cost in integer micro-USD
 */
export function calculateCostMicroUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
): bigint {
  const pricing = PRICING[model] || DEFAULT_PRICING;

  // Reason: Google Pro models charge 2x input / 1.5x output above 200K prompt tokens.
  // When above threshold, ALL tokens (not just the excess) use the high-tier rate.
  const useHighTier = inputTokens > 200_000;

  const inputRate = (useHighTier && pricing.inputMicroAbove200k != null)
    ? pricing.inputMicroAbove200k : pricing.inputMicro;
  const outputRate = (useHighTier && pricing.outputMicroAbove200k != null)
    ? pricing.outputMicroAbove200k : pricing.outputMicro;
  const cachedReadRate = (useHighTier && pricing.cachedInputMicroAbove200k != null)
    ? pricing.cachedInputMicroAbove200k : pricing.cachedInputMicro;

  // Reason: Guard against provider bugs where cached counts exceed total input.
  const safeCachedInput = Math.min(cachedInputTokens, inputTokens);
  const safeCacheCreation = Math.min(cacheCreationTokens, inputTokens - safeCachedInput);
  const nonCachedInput = Math.max(0, inputTokens - safeCachedInput - safeCacheCreation);

  // Reason: multiply-then-divide — sum all terms exactly, divide once at the end.
  // BigInt `/` truncates toward zero, so the remainder (< 1 µ$) goes to the user.
  const microTimesMillion =
    BigInt(nonCachedInput) * inputRate +
    BigInt(safeCachedInput) * cachedReadRate +
    BigInt(safeCacheCreation) * pricing.cacheCreationMicro +
    BigInt(outputTokens) * outputRate;
  return microTimesMillion / 1_000_000n;
}

/**
 * Calculate USD cost for a request based on token counts. Display-only wrapper
 * around {@link calculateCostMicroUsd} — the ledger path must use the micro
 * variant directly; this float form exists for logs and tests.
 *
 * @param model - Model ID from the provider's response
 * @param inputTokens - Total prompt tokens (includes cached + cache-creation for Anthropic)
 * @param outputTokens - Number of output/completion tokens
 * @param cachedInputTokens - Tokens served from cache (billed at reduced rate)
 * @param cacheCreationTokens - Tokens written to cache (Anthropic: billed at 1.25x)
 * @returns Cost in USD (floored at the micro-USD digit)
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
): number {
  return (
    Number(
      calculateCostMicroUsd(model, inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens),
    ) / 1e6
  );
}
