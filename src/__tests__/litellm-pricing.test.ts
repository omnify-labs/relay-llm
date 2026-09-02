// src/__tests__/litellm-pricing.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  PRICING, SERVED_MODELS, ALIASES, normalizeEntry, lookupRaw, missingServedModels,
} from '../billing/litellm-pricing.js';

describe('litellm-pricing', () => {
  it('converts per-token to per-million (×1e6)', () => {
    const p = normalizeEntry({ input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 });
    expect(p.inputPerMillion).toBeCloseTo(3.0, 6);
    expect(p.outputPerMillion).toBeCloseTo(15.0, 6);
  });

  it('maps cache and above-200k fields', () => {
    const p = normalizeEntry({
      input_cost_per_token: 2e-6,
      cache_read_input_token_cost: 2e-7,
      input_cost_per_token_above_200k_tokens: 4e-6,
      output_cost_per_token_above_200k_tokens: 1.8e-5,
      cache_read_input_token_cost_above_200k_tokens: 4e-7,
    });
    expect(p.cachedInputPerMillion).toBeCloseTo(0.2, 6);
    expect(p.inputPerMillionAbove200k).toBeCloseTo(4.0, 6);
    expect(p.outputPerMillionAbove200k).toBeCloseTo(18.0, 6);
    expect(p.cachedInputPerMillionAbove200k).toBeCloseTo(0.4, 6);
  });

  it('omits above-200k fields when absent', () => {
    const p = normalizeEntry({ input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 });
    expect(p.inputPerMillionAbove200k).toBeUndefined();
  });

  it('resolves aliases for non-matching keys', () => {
    expect(ALIASES['gemini-2.5-pro-preview']).toBe('gemini-2.5-pro');
    // The relay model id has no exact upstream key; the alias resolves it.
    expect(lookupRaw('gemini-2.5-pro-preview')).not.toBeNull();
  });

  it('covers every served model with a non-default price', () => {
    expect(missingServedModels()).toEqual([]);
    for (const m of SERVED_MODELS) {
      expect(PRICING[m]).toBeDefined();
      expect(PRICING[m].inputPerMillion).toBeGreaterThan(0);
    }
  });

  it('does not include the sample_spec doc entry as a served model', () => {
    expect(SERVED_MODELS).not.toContain('sample_spec');
    expect(PRICING['sample_spec']).toBeUndefined();
  });

  it('matches known anthropic rates end-to-end (claude-sonnet-4-5)', () => {
    expect(PRICING['claude-sonnet-4-5'].inputPerMillion).toBeCloseTo(3.0, 4);
    expect(PRICING['claude-sonnet-4-5'].outputPerMillion).toBeCloseTo(15.0, 4);
    expect(PRICING['claude-sonnet-4-5'].cachedInputPerMillion).toBeCloseTo(0.3, 4);
    expect(PRICING['claude-sonnet-4-5'].cacheCreationPerMillion).toBeCloseTo(3.75, 4);
  });

  it('derives exact integer micro-USD rates (µ$/Mtok = per-token × 1e12)', () => {
    // $3/M, $15/M, and the fractional $0.075/M cache-read shape that motivated
    // the integer path (75,000 µ$/Mtok is not an integer per token).
    const p = normalizeEntry({
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 7.5e-8,
    });
    expect(p.inputMicro).toBe(3_000_000n);
    expect(p.outputMicro).toBe(15_000_000n);
    expect(p.cachedInputMicro).toBe(75_000n);
  });

  it('maps absent price fields to 0n micro rates and omits above-200k micro fields', () => {
    const p = normalizeEntry({ input_cost_per_token: 2e-6 });
    expect(p.outputMicro).toBe(0n);
    expect(p.cacheCreationMicro).toBe(0n);
    expect(p.inputMicroAbove200k).toBeUndefined();
  });

  it('derives above-200k micro rates when present', () => {
    const p = normalizeEntry({
      input_cost_per_token: 2e-6,
      input_cost_per_token_above_200k_tokens: 4e-6,
      output_cost_per_token_above_200k_tokens: 1.8e-5,
      cache_read_input_token_cost_above_200k_tokens: 4e-7,
    });
    expect(p.inputMicroAbove200k).toBe(4_000_000n);
    expect(p.outputMicroAbove200k).toBe(18_000_000n);
    expect(p.cachedInputMicroAbove200k).toBe(400_000n);
  });

  it('float and micro rates agree for every served model', () => {
    // Reason: the float fields are display-only but must never drift from the
    // integer billing rates — one fact, two encodings, pinned equal here.
    for (const m of SERVED_MODELS) {
      const p = PRICING[m];
      if (!p) continue; // covered by missingServedModels() assertion above
      expect(Number(p.inputMicro) / 1e6).toBeCloseTo(p.inputPerMillion, 6);
      expect(Number(p.outputMicro) / 1e6).toBeCloseTo(p.outputPerMillion, 6);
      expect(Number(p.cachedInputMicro) / 1e6).toBeCloseTo(p.cachedInputPerMillion, 6);
      expect(Number(p.cacheCreationMicro) / 1e6).toBeCloseTo(p.cacheCreationPerMillion, 6);
    }
  });

  it('logs a loud error at table build when a served model has no price', async () => {
    // Reason: covers the buildPricingTable() missing-model branch — a silent gap
    // here means CEILING-pricing overcharge in production, so the error must fire.
    vi.resetModules();
    vi.doMock('../../vendor/litellm/model_prices_and_context_window.json', () => ({ default: {} }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../billing/litellm-pricing.js');
    expect(mod.missingServedModels()).toEqual([...mod.SERVED_MODELS]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('LiteLLM pricing MISSING'));
    spy.mockRestore();
    vi.doUnmock('../../vendor/litellm/model_prices_and_context_window.json');
    vi.resetModules();
  });
});
