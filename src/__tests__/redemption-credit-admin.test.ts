import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const mocks = vi.hoisted(() => ({ grant: vi.fn() }));
vi.mock('../db/redemption-credit.js', () => ({
  settleRedemptionCredit: mocks.grant,
}));
import { adminApp } from '../admin/handler.js';
import { __resetAdmissionsForTests, admitRun, isRunAdmitted } from '../billing/run-admission.js';
import { RedemptionBudgetConflict } from '../db/redemption.js';
const owner = '11111111-1111-4111-8111-111111111111';
const code = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const app = new Hono().route('/admin', adminApp);
const request = (body: unknown) =>
  app.request(`/admin/users/${owner}/budget/redemption-credit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('guarded one-time redemption credit', () => {
  beforeEach(() => {
    __resetAdmissionsForTests();
    mocks.grant.mockReset().mockResolvedValue({
      account_id: owner,
      applied: true,
      idempotency_key: `redemption_credit_${code}`,
    });
  });
  it('derives value and recipient from the database rather than the request', async () => {
    const response = await request({
      code_id: code.toUpperCase(),
      delta_cents: 999999,
      account_id: 'other',
    });
    expect(response.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith(owner, code, 'grant');
    expect(await response.json()).toMatchObject({
      protocol: 'redemption-credit.v1',
      account_id: owner,
      applied: true,
    });
  });
  it.each([null, {}, { code_id: 'bad' }, { code_id: 1 }, { code_id: code, phase: 'invalid' }])(
    'rejects malformed claims %j',
    async (body) => {
      expect((await request(body)).status).toBe(400);
      expect(mocks.grant).not.toHaveBeenCalled();
    },
  );
  it('reports lost eligibility as a conflict', async () => {
    mocks.grant.mockRejectedValue(new RedemptionBudgetConflict());
    expect((await request({ code_id: code })).status).toBe(409);
  });
  it('fails closed on a database error', async () => {
    mocks.grant.mockRejectedValue(new Error('database unavailable'));
    expect((await request({ code_id: code })).status).toBe(500);
  });
  it('invalidates a personal trial admission even on an acknowledged grant replay', async () => {
    admitRun(owner, 'trial-run', Date.now(), 2);
    mocks.grant.mockResolvedValue({
      account_id: owner,
      applied: false,
      idempotency_key: `redemption_credit_${code}`,
    });
    expect((await request({ code_id: code })).status).toBe(200);
    expect(isRunAdmitted(owner, 'trial-run')).toBe(false);
  });
  it('passes revocation through the verified settlement boundary', async () => {
    admitRun(owner, 'owner-run');
    admitRun('member', 'member-run');
    mocks.grant.mockResolvedValue({
      account_id: 'workspace',
      applied: false,
      revoked_user_ids: [owner, 'member'],
    });
    expect((await request({ code_id: code, phase: 'revoke' })).status).toBe(200);
    expect(isRunAdmitted(owner, 'owner-run')).toBe(false);
    expect(isRunAdmitted('member', 'member-run')).toBe(false);
    expect(mocks.grant).toHaveBeenCalledWith(owner, code, 'revoke');
  });
});
