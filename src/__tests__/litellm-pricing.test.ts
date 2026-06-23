// src/__tests__/litellm-pricing.test.ts
import { describe, it, expect } from 'vitest';
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
});
