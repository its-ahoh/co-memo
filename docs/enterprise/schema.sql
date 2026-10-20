-- Reviewed design seed; not a production migration. Apply only to an empty test DB.
-- Provision separate owner/runtime/worker roles and explicit GRANTs in implementation.
BEGIN;
CREATE SCHEMA enterprise;
REVOKE ALL ON SCHEMA enterprise FROM PUBLIC;
SET LOCAL search_path = enterprise, pg_catalog;
CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE principals (
 tenant_id uuid NOT NULL REFERENCES tenants, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('human','agent')),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE tenant_memberships (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
 is_admin boolean NOT NULL DEFAULT false, auth_version bigint NOT NULL DEFAULT 1 CHECK(auth_version>0),
 PRIMARY KEY(tenant_id,principal_id), FOREIGN KEY(tenant_id,principal_id) REFERENCES principals
);
CREATE TABLE workspaces (
 tenant_id uuid NOT NULL REFERENCES tenants, id uuid NOT NULL, name text NOT NULL,
 paused boolean NOT NULL DEFAULT false, save_mode text NOT NULL DEFAULT 'automatic' CHECK(save_mode IN ('automatic','explicit')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE workspace_memberships (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, principal_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('viewer','contributor','manager','admin')),
 clearance text NOT NULL DEFAULT 'internal' CHECK(clearance IN ('internal','restricted')),
 active boolean NOT NULL DEFAULT true, auth_version bigint NOT NULL DEFAULT 1 CHECK(auth_version>0),
 PRIMARY KEY(tenant_id,workspace_id,principal_id),
 FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES tenant_memberships
);
CREATE TABLE credentials (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, principal_id uuid NOT NULL,
 secret_hash bytea NOT NULL CHECK(octet_length(secret_hash)=32), scopes text[] NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, PRIMARY KEY(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,principal_id) REFERENCES workspace_memberships
);
-- Authenticate key using a narrowly privileged credential lookup connection/function,
-- which returns identity/digest only. User runtime has no unscoped credential SELECT.
CREATE TABLE objects (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('context','entity','handoff')),
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
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=16384),
 expires_at timestamptz,
 CHECK((state='purged' AND content IS NULL) OR (state<>'purged' AND content IS NOT NULL AND char_length(content) BETWEEN 1 AND 32000)),
 PRIMARY KEY(tenant_id,workspace_id,id), FOREIGN KEY(tenant_id,workspace_id,id,object_kind) REFERENCES objects(tenant_id,workspace_id,id,kind)
);
CREATE TABLE entity_data (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
 object_kind text NOT NULL DEFAULT 'entity' CHECK(object_kind='entity'),
 kind text NOT NULL CHECK(char_length(kind) BETWEEN 1 AND 100), external_key text NOT NULL CHECK(char_length(external_key) BETWEEN 1 AND 200),
 display_name text NOT NULL CHECK(char_length(display_name)<=200),
 attributes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(attributes)='object' AND octet_length(attributes::text)<=32768),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','purged')),
 PRIMARY KEY(tenant_id,workspace_id,id), UNIQUE(tenant_id,workspace_id,kind,external_key),
 FOREIGN KEY(tenant_id,workspace_id,id,object_kind) REFERENCES objects(tenant_id,workspace_id,id,kind)
);
CREATE TABLE object_revisions (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, object_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 snapshot jsonb, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,workspace_id,object_id,revision),
 FOREIGN KEY(tenant_id,workspace_id,object_id) REFERENCES objects,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES principals
);
CREATE TABLE context_entities (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, context_id uuid NOT NULL, entity_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,context_id,entity_id),
 FOREIGN KEY(tenant_id,workspace_id,context_id) REFERENCES context_data,
 FOREIGN KEY(tenant_id,workspace_id,entity_id) REFERENCES entity_data
);
CREATE TABLE handoff_data (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
 object_kind text NOT NULL DEFAULT 'handoff' CHECK(object_kind='handoff'),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200), instructions text NOT NULL CHECK(char_length(instructions) BETWEEN 1 AND 32000),
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','leased','completed','cancelled')),
 assigned_to uuid, lease_owner uuid, lease_expires_at timestamptz,
 fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 100),
 result_context_id uuid, result_revision bigint,
 PRIMARY KEY(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,id,object_kind) REFERENCES objects(tenant_id,workspace_id,id,kind),
 FOREIGN KEY(tenant_id,workspace_id,assigned_to) REFERENCES workspace_memberships,
 FOREIGN KEY(tenant_id,workspace_id,lease_owner) REFERENCES workspace_memberships,
 FOREIGN KEY(tenant_id,workspace_id,result_context_id) REFERENCES context_data,
 FOREIGN KEY(tenant_id,workspace_id,result_context_id,result_revision) REFERENCES object_revisions(tenant_id,workspace_id,object_id,revision),
 CHECK((state='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)),
 CHECK((state='completed' AND result_context_id IS NOT NULL AND result_revision IS NOT NULL) OR (state<>'completed' AND result_context_id IS NULL AND result_revision IS NULL))
);
CREATE TABLE handoff_inputs (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, handoff_id uuid NOT NULL, object_id uuid NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,handoff_id,object_id),
 FOREIGN KEY(tenant_id,workspace_id,handoff_id) REFERENCES handoff_data,
 FOREIGN KEY(tenant_id,workspace_id,object_id,revision) REFERENCES object_revisions
 -- Service restricts input object kinds to context/entity and checks current access.
);
CREATE TABLE proposals (
 tenant_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, context_id uuid NOT NULL,
 base_revision bigint NOT NULL, conflict_revision bigint NOT NULL CHECK(conflict_revision>0),
 candidate jsonb, actor_id uuid NOT NULL, resolved_at timestamptz,
 PRIMARY KEY(tenant_id,workspace_id,id),
 FOREIGN KEY(tenant_id,workspace_id,context_id) REFERENCES context_data,
 FOREIGN KEY(tenant_id,workspace_id,context_id,base_revision) REFERENCES object_revisions(tenant_id,workspace_id,object_id,revision),
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
 FOREACH t IN ARRAY ARRAY['workspace_memberships','credentials','objects','context_data','entity_data','object_revisions','context_entities','handoff_data','handoff_inputs','proposals','receipts','outbox','inbox','audit'] LOOP
  EXECUTE format('ALTER TABLE enterprise.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE enterprise.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_scope ON enterprise.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
COMMIT;
