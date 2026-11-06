CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

CREATE TABLE app.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.device_pairings (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  certificate_fingerprint text NOT NULL,
  paired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, certificate_fingerprint)
);
CREATE TABLE app.groups (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TABLE app.site_profiles (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  start_url text NOT NULL CHECK (start_url ~ '^https?://'),
  capability_mode text NOT NULL DEFAULT 'generic' CHECK (capability_mode IN ('generic', 'recipe', 'integration')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE app.accounts (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  group_id uuid NOT NULL,
  site_id uuid NOT NULL,
  alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES app.groups(tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES app.site_profiles(tenant_id, id)
);
CREATE TABLE app.secrets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  group_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('credential', 'session', 'proxy')),
  encrypted_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES app.groups(tenant_id, id)
);
CREATE TABLE app.vault_verifiers (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id),
  encrypted_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.audit_log (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  actor_id uuid NOT NULL,
  verb text NOT NULL,
  target_id uuid,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE app.outbox_events (
  tenant_id uuid NOT NULL REFERENCES app.tenants(id),
  id uuid NOT NULL,
  topic text NOT NULL,
  entity_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX pending_outbox ON app.outbox_events(created_at, id) WHERE published_at IS NULL;
CREATE INDEX account_group_filter ON app.accounts(tenant_id, group_id, id);

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $policies$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['device_pairings','groups','site_profiles','accounts','secrets','vault_verifiers','audit_log','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', tbl);
  END LOOP;
END $policies$;

GRANT USAGE ON SCHEMA app TO msm_app;
GRANT SELECT ON app.tenants TO msm_app;
GRANT SELECT, INSERT ON app.device_pairings TO msm_app;
GRANT SELECT, INSERT ON app.vault_verifiers TO msm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.groups, app.site_profiles, app.accounts, app.secrets TO msm_app;
GRANT SELECT, INSERT ON app.audit_log, app.outbox_events TO msm_app;
