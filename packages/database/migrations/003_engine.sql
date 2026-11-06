CREATE TABLE app.recipes (
 tenant_id uuid NOT NULL REFERENCES app.tenants(id), id uuid NOT NULL, name text NOT NULL,
 version integer NOT NULL CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE app.recipe_versions (
 tenant_id uuid NOT NULL, recipe_id uuid NOT NULL, version integer NOT NULL,
 steps jsonb NOT NULL, adapters jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,recipe_id,version), FOREIGN KEY(tenant_id,recipe_id) REFERENCES app.recipes(tenant_id,id)
);
CREATE TABLE app.execution_plans (
 tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL, recipe_id uuid NOT NULL, recipe_version integer NOT NULL,
 snapshot jsonb NOT NULL, canonical_hash text NOT NULL, token_hash text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz, campaign_id uuid, idempotency_key uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,actor_id,idempotency_key),
 FOREIGN KEY(tenant_id,recipe_id,recipe_version) REFERENCES app.recipe_versions(tenant_id,recipe_id,version)
);
CREATE TABLE app.campaigns (
 tenant_id uuid NOT NULL, id uuid NOT NULL, plan_id uuid NOT NULL, name text NOT NULL, mode text NOT NULL CHECK(mode IN ('distributed','immediate')),
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','CANCELLED','BLOCKED')),
 version integer NOT NULL DEFAULT 1, starts_at timestamptz NOT NULL, deadline timestamptz NOT NULL, cancel_requested_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,plan_id),
 FOREIGN KEY(tenant_id,plan_id) REFERENCES app.execution_plans(tenant_id,id)
);
CREATE TABLE app.execution_heads (
 tenant_id uuid NOT NULL, account_id uuid NOT NULL, epoch integer NOT NULL DEFAULT 1 CHECK(epoch>0), next_seq bigint NOT NULL DEFAULT 1,
 current_action_id uuid, last_action_id uuid, blocked_reason text, baseline text,
 PRIMARY KEY(tenant_id,account_id), FOREIGN KEY(tenant_id,account_id) REFERENCES app.accounts(tenant_id,id)
);
CREATE TABLE app.action_intents (
 tenant_id uuid NOT NULL, id uuid NOT NULL, campaign_id uuid NOT NULL, account_id uuid NOT NULL, group_id uuid NOT NULL, proxy_id uuid,
 step_no integer NOT NULL CHECK(step_no>=0), depends_on_id uuid, previous_execution_id uuid, dispatch_seq bigint, execution_epoch integer,
 spec jsonb NOT NULL, adapter_version text NOT NULL, replay_safe boolean NOT NULL, snapshot jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('WAITING_PREDECESSOR','SCHEDULED','READY','LEASED','RUNNING','VERIFYING','SUCCEEDED','RETRY_WAIT','RECONCILING','UNKNOWN','FAILED','CANCELLED','EXPIRED','ABANDONED')),
 version integer NOT NULL DEFAULT 1, earliest_start timestamptz NOT NULL, deadline timestamptz NOT NULL,
 attempt_count integer NOT NULL DEFAULT 0, lease_owner uuid, lease_token_hash text, lease_epoch integer NOT NULL DEFAULT 0, lease_expires_at timestamptz,
 cancel_requested_at timestamptz, reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,campaign_id,account_id,step_no), UNIQUE(tenant_id,account_id,id), UNIQUE(tenant_id,campaign_id,account_id,id),
 FOREIGN KEY(tenant_id,campaign_id) REFERENCES app.campaigns(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES app.accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,group_id) REFERENCES app.groups(tenant_id,id),
 FOREIGN KEY(tenant_id,group_id,proxy_id) REFERENCES app.proxies(tenant_id,group_id,id),
 FOREIGN KEY(tenant_id,campaign_id,account_id,depends_on_id) REFERENCES app.action_intents(tenant_id,campaign_id,account_id,id),
 FOREIGN KEY(tenant_id,account_id,previous_execution_id) REFERENCES app.action_intents(tenant_id,account_id,id)
);
CREATE TABLE app.action_attempts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, action_id uuid NOT NULL, attempt_no integer NOT NULL, worker_id uuid NOT NULL, lease_epoch integer NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), effect_sent_at timestamptz, finished_at timestamptz, outcome text, evidence jsonb,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,action_id,attempt_no), FOREIGN KEY(tenant_id,action_id) REFERENCES app.action_intents(tenant_id,id)
);
CREATE TABLE app.action_transitions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, action_id uuid NOT NULL, from_state text, to_state text NOT NULL, action_version integer NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,action_id,action_version),
 FOREIGN KEY(tenant_id,action_id) REFERENCES app.action_intents(tenant_id,id)
);
CREATE TABLE app.quota_reservations (
 tenant_id uuid NOT NULL, action_id uuid NOT NULL, attempt_no integer NOT NULL, scope_kind text NOT NULL CHECK(scope_kind IN ('account','group','proxy')),
 scope_id uuid NOT NULL, reserved_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz,
 PRIMARY KEY(tenant_id,action_id,attempt_no,scope_kind), FOREIGN KEY(tenant_id,action_id,attempt_no) REFERENCES app.action_attempts(tenant_id,action_id,attempt_no)
);
ALTER TABLE app.outbox_events ADD COLUMN publish_attempts integer NOT NULL DEFAULT 0, ADD COLUMN last_published_at timestamptz;
CREATE INDEX engine_due ON app.action_intents(tenant_id,state,earliest_start);
CREATE INDEX engine_account_order ON app.action_intents(tenant_id,account_id,created_at,campaign_id,step_no);
CREATE INDEX quota_window ON app.quota_reservations(tenant_id,scope_kind,scope_id,reserved_at);
CREATE INDEX engine_expired_leases ON app.action_intents(lease_expires_at) WHERE state IN ('LEASED','RUNNING','VERIFYING');
DO $policies$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['recipes','recipe_versions','execution_plans','campaigns','execution_heads','action_intents','action_attempts','action_transitions','quota_reservations'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',tbl);
 END LOOP;
END $policies$;
GRANT SELECT,INSERT,UPDATE ON app.recipes,app.execution_plans,app.campaigns,app.execution_heads,app.action_intents,app.action_attempts TO msm_app;
GRANT SELECT,INSERT ON app.recipe_versions,app.action_transitions TO msm_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.quota_reservations TO msm_app;
GRANT UPDATE(published_at,publish_attempts,last_published_at) ON app.outbox_events TO msm_app;
