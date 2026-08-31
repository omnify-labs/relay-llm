import { describe, it, expect } from 'vitest';
import { calculateCost, calculateCostMicroUsd } from '../billing/pricing.js';
import { PRICING, type ModelPricing } from '../billing/litellm-pricing.js';

// helper: expected simple in+out cost from the live table
const io = (m: string, inTok: number, outTok: number) =>
  (inTok / 1e6) * PRICING[m].inputPerMillion + (outTok / 1e6) * PRICING[m].outputPerMillion;

describe('calculateCost', () => {
  // --- Existing tests (updated signature) ---

  it('calculates cost for known OpenAI model', () => {
    expect(calculateCost('gpt-5.4', 1000, 500, 0, 0)).toBeCloseTo(io('gpt-5.4', 1000, 500), 5);
  });

  it('calculates cost for known Anthropic model', () => {
    expect(calculateCost('claude-sonnet-4-5', 2000, 1000, 0, 0))
      .toBeCloseTo(io('claude-sonnet-4-5', 2000, 1000), 5);
  });

  it('calculates cost for known Google model', () => {
    expect(calculateCost('gemini-2.0-flash', 10000, 5000, 0, 0))
      .toBeCloseTo(io('gemini-2.0-flash', 10000, 5000), 5);
  });

  it('gemini-3.5-flash resolves to a real (non-default) price', () => {
    const cost = calculateCost('gemini-3.5-flash', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(io('gemini-3.5-flash', 1_000_000, 1_000_000), 4);
    expect(cost).not.toBeCloseTo(3.0 + 15.0, 4); // not the DEFAULT_PRICING fallback
  });

  it('2026-07 lineup models resolve to real (non-default) prices', () => {
    // Reason: these back the refreshed managed model list (dassi PR #2159) —
    // a missing entry would silently bill at the conservative DEFAULT_PRICING.
    // PRICING only contains served models that resolved to a real LiteLLM
    // entry, so membership alone proves the fallback isn't in play. Do NOT
    // compare against the $3/$15 sentinel here: claude-sonnet-5 moves from
    // its introductory $2/$10 to the standard $3/$15 on a future price sync,
    // where 1M+1M would legitimately equal the sentinel and false-fail.
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'gemini-3.6-flash']) {
      expect(PRICING[m], `${m} must be in the served pricing table`).toBeDefined();
      const cost = calculateCost(m, 1_000_000, 1_000_000, 0, 0);
      expect(cost).toBeCloseTo(io(m, 1_000_000, 1_000_000), 4);
    }
  });

  it('gemini-3.5-flash-lite resolves to real rates, with a non-zero cache read', () => {
    // Reason: this is the managed budget tier (dassi PR #2541), and its whole
    // point is the cheap cache read. Assert the absolute rates, not just
    // membership: `normalizeEntry()` maps a missing/renamed cache key to 0 via
    // `toMillion(undefined)`, which would bill every cached token at $0 —
    // silently free, and invisible to the generic `inputPerMillion > 0` check.
    // That is the exact inverse of the DEFAULT_PRICING overcharge this model
    // was added to avoid, so both directions are pinned here.
    const p = PRICING['gemini-3.5-flash-lite'];
    expect(p, 'gemini-3.5-flash-lite must be in the served pricing table').toBeDefined();
    expect(p.inputPerMillion).toBeCloseTo(0.3, 6);
    expect(p.outputPerMillion).toBeCloseTo(2.5, 6);
    expect(p.cachedInputPerMillion).toBeCloseTo(0.03, 6);
    expect(p.cachedInputPerMillion).toBeGreaterThan(0);
  });

  it('gemini-3.7-flash resolves to real rates, with a non-zero cache read', () => {
    // Reason: this is the cache-heavy managed default, and any silent $0
    // cached rate would under-bill every long session. Assert the absolute rates,
    // not just membership: `normalizeEntry()` maps a missing/renamed cache key to 0
    // via `toMillion(undefined)`, which would bill cached tokens at $0 — invisible
    // to the generic `inputPerMillion > 0` check. Both directions are pinned.
    const p = PRICING['gemini-3.7-flash'];
    expect(p, 'gemini-3.7-flash must be in the served pricing table').toBeDefined();
    expect(p.inputPerMillion).toBeCloseTo(0.75, 6);
    expect(p.outputPerMillion).toBeCloseTo(3.75, 6);
    expect(p.cachedInputPerMillion).toBeCloseTo(0.075, 6);
    expect(p.cacheCreationPerMillion).toBeCloseTo(0, 6);
  });

  it('gemini-3.6-flash resolves to real rates, with a non-zero cache read', () => {
    // Reason: Google halved 3.6 in the 2026-08 refresh. The vendored table carried
    // the old $1.50/$7.50 rates for weeks and billed managed users at 2× against
    // their budgets. The generic loop (L40–44) checks `calculateCost(m, …) ≈ io(m, …)`
    // — but both sides read `PRICING[m]`, so the assertion is tautological on values.
    // A future sync restoring 3.6 to $1.50/$7.50 would pass the loop. This block
    // cannot be caught by generic assertions; pinning the absolute rates here
    // catches any regression to the old billing bug.
    const p = PRICING['gemini-3.6-flash'];
    expect(p, 'gemini-3.6-flash must be in the served pricing table').toBeDefined();
    expect(p.inputPerMillion).toBeCloseTo(0.75, 6);
    expect(p.outputPerMillion).toBeCloseTo(3.75, 6);
    expect(p.cachedInputPerMillion).toBeCloseTo(0.075, 6);
    expect(p.cacheCreationPerMillion).toBeCloseTo(0, 6);
  });

  it('applies gemini-3.5-flash-lite cached input discount (90% off)', () => {
    // 100K total input, 90K cached, 1K output — same shape as the 3.5-flash
    // case above, so the two budget/mid tiers stay directly comparable.
    const p = PRICING['gemini-3.5-flash-lite'];
    const expected =
      (10_000 / 1e6) * p.inputPerMillion +
      (90_000 / 1e6) * p.cachedInputPerMillion +
      (1_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('gemini-3.5-flash-lite', 100_000, 1_000, 90_000, 0);
    expect(cost).toBeCloseTo(expected, 5);
    // Reason: failure case — an unserved id falls to DEFAULT_PRICING, which
    // charges cached reads at the full $3/M. The budget tier must be strictly
    // cheaper on this shape or the entry is not doing its job.
    const unserved = calculateCost('gemini-3.5-flash-lite-typo', 100_000, 1_000, 90_000, 0);
    expect(cost).toBeLessThan(unserved);
  });

  it('claude-opus-5 applies Anthropic cache read + write rates', () => {
    const p = PRICING['claude-opus-5'];
    const expected =
      (10_000 / 1e6) * p.inputPerMillion +
      (30_000 / 1e6) * p.cachedInputPerMillion +
      (10_000 / 1e6) * p.cacheCreationPerMillion +
      (5_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('claude-opus-5', 50_000, 5_000, 30_000, 10_000);
    expect(cost).toBeCloseTo(expected, 5);
  });

  it('applies gemini-3.5-flash cached input discount (90% off)', () => {
    // 100K total input, 90K cached, 1K output
    // non-cached: 10K × inputPerMillion/M
    // cached: 90K × cachedInputPerMillion/M
    // output: 1K × outputPerMillion/M
    const p = PRICING['gemini-3.5-flash'];
    const expected =
      (10_000 / 1e6) * p.inputPerMillion +
      (90_000 / 1e6) * p.cachedInputPerMillion +
      (1_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('gemini-3.5-flash', 100_000, 1_000, 90_000, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('uses default pricing for unknown models', () => {
    const cost = calculateCost('unknown-model-xyz', 1000000, 1000000, 0, 0);
    expect(cost).toBeCloseTo(3.0 + 15.0, 4);
  });

  it('returns 0 for zero tokens', () => {
    expect(calculateCost('gpt-5.4', 0, 0, 0, 0)).toBe(0);
  });

  // --- Cache pricing tests ---

  it('applies OpenAI cached input discount (gpt-4.1 = 75% off)', () => {
    // 1M total input, 800K cached, 200K output
    // non-cached input: 200K × inputPerMillion/M
    // cached input: 800K × cachedInputPerMillion/M
    // output: 200K × outputPerMillion/M
    const p = PRICING['gpt-4.1'];
    const expected =
      (200_000 / 1e6) * p.inputPerMillion +
      (800_000 / 1e6) * p.cachedInputPerMillion +
      (200_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('gpt-4.1', 1_000_000, 200_000, 800_000, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('applies Google cached input discount (gemini-3.1-pro = 90% off)', () => {
    // 100K total input, 90K cached, 1K output — below 200K threshold so standard rates apply
    // non-cached: 10K × inputPerMillion/M
    // cached: 90K × cachedInputPerMillion/M
    // output: 1K × outputPerMillion/M
    const p = PRICING['gemini-3.1-pro-preview'];
    const expected =
      (10_000 / 1e6) * p.inputPerMillion +
      (90_000 / 1e6) * p.cachedInputPerMillion +
      (1_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('gemini-3.1-pro-preview', 100_000, 1_000, 90_000, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('applies Anthropic cache read discount (claude-opus-4-6 = 90% off)', () => {
    // 50K total input (includes cache), 40K cache read, 5K output
    // non-cached: 10K × inputPerMillion/M
    // cache read: 40K × cachedInputPerMillion/M
    // output: 5K × outputPerMillion/M
    const p = PRICING['claude-opus-4-6'];
    const expected =
      (10_000 / 1e6) * p.inputPerMillion +
      (40_000 / 1e6) * p.cachedInputPerMillion +
      (5_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('claude-opus-4-6', 50_000, 5_000, 40_000, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('applies Anthropic cache write pricing (1.25x base input)', () => {
    // 50K total, 10K cache creation, 30K cache read, 10K non-cached, 5K output
    // non-cached: 10K × inputPerMillion/M
    // cache read: 30K × cachedInputPerMillion/M
    // cache write: 10K × cacheCreationPerMillion/M
    // output: 5K × outputPerMillion/M
    const p = PRICING['claude-sonnet-4-5'];
    const expected =
      (10_000 / 1e6) * p.inputPerMillion +
      (30_000 / 1e6) * p.cachedInputPerMillion +
      (10_000 / 1e6) * p.cacheCreationPerMillion +
      (5_000 / 1e6) * p.outputPerMillion;
    const cost = calculateCost('claude-sonnet-4-5', 50_000, 5_000, 30_000, 10_000);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('applies above-200K tiered pricing for Google Pro models', () => {
    // gemini-3.1-pro: 300K input (above 200K threshold), 10K output — high tier applies
    // input: 300K × inputPerMillionAbove200k/M
    // output: 10K × outputPerMillionAbove200k/M
    const p = PRICING['gemini-3.1-pro-preview'];
    const expected =
      (300_000 / 1e6) * p.inputPerMillionAbove200k! +
      (10_000 / 1e6) * p.outputPerMillionAbove200k!;
    const cost = calculateCost('gemini-3.1-pro-preview', 300_000, 10_000, 0, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('applies above-200K tiered pricing with cached tokens', () => {
    // gemini-2.5-pro: 250K total, 200K cached, 5K output — above 200K so high-tier rates apply
    // non-cached: 50K × inputPerMillionAbove200k/M
    // cached: 200K × cachedInputPerMillionAbove200k/M
    // output: 5K × outputPerMillionAbove200k/M
    const p = PRICING['gemini-2.5-pro-preview'];
    const expected =
      (50_000 / 1e6) * p.inputPerMillionAbove200k! +
      (200_000 / 1e6) * p.cachedInputPerMillionAbove200k! +
      (5_000 / 1e6) * p.outputPerMillionAbove200k!;
    const cost = calculateCost('gemini-2.5-pro-preview', 250_000, 5_000, 200_000, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('does NOT apply above-200K pricing for models without tiers', () => {
    // gpt-4.1: 300K input — no above-200K tier exists, standard inputPerMillion applies
    const p = PRICING['gpt-4.1'];
    const expected = (300_000 / 1e6) * p.inputPerMillion;
    const cost = calculateCost('gpt-4.1', 300_000, 0, 0, 0);
    expect(cost).toBeCloseTo(expected, 4);
  });

  it('handles all cache tokens being zero (backward compat)', () => {
    // 1000 input + 500 output, no cache — same as the simple io() helper
    const withZeros = calculateCost('gpt-5.4', 1000, 500, 0, 0);
    expect(withZeros).toBeCloseTo(io('gpt-5.4', 1000, 500), 5);
  });

  it('guards against cachedInputTokens exceeding total (provider bug)', () => {
    // cachedInputTokens (5000) > inputTokens (1000) — should clamp to inputTokens
    // Correct cost: all 1000 input treated as cached @ $0.50/M + 500 output @ $8.00/M
    // = 0.0005 + 0.004 = 0.0045
    const cost = calculateCost('gpt-4.1', 1000, 500, 5000, 0);
    expect(cost).toBeGreaterThanOrEqual(0);
    const normalCost = calculateCost('gpt-4.1', 1000, 500, 0, 0);
    expect(cost).toBeLessThanOrEqual(normalCost);
  });
});

describe('calculateCostMicroUsd (integer billing path)', () => {
  it('returns exact integer micro-USD against DEFAULT_PRICING (stable in-repo rates)', () => {
    // Unknown model → DEFAULT_PRICING $3/M in, $15/M out (pinned in pricing.ts):
    // 1000 × 3,000,000µ + 500 × 15,000,000µ = 10.5e9 → /1e6 = 10,500 µ$ = $0.0105
    expect(calculateCostMicroUsd('unknown-model-xyz', 1000, 500, 0, 0)).toBe(10_500n);
  });

  it('keeps DEFAULT_PRICING float and micro rates in agreement', () => {
    // Reason: DEFAULT_PRICING hand-writes the same rates in two encodings and is not
    // covered by the served-model consistency sweep (it is not in PRICING). An unknown
    // model is billed from it, so a drift between the two would mischarge silently.
    // 1M tokens of each makes both encodings directly comparable.
    const floatCost = calculateCost('unknown-model-xyz', 1_000_000, 1_000_000, 0, 0);
    const microCost = Number(calculateCostMicroUsd('unknown-model-xyz', 1_000_000, 1_000_000, 0, 0)) / 1e6;
    expect(microCost).toBeCloseTo(floatCost, 6);
    expect(microCost).toBeCloseTo(3.0 + 15.0, 6); // the documented $3/M + $15/M
    // Cache rates: unknown models get no discount — cached reads bill at full input rate.
    const cachedOnly = Number(calculateCostMicroUsd('unknown-model-xyz', 1_000_000, 0, 1_000_000, 0)) / 1e6;
    expect(cachedOnly).toBeCloseTo(3.0, 6);
    const writeOnly = Number(calculateCostMicroUsd('unknown-model-xyz', 1_000_000, 0, 0, 1_000_000)) / 1e6;
    expect(writeOnly).toBeCloseTo(3.0, 6);
  });

  it('floors the sub-micro-dollar remainder (user-favoring)', () => {
    // gemini-3.7-flash cache read is $0.075/M = 75,000 µ$/Mtok (rate pinned above).
    // 13 cached tokens → 13 × 75,000 = 975,000 < 1e6 → floors to 0 µ$;
    // 14 cached tokens → 1,050,000 → floors to 1 µ$ (remainder 50,000 discarded).
    expect(calculateCostMicroUsd('gemini-3.7-flash', 13, 0, 13, 0)).toBe(0n);
    expect(calculateCostMicroUsd('gemini-3.7-flash', 14, 0, 14, 0)).toBe(1n);
  });

  it('returns 0n for zero tokens', () => {
    expect(calculateCostMicroUsd('gpt-5.4', 0, 0, 0, 0)).toBe(0n);
  });

  it('stays exact where the float product loses integer precision (> 2^53)', () => {
    // 4e9 output tokens × 15e6 µ rate = 6e16 — above 2^53 (~9.007e15), so the float
    // product is no longer exactly representable; BigInt keeps it exact.
    // 6e16 / 1e6 = 6e10 µ$ = $60,000.
    const tokens = 4_000_000_000;
    const rate = 15_000_000;
    expect(Number.isSafeInteger(tokens * rate)).toBe(false); // pins the premise
    expect(calculateCostMicroUsd('unknown-model-xyz', 0, tokens, 0, 0)).toBe(60_000_000_000n);
  });

  // --- Provider-garbage hardening (BigInt() throws on non-integers) ---

  it.each([
    ['fractional', 150.5, 10.25],
    ['Infinity', Infinity, Infinity],
    ['NaN', NaN, NaN],
    ['negative', -1000, -500],
  ])('does not throw on %s token counts, and never charges below zero', (_label, inTok, outTok) => {
    // Reason: BigInt() throws a RangeError on non-integer/non-finite input. That throw
    // would escape logUsage BEFORE its Promise.allSettled, skipping both the spend
    // increment and the usage-log row — free, unaudited usage. Counts are sanitized
    // instead (floor, clamped at 0), so the call is always safe.
    let micro: bigint | undefined;
    expect(() => {
      micro = calculateCostMicroUsd('gpt-5.4', inTok, outTok, 0, 0);
    }).not.toThrow();
    expect(micro).toBeGreaterThanOrEqual(0n);
  });

  it('floors fractional token counts rather than rounding them up', () => {
    // 1000.9 input floors to 1000 — identical to a clean 1000-token request.
    expect(calculateCostMicroUsd('gpt-5.4', 1000.9, 500.9, 0, 0)).toBe(
      calculateCostMicroUsd('gpt-5.4', 1000, 500, 0, 0),
    );
  });

  it('bills numeric-string counts like the legacy float path (not $0)', () => {
    // Reason: a provider reporting counts as JSON strings ("1000") was billed by main
    // via arithmetic coercion. safeTokenCount uses Number(), so we do not regress it to
    // $0. Typed as number, so cast at the call boundary to model untrusted runtime JSON.
    const asString = calculateCostMicroUsd('gpt-5.4', '1000' as unknown as number, '500' as unknown as number, 0, 0);
    expect(asString).toBe(calculateCostMicroUsd('gpt-5.4', 1000, 500, 0, 0));
    expect(asString).toBeGreaterThan(0n);
  });

  it('ignores garbage cache counts without going negative', () => {
    // Negative cached/cache-creation counts must not inflate the non-cached term
    // (a -1e9 cached count with an unclamped formula would bill ~$3,000 of input).
    const garbage = calculateCostMicroUsd('gpt-5.4', 1000, 500, -1_000_000_000, -5.5);
    expect(garbage).toBe(calculateCostMicroUsd('gpt-5.4', 1000, 500, 0, 0));
  });

  it('agrees with the legacy float algorithm within 1 µ$ across a random sweep', () => {
    // Reason: differential test — the integer rewrite must be a refinement of the
    // old float math (identical up to the intentional floor), never a re-pricing.
    const legacyFloatCost = (
      p: ModelPricing,
      inputTokens: number,
      outputTokens: number,
      cachedInputTokens: number,
      cacheCreationTokens: number,
    ): number => {
      const useHighTier = inputTokens > 200_000;
      const inputRate = (useHighTier && p.inputPerMillionAbove200k != null)
        ? p.inputPerMillionAbove200k : p.inputPerMillion;
      const outputRate = (useHighTier && p.outputPerMillionAbove200k != null)
        ? p.outputPerMillionAbove200k : p.outputPerMillion;
      const cachedReadRate = (useHighTier && p.cachedInputPerMillionAbove200k != null)
        ? p.cachedInputPerMillionAbove200k : p.cachedInputPerMillion;
      const safeCachedInput = Math.min(cachedInputTokens, inputTokens);
      const safeCacheCreation = Math.min(cacheCreationTokens, inputTokens - safeCachedInput);
      const nonCachedInput = Math.max(0, inputTokens - safeCachedInput - safeCacheCreation);
      return (
        (nonCachedInput / 1e6) * inputRate +
        (safeCachedInput / 1e6) * cachedReadRate +
        (safeCacheCreation / 1e6) * p.cacheCreationPerMillion +
        (outputTokens / 1e6) * outputRate
      );
    };

    const models = Object.keys(PRICING);
    for (let i = 0; i < 100_000; i++) {
      const model = models[i % models.length];
      const inputTokens = Math.floor(Math.random() * 2_000_000);
      const outputTokens = Math.floor(Math.random() * 100_000);
      const cachedInputTokens = Math.floor(Math.random() * inputTokens * 1.1); // sometimes exceeds input (provider-bug path)
      const cacheCreationTokens = Math.floor(Math.random() * 50_000);
      const micro = calculateCostMicroUsd(model, inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens);
      const legacy = legacyFloatCost(PRICING[model], inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens);
      const diff = Math.abs(legacy - Number(micro) / 1e6);
      // 1 µ$ for the intentional floor + 1e-9 slack for the legacy algorithm's own float error
      expect(diff, `model=${model} in=${inputTokens} out=${outputTokens} cached=${cachedInputTokens} cc=${cacheCreationTokens}`)
        .toBeLessThanOrEqual(1e-6 + 1e-9);
    }
  });
});
