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
  request_id TEXT,
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
CREATE TABLE IF NOT EXISTS user_budgets (
  user_id TEXT PRIMARY KEY,
  budget NUMERIC(10,4) DEFAULT 0,
  spend NUMERIC(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cache token tracking (2026-03-30)
-- cached_input_tokens: tokens served from provider cache (billed at reduced rate)
-- cache_creation_tokens: tokens written to cache (Anthropic: billed at 1.25x)
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
