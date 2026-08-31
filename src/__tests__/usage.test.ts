import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for usage logging (logUsage + retryAsync).
 * Verifies independent retry, partial failure handling, and cost calculation.
 */

const mockInsertUsageLog = vi.fn();
const mockIncrementUserSpend = vi.fn();

vi.mock('../db/queries.js', () => ({
  insertUsageLog: (...args: unknown[]) => mockInsertUsageLog(...args),
  incrementUserSpend: (...args: unknown[]) => mockIncrementUserSpend(...args),
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
import {
  admitRun,
  isRunAdmitted,
  __resetAdmissionsForTests,
} from '../billing/run-admission.js';

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
  __resetAdmissionsForTests();
  mockInsertUsageLog.mockReset();
  mockIncrementUserSpend.mockReset();
  mockCalc.mockClear();
  mockCalc.mockReturnValue(5000n);
  // Default: both succeed
  mockInsertUsageLog.mockResolvedValue(undefined);
  mockIncrementUserSpend.mockResolvedValue(undefined);
});

describe('logUsage', () => {
  it('calls insertUsageLog and incrementUserSpend on success', async () => {
    await logUsage(baseRecord);

    expect(mockIncrementUserSpend).toHaveBeenCalledWith('user-abc-123', 5000);
    expect(mockInsertUsageLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-abc-123',
        provider: 'openai',
        model: 'gpt-4o',
        totalTokens: 150,
        costMicroUsd: 5000,
      }),
    );
  });

  it('passes cost args in the exact (model, in, out, cached, cacheCreation) order', async () => {
    // Reason: logUsage rewrote this 5-arg call site. A swap (e.g. cached<->cacheCreation,
    // or in<->out) would mis-price silently — a constant-return mock can't catch it, so
    // pin the call arguments positionally.
    await logUsage({
      ...baseRecord,
      inputTokens: 111,
      outputTokens: 22,
      cachedInputTokens: 33,
      cacheCreationTokens: 4,
    });
    expect(mockCalc).toHaveBeenCalledWith('gpt-4o', 111, 22, 33, 4);
  });

  it('sanitizes garbage provider counts before both the charge and the audit row', async () => {
    // Reason: usage_logs' token columns are INTEGER. A fractional/non-finite count must
    // not let the spend increment succeed while the INSERT dies (charge kept, audit row
    // lost). Counts are floored/clamped once in logUsage, so the row carries clean ints
    // and the cost is computed from the same clean ints.
    await logUsage({
      ...baseRecord,
      inputTokens: 150.9,
      outputTokens: Infinity,
      cachedInputTokens: -5,
      cacheCreationTokens: NaN,
    });
    // cost computed from sanitized ints: 150 in, 0 out, 0 cached, 0 cacheCreation
    expect(mockCalc).toHaveBeenCalledWith('gpt-4o', 150, 0, 0, 0);
    // audit row carries only integers, total = 150 + 0
    expect(mockInsertUsageLog).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 150,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 150,
      }),
    );
    // and the request is still both charged and logged (no throw skipped either leg)
    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(1);
    expect(mockInsertUsageLog).toHaveBeenCalledTimes(1);
  });

  it('retries insertUsageLog independently without duplicating incrementUserSpend', async () => {
    // insertUsageLog fails twice then succeeds; incrementUserSpend succeeds first try
    mockInsertUsageLog
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockResolvedValueOnce(undefined);

    await logUsage(baseRecord);

    // incrementUserSpend should only be called once (no retry needed)
    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(1);
    // insertUsageLog retried 3 times total
    expect(mockInsertUsageLog).toHaveBeenCalledTimes(3);
  });

  it('retries incrementUserSpend independently without duplicating insertUsageLog', async () => {
    mockIncrementUserSpend
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    await logUsage(baseRecord);

    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(2);
    expect(mockInsertUsageLog).toHaveBeenCalledTimes(1);
  });

  it('handles insertUsageLog failure without affecting incrementUserSpend', async () => {
    // insertUsageLog fails all 3 attempts
    mockInsertUsageLog.mockRejectedValue(new Error('disk full'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logUsage(baseRecord);

    // incrementUserSpend still succeeds
    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert usage log'),
    );

    consoleSpy.mockRestore();
  });

  it('handles incrementUserSpend failure without affecting insertUsageLog', async () => {
    mockIncrementUserSpend.mockRejectedValue(new Error('conn refused'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logUsage(baseRecord);

    // insertUsageLog still succeeds
    expect(mockInsertUsageLog).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to increment spend'),
    );

    consoleSpy.mockRestore();
  });

  it('handles both operations failing', async () => {
    mockInsertUsageLog.mockRejectedValue(new Error('db down'));
    mockIncrementUserSpend.mockRejectedValue(new Error('db down'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logUsage(baseRecord);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to increment spend'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert usage log'),
    );

    consoleSpy.mockRestore();
  });

  it('normalizes non-Error rejections into readable log messages', async () => {
    // Reason: covers retryAsync's non-Error branch — a driver can reject with a
    // bare string/object; retryAsync wraps it in `new Error(String(...))` so the
    // log path never crashes on `.message` and still carries the reason text.
    mockIncrementUserSpend.mockRejectedValue('string failure');
    mockInsertUsageLog.mockRejectedValue({ code: 'ECONNRESET' });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logUsage(baseRecord);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to increment spend after 3 attempts: string failure'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert usage log after 3 attempts: [object Object]'),
    );

    consoleSpy.mockRestore();
  });

  it('does not throw even when both operations fail (fail-open)', async () => {
    mockInsertUsageLog.mockRejectedValue(new Error('db down'));
    mockIncrementUserSpend.mockRejectedValue(new Error('db down'));

    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw — usage logging is fail-open
    await expect(logUsage(baseRecord)).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });

  it('debits the admitted run\'s headroom by the request cost', async () => {
    // Reason: closes the loop end-to-end — logUsage must call chargeRun so a run's own
    // spend shrinks its admission headroom. Cost mock = 5000 µ$; headroom = 6000 µ$.
    // Real clock (no now arg): logUsage's chargeRun uses Date.now(), so the window must
    // be opened on the same clock or it would read as expired.
    admitRun('user-abc-123', 'run-x', 6000);
    await logUsage({ ...baseRecord, runId: 'run-x' });
    expect(isRunAdmitted('user-abc-123', 'run-x')).toBe(true); // 5000 < 6000
    await logUsage({ ...baseRecord, runId: 'run-x' });
    expect(isRunAdmitted('user-abc-123', 'run-x')).toBe(false); // 10000 > 6000 → dropped
  });

  it('does not touch admission state when the record has no runId', async () => {
    admitRun('user-abc-123', 'run-y', 100); // tiny headroom, but this request is run-less
    await logUsage(baseRecord); // no runId
    expect(isRunAdmitted('user-abc-123', 'run-y')).toBe(true); // untouched
  });
});
