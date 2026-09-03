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
  incrementUserBudget,
  recordUsage,
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

  it('resetSpend:false — ONE statement writing base + remaining purchased credit, spend untouched', async () => {
    mockSqlFn.mockResolvedValueOnce([{ user_id: 'u1' }]);
    await setUserBudget('u1', 200, false);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    expect(sql).toBe(
      'INSERT INTO user_budgets (user_id, budget) VALUES ($0, $1::numeric + ' +
        '(SELECT COALESCE(SUM(remaining_cents), 0) FROM budget_increments WHERE user_id = $2) / 100.0) ' +
        'ON CONFLICT (user_id) DO UPDATE SET budget = EXCLUDED.budget, updated_at = NOW() RETURNING user_id',
    );
    expect(values).toEqual(['u1', 200, 'u1']);
  });

  it('resetSpend:true — ONE statement: FIFO draw-down of over-base spend, then base + remaining, spend = 0', async () => {
    mockSqlFn.mockResolvedValueOnce([{ user_id: 'u1' }]);
    await setUserBudget('u1', 50, true);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    expect(sql).toBe(
      'WITH cur AS ( SELECT budget, spend FROM user_budgets WHERE user_id = $0 ), ' +
        'purchased AS ( SELECT idempotency_key, remaining_cents, COALESCE(SUM(remaining_cents) OVER ' +
        '(ORDER BY created_at, idempotency_key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_cents ' +
        'FROM budget_increments WHERE user_id = $1 AND remaining_cents > 0 ), ' +
        'consumed AS ( SELECT COALESCE(( SELECT GREATEST(0, floor((cur.spend - (cur.budget - ' +
        '(SELECT COALESCE(SUM(remaining_cents), 0) FROM purchased) / 100.0)) * 100))::bigint FROM cur ), 0) AS cents ), ' +
        'drawn AS ( UPDATE budget_increments b SET remaining_cents = b.remaining_cents - ' +
        'LEAST(b.remaining_cents, GREATEST(0, c.cents - p.prior_cents))::int FROM purchased p, consumed c ' +
        'WHERE b.idempotency_key = p.idempotency_key RETURNING b.remaining_cents ), ' +
        'upsert AS ( INSERT INTO user_budgets (user_id, budget, spend) VALUES ($2, $3::numeric + ' +
        '(SELECT COALESCE(SUM(remaining_cents), 0) FROM drawn) / 100.0, 0) ' +
        'ON CONFLICT (user_id) DO UPDATE SET budget = EXCLUDED.budget, spend = 0, updated_at = NOW() RETURNING user_id ) ' +
        'SELECT user_id FROM upsert',
    );
    expect(values).toEqual(['u1', 'u1', 'u1', 50]);
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

describe('recordUsage (atomic insert + charge)', () => {
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

  it('issues ONE statement that inserts the row and charges spend only when the row was inserted', async () => {
    // Reason: pin the whole statement. The idempotency and atomicity live in the SQL
    // text: ON CONFLICT (request_id) DO NOTHING, the UPDATE gated on EXISTS(ins), the
    // never-round-up trunc(…, 6), the row-scoped WHERE user_id, and the positional
    // binding of every value (cost appears twice: the row and the charge).
    mockSqlFn.mockResolvedValueOnce([{ inserted: '1', charged: '1' }]);
    await recordUsage(record);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    expect(sql).toBe(
      'WITH ins AS ( INSERT INTO usage_logs ( user_id, provider, model, input_tokens, output_tokens, total_tokens, ' +
        'cached_input_tokens, cache_creation_tokens, cost_usd, request_id, latency_ms, status_code ) VALUES ( ' +
        '$0, $1, $2, $3, $4, $5, $6, $7, $8::numeric / 1000000, $9, $10, $11 ) ' +
        'ON CONFLICT (request_id) DO NOTHING RETURNING id ), ' +
        'charged AS ( UPDATE user_budgets SET spend = spend + trunc($12::numeric / 1000000, 6), updated_at = NOW() ' +
        'WHERE user_id = $13 AND EXISTS (SELECT 1 FROM ins) RETURNING user_id ) ' +
        'SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT count(*) FROM charged) AS charged',
    );
    expect(values).toEqual([
      record.userId, record.provider, record.model,
      record.inputTokens, record.outputTokens, record.totalTokens,
      record.cachedInputTokens, record.cacheCreationTokens,
      record.costMicroUsd, record.requestId, record.latencyMs, record.statusCode,
      record.costMicroUsd, record.userId,
    ]);
  });

  it("returns 'charged' only when BOTH the row was inserted and a budget row was debited", async () => {
    mockSqlFn.mockResolvedValueOnce([{ inserted: '1', charged: '1' }]);
    expect(await recordUsage(record)).toBe('charged');
  });

  it("returns 'replay' on a request_id conflict (already recorded and charged)", async () => {
    mockSqlFn.mockResolvedValueOnce([{ inserted: '0', charged: '0' }]);
    expect(await recordUsage(record)).toBe('replay');
  });

  it("returns 'uncharged' when the row was inserted but no user_budgets row exists to debit", async () => {
    mockSqlFn.mockResolvedValueOnce([{ inserted: '1', charged: '0' }]);
    expect(await recordUsage(record)).toBe('uncharged');
  });

  it('throws on an empty result set instead of reporting a silent replay', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await expect(recordUsage(record)).rejects.toThrow('no rows');
  });

  it('propagates a DB error (the caller retries the whole atomic write)', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(recordUsage(record)).rejects.toThrow('connection lost');
  });
});

describe('incrementUserBudget (exactly-once purchased credit)', () => {
  it('issues ONE statement: claims the idempotency key and feeds the upsert from that claim', async () => {
    mockSqlFn.mockResolvedValueOnce([{ applied: '1', budget: '60.0000', spend: '50.021400' }]);
    await incrementUserBudget('u1', 1000, 'pi_1');
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
    const { sql, values } = reconstructSql(mockSqlFn.mock.calls[0]);
    expect(sql).toBe(
      'WITH ins AS ( INSERT INTO budget_increments (idempotency_key, user_id, delta_cents, remaining_cents) VALUES ($0, $1, $2, $3) ' +
        'ON CONFLICT (idempotency_key) DO NOTHING RETURNING delta_cents ), ' +
        'applied AS ( INSERT INTO user_budgets (user_id, budget, spend) SELECT $4, delta_cents::numeric / 100, 0 FROM ins ' +
        'ON CONFLICT (user_id) DO UPDATE SET budget = user_budgets.budget + EXCLUDED.budget, updated_at = NOW() ' +
        'RETURNING budget, spend ) ' +
        'SELECT (SELECT count(*) FROM ins) AS applied, ' +
        'COALESCE((SELECT budget FROM applied), (SELECT budget FROM user_budgets WHERE user_id = $5)) AS budget, ' +
        'COALESCE((SELECT spend FROM applied), (SELECT spend FROM user_budgets WHERE user_id = $6)) AS spend',
    );
    expect(values).toEqual(['pi_1', 'u1', 1000, 1000, 'u1', 'u1', 'u1']);
  });

  it('maps a fresh key to applied:true with the post-increment ledger', async () => {
    mockSqlFn.mockResolvedValueOnce([{ applied: '1', budget: '60.0000', spend: '50.021400' }]);
    expect(await incrementUserBudget('u1', 1000, 'pi_1')).toEqual({ applied: true, budget: 60, spend: 50.0214 });
  });

  it('maps a replayed key to applied:false and still reports the current ledger', async () => {
    mockSqlFn.mockResolvedValueOnce([{ applied: '0', budget: '60.0000', spend: '50.021400' }]);
    expect(await incrementUserBudget('u1', 1000, 'pi_1')).toEqual({ applied: false, budget: 60, spend: 50.0214 });
  });

  it('reports 0/0 for a replay against a user with no budget row', async () => {
    mockSqlFn.mockResolvedValueOnce([{ applied: '0', budget: null, spend: null }]);
    expect(await incrementUserBudget('ghost', 1000, 'pi_1')).toEqual({ applied: false, budget: 0, spend: 0 });
  });

  it('throws on an empty result set and propagates DB errors (the webhook retries)', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await expect(incrementUserBudget('u1', 1000, 'pi_1')).rejects.toThrow('no rows');
    mockSqlFn.mockRejectedValueOnce(new Error('connection refused'));
    await expect(incrementUserBudget('u1', 1000, 'pi_1')).rejects.toThrow('connection refused');
  });
});
