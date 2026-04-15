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

import { setUserBudget, deleteUserBudget, getUserBudget, incrementUserSpend } from '../db/queries.js';

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

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(getUserBudget('u1')).rejects.toThrow('connection lost');
  });
});

describe('incrementUserSpend', () => {
  it('calls SQL update without error', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 0.05);
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
  });

  it('handles zero amount', async () => {
    mockSqlFn.mockResolvedValueOnce([]);
    await incrementUserSpend('u1', 0);
    expect(mockSqlFn).toHaveBeenCalledTimes(1);
  });

  it('propagates a DB error', async () => {
    mockSqlFn.mockRejectedValueOnce(new Error('connection lost'));
    await expect(incrementUserSpend('u1', 0.05)).rejects.toThrow('connection lost');
  });
});
