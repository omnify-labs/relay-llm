import { describe, it, expect } from 'vitest';
import { calculateCost } from '../billing/pricing.js';
import { PRICING } from '../billing/litellm-pricing.js';

// helper: expected simple in+out cost from the live table
const io = (m: string, inTok: number, outTok: number) =>
  (inTok / 1e6) * PRICING[m].inputPerMillion + (outTok / 1e6) * PRICING[m].outputPerMillion;

describe('calculateCost', () => {
  // --- Existing tests (updated signature) ---

  it('calculates cost for known OpenAI model', () => {
    expect(calculateCost('gpt-5.4', 1000, 500, 0, 0)).toBeCloseTo(io('gpt-5.4', 1000, 500), 6);
  });

  it('calculates cost for known Anthropic model', () => {
    expect(calculateCost('claude-sonnet-4-5', 2000, 1000, 0, 0))
      .toBeCloseTo(io('claude-sonnet-4-5', 2000, 1000), 6);
  });

  it('calculates cost for known Google model', () => {
    expect(calculateCost('gemini-2.0-flash', 10000, 5000, 0, 0))
      .toBeCloseTo(io('gemini-2.0-flash', 10000, 5000), 6);
  });

  it('gemini-3.5-flash resolves to a real (non-default) price', () => {
    const cost = calculateCost('gemini-3.5-flash', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(io('gemini-3.5-flash', 1_000_000, 1_000_000), 4);
    expect(cost).not.toBeCloseTo(3.0 + 15.0, 4); // not the DEFAULT_PRICING fallback
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
    expect(withZeros).toBeCloseTo(io('gpt-5.4', 1000, 500), 6);
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
