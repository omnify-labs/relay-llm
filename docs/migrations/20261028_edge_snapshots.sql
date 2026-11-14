-- Add after 20261027_edge_admission.sql. No customer billing rows are rewritten.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE TABLE IF NOT EXISTS relay_internal.budget_versions (
  account_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1
);
REVOKE ALL ON relay_internal.budget_versions FROM PUBLIC;

CREATE OR REPLACE FUNCTION relay_internal.revoke_budget_admissions()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, relay_internal AS $$
BEGIN
  IF TG_ARGV[0] = 'plan' OR NEW.budget <= OLD.budget THEN
    DELETE FROM relay_internal.run_admissions WHERE billing_account_id = OLD.user_id;
    INSERT INTO relay_internal.budget_versions(account_id) VALUES (OLD.user_id)
      ON CONFLICT (account_id) DO UPDATE SET revision = budget_versions.revision + 1;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION relay_internal.deleted_budget_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, relay_internal AS $$
BEGIN
  INSERT INTO relay_internal.budget_versions(account_id) VALUES (OLD.user_id)
    ON CONFLICT (account_id) DO UPDATE SET revision = budget_versions.revision + 1;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS relay_deleted_budget_version ON public.user_budgets;
CREATE TRIGGER relay_deleted_budget_version AFTER DELETE ON public.user_budgets
  FOR EACH ROW EXECUTE FUNCTION relay_internal.deleted_budget_version();
REVOKE ALL ON FUNCTION relay_internal.deleted_budget_version() FROM PUBLIC;
COMMIT;
