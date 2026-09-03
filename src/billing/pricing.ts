import {
  PRICING,
  liveProxiedEntries,
  lookupRaw,
  normalizeEntry,
  tierPrices,
  toMicro,
  type LiteLLMEntry,
  type ModelPricing,
} from './litellm-pricing.js';

/**
 * Billing for an UNKNOWN model id (not in the served table) — fail closed.
 *
 * The proxy forwards any model a client names; a returned id that is not in PRICING
 * must never be billed at a rate cheaper than what the provider actually charges us.
 * So there is no "default price": an unknown id is billed at the CEILING — for every
 * component, the most expensive rate across EVERY live model the proxied providers
 * sell (the whole vendored table, not just served models — a client can name
 * o1-pro or gpt-4 just as easily as gpt-4o), including above-200k and 1-hour-cache
 * tiers, floored by a hard conservative-high constant so even an empty table cannot
 * produce a cheap fallback. Unknown ids can only ever be OVER-billed, never under.
 * Each unknown id is logged once so allowlist gaps surface instead of silently
 * costing money.
 */
// Backstop only — the derived ceiling from the vendored table normally dominates.
const CEILING_FLOOR = {
  inputMicro: 30_000_000n,
  outputMicro: 120_000_000n,
  cachedInputMicro: 30_000_000n,
  cacheCreationMicro: 37_500_000n,
} as const;

// Reason: guard the ceiling against a corrupt upstream row (LiteLLM has had entries
// mis-scaled by 1e6). Nothing a proxied provider sells is anywhere near $5,000/M.
const MAX_SANE_PER_TOKEN = 0.005;

function saneMicro(perToken: number | undefined): bigint {
  if (perToken === undefined || !Number.isFinite(perToken) || perToken <= 0) return 0n;
  if (perToken > MAX_SANE_PER_TOKEN) return 0n;
  return toMicro(perToken);
}

function maxMicro(...values: bigint[]): bigint {
  let m = 0n;
  for (const v of values) if (v > m) m = v;
  return m;
}

/**
 * Build the ceiling from the live proxied entries.
 *
 * @param entries - Raw LiteLLM entries to bound by (see liveProxiedEntries).
 * @returns Per-component max, floored by CEILING_FLOOR, with float fields derived from
 *   the integers so the two encodings cannot drift.
 */
export function buildCeilingPricing(entries: LiteLLMEntry[]): ModelPricing {
  // Reason: tierPrices() scans every `_above_*` tier LiteLLM ships (200k, 272k, 1hr, …)
  // so a new tier suffix cannot silently fall outside the ceiling.
  const maxOf = (component: Parameters<typeof tierPrices>[1]): bigint =>
    maxMicro(...entries.flatMap((e) => tierPrices(e, component).map(saneMicro)));
  const inputMicro = maxMicro(CEILING_FLOOR.inputMicro, maxOf('input'));
  const outputMicro = maxMicro(CEILING_FLOOR.outputMicro, maxOf('output'));
  // Reason: no cache discount for unknown ids — cached reads never bill below the
  // input ceiling.
  const cachedInputMicro = maxMicro(CEILING_FLOOR.cachedInputMicro, inputMicro, maxOf('cache_read_input'));
  const cacheCreationMicro = maxMicro(CEILING_FLOOR.cacheCreationMicro, inputMicro, maxOf('cache_creation_input'));
  return {
    inputMicro, outputMicro, cachedInputMicro, cacheCreationMicro,
    inputPerMillion: Number(inputMicro) / 1e6,
    outputPerMillion: Number(outputMicro) / 1e6,
    cachedInputPerMillion: Number(cachedInputMicro) / 1e6,
    cacheCreationPerMillion: Number(cacheCreationMicro) / 1e6,
  };
}

export const CEILING_PRICING: ModelPricing = buildCeilingPricing(liveProxiedEntries().map(([, e]) => e));

// Reason: OpenAI echoes a dated snapshot id (gpt-4o-2024-08-06) for a request that
// named the bare id (gpt-4o). Without this, EVERY served OpenAI model would fall to the
// ceiling. But a dated id is NOT always priced like its stem — gpt-4o-2024-05-13 is
// $5/$15 vs gpt-4o's $2.50/$10 — so a snapshot that LiteLLM prices itself is billed
// from ITS OWN row, and only a snapshot LiteLLM does not know is mapped to the stem.
const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a provider-returned model id to a served pricing row, tolerating dated
 * OpenAI snapshot suffixes without ever under-billing a differently-priced snapshot.
 *
 * @param model - Model id as returned by the provider.
 * @returns The pricing to bill at, or undefined when the id is genuinely unknown.
 */
export function resolveServedPricing(model: string): ModelPricing | undefined {
  const exact = PRICING[model];
  if (exact) return exact;
  const stem = model.replace(SNAPSHOT_SUFFIX, '');
  if (stem === model || !PRICING[stem]) return undefined; // not a snapshot of a served model
  const own = lookupRaw(model);
  // Reason: the snapshot has its own (possibly different) price — bill that, not the stem's.
  if (own && own.input_cost_per_token != null) return normalizeEntry(own);
  return PRICING[stem];
}

const warnedUnknownModels = new Set<string>();
function pricingFor(model: string): ModelPricing {
  const known = resolveServedPricing(model);
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
