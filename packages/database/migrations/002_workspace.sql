ALTER TABLE app.groups ADD COLUMN deleted_at timestamptz, ADD COLUMN policy jsonb NOT NULL DEFAULT '{"windowSeconds":3600,"maxActionsHour":60,"maxConcurrency":2}', ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app.groups DROP CONSTRAINT groups_tenant_id_name_key;
CREATE UNIQUE INDEX group_active_name ON app.groups(tenant_id,name) WHERE deleted_at IS NULL;
CREATE TABLE app.group_policy_versions (
 tenant_id uuid NOT NULL, group_id uuid NOT NULL, version integer NOT NULL, policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,group_id,version), FOREIGN KEY(tenant_id,group_id) REFERENCES app.groups(tenant_id,id)
);
INSERT INTO app.group_policy_versions(tenant_id,group_id,version,policy) SELECT tenant_id,id,version,policy FROM app.groups;
ALTER TABLE app.site_profiles ADD COLUMN navigation_origins jsonb NOT NULL DEFAULT '[]', ADD COLUMN deleted_at timestamptz, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE app.proxies (
 tenant_id uuid NOT NULL, id uuid NOT NULL, group_id uuid NOT NULL, scheme text NOT NULL CHECK(scheme IN ('http','https','socks5')), host text NOT NULL, port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
 auth_envelope jsonb, auth_lookup text NOT NULL, max_accounts integer NOT NULL CHECK(max_accounts BETWEEN 1 AND 500), enabled boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'UNKNOWN' CHECK(state IN ('UNKNOWN','HEALTHY','UNAVAILABLE')), observed_egress_ip text, latency_ms integer, checked_at timestamptz, error_code text,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,group_id,id), FOREIGN KEY(tenant_id,group_id) REFERENCES app.groups(tenant_id,id)
);
CREATE UNIQUE INDEX proxy_unique_endpoint ON app.proxies(tenant_id,scheme,host,port,auth_lookup) WHERE deleted_at IS NULL;
ALTER TABLE app.accounts ADD COLUMN credential_envelope jsonb, ADD COLUMN login_lookup text, ADD COLUMN has_login boolean NOT NULL DEFAULT false, ADD COLUMN has_password boolean NOT NULL DEFAULT false,
 ADD COLUMN proxy_id uuid, ADD COLUMN account_state text NOT NULL DEFAULT 'UNKNOWN' CHECK(account_state IN ('UNKNOWN','ACTIVE','BLOCKED','BANNED','MAINTENANCE','LOGIN_ERROR')),
 ADD COLUMN runtime_state text NOT NULL DEFAULT 'DORMANT' CHECK(runtime_state IN ('DORMANT','LIVE','AUTOMATING','CHECKING','STOPPING','ERROR')),
 ADD COLUMN notes text NOT NULL DEFAULT '', ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN deleted_at timestamptz,
 ADD FOREIGN KEY(tenant_id,group_id,proxy_id) REFERENCES app.proxies(tenant_id,group_id,id);
CREATE UNIQUE INDEX account_unique_login ON app.accounts(tenant_id,site_id,login_lookup) WHERE login_lookup IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX account_proxy_filter ON app.accounts(tenant_id,proxy_id) WHERE deleted_at IS NULL;
CREATE TABLE app.workspace_imports (
 tenant_id uuid NOT NULL, id uuid NOT NULL, group_id uuid NOT NULL, site_id uuid, entity text NOT NULL CHECK(entity IN ('accounts','proxies')),
 hash text NOT NULL, state text NOT NULL DEFAULT 'PREVIEW' CHECK(state IN ('PREVIEW','COMMITTED')), encrypted_rows jsonb,
 preview jsonb NOT NULL, group_version integer NOT NULL, site_version integer, expires_at timestamptz NOT NULL,
 committed_ids jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,group_id) REFERENCES app.groups(tenant_id,id), FOREIGN KEY(tenant_id,site_id) REFERENCES app.site_profiles(tenant_id,id)
);
DO $policies$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['group_policy_versions','proxies','workspace_imports'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',tbl);
 END LOOP;
END $policies$;
GRANT SELECT,INSERT ON app.group_policy_versions TO msm_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.proxies,app.workspace_imports TO msm_app;
