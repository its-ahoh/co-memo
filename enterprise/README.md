# Enterprise M1: Context vertical slice

Private, opt-in TypeScript/Node service. This package does not import the local SQLite Store, read local memories, install agent configuration, or alter the local CLI. It depends on the design in PR #20 and implements only M1 of [issue #19](https://github.com/its-ahoh/co-memo/issues/19). Not production-ready.

## Run the self-contained demo

Requires Node >=24.12 and pnpm 11.21.0, macOS/Linux with a supported embedded-postgres binary, and registry access for installation. Run as a regular user. The locked development dependency starts **real PostgreSQL 18.4**, not an in-memory substitute. No Docker or existing database is required.

```sh
cd enterprise
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

The demo creates a temporary cluster bound to loopback, random database passwords and two tenant/workspace credentials. It exercises create/get/PATCH, old ETag rejection, receipt replay, cross-workspace rejection and content-free internal event delivery. Credentials are never printed. Connections, server and temporary data are removed on completion. The dependency's approved postinstall only restores required binary symlinks. On unsupported platforms or unavailable binaries, checks fail; they never substitute mocked PostgreSQL.

## Run against a dedicated development PostgreSQL database

Use PostgreSQL 16+ and a **fresh dedicated cluster/database**. Role names `cm_owner`, `cm_auth`, `cm_runtime`, `cm_worker` must not already exist. Migration deliberately refuses collisions. The tested baseline is PostgreSQL 18.4; other majors need their own validation before use. Do not point this at a personal or production database.

1. Install dependencies and build with `pnpm build`.
2. Set `ADMIN_DATABASE_URL` privately to the dedicated database's administrative connection. M1 bootstrap/migration needs a superuser (creates roles and bypasses FORCE RLS for explicit provisioning). This connection is never supplied to the HTTP server or worker.
3. Run `pnpm admin migrate`. Numbered, checksummed migrations run transactionally under an advisory lock. Reruns verify the checksum; unknown/newer versions and drift are refused. Startup only verifies migrations, never applies them.
4. In an administrative `psql` session, enable runtime/worker login and assign unique passwords using interactive prompts:

```sql
ALTER ROLE cm_runtime LOGIN;
\password cm_runtime
ALTER ROLE cm_worker LOGIN;
\password cm_worker
```

No login/password is shipped in the migration. These roles cannot become owner/auth, bypass RLS, change schema, truncate, change membership, or modify authorization columns. `cm_auth` and `cm_owner` stay NOLOGIN. The narrowly privileged SECURITY DEFINER authentication function accepts an ID **and a digest**, returns only the matching active identity, has a fixed search path and is executable only by runtime. It cannot enumerate credentials. Shared authorization row locks use UPDATE permission on an inert `lock_guard` column, not permission to change scopes or memberships.

5. Run `pnpm admin bootstrap-demo` to create one synthetic tenant/workspace/principal; it prints only their IDs. Run it twice for two tenants. This command creates no credential. For an existing deployment, provision memberships administratively rather than using the demo bootstrap.
6. Provision a credential, replacing the three UUIDs and expiration with the bootstrap output and a future UTC timestamp:

```sh
pnpm admin provision '{"tenantId":"<tenant UUID>","workspaceId":"<workspace UUID>","principalId":"<principal UUID>","expiresAt":"<future RFC3339 timestamp>","scopes":["context:read","context:write"]}'
```

The random 256-bit bearer token is printed **once**. Store it privately; only its SHA-256 digest is stored in PostgreSQL. To revoke it, run `pnpm admin revoke '<credential UUID>'` (the UUID before the token's dot). Provision a replacement to rotate. Expired credentials cannot be provisioned. Revocation takes a conflicting database lock: already authorized transactions may finish before revocation commits, but subsequent authorization fails.

7. Set `DATABASE_URL` to a `cm_runtime` connection and set `CURSOR_SIGNING_KEY` to at least 32 cryptographically random bytes encoded as base64url. For example, generate a private value with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`. Keep the key stable across server processes; rotating it invalidates cursors. Run `pnpm start`. HTTP binds only `127.0.0.1:8787`; plain HTTP is for local development only. A production TLS gateway and operational hardening remain M5.
8. Set `WORKER_DATABASE_URL` to `cm_worker`, plus `TENANT_ID` and `WORKSPACE_ID`, then run `pnpm worker`. It drains currently due events in that explicit scope, prints only event envelopes and exits. Re-run it to process retries when due; no cross-tenant scheduler is exposed.

`.env.example` lists variable names without credentials. It is a template, not automatically loaded. Keep admin credentials out of the API/worker environment.

## HTTP behavior

The [OpenAPI contract](../docs/enterprise/openapi.json) is authoritative for the live routes:

- `POST /v1/workspaces/{workspaceId}/contexts`: `{kind, content, title?, metadata?}`, UUID `Idempotency-Key`, returns 201.
- `GET /v1/workspaces/{workspaceId}/contexts`: `limit` (1–100, default 50), optional signed `cursor`.
- `GET /v1/workspaces/{workspaceId}/contexts/{id}`: current visible active resource.
- `PATCH /v1/workspaces/{workspaceId}/contexts/{id}`: nonempty `{content?, title?, metadata?}`, UUID `Idempotency-Key` and strong `If-Match: "<revision>"`.

Use `Authorization: Bearer <token>` and `Content-Type: application/json` for mutations. Tenant/workspace/principal come from the verified credential. Unknown JSON/query keys are rejected; spoofed tenant headers cannot select a tenant. M1 creates active/internal objects owned by the authenticated principal; public callers cannot change classification, ownership, expiry or state. Restricted/expired/archived/conflicted/purged data is filtered by current access. A viewer cannot write; all calls require `context:read`, mutations additionally require `context:write` and a writer role. No `sourceAgent` field grants authority.

Bodies are <=128 KiB; text limits count Unicode code points; metadata serialized JSON is <=16 KiB and rejects prototype keys recursively. NUL/unpaired surrogate text and metadata nesting beyond 64 levels are invalid. The DB adds a 32 KiB ceiling on its whitespace-expanded jsonb representation. Mutation, exact-revision history, receipt, audit and outbox commit together. Transient deadlock/serialization errors retry the entire pure DB transaction at most three attempts; other failures roll back and return a safe problem response.

Revisions and ETags preserve PostgreSQL bigint precision as decimal strings. Missing key/ETag returns 428, stale revision 412, same key with changed method/path/body/ETag 409. Authorization and current object visibility precede successful replay; replay returns the original exact snapshot, status and ETag with `Idempotency-Replayed: true`. Receipts store references, never duplicate content. Clients should reconcile rather than retry past seven days. M1 retains receipts indefinitely (no cleanup job); M2 will define erasure/410 behavior. All HTTP responses use `Cache-Control: no-store`.

Signed pagination binds tenant, workspace, principal, clearance and the fixed active/unexpired filter/sort. `(created_at,id)` cursors retain microseconds. Pagination is not a snapshot guarantee.

All business queries run inside transactions with local session settings and rechecked credential/membership/workspace locks. Missing settings deny rows. The runtime is a non-owner NOBYPASSRLS role; FORCE RLS covers every tenant-bearing table. RLS protects scope, while application checks enforce role/scope/classification. This does not make arbitrary SQL from untrusted callers safe; no SQL endpoint exists.

## Internal worker guarantee

The outbox has identifiers, revision, event type and timestamps only. Claims use SKIP LOCKED, an owner, monotonically increasing token and DB-time lease. Ack/failure checks the lease **after acquiring the row lock**. Marker insertion and ack are one transaction; an inbox unique key deduplicates repeated events. Failed attempts use bounded exponential backoff/jitter; ten attempts result in dead-letter state, including the final crashed lease. The worker has no Context/history read grant. It checks and locks workspace policy before claiming or acknowledging; paused workspaces are refused. This proves internal database delivery only, not external exactly-once effects or ordering. Dead-letter administration/replay is deferred; no replay endpoint is advertised.

## Design findings resolved for M1

- The seed had no role grants or executable pre-scope authentication path. The real migration adds them and globally unique credential IDs.
- Seed jsonb text size checks disagreed with the wire JSON limit because PostgreSQL adds whitespace. Wire validation remains 16 KiB; DB defense-in-depth uses 32 KiB.
- Broad design prose mentioned expiry/classification/actors beyond the M1 DTO. OpenAPI remains the M1 public subset; extra provenance stays in DB and cannot be supplied by clients.
- OpenAPI exposes no verified explicit-submission intent. All M1 writes are treated as automatic and explicit-only workspaces reject writes. No header can claim human approval.
- Later lifecycle states remain database guards only. No Entity, Handoff, history endpoint, purge, SDK, MCP, importer or OIDC is implemented.

## Verification and remaining milestones

See [validation.md](validation.md) for executed checks and limits, and [backlog.md](backlog.md) for M2–M5. No publish, deployment, merge, upload or local-memory migration is part of M1.
