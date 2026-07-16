/**
 * Run-scoped budget admission.
 *
 * Tracks admitted agent runs so `budgetMiddleware` can gate budget once at a
 * run's first call and then allow every subsequent call of that run —
 * preventing a mid-task 402 when spend crosses budget.
 *
 * A run stays admitted for a hard window (ADMISSION_TTL_MS) from admission,
 * regardless of activity — the anti-abuse ceiling. State is in-memory; a relay
 * restart clears it (an in-flight over-budget run may then be re-checked).
 */

/** Hard admission window in ms (default 30 min). */
const DEFAULT_ADMISSION_TTL_MS = 1_800_000;
const parsedTtl = parseInt(process.env.RUN_ADMISSION_TTL_MS || '', 10);
// Reason: a malformed env value must not silently disable admission. NaN would make
// every `now < expiresAt` false, so no run would ever stay admitted and every call
// would fall back to per-call gating — the bug this module exists to fix, but silent.
const ADMISSION_TTL_MS =
  Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_ADMISSION_TTL_MS;

/**
 * Admitted runs keyed by user+run, valued by expiry.
 *
 * Reason: keyed per RUN, not per user. Dassi serializes runs per tab group
 * (`navigator.locks` on `dassi-group-<id>`), not per user, so one user can have
 * concurrent runs — e.g. a schedule firing on one group while they work manually
 * in another. A per-user entry would let the newer run evict the older one, and
 * the older run's next call would be re-budget-checked and 402'd mid-task.
 */
const admitted = new Map<string, number>();

/** Composite key; the NUL separator cannot occur in a uuid, so keys cannot collide. */
function admissionKey(userId: string, runId: string): string {
  return `${userId}\u0000${runId}`;
}

/**
 * Drop admissions whose hard window has closed.
 *
 * Reason: keying per run means the map grows with run count rather than user
 * count, so a long-lived relay process needs a sweep. Called on admit (once per
 * run, not per call), which is cheap and keeps the map proportional to runs
 * currently in flight.
 */
function pruneExpired(now: number): void {
  for (const [key, expiresAt] of admitted) {
    if (now >= expiresAt) admitted.delete(key);
  }
}

/**
 * Whether `runId` is an admitted run of `userId` still within its hard window.
 *
 * @param userId - The authenticated user.
 * @param runId - Run id from the X-Dassi-Run-Id header.
 * @param now - Injectable clock for tests.
 * @returns True when the run is admitted and unexpired.
 */
export function isRunAdmitted(userId: string, runId: string, now: number = Date.now()): boolean {
  const expiresAt = admitted.get(admissionKey(userId, runId));
  return expiresAt !== undefined && now < expiresAt;
}

/**
 * Admit `runId` for `userId`, opening a fresh hard window.
 *
 * @param userId - The authenticated user.
 * @param runId - Run id from the X-Dassi-Run-Id header.
 * @param now - Injectable clock for tests.
 */
export function admitRun(userId: string, runId: string, now: number = Date.now()): void {
  pruneExpired(now);
  admitted.set(admissionKey(userId, runId), now + ADMISSION_TTL_MS);
}

/** Test-only: clear all admissions. */
export function __resetAdmissionsForTests(): void {
  admitted.clear();
}

/** Test-only: number of tracked admissions (asserts the sweep bounds the map). */
export function admissionCountForTests(): number {
  return admitted.size;
}
