import { describe, it, expect } from 'vitest';
import { calculateCost } from '../billing/pricing.js';

describe('calculateCost', () => {
  // --- Existing tests (updated signature) ---

  it('calculates cost for known OpenAI model', () => {
    const cost = calculateCost('gpt-5.4', 1000, 500, 0, 0);
    expect(cost).toBeCloseTo(0.0025 + 0.0075, 6);
  });

  it('calculates cost for known Anthropic model', () => {
    const cost = calculateCost('claude-sonnet-4-5', 2000, 1000, 0, 0);
    expect(cost).toBeCloseTo(0.006 + 0.015, 6);
  });

  it('calculates cost for known Google model', () => {
    const cost = calculateCost('gemini-2.0-flash', 10000, 5000, 0, 0);
    expect(cost).toBeCloseTo(0.001 + 0.002, 6);
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
    // non-cached input: 200K × $2.00/M = $0.40
    // cached input: 800K × $0.50/M = $0.40
    // output: 200K × $8.00/M = $1.60
    const cost = calculateCost('gpt-4.1', 1_000_000, 200_000, 800_000, 0);
    expect(cost).toBeCloseTo(0.40 + 0.40 + 1.60, 4);
  });

  it('applies Google cached input discount (gemini-3.1-pro = 90% off)', () => {
    // 100K total input, 90K cached, 1K output
    // non-cached: 10K × $2.00/M = $0.02
    // cached: 90K × $0.20/M = $0.018
    // output: 1K × $12.00/M = $0.012
    const cost = calculateCost('gemini-3.1-pro-preview', 100_000, 1_000, 90_000, 0);
    expect(cost).toBeCloseTo(0.02 + 0.018 + 0.012, 4);
  });

  it('applies Anthropic cache read discount (claude-opus-4-6 = 90% off)', () => {
    // 50K total input (includes cache), 40K cache read, 5K output
    // non-cached: 10K × $5.00/M = $0.05
    // cache read: 40K × $0.50/M = $0.02
    // output: 5K × $25.00/M = $0.125
    const cost = calculateCost('claude-opus-4-6', 50_000, 5_000, 40_000, 0);
    expect(cost).toBeCloseTo(0.05 + 0.02 + 0.125, 4);
  });

  it('applies Anthropic cache write pricing (1.25x base input)', () => {
    // 50K total, 10K cache creation, 30K cache read, 10K non-cached, 5K output
    // non-cached: 10K × $3.00/M = $0.03
    // cache read: 30K × $0.30/M = $0.009
    // cache write: 10K × $3.75/M = $0.0375
    // output: 5K × $15.00/M = $0.075
    const cost = calculateCost('claude-sonnet-4-5', 50_000, 5_000, 30_000, 10_000);
    expect(cost).toBeCloseTo(0.03 + 0.009 + 0.0375 + 0.075, 4);
  });

  it('applies above-200K tiered pricing for Google Pro models', () => {
    // gemini-3.1-pro: 300K input (above 200K threshold), 10K output
    // input: 300K × $4.00/M = $1.20 (high tier)
    // output: 10K × $18.00/M = $0.18 (high tier)
    const cost = calculateCost('gemini-3.1-pro-preview', 300_000, 10_000, 0, 0);
    expect(cost).toBeCloseTo(1.20 + 0.18, 4);
  });

  it('applies above-200K tiered pricing with cached tokens', () => {
    // gemini-2.5-pro: 250K total, 200K cached, 5K output
    // non-cached: 50K × $2.50/M = $0.125 (high tier)
    // cached: 200K × $0.25/M = $0.05 (high tier cached)
    // output: 5K × $15.00/M = $0.075 (high tier)
    const cost = calculateCost('gemini-2.5-pro-preview', 250_000, 5_000, 200_000, 0);
    expect(cost).toBeCloseTo(0.125 + 0.05 + 0.075, 4);
  });

  it('does NOT apply above-200K pricing for models without tiers', () => {
    // gpt-4.1: 300K input — no above-200K tier exists
    const cost = calculateCost('gpt-4.1', 300_000, 0, 0, 0);
    expect(cost).toBeCloseTo(0.60, 4);
  });

  it('handles all cache tokens being zero (backward compat)', () => {
    const withZeros = calculateCost('gpt-5.4', 1000, 500, 0, 0);
    expect(withZeros).toBeCloseTo(0.0025 + 0.0075, 6);
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
