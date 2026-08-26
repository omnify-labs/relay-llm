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
 * Coerce a provider-reported token count to a safe non-negative integer.
 *
 * @param n - Raw count from the provider's usage block (may be fractional, negative,
 *   non-finite, or absent when a provider misbehaves).
 * @returns A non-negative integer safe to pass to BigInt().
 */
function safeTokenCount(n: number): number {
  // Reason: BigInt() THROWS on non-integer and non-finite input. A throw here
  // escapes logUsage before its Promise.allSettled, skipping BOTH the spend
  // increment and the usage-log row — the request would be served free and
  // unaudited. Floor (never ceil) keeps the user-favoring rounding policy, and
  // clamping at 0 keeps the running total non-negative so the final division
  // can only ever truncate downward.
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

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

  // Reason: sanitize BEFORE any arithmetic — everything below assumes non-negative
  // integers (see safeTokenCount).
  const inTok = safeTokenCount(inputTokens);
  const outTok = safeTokenCount(outputTokens);
  const cachedTok = safeTokenCount(cachedInputTokens);
  const cacheCreationTok = safeTokenCount(cacheCreationTokens);

  // Reason: Google Pro models charge 2x input / 1.5x output above 200K prompt tokens.
  // When above threshold, ALL tokens (not just the excess) use the high-tier rate.
  const useHighTier = inTok > 200_000;

  const inputRate = (useHighTier && pricing.inputMicroAbove200k != null)
    ? pricing.inputMicroAbove200k : pricing.inputMicro;
  const outputRate = (useHighTier && pricing.outputMicroAbove200k != null)
    ? pricing.outputMicroAbove200k : pricing.outputMicro;
  const cachedReadRate = (useHighTier && pricing.cachedInputMicroAbove200k != null)
    ? pricing.cachedInputMicroAbove200k : pricing.cachedInputMicro;

  // Reason: Guard against provider bugs where cached counts exceed total input.
  const safeCachedInput = Math.min(cachedTok, inTok);
  const safeCacheCreation = Math.min(cacheCreationTok, inTok - safeCachedInput);
  const nonCachedInput = Math.max(0, inTok - safeCachedInput - safeCacheCreation);

  // Reason: multiply-then-divide — sum all terms exactly, divide once at the end.
  // Every term is non-negative (safeTokenCount clamps at 0, rates are non-negative),
  // so BigInt `/` — which truncates toward zero — is a true floor here, and the
  // discarded remainder (< 1 µ$) always goes to the user.
  const microTimesMillion =
    BigInt(nonCachedInput) * inputRate +
    BigInt(safeCachedInput) * cachedReadRate +
    BigInt(safeCacheCreation) * pricing.cacheCreationMicro +
    BigInt(outTok) * outputRate;
  return microTimesMillion / 1_000_000n;
}

/**
 * Calculate USD cost for a request based on token counts, as a float.
 *
 * Display/compatibility form of {@link calculateCostMicroUsd}, kept for external
 * consumers and tests — it has no callers on relay's own billing path, which must
 * use the micro variant so no float ever touches the ledger.
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
