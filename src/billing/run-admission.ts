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
 * Most runs one user may hold admitted at once.
 *
 * Reason: `runId` is client-controlled, so without a cap any authenticated user who
 * is under budget could flood distinct ids and pin an unbounded, attacker-controlled
 * number of entries for a full TTL each. The cap bounds memory to (users x this) and
 * doubles as the anti-abuse ceiling: worst-case overage is this many concurrent runs'
 * spend. Comfortably above real usage — a user's concurrent runs are their open tab
 * groups plus any schedule that fires in the same window.
 */
export const MAX_ADMITTED_RUNS_PER_USER = 8;

/**
 * One admitted run: its hard time backstop and its remaining spend headroom.
 *
 * `remainingMicroUsd` is the run's budget-aware bound — the (budget − spend) headroom
 * in integer micro-USD captured at admission, decremented by each of the run's charges
 * (see {@link chargeRun}). When it reaches ≤ 0 the run is dropped, so its next call is
 * re-gated. This bounds a run's overage to its admission headroom plus the one in-flight
 * request that crosses it — NOT the whole `expiresAt` window, which the time-only design
 * left unmetered (a run could burn arbitrarily much for the full TTL).
 */
interface AdmissionEntry {
  expiresAt: number;
  remainingMicroUsd: number;
}

/**
 * Admitted runs: user -> (run -> entry).
 *
 * Reason: nested per user, not a flat user+run key, so the cap check and the expiry
 * sweep touch only one user's runs (at most MAX_ADMITTED_RUNS_PER_USER) instead of
 * scanning every admission in the process. A flat map made each admit an O(n) full
 * scan that pruned nothing during a burst — O(n^2) across a flood.
 *
 * Keyed per RUN, not one entry per user: Dassi serializes runs per tab group
 * (`navigator.locks` on `dassi-group-<id>`), not per user, so one user can have
 * concurrent runs — e.g. a schedule firing on one group while they work manually in
 * another. A single per-user entry would let the newer run evict the older one, whose
 * next call would then be re-budget-checked and 402'd mid-task.
 */
const admitted = new Map<string, Map<string, AdmissionEntry>>();

/**
 * Drop this user's closed windows, and the user entry itself once empty.
 *
 * @param userId - The authenticated user.
 * @param runs - That user's run -> entry map.
 * @param now - Current time in ms.
 */
function pruneUser(userId: string, runs: Map<string, AdmissionEntry>, now: number): void {
  for (const [runId, entry] of runs) {
    if (now >= entry.expiresAt) runs.delete(runId);
  }
  if (runs.size === 0) admitted.delete(userId);
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
  const runs = admitted.get(userId);
  if (!runs) return false;
  const entry = runs.get(runId);
  if (entry === undefined) return false;
  if (now >= entry.expiresAt) {
    // Reason: prune on the read path too. pruneUser only runs on that user's next
    // admitRun, so a user admitted once who then goes idle would otherwise keep their
    // bucket and its expired entries until process exit. The per-user cap bounds
    // entries within a bucket, not the number of buckets.
    runs.delete(runId);
    if (runs.size === 0) admitted.delete(userId);
    return false;
  }
  return true;
}

/**
 * Drop every admission for a user, effective immediately.
 *
 * Reason: an admitted run skips the budget check for the rest of its window, so an
 * admin zeroing a budget to halt runaway spend would otherwise be silently defeated
 * for up to the full TTL. Call this right after any admin write that revokes or
 * reduces a budget, so the user's next call is re-gated against the new value.
 *
 * @param userId - The user whose admissions to drop.
 */
export function revokeUser(userId: string): void {
  admitted.delete(userId);
}

/**
 * Admit `runId` for `userId`, opening a fresh window bounded by both a hard time
 * backstop and the run's spend headroom.
 *
 * Silently does not admit when the user is already at
 * {@link MAX_ADMITTED_RUNS_PER_USER}. That is safe by construction: an unadmitted run
 * simply keeps today's per-call budget gating.
 *
 * @param userId - The authenticated user.
 * @param runId - Run id from the X-Dassi-Run-Id header.
 * @param headroomMicroUsd - The (budget − spend) headroom in integer micro-USD at
 *   admission. The run may overspend by at most this (plus the one request that crosses
 *   it) before {@link chargeRun} drops it. Clamped at ≥ 0.
 * @param now - Injectable clock for tests.
 */
export function admitRun(
  userId: string,
  runId: string,
  headroomMicroUsd: number,
  now: number = Date.now(),
): void {
  let runs = admitted.get(userId);
  if (!runs) {
    runs = new Map();
    admitted.set(userId, runs);
  }
  pruneUser(userId, runs, now);
  // Reason: refreshing a run we already track must not be capped out — only genuinely
  // new runs beyond the cap are refused.
  if (runs.size >= MAX_ADMITTED_RUNS_PER_USER && !runs.has(runId)) return;
  runs.set(runId, {
    expiresAt: now + ADMISSION_TTL_MS,
    remainingMicroUsd: Math.max(0, headroomMicroUsd),
  });
  // Reason: not redundant with the set above. pruneUser deletes the bucket from
  // `admitted` whenever it empties — which is exactly a new user's first call (the
  // bucket starts empty) and any call after all prior runs expired. Mutating `runs` in
  // place is then not enough because `admitted` no longer references it; this re-inserts
  // the bucket.
  admitted.set(userId, runs);
}

/**
 * Debit a completed request's cost from its run's remaining headroom, dropping the run
 * once the headroom is spent so its next call is re-gated against live budget.
 *
 * Idempotent-safe against a missing run: a charge for a run that was never admitted (no
 * runId header) or already dropped/expired is a no-op. Called from the usage-logging
 * path BEFORE the ledger writes, and unconditionally — the request was served, so the
 * in-memory bound shrinks even if `incrementUserSpend` later fails.
 *
 * @param userId - The authenticated user.
 * @param runId - Run id from the X-Dassi-Run-Id header.
 * @param costMicroUsd - The request's cost in integer micro-USD (same value written to
 *   the ledger).
 * @param now - Injectable clock for tests.
 */
export function chargeRun(
  userId: string,
  runId: string,
  costMicroUsd: number,
  now: number = Date.now(),
): void {
  const runs = admitted.get(userId);
  if (!runs) return;
  const entry = runs.get(runId);
  if (entry === undefined) return;
  // Reason: an expired run is not admitted; drop it rather than debiting a dead window.
  if (now >= entry.expiresAt) {
    runs.delete(runId);
    if (runs.size === 0) admitted.delete(userId);
    return;
  }
  entry.remainingMicroUsd -= costMicroUsd;
  // Reason: headroom spent — drop the admission so the run's next call re-reads budget
  // and 402s if the user is now over. This is the budget-aware bound that replaces the
  // time-only window: overage per run is capped at its admission headroom plus the
  // single request that crossed it.
  if (entry.remainingMicroUsd <= 0) {
    runs.delete(runId);
    if (runs.size === 0) admitted.delete(userId);
  }
}

/**
 * Sweep every user's expired admissions (and empty buckets).
 *
 * Reason: the read/admit paths only prune a user when that user makes another call, so
 * a user admitted once who never returns keeps their bucket for the process lifetime.
 * On a long-lived instance the bucket count grows with every distinct user ever
 * admitted; a periodic call to this reclaims them. Wired to a timer in `index.ts`.
 *
 * @param now - Injectable clock for tests.
 */
export function pruneAllUsers(now: number = Date.now()): void {
  for (const [userId, runs] of admitted) pruneUser(userId, runs, now);
}

/** Test-only: clear all admissions. */
export function __resetAdmissionsForTests(): void {
  admitted.clear();
}

/**
 * Test-only: total tracked admissions (asserts the sweep and cap bound the map).
 *
 * @returns Total number of run-level entries currently tracked across all users.
 */
export function admissionCountForTests(): number {
  let total = 0;
  for (const runs of admitted.values()) total += runs.size;
  return total;
}

/**
 * Test-only: a run's remaining headroom in µ$, or undefined if not admitted.
 *
 * Exposes the budget-aware bound so tests can assert the exact headroom captured at
 * admission (the µ$ conversion in budget.ts) and the negative-headroom clamp — neither
 * is observable through isRunAdmitted, which reads only expiresAt.
 *
 * @param userId - The authenticated user.
 * @param runId - Run id.
 * @returns remainingMicroUsd, or undefined when the run is not tracked.
 */
export function runHeadroomForTests(userId: string, runId: string): number | undefined {
  return admitted.get(userId)?.get(runId)?.remainingMicroUsd;
}
