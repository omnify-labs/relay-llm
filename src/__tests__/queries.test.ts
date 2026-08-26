import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for database query functions.
 * Mocks the postgres.js tagged template to verify SQL branching logic.
 */

// Reason: postgres.js uses tagged template literals (sql`...`). We mock getDb()
// to return a function that captures call count and returns configurable results.
const mockSqlFn = vi.fn();
vi.mock('../db/client.js', () => ({
  getDb: () => mockSqlFn,
}));

import {
  setUserBudget,
  deleteUserBudget,
  getUserBudget,
  incrementUserSpend,
  insertUsageLog,
  type UsageLogInsert,
} from '../db/queries.js';

beforeEach(() => {
  mockSqlFn.mockReset();
});

describe('setUserBudget', () => {
  it('returns true on successful upsert (resetSpend: false)', async () => {
    mockSqlFn.mockResolvedValueOnce([{ user_id: 'u1' }]);
    const result = await setUserBudget('u1', 10, false);
    expect(result).toBe(true);
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
  });

  it('returns true on successful upsert (resetSpend: true)', async () => {
    mockSqlFn.mockResolvedValueOnce([{ user_id: 'u1' }]);
    const result = await setUserBudget('u1', 25, true);
    expect(result).toBe(true);
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
  });

  it('calls different SQL paths for resetSpend true vs false', async () => {
    // Reason: The two branches produce different SQL (one zeros spend, the other doesn't).
    // We verify both branches are reachable and produce results.
    mockSqlFn.mockResolvedValue([{ user_id: 'u1' }]);

    await setUserBudget('u1', 10, false);
    const callNoReset = mockSqlFn.mock.calls[0];

    mockSqlFn.mockClear();

    await setUserBudget('u1', 10, true);
    const callWithReset = mockSqlFn.mock.calls[0];

    // Tagged template calls differ — the resetSpend: true path includes spend = 0
    expect(callNoReset).not.toEqual(callWithReset);
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(setUserBudget('u1', 10, false)).rejects.toThrow('connection lost');
  });
});

describe('deleteUserBudget', () => {
  it('returns true when a row was deleted', async () => {
    mockSqlFn.mockResolvedValueOnce([{ user_id: 'u1' }]);
    const result = await deleteUserBudget('u1');
    expect(result).toBe(true);
  });

  it('returns false when no row existed', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    const result = await deleteUserBudget('nobody');
    expect(result).toBe(false);
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(deleteUserBudget('u1')).rejects.toThrow('connection lost');
  });
});

describe('getUserBudget', () => {
  it('returns budget record when user exists', async () => {
    mockSqlFn.mockResolvedValueOnce([{ budget: '25.0000', spend: '3.5000' }]);
    const result = await getUserBudget('u1');
    expect(result).toEqual({ budget: 25, spend: 3.5 });
  });

  it('returns null when user has no budget', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    const result = await getUserBudget('nobody');
    expect(result).toBeNull();
  });

  it('coerces null/unparseable budget columns to 0 instead of NaN', async () => {
    // Reason: covers the `parseFloat(...) || 0` fallback — a NaN here would make
    // the fail-closed `spend >= budget` comparison in budgetMiddleware always
    // false and silently unlimit the user.
    mockSqlFn.mockResolvedValueOnce([{ budget: null, spend: 'not-a-number' }]);
    const result = await getUserBudget('u1');
    expect(result).toEqual({ budget: 0, spend: 0 });
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(getUserBudget('u1')).rejects.toThrow('connection lost');
  });
});

describe('incrementUserSpend', () => {
  it('calls SQL update without error', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 59_511);
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
  });

  it('adds the exact micro-USD amount and never rounds up', async () => {
    // Reason: the never-round-up policy lives in the SQL text — pin it so a refactor
    // back to a bare `spend + ${amount}` (implicit half-up NUMERIC rounding) fails
    // loudly. 6 dp matches the micro-USD granularity of the charge, so the write is
    // lossless; 4 dp would silently drop every sub-$0.0001 request to zero spend.
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 59_511);
    const [strings, ...values] = mockSqlFn.mock.calls[0];
    const sqlText = (strings as string[]).join('?');
    expect(sqlText).toContain('trunc(');
    expect(sqlText).toContain('/ 1000000, 6)');
    expect(values).toContain(59_511);
  });

  it('records sub-$0.0001 charges instead of dropping them to zero spend', async () => {
    // Reason: a request costing 92 µ$ ($0.000092) is routine on cached reads of
    // budget models. Truncating the increment at 4 dp would store $0 for it, so a
    // stream of such requests would never advance spend and the fail-close budget
    // gate would never trip. Pin the precision that makes the charge survive.
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 92);
    const [strings, ...values] = mockSqlFn.mock.calls[0];
    const sqlText = (strings as string[]).join('?');
    const decimals = Number(/\/ 1000000, (\d+)\)/.exec(sqlText)?.[1]);
    expect(values).toContain(92);
    // 92 µ$ = 0.000092 — needs at least 6 decimal places to survive truncation.
    expect(decimals).toBeGreaterThanOrEqual(6);
  });

  it('handles zero amount', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 0);
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(incrementUserSpend('u1', 59_511)).rejects.toThrow('connection lost');
  });
});

describe('insertUsageLog', () => {
  const record: UsageLogInsert = {
    userId: 'u1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 18_452,
    outputTokens: 2_437,
    totalTokens: 20_889,
    cachedInputTokens: 12_000,
    cacheCreationTokens: 0,
    costMicroUsd: 59_511,
    requestId: 'req-1',
    latencyMs: 1200,
    statusCode: 200,
  };

  it('passes the integer micro-USD amount and converts to USD in SQL', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await insertUsageLog(record);
    const [strings, ...values] = mockSqlFn.mock.calls[0];
    const sqlText = (strings as string[]).join('?');
    // Reason: cost_usd must be derived from the same integer as the spend
    // increment — division happens in exact NUMERIC, not in JS floats. The trailing
    // comma anchors the divisor: a plain `toContain('/ 1000000')` also matches a
    // 10x-overcharge typo like `/ 10000000`.
    expect(sqlText).toMatch(/::numeric \/ 1000000\s*,/);
    expect(values).toContain(59_511);
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(insertUsageLog(record)).rejects.toThrow('connection lost');
  });
});
