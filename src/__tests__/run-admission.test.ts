import { describe, it, expect, beforeEach } from 'vitest';
import { isRunAdmitted, admitRun, __resetAdmissionsForTests } from '../billing/run-admission.js';

const TTL = 1_800_000; // 30 min default

beforeEach(() => __resetAdmissionsForTests());

describe('run-admission', () => {
  it('is not admitted before admitRun', () => {
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
  });

  it('admits a run and reports it admitted within the window', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true);
    expect(isRunAdmitted('u1', 'run-a', TTL - 1)).toBe(true);
  });

  it('expires the admission at the hard cap', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-a', TTL)).toBe(false);
    expect(isRunAdmitted('u1', 'run-a', TTL + 1)).toBe(false);
  });

  it('does not admit a different run id for the same user', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-b', 0)).toBe(false);
  });

  it('keeps admissions independent per user', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u2', 'run-a', 0)).toBe(false);
  });

  it('re-admitting the same user replaces the prior run and resets the window', () => {
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 1000);
    expect(isRunAdmitted('u1', 'run-a', 1000)).toBe(false);
    expect(isRunAdmitted('u1', 'run-b', 1000)).toBe(true);
  });
});
