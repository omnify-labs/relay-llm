-- Minimal billing fixture for isolated test databases only. Not a production migration.
CREATE TABLE test_accounts(id uuid PRIMARY KEY, paid boolean, payer text, blocked boolean);
CREATE FUNCTION public.has_paid_subscription(actor uuid) RETURNS boolean LANGUAGE sql AS $$SELECT paid FROM test_accounts WHERE id=actor$$;
CREATE FUNCTION public.billing_account_id(actor uuid) RETURNS text LANGUAGE sql AS $$SELECT payer FROM test_accounts WHERE id=actor$$;
CREATE FUNCTION public.billing_account_id(actor text) RETURNS text LANGUAGE sql AS $$SELECT payer FROM test_accounts WHERE id=actor::uuid$$;
CREATE FUNCTION public.workspace_of(actor uuid) RETURNS TABLE(monthly_cap_usd numeric,month_spend_usd numeric)
LANGUAGE sql AS $$SELECT CASE WHEN blocked THEN 0::numeric ELSE null::numeric END,0::numeric FROM test_accounts WHERE id=actor$$;
CREATE FUNCTION public.workspace_member_blocked(actor uuid) RETURNS boolean LANGUAGE sql AS $$SELECT blocked FROM test_accounts WHERE id=actor$$;
CREATE FUNCTION public.workspace_member_charge(actor text, amount numeric) RETURNS integer LANGUAGE sql AS $$SELECT 1$$;
CREATE TABLE user_budgets(user_id text PRIMARY KEY,budget numeric,spend numeric,plan_base numeric,updated_at timestamptz);
CREATE TABLE usage_logs(id bigserial PRIMARY KEY,user_id text,billing_account_id text,provider text,model text,
  input_tokens integer,output_tokens integer,total_tokens integer,cached_input_tokens integer,cache_creation_tokens integer,
  cost_usd numeric,request_id text UNIQUE,latency_ms integer,status_code integer);
