// src/__tests__/litellm-prices-check.test.ts
/**
 * Unit tests for the price-sync fingerprint.
 *
 * Reason this file exists: servedFingerprint() JSON.stringify's normalizeEntry()
 * output, so any non-serializable field added to ModelPricing (bigint micro rates,
 * for instance) makes the scheduled litellm-prices-sync workflow throw
 * `TypeError: Do not know how to serialize a BigInt` on every run — silently
 * stopping price refreshes while the vitest suite stays green. These tests run the
 * fingerprint against the real vendored table so that class of breakage cannot ship.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { servedFingerprint, SERVED_MODELS, ALIASES } from '../billing/litellm-pricing.js';

const VENDORED = 'vendor/litellm/model_prices_and_context_window.json';
const vendored = JSON.parse(readFileSync(VENDORED, 'utf8')) as Record<
  string,
  Record<string, unknown>
>;

describe('servedFingerprint', () => {
  it('serializes the real vendored table without throwing', () => {
    expect(() => servedFingerprint(vendored)).not.toThrow();
    expect(servedFingerprint(vendored).length).toBeGreaterThan(0);
  });

  it('covers every served model', () => {
    const parsed = JSON.parse(servedFingerprint(vendored)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...SERVED_MODELS].sort());
  });

  it('includes the integer micro rates the ledger bills from', () => {
    // Reason: the fingerprint decides whether a price change opens a sync PR. If it
    // omitted the micro rates, a price move that changed only them would go unnoticed.
    const parsed = JSON.parse(servedFingerprint(vendored)) as Record<
      string,
      Record<string, unknown>
    >;
    const sonnet = parsed['claude-sonnet-4-5'];
    expect(sonnet).toBeTruthy();
    expect(sonnet.inputMicro).toBe('3000000');
    expect(sonnet.outputMicro).toBe('15000000');
  });

  it('is stable across calls and changes when a served price moves', () => {
    const before = servedFingerprint(vendored);
    expect(servedFingerprint(vendored)).toBe(before);

    const key = ALIASES['claude-sonnet-4-5'] ?? 'claude-sonnet-4-5';
    const bumped = {
      ...vendored,
      [key]: { ...vendored[key], input_cost_per_token: 9e-6 },
    };
    expect(servedFingerprint(bumped)).not.toBe(before);
  });

  it('ignores price moves on models relay does not serve', () => {
    const unserved = Object.keys(vendored).find(
      (m) => !SERVED_MODELS.includes(m) && vendored[m]?.input_cost_per_token != null,
    );
    expect(unserved, 'vendored table should contain unserved models').toBeTruthy();
    const noisy = {
      ...vendored,
      [unserved as string]: { ...vendored[unserved as string], input_cost_per_token: 1 },
    };
    expect(servedFingerprint(noisy)).toBe(servedFingerprint(vendored));
  });

  it('maps a served model with no usable price to null', () => {
    const stripped = { ...vendored };
    delete stripped[ALIASES['gpt-5.4'] ?? 'gpt-5.4'];
    const parsed = JSON.parse(servedFingerprint(stripped)) as Record<string, unknown>;
    expect(parsed['gpt-5.4']).toBeNull();
  });
});
