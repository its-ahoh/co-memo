-- Fresh dedicated PostgreSQL database; executed only by the admin migrator.
CREATE ROLE cm_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE cm_auth NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE cm_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE cm_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA enterprise AUTHORIZATION cm_owner;
REVOKE ALL ON SCHEMA enterprise FROM PUBLIC;
SET LOCAL ROLE cm_owner;
SET LOCAL search_path = enterprise, pg_catalog;
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE principals (
 tenant_id uuid NOT NULL REFERENCES tenants, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('human','agent')),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE tenant_memberships (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, active boolean NOT NULL DEFAULT true, lock_guard boolean NOT NULL DEFAULT false,
 is_admin boolean NOT NULL DEFAULT false, auth_version bigint NOT NULL DEFAULT 1 CHECK(auth_version>0),
 PRIMARY KEY(tenant_id,principal_id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals
);
CREATE TABLE workspaces (
 tenant_id uuid NOT NULL REFERENCES tenants, id uuid NOT NULL, name text NOT NULL,
 paused boolean NOT NULL DEFAULT false, lock_guard boolean NOT NULL DEFAULT false, save_mode text NOT NULL DEFAULT 'automatic' CHECK(save_mode IN ('automatic','explicit')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE workspace_memberships (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, principal_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('viewer','contributor','manager','admin')),
 clearance text NOT NULL DEFAULT 'internal' CHECK(clearance IN ('internal','restricted')),
 active boolean NOT NULL DEFAULT true, lock_guard boolean NOT NULL DEFAULT false, auth_version bigint NOT NULL DEFAULT 1 CHECK(auth_version>0),
 PRIMARY KEY(tenant_id,workspace_id,principal_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES tenant_memberships
);
CREATE TABLE credentials (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL UNIQUE, principal_id uuid NOT NULL,
 lock_guard boolean NOT NULL DEFAULT false,
 secret_hash bytea NOT NULL CHECK(octet_length(secret_hash)=32), scopes text[] NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, PRIMARY KEY(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,principal_id) REFERENCES workspace_memberships
);
-- Authenticate key using a narrowly privileged credential lookup connection/function,
-- which returns identity/digest only. User runtime has no unscoped credential SELECT.
CREATE TABLE objects (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('context')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 classification text NOT NULL DEFAULT 'internal' CHECK(classification IN ('internal','restricted')),
 owner_id uuid NOT NULL, created_by uuid NOT NULL, updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,workspace_id,id), UNIQUE(tenant_id,workspace_id,id,kind),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES principals,
 FOREIGN KEY(tenant_id,created_by) REFERENCES principals,
 FOREIGN KEY(tenant_id,updated_by) REFERENCES principals
);
CREATE INDEX objects_page ON objects(tenant_id,workspace_id,kind,created_at,id);
CREATE TABLE context_data (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
 object_kind text NOT NULL DEFAULT 'context' CHECK(object_kind='context'),
 kind text NOT NULL CHECK(kind IN ('note','preference','decision','constraint','lesson')),
 title text NOT NULL CHECK(char_length(title)<=200), content text,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','conflicted','purged')),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=32768),
 expires_at timestamptz,
 CHECK((state='purged' AND content IS NULL) OR (state<>'purged' AND content IS NOT NULL AND char_length(content) BETWEEN 1 AND 32000)),
 PRIMARY KEY(tenant_id,workspace_id,id), FOREIGN KEY(tenant_id,workspace_id,id,object_kind) REFERENCES objects(tenant_id,workspace_id,id,kind)
);
CREATE TABLE object_revisions (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, object_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 snapshot jsonb, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,workspace_id,object_id,revision),
 FOREIGN KEY(tenant_id,workspace_id,object_id) REFERENCES objects,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals
);
CREATE TABLE receipts (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, principal_id uuid NOT NULL, key uuid NOT NULL,
 request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32), status integer,
 object_id uuid, revision bigint, purged boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '7 days'),
 PRIMARY KEY(tenant_id,workspace_id,principal_id,key),
 FOREIGN KEY(tenant_id,workspace_id,principal_id) REFERENCES workspace_memberships,
 FOREIGN KEY(tenant_id,workspace_id,object_id,revision) REFERENCES object_revisions,
 CHECK(status IS NULL OR status BETWEEN 200 AND 599)
 -- Pending status exists only inside the transaction; service must finalize before commit.
);
CREATE TABLE outbox (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
 aggregate_id uuid NOT NULL, aggregate_kind text NOT NULL, aggregate_revision bigint NOT NULL,
 event_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), dead_letter boolean NOT NULL DEFAULT false,
 claim_owner uuid, claim_token bigint NOT NULL DEFAULT 0 CHECK(claim_token>=0), lease_until timestamptz,
 last_error_code text,
 PRIMARY KEY(tenant_id,workspace_id,id),
 UNIQUE(tenant_id,workspace_id,aggregate_kind,aggregate_id,aggregate_revision,event_type),
 FOREIGN KEY(tenant_id,workspace_id,aggregate_id,aggregate_kind) REFERENCES objects(tenant_id,workspace_id,id,kind),
 FOREIGN KEY(tenant_id,workspace_id,aggregate_id,aggregate_revision) REFERENCES object_revisions,
 CHECK((claim_owner IS NULL)=(lease_until IS NULL))
);
CREATE INDEX outbox_due ON outbox(tenant_id,workspace_id,available_at,id) WHERE delivered_at IS NULL AND NOT dead_letter;
CREATE TABLE inbox (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, consumer text NOT NULL, event_id uuid NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,workspace_id,consumer,event_id),
 FOREIGN KEY(tenant_id,workspace_id,event_id) REFERENCES outbox
);
CREATE TABLE audit (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL,
 action text NOT NULL, object_id uuid, request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,workspace_id,id), FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals
 -- No payload text. API can append but cannot update/delete audit rows.
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['principals','tenant_memberships'] LOOP
  EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON enterprise.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
 ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
 ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
 CREATE POLICY tenant_scope ON tenants USING(id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(id=nullif(current_setting('app.tenant_id',true),'')::uuid);
 ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
 ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
 CREATE POLICY workspace_scope ON workspaces USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=nullif(current_setting('app.workspace_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND id=nullif(current_setting('app.workspace_id',true),'')::uuid);
 FOREACH t IN ARRAY ARRAY['workspace_memberships','credentials','objects','context_data','object_revisions','receipts','outbox','inbox','audit'] LOOP
  EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_scope ON enterprise.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;

RESET ROLE;
GRANT USAGE ON SCHEMA enterprise TO cm_runtime, cm_worker, cm_auth;
-- Only this no-login role can look up a credential before a tenant is known.
CREATE POLICY credential_lookup ON enterprise.credentials FOR SELECT TO cm_auth USING (true);
GRANT SELECT ON enterprise.credentials TO cm_auth;
CREATE FUNCTION enterprise.authenticate(key_id uuid, digest bytea)
RETURNS TABLE(tenant_id uuid, workspace_id uuid, principal_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, enterprise
AS $$ SELECT c.tenant_id, c.workspace_id, c.principal_id FROM enterprise.credentials c
 WHERE c.id=key_id AND c.secret_hash=digest AND c.revoked_at IS NULL
 AND c.expires_at>clock_timestamp() $$;
ALTER FUNCTION enterprise.authenticate(uuid,bytea) OWNER TO cm_auth;
REVOKE ALL ON FUNCTION enterprise.authenticate(uuid,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enterprise.authenticate(uuid,bytea) TO cm_runtime;
GRANT SELECT ON enterprise.credentials, enterprise.tenant_memberships,
 enterprise.workspace_memberships, enterprise.workspaces TO cm_runtime;
-- SELECT FOR SHARE needs an UPDATE privilege; no authorization column is writable.
GRANT UPDATE(lock_guard) ON enterprise.credentials, enterprise.tenant_memberships,
 enterprise.workspace_memberships, enterprise.workspaces TO cm_runtime;
GRANT SELECT,INSERT ON enterprise.objects, enterprise.context_data, enterprise.receipts TO cm_runtime;
GRANT UPDATE(revision,updated_at,updated_by) ON enterprise.objects TO cm_runtime;
GRANT UPDATE(title,content,metadata) ON enterprise.context_data TO cm_runtime;
GRANT UPDATE(status,object_id,revision) ON enterprise.receipts TO cm_runtime;
GRANT SELECT,INSERT ON enterprise.object_revisions TO cm_runtime;
GRANT INSERT ON enterprise.audit, enterprise.outbox TO cm_runtime;
GRANT SELECT ON enterprise.outbox TO cm_worker;
GRANT UPDATE(available_at,delivered_at,attempts,dead_letter,claim_owner,claim_token,lease_until,last_error_code) ON enterprise.outbox TO cm_worker;
GRANT SELECT,INSERT ON enterprise.inbox TO cm_worker;

GRANT SELECT ON enterprise.workspaces TO cm_worker;
GRANT UPDATE(lock_guard) ON enterprise.workspaces TO cm_worker;
