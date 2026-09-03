-- Relay LLM Database Schema
-- Run against your Postgres instance

-- Usage log table (append-only)
CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for per-user queries and time-range analytics
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);

-- Model pricing table (configurable without redeploy)
CREATE TABLE IF NOT EXISTS model_pricing (
  model TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  input_price_per_million NUMERIC(10, 4) NOT NULL,
  output_price_per_million NUMERIC(10, 4) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Legacy: user_billing columns (only needed when running against an existing database)
-- These ALTER statements require the user_billing table to already exist.
-- Skip when running Relay with its own standalone database.
-- ALTER TABLE user_billing ADD COLUMN IF NOT EXISTS spend NUMERIC(10, 4) DEFAULT 0;
-- ALTER TABLE user_billing ADD COLUMN IF NOT EXISTS max_budget NUMERIC(10, 4) DEFAULT 5;
-- ALTER TABLE user_billing ADD COLUMN IF NOT EXISTS budget_reset_at TIMESTAMPTZ;
-- ALTER TABLE user_billing ADD COLUMN IF NOT EXISTS rpm_limit INTEGER DEFAULT 10;

-- Seed model pricing
INSERT INTO model_pricing (model, provider, input_price_per_million, output_price_per_million) VALUES
  ('gpt-5.4', 'openai', 2.50, 15.00),
  ('gpt-4.1', 'openai', 2.00, 8.00),
  ('gpt-4o', 'openai', 2.50, 10.00),
  ('o4-mini', 'openai', 1.10, 4.40),
  ('claude-opus-4-6', 'anthropic', 5.00, 25.00),
  ('claude-sonnet-4-5', 'anthropic', 3.00, 15.00),
  ('claude-haiku-4-5', 'anthropic', 1.00, 5.00),
  ('gemini-3.5-flash', 'google', 1.50, 9.00),
  ('gemini-3.1-pro-preview', 'google', 2.00, 12.00),
  ('gemini-3-flash-preview', 'google', 0.50, 3.00),
  ('gemini-2.5-pro-preview', 'google', 1.25, 10.00),
  ('gemini-2.0-flash', 'google', 0.10, 0.40),
  ('deepseek-v3.2', 'deepseek', 0.28, 0.42)
ON CONFLICT (model) DO UPDATE SET
  input_price_per_million = EXCLUDED.input_price_per_million,
  output_price_per_million = EXCLUDED.output_price_per_million,
  updated_at = NOW();

-- User budgets for managed users (set via Admin API)
-- spend is NUMERIC(12,6): the ledger quantum MUST be finer than a single request's
-- cost. At 4 decimal places, any charge below $0.0001 (routine for cached reads on
-- budget models) rounds to zero and spend never advances, so the fail-close budget
-- gate never trips. 6 dp matches the micro-USD granularity relay bills in.
CREATE TABLE IF NOT EXISTS user_budgets (
  user_id TEXT PRIMARY KEY,
  budget NUMERIC(10,4) DEFAULT 0,
  spend NUMERIC(12,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Micro-USD spend precision (2026-08-25)
-- Widens spend so a request cheaper than $0.0001 still advances the ledger. Relay
-- computes cost in integer micro-USD and floors ONCE there (in the user's favor);
-- at 6 dp the SQL increment stores that value exactly, so user_budgets.spend and
-- SUM(usage_logs.cost_usd) reconcile per request instead of drifting.
-- Widening is backward compatible: existing values are preserved, readers parse
-- more decimals, and old relay builds writing 4-dp amounts keep working.
ALTER TABLE user_budgets ALTER COLUMN spend TYPE NUMERIC(12,6);

-- Harden the billing ledger against PostgREST exposure (2026-08-27)
-- On the shared Supabase deployment, PostgREST exposes the `public` schema. Today
-- anon/authenticated cannot reach these tables (no USAGE granted on schema public,
-- verified: GET returns 403), but user_budgets still carries over-broad table grants
-- (INSERT/UPDATE/DELETE to `authenticated`) with NO RLS backstop. A single future
-- `GRANT USAGE ON SCHEMA public TO authenticated` — a common Supabase default — would
-- then let any signed-in user rewrite their own budget/spend.
--
-- Enabling RLS with no permissive policy is safe here: relay connects as the table
-- owner `postgres` (BYPASSRLS) and the dassi edge functions use `service_role`
-- (BYPASSRLS); only anon/authenticated are affected, which is the intent. The REVOKEs
-- are guarded so this block is a no-op on a standalone relay Postgres that has no
-- Supabase roles.
ALTER TABLE user_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs   ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON user_budgets FROM authenticated;
    REVOKE ALL ON usage_logs   FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON user_budgets FROM anon;
    REVOKE ALL ON usage_logs   FROM anon;
  END IF;
END $$;

-- Cache token tracking (2026-03-30)
-- cached_input_tokens: tokens served from provider cache (billed at reduced rate)
-- cache_creation_tokens: tokens written to cache (Anthropic: billed at 1.25x)
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0;

-- Per-request billing idempotency (2026-09-02)
-- usage_logs.request_id is the idempotency key: recordUsage() runs the INSERT
-- (`ON CONFLICT (request_id) DO NOTHING RETURNING id`) and the spend UPDATE in ONE
-- statement, with the UPDATE gated on the INSERT — so a retried write after a lost
-- ack conflicts, charges nothing, and cannot half-apply. Verified on prod before
-- adding: 416,842 rows, 0 NULL and 0 duplicate request_ids.
--
-- RUNBOOK — order matters, and merging to main IS a prod deploy (deploy.yml):
--   1. Run BOTH statements below on prod BEFORE merging the code that uses them.
--      CONCURRENTLY cannot run inside a transaction block — run it standalone.
--   2. Verify the index is VALID. A cancelled/failed CONCURRENTLY build leaves an
--      INVALID index; `IF NOT EXISTS` then silently skips, and Postgres refuses an
--      invalid index as an ON CONFLICT arbiter — every insert would error and,
--      since the charge is gated on the insert, NO request would be billed.
--        SELECT indisvalid FROM pg_index WHERE indexrelid = 'usage_logs_request_id_key'::regclass;
--      If false: DROP INDEX usage_logs_request_id_key; and re-run step 1.
--      A build can also fail because the OLD writer (still running during the
--      build) inserted a duplicate request_id after a lost ack — the very bug this
--      index closes. Then: SELECT request_id FROM usage_logs GROUP BY 1 HAVING count(*) > 1;
--      delete the later row of each pair, reconcile spend, and re-run step 1.
--   3. SET NOT NULL takes ACCESS EXCLUSIVE and scans the table; behind a long
--      analytics query it would queue every relay INSERT behind it (which then fail
--      open = served free). Bound the wait: SET lock_timeout = '2s'; and retry.
-- Applied to the production Supabase on 2026-09-03 (index VALID, 430,395 rows).
ALTER TABLE usage_logs ALTER COLUMN request_id SET NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS usage_logs_request_id_key ON usage_logs(request_id);
