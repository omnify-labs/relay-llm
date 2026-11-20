CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE redemption_batches (id uuid PRIMARY KEY, type text, tier text);
CREATE TABLE redemption_codes (
  id uuid PRIMARY KEY, batch_id uuid REFERENCES redemption_batches(id), user_id uuid,
  starts_at timestamptz, ends_at timestamptz, revoked_at timestamptz
);
CREATE TABLE subscriptions (
  user_id uuid, canceled_at timestamptz, status text, is_one_time boolean DEFAULT false,
  current_period_end timestamptz
);
CREATE TABLE test_seats (user_id uuid);
CREATE FUNCTION public.workspace_of(uuid) RETURNS TABLE (id uuid) LANGUAGE sql AS
  $$ SELECT user_id FROM test_seats WHERE user_id = $1 $$;
CREATE TABLE user_budgets (
  user_id text PRIMARY KEY, plan_base numeric NOT NULL DEFAULT 0,
  budget numeric NOT NULL DEFAULT 0, spend numeric NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE budget_increments (
  idempotency_key text PRIMARY KEY, user_id text NOT NULL, delta_cents integer NOT NULL,
  remaining_cents integer NOT NULL CHECK (remaining_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE budget_reset_receipts (
  user_id text, idempotency_key text, PRIMARY KEY (user_id, idempotency_key)
);
