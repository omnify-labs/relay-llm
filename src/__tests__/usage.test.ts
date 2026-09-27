import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for usage logging (logUsage + retryAsync).
 * Verifies independent retry, partial failure handling, and cost calculation.
 */

const mockRecordUsage = vi.fn();

vi.mock('../db/queries.js', () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

// Reason: keep the REAL safeTokenCount (logUsage now sanitizes counts through it) but
// stub the cost so tests assert wiring, not pricing. Spreading importActual preserves
// every other export.
vi.mock('../billing/pricing.js', async (importActual) => {
  const actual = await importActual<typeof import('../billing/pricing.js')>();
  return { ...actual, calculateCostMicroUsd: vi.fn().mockReturnValue(5000n) }; // 5000 µ$ = $0.005
});

import { logUsage, type UsageRecord } from '../billing/usage.js';
import { calculateCostMicroUsd } from '../billing/pricing.js';

const mockCalc = vi.mocked(calculateCostMicroUsd);

const baseRecord: UsageRecord = {
  userId: 'user-abc-123',
  provider: 'openai',
  model: 'gpt-4o',
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  requestId: 'req-001',
  latencyMs: 200,
  statusCode: 200,
};

beforeEach(() => {
  mockRecordUsage.mockReset();
  mockCalc.mockClear();
  mockCalc.mockReturnValue(5000n);
  mockRecordUsage.mockResolvedValue('charged');
});

describe('logUsage', () => {
  it('records the row and the charge in one atomic write with the sanitized values', async () => {
    await logUsage(baseRecord);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-abc-123',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costMicroUsd: 5000,
        requestId: 'req-001',
      }),
    );
  });

  it('passes cost args in the exact (model, in, out, cached, cacheCreation) order', async () => {
    await logUsage({ ...baseRecord, inputTokens: 111, outputTokens: 22, cachedInputTokens: 33, cacheCreationTokens: 4 });
    expect(mockCalc).toHaveBeenCalledWith('gpt-4o', 111, 22, 33, 4);
  });

  it('sanitizes garbage provider counts before the write', async () => {
    // Reason: usage_logs' token columns are INTEGER; a fractional/non-finite count
    // would make the atomic write fail — and then nothing would be charged.
    await logUsage({ ...baseRecord, inputTokens: 150.9, outputTokens: Infinity, cachedInputTokens: -5, cacheCreationTokens: NaN });
    expect(mockCalc).toHaveBeenCalledWith('gpt-4o', 150, 0, 0, 0);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 150, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 150 }),
    );
  });

  it('treats a replay as already charged: warns, does not throw, writes nothing else', async () => {
    // Reason: THE double-charge fix. 'replay' means the earlier attempt's single
    // statement already committed row + charge together.
    mockRecordUsage.mockResolvedValue('replay');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(logUsage(baseRecord)).resolves.toBeUndefined();
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replay ignored'));
    warn.mockRestore();
  });

  it("logs an error and writes nothing else when the row was recorded but no budget row existed ('uncharged')", async () => {
    mockRecordUsage.mockResolvedValue('uncharged');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(logUsage(baseRecord)).resolves.toBeUndefined();
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT charged'));
    error.mockRestore();
  });

  it('retries the whole atomic write and stops after the first success', async () => {
    mockRecordUsage
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockResolvedValueOnce('charged');
    await logUsage(baseRecord);
    expect(mockRecordUsage).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 failed attempts: neither logged nor charged, error logged, no throw', async () => {
    mockRecordUsage.mockRejectedValue(new Error('disk full'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(logUsage(baseRecord)).resolves.toBeUndefined();
    expect(mockRecordUsage).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record usage after 3 attempts (not logged, not charged): user=user-abc request=req-001: disk full'),
    );
    err.mockRestore();
  });

  it('normalizes a non-Error rejection into a readable log message', async () => {
    // Reason: covers retryAsync's non-Error branch — a driver can reject with a bare
    // object; retryAsync wraps it in new Error(String(...)).
    mockRecordUsage.mockRejectedValue({ code: 'ECONNRESET' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await logUsage(baseRecord);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
    err.mockRestore();
  });
});
