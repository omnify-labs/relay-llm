import { describe, it, expect, beforeEach } from 'vitest';
import {
  isRunAdmitted,
  admitRun,
  chargeRun,
  __resetAdmissionsForTests,
  admissionCountForTests,
  MAX_ADMITTED_RUNS_PER_USER,
  revokeUser,
  pruneAllUsers,
} from '../billing/run-admission.js';

const TTL = 1_800_000; // 30 min default

// Reason: these window/cap/prune tests predate budget-aware headroom and don't exercise
// it. Admit with effectively unlimited headroom so chargeRun never drops the run, and
// keep the third positional arg as the injectable clock they were written against.
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const admit = (userId: string, runId: string, now?: number): void =>
  admitRun(userId, runId, UNLIMITED, now);

beforeEach(() => __resetAdmissionsForTests());

describe('run-admission', () => {
  it('is not admitted before admitRun', () => {
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
  });

  it('admits a run and reports it admitted within the window', () => {
    admit('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true);
    expect(isRunAdmitted('u1', 'run-a', TTL - 1)).toBe(true);
  });

  it('expires the admission at the hard cap', () => {
    admit('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-a', TTL)).toBe(false);
    expect(isRunAdmitted('u1', 'run-a', TTL + 1)).toBe(false);
  });

  it('does not admit a different run id for the same user', () => {
    admit('u1', 'run-a', 0);
    expect(isRunAdmitted('u1', 'run-b', 0)).toBe(false);
  });

  it('keeps admissions independent per user', () => {
    admit('u1', 'run-a', 0);
    expect(isRunAdmitted('u2', 'run-a', 0)).toBe(false);
  });

  it('keeps CONCURRENT runs of the same user independently admitted', () => {
    // Reason: a user really can have two runs in flight — runs are serialized
    // per tab group (navigator.locks `dassi-group-<id>`), not per user, so a
    // schedule firing on one group overlaps a manual run in another. Admitting
    // run-b must not evict run-a, or run-a's next call gets re-budget-checked
    // and 402s mid-task — the exact failure this feature exists to prevent.
    admit('u1', 'run-a', 0);
    admit('u1', 'run-b', 1000);
    expect(isRunAdmitted('u1', 'run-a', 1000)).toBe(true);
    expect(isRunAdmitted('u1', 'run-b', 1000)).toBe(true);
  });

  it('expires each concurrent run on its own window, not a shared one', () => {
    admit('u1', 'run-a', 0);
    admit('u1', 'run-b', 1000);
    // run-a's window closes first; run-b is still inside its own.
    expect(isRunAdmitted('u1', 'run-a', TTL)).toBe(false);
    expect(isRunAdmitted('u1', 'run-b', TTL)).toBe(true);
    expect(isRunAdmitted('u1', 'run-b', TTL + 1000)).toBe(false);
  });

  it('prunes expired entries so the map cannot grow without bound', () => {
    // Reason: keying per run (not per user) means the map grows with run count,
    // so admissions must be swept or a long-lived relay process leaks.
    admit('u1', 'run-a', 0);
    admit('u1', 'run-b', 0);
    expect(admissionCountForTests()).toBe(2);
    // A later admit for the same user sweeps their closed windows.
    admit('u1', 'run-c', TTL + 1);
    expect(admissionCountForTests()).toBe(1);
    expect(isRunAdmitted('u1', 'run-c', TTL + 1)).toBe(true);
  });

  it('caps concurrent admissions per user (flood of distinct run ids)', () => {
    // Reason: runId is client-controlled. Without a cap, any authenticated user under
    // budget could flood distinct ids, each pinning an entry for the full TTL — an
    // unbounded, attacker-controlled map. Over the cap we simply do not admit, which
    // falls back to per-call budget gating: the already-safe path.
    for (let i = 0; i < MAX_ADMITTED_RUNS_PER_USER; i++) admit('u1', `run-${i}`, 0);
    expect(admissionCountForTests()).toBe(MAX_ADMITTED_RUNS_PER_USER);

    admit('u1', 'run-overflow', 0);
    expect(isRunAdmitted('u1', 'run-overflow', 0)).toBe(false);
    expect(admissionCountForTests()).toBe(MAX_ADMITTED_RUNS_PER_USER);
    // The cap is per user — a different user is unaffected.
    admit('u2', 'run-x', 0);
    expect(isRunAdmitted('u2', 'run-x', 0)).toBe(true);
  });

  it('revokeUser drops every admission for that user immediately', () => {
    // Reason: an admin zeroing a budget to halt runaway spend must take effect now.
    // Without this, an already-admitted run skips the budget check and keeps spending
    // for the rest of its window, silently defeating the admin control.
    admit('u1', 'run-a', 0);
    admit('u1', 'run-b', 0);
    admit('u2', 'run-c', 0);

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
    admit('idle-user', 'run-a', 0);
    expect(admissionCountForTests()).toBe(1);
    // Their window closes and they are checked once more; nothing should be retained.
    expect(isRunAdmitted('idle-user', 'run-a', TTL + 1)).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });

  it('pruneAllUsers reclaims buckets of users who went idle and never returned', () => {
    // Reason: the read/admit paths only prune a user when THAT user makes another call.
    // A user admitted once who never returns would otherwise keep their bucket for the
    // process lifetime. On a long-lived (non-scale-to-zero) instance the bucket count
    // grows with every distinct user ever admitted; a periodic sweep reclaims them.
    admit('gone-1', 'run-a', 0);
    admit('gone-2', 'run-b', 0);
    admit('active', 'run-c', TTL); // still within its own window at sweep time
    expect(admissionCountForTests()).toBe(3);

    pruneAllUsers(2 * TTL); // gone-1/gone-2 expired; active's window (TTL..2*TTL) closed too
    expect(admissionCountForTests()).toBe(0);
  });

  it('pruneAllUsers keeps still-live admissions', () => {
    admit('u1', 'run-a', 0);
    pruneAllUsers(TTL - 1); // still inside the window
    expect(isRunAdmitted('u1', 'run-a', TTL - 1)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });

  it('frees cap space as windows close, without a global scan', () => {
    for (let i = 0; i < MAX_ADMITTED_RUNS_PER_USER; i++) admit('u1', `run-${i}`, 0);
    // Once the old windows have closed, the user can be admitted again.
    admit('u1', 'run-later', TTL + 1);
    expect(isRunAdmitted('u1', 'run-later', TTL + 1)).toBe(true);
    expect(admissionCountForTests()).toBe(1);
  });

  it('does not let one user\'s run id collide with another user\'s', () => {
    admit('u1', 'run-shared', 0);
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(false);
    admit('u2', 'run-shared', 0);
    expect(isRunAdmitted('u1', 'run-shared', 0)).toBe(true);
    expect(isRunAdmitted('u2', 'run-shared', 0)).toBe(true);
  });
});

describe('run-admission — budget-aware headroom (chargeRun)', () => {
  it('keeps a run admitted while its charges stay within headroom', () => {
    admitRun('u1', 'run-a', 1000, 0); // $0.001 headroom
    chargeRun('u1', 'run-a', 400, 0);
    chargeRun('u1', 'run-a', 400, 0);
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true); // 800 < 1000
  });

  it('drops the run once cumulative charges spend its headroom', () => {
    // Reason: THE fix — a run is bounded by its admission headroom, not a time window.
    // After headroom is spent the run is dropped so its next call re-reads budget.
    admitRun('u1', 'run-a', 1000, 0);
    chargeRun('u1', 'run-a', 600, 0);
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true);
    chargeRun('u1', 'run-a', 600, 0); // cumulative 1200 > 1000
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
    expect(admissionCountForTests()).toBe(0);
  });

  it('drops the run when a single charge exceeds headroom (the crossing request)', () => {
    admitRun('u1', 'run-a', 100, 0); // tiny headroom (user near the wall)
    chargeRun('u1', 'run-a', 3_750_000, 0); // one $3.75 request
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
  });

  it('bounds total overage across concurrent runs to sum of their headrooms + one request each', () => {
    // Reason: 8 runs admitted off one stale budget read (spend just under budget) each
    // carry the same tiny headroom. Each can overspend by at most headroom + the one
    // request that crosses it — NOT 8 unmetered time windows. Here 8 runs × 100µ$
    // headroom: each is dropped by its first over-headroom charge.
    for (let i = 0; i < 8; i++) admitRun('u1', `run-${i}`, 100, 0);
    expect(admissionCountForTests()).toBe(8);
    for (let i = 0; i < 8; i++) chargeRun('u1', `run-${i}`, 200, 0); // each exceeds its 100
    expect(admissionCountForTests()).toBe(0); // all dropped, no lingering window
  });

  it('chargeRun is a no-op for an unknown user, run, or expired window', () => {
    expect(() => chargeRun('nobody', 'run-x', 500, 0)).not.toThrow();
    admitRun('u1', 'run-a', 1000, 0);
    expect(() => chargeRun('u1', 'unknown-run', 500, 0)).not.toThrow();
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(true); // untouched
    // A charge landing after the TTL drops the dead window rather than debiting it.
    chargeRun('u1', 'run-a', 500, TTL + 1);
    expect(admissionCountForTests()).toBe(0);
  });

  it('clamps a negative admission headroom to zero (drops on first charge)', () => {
    // A run admitted with no headroom (e.g. rounding a spend already at budget) must not
    // become an unlimited window; the next charge drops it.
    admitRun('u1', 'run-a', -5, 0);
    chargeRun('u1', 'run-a', 1, 0);
    expect(isRunAdmitted('u1', 'run-a', 0)).toBe(false);
  });
});
