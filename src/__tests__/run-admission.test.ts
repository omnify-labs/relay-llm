import { describe, it, expect, beforeEach } from 'vitest';
import {
  isRunAdmitted,
  admitRun,
  endRun,
  touchRun,
  revokeUser,
  pruneAllUsers,
  __resetAdmissionsForTests,
  admissionCountForTests,
  MAX_ADMITTED_RUNS_PER_USER,
} from '../billing/run-admission.js';

const TTL = 1_800_000; // idle window default (30 min)

beforeEach(() => __resetAdmissionsForTests());

describe('run-admission — admit & gate', () => {
  it('is not admitted before admitRun', () => {
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
  });

  it('admits a run and reports it admitted within the idle window', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true);
    expect(isRunAdmitted('u1', 'run-a', TTL - 1)).toBe(true);
  });

  it('does not admit a different run id for the same user', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-b', 0)).toBe(false);
  });

  it('keeps admissions independent per user', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u2', 'run-a', 0)).toBe(false);
  });

  it('does not let one user\'s run id collide with another user\'s', () => {
    admitRun('u1', 'run-shared', 0);
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(false);
    admitRun('u2', 'run-shared', 0);
    expect(isRunAdmitted('u1', 'run-shared', 0)).toBe(true);
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(true);
  });

  it('keeps concurrent runs of the same user independently admitted', () => {
    // Reason: runs are serialized per tab group (navigator.locks `dassi-group-<id>`), not
    // per user — a schedule firing on one group overlaps a manual run in another. Admitting
    // run-b must not evict run-a.
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 1000);
    expect(isRunAdmitted('u1', 'run-a', 1000)).toBe(true);
    expect(isRunAdmitted('u1', 'run-b', 1000)).toBe(true);
  });
});

describe('run-admission — sliding idle window (a run is never cut off while active)', () => {
  it('slides the window on each admitted call, so an active run outlives the initial TTL', () => {
    // Reason: THE fix. A run that keeps making calls stays admitted however long it runs —
    // it is not cut off by a hard window. Each isRunAdmitted hit pushes the expiry out.
    admitRun('u1', 'run-a', 0); // expiry 0 + TTL
    expect(isRunAdmitted('u1', 'run-a', TTL - 1)).toBe(true); // refresh -> (TTL-1)+TTL
    expect(isRunAdmitted('u1', 'run-a', 2 * TTL - 2)).toBe(true); // still inside the slid window
    expect(isRunAdmitted('u1', 'run-a', 100 * TTL)).toBe(false); // long idle -> lapsed
  });

  it('lapses only after a full idle gap since the last call', () => {
    admitRun('u1', 'run-a', 0);
    // No call for the whole TTL -> the window closes exactly at TTL.
    expect(isRunAdmitted('u1', 'run-a', TTL)).toBe(false);
    expect(admissionCountForTests()).toBe(0); // pruned on the expired read
  });

  it('an idle run does not leak its bucket', () => {
    admitRun('idle-user', 'run-a', 0);
    expect(admissionCountForTests()).toBe(1);
    expect(isRunAdmitted('idle-user', 'run-a', TTL + 1)).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });
});

describe('run-admission — admitRun on an already-tracked run refreshes it', () => {
  it('re-admitting a live run slides its window instead of refusing it', () => {
    // Reason: budgetMiddleware re-admits a run whose window lapsed and re-checked under
    // budget; and the cap exemption promises a tracked run is never refused. A mutant
    // that refuses re-admission (`if (runs.has(runId)) return`) must fail here.
    admitRun('u1', 'run-a', 0); // expiry TTL
    admitRun('u1', 'run-a', TTL - 1); // refresh -> (TTL-1)+TTL
    expect(isRunAdmitted('u1', 'run-a', TTL + 1)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });
});

describe('run-admission — touchRun (keepalive)', () => {
  it('slides the idle window of an admitted run', () => {
    admitRun('u1', 'run-a', 0);
    expect(touchRun('u1', 'run-a', TTL - 1)).toBe(true); // -> (TTL-1)+TTL
    expect(isRunAdmitted('u1', 'run-a', 2 * TTL - 2)).toBe(true);
  });

  it('never admits an unknown run', () => {
    expect(touchRun('u1', 'ghost', 0)).toBe(false);
    expect(isRunAdmitted('u1', 'ghost', 0)).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });

  it('does not resurrect a lapsed run', () => {
    admitRun('u1', 'run-a', 0);
    expect(touchRun('u1', 'run-a', TTL)).toBe(false); // already lapsed
    expect(isRunAdmitted('u1', 'run-a', TTL)).toBe(false);
  });

  it('is scoped per user', () => {
    admitRun('u2', 'run-shared', 0);
    expect(touchRun('u1', 'run-shared', 0)).toBe(false);
    expect(isRunAdmitted('u2', 'run-shared', TTL - 1)).toBe(true);
  });
});

describe('run-admission — endRun (explicit end signal)', () => {
  it('drops the run immediately so the next call is re-gated', () => {
    admitRun('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-a', 1000)).toBe(true);
    endRun('u1', 'run-a');
    expect(isRunAdmitted('u1', 'run-a', 1000)).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });

  it('is scoped to the caller — one user cannot end another user\'s run', () => {
    admitRun('u1', 'run-shared', 0);
    admitRun('u2', 'run-shared', 0);
    endRun('u2', 'run-shared');
    expect(isRunAdmitted('u1', 'run-shared', 0)).toBe(true); // u1 untouched
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(false);
  });

  it('only drops the named run, leaving the user\'s other runs admitted', () => {
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 0);
    endRun('u1', 'run-a');
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
    expect(isRunAdmitted('u1', 'run-b', 0)).toBe(true);
  });

  it('is idempotent for an unknown user or run', () => {
    expect(() => endRun('nobody', 'run-x')).not.toThrow();
    admitRun('u1', 'run-a', 0);
    expect(() => endRun('u1', 'already-ended')).not.toThrow();
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true);
  });
});

describe('run-admission — cap, revoke, sweep', () => {
  it('caps concurrent admissions per user (flood of distinct run ids)', () => {
    for (let i = 0; i < MAX_ADMITTED_RUNS_PER_USER; i++) admitRun('u1', `run-${i}`, 0);
    expect(admissionCountForTests()).toBe(MAX_ADMITTED_RUNS_PER_USER);
    admitRun('u1', 'run-overflow', 0);
    expect(isRunAdmitted('u1', 'run-overflow', 0)).toBe(false);
    expect(admissionCountForTests()).toBe(MAX_ADMITTED_RUNS_PER_USER);
    admitRun('u2', 'run-x', 0); // cap is per user
    expect(isRunAdmitted('u2', 'run-x', 0)).toBe(true);
  });

  it('frees cap space as windows idle out', () => {
    for (let i = 0; i < MAX_ADMITTED_RUNS_PER_USER; i++) admitRun('u1', `run-${i}`, 0);
    admitRun('u1', 'run-later', TTL + 1); // prior windows have idled out; sweep on admit
    expect(isRunAdmitted('u1', 'run-later', TTL + 1)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });

  it('revokeUser drops every admission for that user immediately', () => {
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 0);
    admitRun('u2', 'run-c', 0);
    revokeUser('u1');
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
    expect(isRunAdmitted('u1', 'run-b', 0)).toBe(false);
    expect(isRunAdmitted('u2', 'run-c', 0)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });

  it('revokeUser is a no-op for a user with no admissions', () => {
    expect(() => revokeUser('nobody')).not.toThrow();
    expect(admissionCountForTests()).toBe(0);
  });

  it('pruneAllUsers reclaims buckets of users who went idle and never returned', () => {
    admitRun('gone-1', 'run-a', 0);
    admitRun('gone-2', 'run-b', 0);
    admitRun('active', 'run-c', TTL); // last active at TTL
    expect(admissionCountForTests()).toBe(3);
    pruneAllUsers(2 * TTL); // gone-1/gone-2 (from 0) idled; active (from TTL) idled by 2*TTL
    expect(admissionCountForTests()).toBe(0);
  });

  it('pruneAllUsers keeps still-live admissions', () => {
    admitRun('u1', 'run-a', 0);
    pruneAllUsers(TTL - 1);
    expect(isRunAdmitted('u1', 'run-a', TTL - 1)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });
});
