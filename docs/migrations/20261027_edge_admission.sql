-- Apply once to the billing database before enabling the edge Worker.
-- Private schema: no PostgREST/client access, no public function execution.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE SCHEMA IF NOT EXISTS relay_internal;
REVOKE ALL ON SCHEMA relay_internal FROM PUBLIC;
CREATE TABLE IF NOT EXISTS relay_internal.run_admissions (
  user_id text NOT NULL,
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  billing_account_id text NOT NULL REFERENCES public.user_budgets(user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  overrun_usd numeric,
  PRIMARY KEY(user_id, run_id)
);
CREATE INDEX IF NOT EXISTS edge_admissions_payer ON relay_internal.run_admissions(billing_account_id);
CREATE TABLE IF NOT EXISTS relay_internal.requests (
  request_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google','deepseek')),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','complete','interrupted','unavailable','failed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS edge_requests_unsettled ON relay_internal.requests(started_at) WHERE settled_at IS NULL;
REVOKE ALL ON ALL TABLES IN SCHEMA relay_internal FROM PUBLIC;

-- Taking the budget row lock serializes admission with admin changes and usage charges.
CREATE OR REPLACE FUNCTION relay_internal.authorize(
  actor text, run text, provider_name text, request uuid,
  ttl_ms integer, max_runs integer, free_ceiling numeric, trial_overrun numeric
) RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, public, relay_internal AS $$
DECLARE
  payer text;
  b public.user_budgets%ROWTYPE;
  a relay_internal.run_admissions%ROWTYPE;
BEGIN
  IF provider_name NOT IN ('google','deepseek') OR ttl_ms <= 0 OR max_runs <= 0
     OR trial_overrun < 0 OR (run IS NOT NULL AND length(run) NOT BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'Invalid admission parameters';
  END IF;
  IF provider_name = 'deepseek' AND public.has_paid_subscription(actor::uuid) IS NOT TRUE THEN
    RETURN 'paid_required';
  END IF;
  payer := public.billing_account_id(actor::uuid)::text;
  SELECT * INTO b FROM public.user_budgets WHERE user_id = payer FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing_budget'; END IF;
  IF b.spend IS NULL OR b.budget IS NULL OR b.plan_base IS NULL THEN
    RAISE EXCEPTION 'Incomplete budget record';
  END IF;
  DELETE FROM relay_internal.run_admissions WHERE user_id = actor
    AND (expires_at <= clock_timestamp() OR billing_account_id <> payer);
  SELECT * INTO a FROM relay_internal.run_admissions WHERE user_id = actor AND run_id = run;
  IF FOUND THEN
    UPDATE relay_internal.run_admissions SET expires_at = clock_timestamp() + ttl_ms * interval '1 millisecond'
      WHERE user_id = actor AND run_id = run;
    IF a.overrun_usd IS NULL THEN
      INSERT INTO relay_internal.requests(request_id,user_id,provider) VALUES(request,actor,provider_name);
      RETURN 'allowed';
    END IF;
  END IF;
  IF b.spend >= b.budget + COALESCE(a.overrun_usd, 0) THEN RETURN 'budget_exceeded'; END IF;
  IF public.workspace_member_blocked(actor::uuid) THEN RETURN 'member_limit'; END IF;
  IF run IS NOT NULL AND a.run_id IS NULL AND
    (SELECT count(*) FROM relay_internal.run_admissions WHERE user_id = actor) < max_runs THEN
    INSERT INTO relay_internal.run_admissions(user_id,run_id,billing_account_id,expires_at,overrun_usd)
      VALUES(actor,run,payer,clock_timestamp() + ttl_ms * interval '1 millisecond',
        CASE WHEN b.plan_base > free_ceiling THEN NULL ELSE trial_overrun END);
  END IF;
  INSERT INTO relay_internal.requests(request_id,user_id,provider) VALUES(request,actor,provider_name);
  RETURN 'allowed';
END $$;

CREATE OR REPLACE FUNCTION relay_internal.run_lifecycle(actor text, run text, action text, ttl_ms integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, public, relay_internal AS $$
DECLARE payer text; affected integer;
BEGIN
  IF action NOT IN ('end','keepalive') OR ttl_ms <= 0 THEN RAISE EXCEPTION 'Invalid lifecycle action'; END IF;
  payer := public.billing_account_id(actor::uuid)::text;
  PERFORM 1 FROM public.user_budgets WHERE user_id = payer FOR UPDATE;
  IF action = 'end' THEN
    DELETE FROM relay_internal.run_admissions WHERE user_id = actor AND run_id = run;
    RETURN true;
  END IF;
  UPDATE relay_internal.run_admissions SET expires_at = clock_timestamp() + ttl_ms * interval '1 millisecond'
    WHERE user_id = actor AND run_id = run AND billing_account_id = payer AND expires_at > clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END $$;

CREATE OR REPLACE FUNCTION relay_internal.revoke_budget_admissions()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, relay_internal AS $$
BEGIN
  -- Top-ups increase the ceiling and must preserve current runs. Sets/resets and
  -- reductions invalidate the grace on the next request, including workspace members.
  IF TG_ARGV[0] = 'plan' OR NEW.budget <= OLD.budget THEN
    DELETE FROM relay_internal.run_admissions WHERE billing_account_id = OLD.user_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS relay_revoke_admissions ON public.user_budgets;
DROP TRIGGER IF EXISTS relay_revoke_plan_admissions ON public.user_budgets;
CREATE TRIGGER relay_revoke_admissions AFTER UPDATE OF budget ON public.user_budgets
  FOR EACH ROW EXECUTE FUNCTION relay_internal.revoke_budget_admissions();
-- Absolute admin writes always set plan_base, even if its value is unchanged.
-- Purchases only update budget, so a top-up does not revoke an active run.
CREATE TRIGGER relay_revoke_plan_admissions AFTER UPDATE OF plan_base ON public.user_budgets
  FOR EACH ROW EXECUTE FUNCTION relay_internal.revoke_budget_admissions('plan');
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA relay_internal FROM PUBLIC;
COMMIT;
