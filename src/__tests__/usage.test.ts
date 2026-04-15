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

vi.mock('../billing/pricing.js', () => ({
  calculateCost: vi.fn().mockReturnValue(0.005),
}));

import { logUsage, type UsageRecord } from '../billing/usage.js';

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
  // Default: both succeed
  mockInsertUsageLog.mockResolvedValue(undefined);
  mockIncrementUserSpend.mockResolvedValue(undefined);
});

describe('logUsage', () => {
  it('calls insertUsageLog and incrementUserSpend on success', async () => {
    await logUsage(baseRecord);

    expect(mockIncrementUserSpend).toHaveBeenCalledWith('user-abc-123', 0.005);
    expect(mockInsertUsageLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-abc-123',
        provider: 'openai',
        model: 'gpt-4o',
        totalTokens: 150,
        costUsd: 0.005,
      }),
    );
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

  it('does not throw even when both operations fail (fail-open)', async () => {
    mockInsertUsageLog.mockRejectedValue(new Error('db down'));
    mockIncrementUserSpend.mockRejectedValue(new Error('db down'));

    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw — usage logging is fail-open
    await expect(logUsage(baseRecord)).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });
});
