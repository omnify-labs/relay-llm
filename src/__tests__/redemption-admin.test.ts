import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({ setBudget: vi.fn() }));
vi.mock('../db/queries.js', () => ({
  setUserBudget: mocks.setBudget,
  deleteUserBudget: vi.fn(),
  incrementUserBudget: vi.fn(),
}));
import { adminApp } from '../admin/handler.js';
import { RedemptionBudgetConflict } from '../db/redemption.js';

const user = '11111111-1111-4111-8111-111111111111';
const code = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const app = new Hono().route('/admin', adminApp);
const request = (body: unknown) =>
  app.request(`/admin/users/${user}/budget/redemption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('guarded redemption budget route', () => {
  beforeEach(() => {
    mocks.setBudget.mockReset().mockResolvedValue({ applied: true, protected: false });
  });
  it('uses a canonical code UUID and the persisted receipt namespace', async () => {
    const response = await request({
      budget: 50,
      code_id: code.toUpperCase(),
      phase: 'activate',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      protocol: 'redemption.v1',
      idempotency_key: `redemption_${code}`,
      applied: true,
      protected: false,
    });
    expect(mocks.setBudget).toHaveBeenCalledWith(user, 50, true, `redemption_${code}`, {
      codeId: code,
      phase: 'activate',
    });
  });
  it('reports protected replacement allowance without claiming a reset', async () => {
    mocks.setBudget.mockResolvedValue({ applied: false, protected: true });
    const response = await request({ budget: 0, code_id: code, phase: 'end' });
    expect(await response.json()).toMatchObject({
      idempotency_key: `redemption_end_${code}`,
      applied: false,
      protected: true,
    });
  });
  it.each([
    null,
    {},
    { budget: 50, code_id: code, phase: 'end' },
    { budget: 0, code_id: code, phase: 'activate' },
    { budget: -1, code_id: code, phase: 'activate' },
    { budget: 50, code_id: 'bad', phase: 'activate' },
    { budget: 50, code_id: code, phase: 'bad' },
  ])('rejects invalid transitions before querying the database: %j', async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(mocks.setBudget).not.toHaveBeenCalled();
  });
  it('maps changed entitlement to a conflict', async () => {
    mocks.setBudget.mockRejectedValue(new RedemptionBudgetConflict());
    expect((await request({ budget: 50, code_id: code, phase: 'activate' })).status).toBe(409);
  });
  it('fails closed on a database failure', async () => {
    mocks.setBudget.mockRejectedValue(new Error('Unavailable'));
    expect((await request({ budget: 50, code_id: code, phase: 'activate' })).status).toBe(500);
  });
});
