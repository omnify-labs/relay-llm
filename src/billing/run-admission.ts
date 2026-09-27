/**
 * Run-scoped budget admission.
 *
 * Tracks admitted agent runs so `budgetMiddleware` can gate budget once at a run's first
 * call and then allow every subsequent call of that SAME run — so a multi-step task is
 * never cut off mid-run when spend crosses budget. The gate lands at a task boundary: the
 * NEXT run's first call is refused, not a call inside the current run.
 *
 * A run stays admitted until it ends. Two reclamation paths:
 *   - Primary: an explicit end signal (`endRun`) the extension sends when the agent run
 *     completes — the admission is dropped at once so the next run is gated immediately.
 *   - Backstop: a sliding IDLE window (ADMISSION_TTL_MS). Each admitted call refreshes it,
 *     and so does the extension's keepalive (`touchRun`) while a run is blocked on a
 *     human, so a run stays admitted as long as it is alive, however long or costly; the
 *     window only lapses after the run goes quiet (e.g. a browser crash that never sent
 *     the end signal). It is NOT a hard cap from admission — an active run is never cut
 *     off by it.
 *
 * TTL invariant: ADMISSION_TTL_MS must exceed the longest SILENT pause a live run can
 * have — one where neither a relay call nor a keepalive arrives. Human waits are covered
 * by the keepalive; the remaining silent pause is a single tool call (the extension's
 * proxy-tool / REPL budget is 5 min) plus one streamed reply. The 30-min default gives
 * ~6x margin. Never set it near 5 min in production: that re-gates runs mid-task.
 *
 * State is in-memory; a relay restart clears it (an in-flight run is then re-gated on its
 * next call, which is safe — under budget it re-admits, over budget it stops).
 */

/** Idle-window backstop in ms (default 30 min), refreshed on each admitted call. */
const DEFAULT_ADMISSION_TTL_MS = 1_800_000;
const parsedTtl = parseInt(process.env.RUN_ADMISSION_TTL_MS || '', 10);
// Reason: a malformed env value must not silently disable admission. NaN would make every
// `now < expiresAt` false, so no run would stay admitted and every call would fall back to
// per-call gating — reintroducing the mid-task 402 this module exists to prevent, silently.
const ADMISSION_TTL_MS =
  Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_ADMISSION_TTL_MS;

/**
 * Most runs one user may hold admitted at once.
 *
 * Reason: `runId` is client-controlled, so without a cap any authenticated user under
 * budget could flood distinct ids and pin an unbounded, attacker-controlled number of
 * entries. The cap bounds memory to (users × this). Comfortably above real usage — a
 * user's concurrent runs are their open tab groups plus any schedule firing in the window.
 */
export const MAX_ADMITTED_RUNS_PER_USER = 8;

/**
 * Admitted runs: user -> (run -> idle-window expiry in ms).
 *
 * Reason: nested per user, not a flat user+run key, so the cap check and the expiry sweep
 * touch only one user's runs (at most MAX_ADMITTED_RUNS_PER_USER) instead of scanning
 * every admission in the process. A flat map made each admit an O(n) full scan that pruned
 * nothing during a burst — O(n^2) across a flood.
 *
 * Keyed per RUN, not one entry per user: Dassi serializes runs per tab group
 * (`navigator.locks` on `dassi-group-<id>`), not per user, so one user can have concurrent
 * runs — e.g. a schedule firing on one group while they work manually in another. A single
 * per-user entry would let the newer run evict the older one, whose next call would then be
 * re-budget-checked and 402'd mid-task.
 */
const admitted = new Map<string, Map<string, number>>();

/**
 * Drop this user's idled-out runs, and the user entry itself once empty.
 *
 * @param userId - The authenticated user.
 * @param runs - That user's run -> expiry map.
 * @param now - Current time in ms.
 */
function pruneUser(userId: string, runs: Map<string, number>, now: number): void {
  for (const [runId, expiresAt] of runs) {
    if (now >= expiresAt) runs.delete(runId);
  }
  if (runs.size === 0) admitted.delete(userId);
}

/**
 * Whether `runId` is an admitted run of `userId` — and, on a hit, refresh its idle window.
 *
 * The refresh is what makes the window sliding rather than hard-from-admission: each call
 * of an active run pushes its expiry out, so a long or costly run is never cut off while
 * it keeps working. The window only lapses once the run stops calling (see the module doc).
 *
 * @param userId - The authenticated user.
 * @param runId - Run id from the X-Dassi-Run-Id header.
 * @param now - Injectable clock for tests.
 * @returns True when the run is admitted (and its idle window was just refreshed).
 */
export function isRunAdmitted(userId: string, runId: string, now: number = Date.now()): boolean {
  const runs = admitted.get(userId);
  if (!runs) return false;
  const expiresAt = runs.get(runId);
  if (expiresAt === undefined) return false;
  if (now >= expiresAt) {
    // Reason: prune on the read path too. pruneUser only runs on that user's next admitRun,
    // so a user admitted once who then goes idle would otherwise keep their bucket and its
    // expired entries until process exit.
    runs.delete(runId);
    if (runs.size === 0) admitted.delete(userId);
    return false;
  }
  runs.set(runId, now + ADMISSION_TTL_MS); // slide the idle window on activity
  return true;
}

/**
 * Drop every admission for a user, effective immediately.
 *
 * Reason: an admitted run skips the budget check, so an admin zeroing a budget to halt
 * runaway spend would otherwise be silently defeated until the run ends or idles out. Call
 * this right after any admin write that revokes or reduces a budget, so the user's next
 * call is re-gated against the new value.
 *
 * @param userId - The user whose admissions to drop.
 */
export function revokeUser(userId: string): void {
  admitted.delete(userId);
}

/**
 * Refresh an admitted run's idle window WITHOUT admitting anything — the keepalive.
 *
 * The extension sends this from its approval heartbeat while a run is blocked on a
 * human (approval card, ask_user), which is the one pause the idle window cannot see
 * and which is unbounded by design. It only slides an existing, unexpired entry; an
 * unknown or lapsed run is left alone (returns false), so a keepalive can never bypass
 * the budget gate — only `budgetMiddleware` admits.
 *
 * @param userId - The authenticated user (from the keepalive request's JWT).
 * @param runId - The run to keep alive.
 * @param now - Injectable clock for tests.
 * @returns True if the run was admitted and its window was refreshed.
 */
export function touchRun(userId: string, runId: string, now: number = Date.now()): boolean {
  const runs = admitted.get(userId);
  if (!runs) return false;
  const expiresAt = runs.get(runId);
  if (expiresAt === undefined || now >= expiresAt) return false;
  runs.set(runId, now + ADMISSION_TTL_MS);
  return true;
}

/**
 * Drop a single run's admission — the explicit end signal.
 *
 * Called when the extension reports that an agent run has ended, so the next run is gated
 * immediately rather than after the idle window lapses. Scoped to `userId`, so a client can
 * only end its own runs. A no-op for an unknown user or run.
 *
 * @param userId - The authenticated user (from the run-end request's JWT).
 * @param runId - The run that ended.
 */
export function endRun(userId: string, runId: string): void {
  const runs = admitted.get(userId);
  if (!runs) return;
  runs.delete(runId);
  if (runs.size === 0) admitted.delete(userId);
}

/**
 * Admit `runId` for `userId`, opening (or refreshing) its idle window.
 *
 * Silently does not admit when the user is already at {@link MAX_ADMITTED_RUNS_PER_USER}.
 * That is safe by construction: an unadmitted run simply keeps today's per-call budget
 * gating.
 *
 * @param userId - The authenticated user.
 * @param runId - Run id from the X-Dassi-Run-Id header.
 * @param now - Injectable clock for tests.
 */
export function admitRun(userId: string, runId: string, now: number = Date.now()): void {
  let runs = admitted.get(userId);
  if (!runs) {
    runs = new Map();
    admitted.set(userId, runs);
  }
  pruneUser(userId, runs, now);
  // Reason: refreshing a run we already track must not be capped out — only genuinely new
  // runs beyond the cap are refused.
  if (runs.size >= MAX_ADMITTED_RUNS_PER_USER && !runs.has(runId)) return;
  runs.set(runId, now + ADMISSION_TTL_MS);
  // Reason: not redundant with the set above. pruneUser deletes the bucket from `admitted`
  // whenever it empties — a new user's first call, or any call after all prior runs idled
  // out. Mutating `runs` in place is then not enough because `admitted` no longer references
  // it; this re-inserts the bucket.
  admitted.set(userId, runs);
}

/**
 * Sweep every user's idled-out admissions (and empty buckets).
 *
 * Reason: the read/admit paths only prune a user when THAT user makes another call, so a
 * user admitted once who never returns keeps their bucket for the process lifetime. On a
 * long-lived instance the bucket count grows with every distinct user ever admitted; a
 * periodic sweep reclaims them. Wired to a timer in `index.ts`.
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
