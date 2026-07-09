/**
 * Run-scoped budget admission.
 *
 * Tracks, per user, the currently-admitted agent run so `budgetMiddleware`
 * can gate budget once at a run's first call and then allow every subsequent
 * call of that run — preventing a mid-task 402 when spend crosses budget.
 *
 * A run stays admitted for a hard window (ADMISSION_TTL_MS) from admission,
 * regardless of activity — the anti-abuse ceiling. State is in-memory; a relay
 * restart clears it (an in-flight over-budget run may then be re-checked).
 */

/** Hard admission window in ms (default 30 min). */
const ADMISSION_TTL_MS = parseInt(process.env.RUN_ADMISSION_TTL_MS || '1800000', 10);

interface Admission {
  runId: string;
  expiresAt: number;
}

/** One entry per user — a user runs one agent at a time; a new run overwrites. */
const admitted = new Map<string, Admission>();

/**
 * Whether `runId` is the user's currently-admitted run and still within its
 * hard window. `now` is injectable for tests.
 */
export function isRunAdmitted(userId: string, runId: string, now: number = Date.now()): boolean {
  const entry = admitted.get(userId);
  return !!entry && entry.runId === runId && now < entry.expiresAt;
}

/** Admit `runId` for `userId`, opening a fresh hard window. `now` injectable for tests. */
export function admitRun(userId: string, runId: string, now: number = Date.now()): void {
  admitted.set(userId, { runId, expiresAt: now + ADMISSION_TTL_MS });
}

/** Test-only: clear all admissions. */
export function __resetAdmissionsForTests(): void {
  admitted.clear();
}
