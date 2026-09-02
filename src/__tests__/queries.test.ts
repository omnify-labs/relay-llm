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

/**
 * Reconstruct the normalized SQL a tagged-template call issued, with each interpolated
 * value replaced by a positional `$n` marker and whitespace collapsed. This pins the
 * FULL statement — accumulation, divisor, precision, column↔value order, and the WHERE
 * clause — instead of loose substrings, so mutations like `spend = spend` (overwrite),
 * `* 2` (overcharge), or a dropped `WHERE` are caught.
 */
function reconstructSql(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [string[], ...unknown[]];
  const sql = strings
    .map((s, i) => (i < values.length ? `${s}$${i}` : s))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return { sql, values };
}

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

  it('issues the exact accumulating, never-round-up, row-scoped UPDATE', async () => {
    // Reason: pin the WHOLE statement. Loose substring checks let these mutations
    // through (all verified to survive a substring-only assertion): `spend = spend`
    // (overwrite instead of accumulate → gate never trips), `... , 6) * 2` (2x
    // overcharge), and a dropped `WHERE user_id = ...` (charges every row). The value
    // order pins costMicroUsd before userId.
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 59_511);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    expect(sql).toBe(
      'UPDATE user_budgets SET spend = spend + trunc($0::numeric / 1000000, 6), updated_at = NOW() WHERE user_id = $1',
    );
    expect(values).toEqual([59_511, 'u1']);
  });

  it('records sub-$0.0001 charges instead of dropping them to zero spend', async () => {
    // Reason: a request costing 92 µ$ ($0.000092) is routine on cached reads of budget
    // models. Truncating the increment at 4 dp would store $0, so a stream of such
    // requests would never advance spend and the fail-close budget gate would never
    // trip. Pin the precision (≥6 dp) that makes the charge survive.
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 92);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    const decimals = Number(/\/ 1000000, (\d+)\)/.exec(sql)?.[1]);
    expect(values[0]).toBe(92);
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

  it('inserts every column bound to the matching value in order', async () => {
    // Reason: pin the full column list AND the positional value binding. A loose
    // `values.toContain(...)` cannot see a swap that writes, say, output_tokens into
    // the input_tokens column. The values array must line up 1:1 with the column list
    // below, with cost_usd derived from the same integer µ$ via exact NUMERIC division.
    mockSqlFn.mockResolvedValueOnce([{ id: 'row-1' }]);
    await insertUsageLog(record);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    expect(sql).toBe(
      'INSERT INTO usage_logs ( user_id, provider, model, input_tokens, output_tokens, total_tokens, ' +
        'cached_input_tokens, cache_creation_tokens, cost_usd, request_id, latency_ms, status_code ) VALUES ( ' +
        '$0, $1, $2, $3, $4, $5, $6, $7, $8::numeric / 1000000, $9, $10, $11 ) ' +
        'ON CONFLICT (request_id) DO NOTHING RETURNING id',
    );
    expect(values).toEqual([
      record.userId, // user_id
      record.provider, // provider
      record.model, // model
      record.inputTokens, // input_tokens
      record.outputTokens, // output_tokens
      record.totalTokens, // total_tokens
      record.cachedInputTokens, // cached_input_tokens
      record.cacheCreationTokens, // cache_creation_tokens
      record.costMicroUsd, // cost_usd (÷1e6 in SQL)
      record.requestId, // request_id
      record.latencyMs, // latency_ms
      record.statusCode, // status_code
    ]);
  });

  it('returns true when a row was inserted and false on a request_id replay', async () => {
    // Reason: the boolean is the whole idempotency contract — the caller charges spend
    // only on true. A conflict (replay after a lost ack) yields no RETURNING row.
    mockSqlFn.mockResolvedValueOnce([{ id: 'row-1' }]);
    expect(await insertUsageLog(record)).toBe(true);
    mockSqlFn.mockResolvedValueOnce([]);
    expect(await insertUsageLog(record)).toBe(false);
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(insertUsageLog(record)).rejects.toThrow('connection lost');
  });
});
