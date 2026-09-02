import { PRICING, type ModelPricing } from './litellm-pricing.js';

/**
 * Billing for an UNKNOWN model id (not in the served table) — fail closed.
 *
 * The proxy forwards any model a client names; a returned id that is not in PRICING
 * must never be billed at a rate cheaper than what the provider actually charges us.
 * So there is no "default price": an unknown id is billed at the CEILING — for every
 * component, the most expensive rate across all served models, floored by a hard
 * conservative-high constant so even an empty/cheap table cannot produce a cheap
 * fallback. Unknown ids can only ever be OVER-billed, never under. Each unknown id is
 * logged once so allowlist gaps surface instead of silently costing money.
 */
// The most expensive tier any provider we proxy sells today ($15/M in, $75/M out);
// cache reads at full input rate (no discount), cache writes at 1.25x input.
const CEILING_FLOOR = {
  inputMicro: 15_000_000n,
  outputMicro: 75_000_000n,
  cachedInputMicro: 15_000_000n,
  cacheCreationMicro: 18_750_000n,
} as const;

function maxMicro(...values: (bigint | undefined)[]): bigint {
  let m = 0n;
  for (const v of values) if (v !== undefined && v > m) m = v;
  return m;
}

/** Per-component max across the served table, floored by CEILING_FLOOR. */
function buildCeilingPricing(table: Record<string, ModelPricing>): ModelPricing {
  const rows = Object.values(table);
  const inputMicro = maxMicro(CEILING_FLOOR.inputMicro, ...rows.map((r) => r.inputMicro), ...rows.map((r) => r.inputMicroAbove200k));
  const outputMicro = maxMicro(CEILING_FLOOR.outputMicro, ...rows.map((r) => r.outputMicro), ...rows.map((r) => r.outputMicroAbove200k));
  const cachedInputMicro = maxMicro(CEILING_FLOOR.cachedInputMicro, ...rows.map((r) => r.cachedInputMicro), ...rows.map((r) => r.cachedInputMicroAbove200k));
  const cacheCreationMicro = maxMicro(CEILING_FLOOR.cacheCreationMicro, ...rows.map((r) => r.cacheCreationMicro));
  // Float fields are derived from the same integers so the two encodings cannot drift.
  return {
    inputMicro, outputMicro, cachedInputMicro, cacheCreationMicro,
    inputPerMillion: Number(inputMicro) / 1e6,
    outputPerMillion: Number(outputMicro) / 1e6,
    cachedInputPerMillion: Number(cachedInputMicro) / 1e6,
    cacheCreationPerMillion: Number(cacheCreationMicro) / 1e6,
  };
}

export const CEILING_PRICING: ModelPricing = buildCeilingPricing(PRICING);

const warnedUnknownModels = new Set<string>();
function pricingFor(model: string): ModelPricing {
  const known = PRICING[model];
  if (known) return known;
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(`[Relay] Unknown model id billed at CEILING pricing: ${model}`);
  }
  return CEILING_PRICING;
}

/**
 * Coerce a provider-reported token count to a safe non-negative integer.
 *
 * @param n - Raw count from the provider's usage block. Typed `number`, but provider
 *   JSON is untrusted at runtime: it may be fractional, negative, non-finite, a
 *   numeric string, or absent.
 * @returns A non-negative integer safe for BigInt() and for the INTEGER columns in
 *   usage_logs.
 */
export function safeTokenCount(n: number): number {
  // Reason: BigInt() THROWS on non-integer and non-finite input, and usage_logs'
  // token columns are INTEGER. An unsanitized value escapes logUsage before its
  // Promise.allSettled, skipping BOTH the spend increment and the audit row — the
  // request is served free and unlogged. Number() coerces numeric strings (which the
  // legacy float path billed via implicit arithmetic coercion) so we don't regress
  // them to $0; floor (never ceil) keeps the user-favoring policy; clamping at 0
  // keeps every term non-negative so the final BigInt division truncates downward.
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
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
  const pricing = pricingFor(model);

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
