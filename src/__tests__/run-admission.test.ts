import { describe, it, expect, beforeEach } from 'vitest';
import {
  isRunAdmitted,
  admitRun,
  __resetAdmissionsForTests,
  admissionCountForTests,
  MAX_ADMITTED_RUNS_PER_USER,
  revokeUser,
} from '../billing/run-admission.js';

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

  it('keeps CONCURRENT runs of the same user independently admitted', () => {
    // Reason: a user really can have two runs in flight — runs are serialized
    // per tab group (navigator.locks `dassi-group-<id>`), not per user, so a
    // schedule firing on one group overlaps a manual run in another. Admitting
    // run-b must not evict run-a, or run-a's next call gets re-budget-checked
    // and 402s mid-task — the exact failure this feature exists to prevent.
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 1000);
    expect(isRunAdmitted('u1', 'run-a', 1000)).toBe(true);
    expect(isRunAdmitted('u1', 'run-b', 1000)).toBe(true);
  });

  it('expires each concurrent run on its own window, not a shared one', () => {
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 1000);
    // run-a's window closes first; run-b is still inside its own.
    expect(isRunAdmitted('u1', 'run-a', TTL)).toBe(false);
    expect(isRunAdmitted('u1', 'run-b', TTL)).toBe(true);
    expect(isRunAdmitted('u1', 'run-b', TTL + 1000)).toBe(false);
  });

  it('prunes expired entries so the map cannot grow without bound', () => {
    // Reason: keying per run (not per user) means the map grows with run count,
    // so admissions must be swept or a long-lived relay process leaks.
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 0);
    expect(admissionCountForTests()).toBe(2);
    // A later admit for the same user sweeps their closed windows.
    admitRun('u1', 'run-c', TTL + 1);
    expect(admissionCountForTests()).toBe(1);
    expect(isRunAdmitted('u1', 'run-c', TTL + 1)).toBe(true);
  });

  it('caps concurrent admissions per user (flood of distinct run ids)', () => {
    // Reason: runId is client-controlled. Without a cap, any authenticated user under
    // budget could flood distinct ids, each pinning an entry for the full TTL — an
    // unbounded, attacker-controlled map. Over the cap we simply do not admit, which
    // falls back to per-call budget gating: the already-safe path.
    for (let i = 0; i < MAX_ADMITTED_RUNS_PER_USER; i++) admitRun('u1', `run-${i}`, 0);
    expect(admissionCountForTests()).toBe(MAX_ADMITTED_RUNS_PER_USER);

    admitRun('u1', 'run-overflow', 0);
    expect(isRunAdmitted('u1', 'run-overflow', 0)).toBe(false);
    expect(admissionCountForTests()).toBe(MAX_ADMITTED_RUNS_PER_USER);
    // The cap is per user — a different user is unaffected.
    admitRun('u2', 'run-x', 0);
    expect(isRunAdmitted('u2', 'run-x', 0)).toBe(true);
  });

  it('revokeUser drops every admission for that user immediately', () => {
    // Reason: an admin zeroing a budget to halt runaway spend must take effect now.
    // Without this, an already-admitted run skips the budget check and keeps spending
    // for the rest of its window, silently defeating the admin control.
    admitRun('u1', 'run-a', 0);
    admitRun('u1', 'run-b', 0);
    admitRun('u2', 'run-c', 0);

    revokeUser('u1');

    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
    expect(isRunAdmitted('u1', 'run-b', 0)).toBe(false);
    // Other users are untouched.
    expect(isRunAdmitted('u2', 'run-c', 0)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });

  it('revokeUser is a no-op for a user with no admissions', () => {
    expect(() => revokeUser('nobody')).not.toThrow();
    expect(admissionCountForTests()).toBe(0);
  });

  it('does not leak the bucket of a user who goes idle after expiry', () => {
    // Reason: pruneUser only runs on that user's next admitRun, and isRunAdmitted was a
    // pure read — so a user admitted once who never returns kept their bucket and its
    // expired entries until process exit. The cap bounds entries per user, not the
    // number of user buckets.
    admitRun('idle-user', 'run-a', 0);
    expect(admissionCountForTests()).toBe(1);
    // Their window closes and they are checked once more; nothing should be retained.
    expect(isRunAdmitted('idle-user', 'run-a', TTL + 1)).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });

  it('frees cap space as windows close, without a global scan', () => {
    for (let i = 0; i < MAX_ADMITTED_RUNS_PER_USER; i++) admitRun('u1', `run-${i}`, 0);
    // Once the old windows have closed, the user can be admitted again.
    admitRun('u1', 'run-later', TTL + 1);
    expect(isRunAdmitted('u1', 'run-later', TTL + 1)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });

  it('does not let one user\'s run id collide with another user\'s', () => {
    admitRun('u1', 'run-shared', 0);
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(false);
    admitRun('u2', 'run-shared', 0);
    expect(isRunAdmitted('u1', 'run-shared', 0)).toBe(true);
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(true);
  });
});
