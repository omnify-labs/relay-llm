/**
 * Run-lifecycle routes the extension calls to keep Relay's admission state honest.
 * Mounted by index.ts under authMiddleware; kept here (not inline in index.ts, which
 * starts the server at import) so the REAL wiring is unit-testable.
 */
import { Hono, type Context } from 'hono';
import { endRun, touchRun } from './run-admission.js';

export const runRoutes = new Hono();

// The extension calls this when an agent run ends, so the run's admission is dropped
// at once and the user's NEXT run is gated. Scoped to the caller's own userId.
// Idempotent: ending an unknown/already-ended run still returns 200.
runRoutes.post('/v1/runs/:runId/end', (c: Context) => {
  const userId = c.get('userId') as string;
  endRun(userId, c.req.param('runId') as string);
  return c.json({ ended: true });
});

// Keepalive while a run is blocked on a human. Only refreshes an existing, unexpired
// admission — never admits — so it cannot bypass the budget gate. `alive:false` tells
// the client the run has lapsed (a later call will be re-gated).
runRoutes.post('/v1/runs/:runId/keepalive', (c: Context) => {
  const userId = c.get('userId') as string;
  const alive = touchRun(userId, c.req.param('runId') as string);
  return c.json({ alive });
});
