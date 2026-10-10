-- CloudForge FinOps schema. Apply as owner; the app connects as cloudforge_app (no BYPASSRLS).
CREATE TABLE IF NOT EXISTS organizations (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (
  org_id text REFERENCES organizations(id), user_id text REFERENCES users(id),
  roles text[] NOT NULL DEFAULT '{}', PRIMARY KEY (org_id, user_id));
CREATE TABLE IF NOT EXISTS cloud_accounts (
  org_id text NOT NULL REFERENCES organizations(id), id text NOT NULL, provider text NOT NULL,
  credential_ref text, PRIMARY KEY (org_id, id));
CREATE TABLE IF NOT EXISTS cost_imports (
  org_id text NOT NULL REFERENCES organizations(id), id text NOT NULL, source_name text NOT NULL,
  rejected jsonb NOT NULL DEFAULT '[]', duplicates jsonb NOT NULL DEFAULT '[]',
  base_currency text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, id));
CREATE TABLE IF NOT EXISTS cost_records (
  org_id text NOT NULL, import_id text NOT NULL, record_id text NOT NULL, usage_date date NOT NULL,
  account_id text NOT NULL, project text, service text NOT NULL, region text, environment text, resource_id text,
  cost numeric(18,4) NOT NULL, currency text NOT NULL, cost_base numeric(18,4) NOT NULL,
  untagged boolean NOT NULL, tags jsonb NOT NULL DEFAULT '{}', source_line int NOT NULL,
  PRIMARY KEY (org_id, record_id),                       -- re-importing the same row is a no-op
  FOREIGN KEY (org_id, import_id) REFERENCES cost_imports(org_id, id));
CREATE INDEX IF NOT EXISTS cost_records_date ON cost_records (org_id, usage_date);
CREATE TABLE IF NOT EXISTS budgets (
  org_id text NOT NULL, id text NOT NULL, name text NOT NULL, month text NOT NULL, amount numeric(18,2) NOT NULL,
  PRIMARY KEY (org_id, id));
-- Engine documents: workflow versions, executions, approvals, effects (idempotency ledger), audit entries.
CREATE TABLE IF NOT EXISTS engine_documents (
  seq bigserial, org_id text NOT NULL, kind text NOT NULL, id text NOT NULL, doc jsonb NOT NULL,
  PRIMARY KEY (org_id, kind, id));
CREATE INDEX IF NOT EXISTS engine_documents_seq ON engine_documents (org_id, kind, seq);
-- Audit entries are append-only.
CREATE OR REPLACE FUNCTION forbid_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.kind = 'audit' THEN RAISE EXCEPTION 'audit entries are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS engine_documents_audit_guard ON engine_documents;
CREATE TRIGGER engine_documents_audit_guard BEFORE UPDATE OR DELETE ON engine_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudforge_app') THEN
    CREATE ROLE cloudforge_app LOGIN PASSWORD 'cloudforge_app' NOSUPERUSER NOBYPASSRLS; END IF; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cloudforge_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO cloudforge_app;

-- Row-level security: a session sees only the org set in app.org_id.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['cloud_accounts','cost_imports','cost_records','budgets','engine_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = current_setting(''app.org_id'', true)) WITH CHECK (org_id = current_setting(''app.org_id'', true))', t);
  END LOOP; END $$;
