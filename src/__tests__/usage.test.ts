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
  mockInsertUsageLog.mockReset();
  mockIncrementUserSpend.mockReset();
  mockCalc.mockClear();
  mockCalc.mockReturnValue(5000n);
  // Default: the row is freshly inserted (true) and the increment succeeds.
  mockInsertUsageLog.mockResolvedValue(true);
  mockIncrementUserSpend.mockResolvedValue(undefined);
});

describe('logUsage', () => {
  it('inserts the audit row, then increments spend', async () => {
    await logUsage(baseRecord);

    expect(mockInsertUsageLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-abc-123',
        provider: 'openai',
        model: 'gpt-4o',
        totalTokens: 150,
        costMicroUsd: 5000,
      }),
    );
    expect(mockIncrementUserSpend).toHaveBeenCalledWith('user-abc-123', 5000);
    // Reason: the row is the idempotency record, so it must land BEFORE the charge.
    expect(mockInsertUsageLog.mock.invocationCallOrder[0]).toBeLessThan(
      mockIncrementUserSpend.mock.invocationCallOrder[0],
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
    expect(mockCalc).toHaveBeenCalledWith('gpt-4o', 150, 0, 0, 0);
    expect(mockInsertUsageLog).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 150,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 150,
      }),
    );
    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(1);
    expect(mockInsertUsageLog).toHaveBeenCalledTimes(1);
  });

  it('skips the spend increment on a request_id replay (row already logged)', async () => {
    // Reason: THE double-charge fix. A retried write after a lost ack conflicts on
    // request_id (insert returns false) — the request was already charged, so no
    // second increment.
    mockInsertUsageLog.mockResolvedValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await logUsage(baseRecord);

    expect(mockIncrementUserSpend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replay ignored'));
    warn.mockRestore();
  });

  it('retries the insert and charges exactly once after it finally succeeds', async () => {
    mockInsertUsageLog
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockRejectedValueOnce(new Error('conn reset'))
      .mockResolvedValueOnce(true);

    await logUsage(baseRecord);

    expect(mockInsertUsageLog).toHaveBeenCalledTimes(3);
    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(1);
  });

  it('retries the increment without re-inserting the row', async () => {
    mockIncrementUserSpend
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    await logUsage(baseRecord);

    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(2);
    expect(mockInsertUsageLog).toHaveBeenCalledTimes(1);
  });

  it('does not charge when the audit row cannot be inserted (spend and audit stay consistent)', async () => {
    // Reason: deliberate semantics change from the old "independent legs" design —
    // without an audit row there is no idempotency record, so charging would risk a
    // double-charge on a later retry and would leave spend unexplained by usage_logs.
    mockInsertUsageLog.mockRejectedValue(new Error('disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logUsage(baseRecord);

    expect(mockInsertUsageLog).toHaveBeenCalledTimes(3);
    expect(mockIncrementUserSpend).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert usage log after 3 attempts (not charged)'),
    );
    consoleSpy.mockRestore();
  });

  it('logs an increment failure after the row was inserted, without re-inserting', async () => {
    mockIncrementUserSpend.mockRejectedValue(new Error('conn refused'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await logUsage(baseRecord);

    expect(mockInsertUsageLog).toHaveBeenCalledTimes(1);
    expect(mockIncrementUserSpend).toHaveBeenCalledTimes(3);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to increment spend after 3 attempts (row logged)'),
    );
    consoleSpy.mockRestore();
  });

  it('normalizes non-Error rejections into readable log messages', async () => {
    // Reason: covers retryAsync's non-Error branch — a driver can reject with a bare
    // string/object; retryAsync wraps it in `new Error(String(...))` so the log path
    // never crashes on `.message` and still carries the reason text.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockInsertUsageLog.mockRejectedValue({ code: 'ECONNRESET' });
    await logUsage(baseRecord);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert usage log after 3 attempts (not charged): user=user-abc request=req-001: [object Object]'),
    );

    mockInsertUsageLog.mockResolvedValue(true);
    mockIncrementUserSpend.mockRejectedValue('string failure');
    await logUsage(baseRecord);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to increment spend after 3 attempts (row logged): user=user-abc request=req-001: string failure'),
    );
    consoleSpy.mockRestore();
  });

  it('does not throw even when the DB is down (fail-open)', async () => {
    mockInsertUsageLog.mockRejectedValue(new Error('db down'));
    mockIncrementUserSpend.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(logUsage(baseRecord)).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });
});
