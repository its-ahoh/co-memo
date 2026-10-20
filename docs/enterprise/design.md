# Co-memo Enterprise Context Infrastructure — TypeScript/PostgreSQL design

Status: reviewed design, approved for an isolated development slice; not a production-readiness claim.
Date: 2026-10-19. Repository: https://github.com/its-ahoh/co-memo. Verified main: `5e8c5cbca9e52158bf89cd3c6c01911bc63da3b4` (0.8.2). User selected TypeScript, not Go.

## 1. Repository findings and product boundary

The existing application is a single TypeScript ESM package, Node >=24.12, pnpm 11.21.0, strict NodeNext compilation, Zod 4, MCP SDK, Commander and Node's built-in SQLite. Tests use `node --test test/*.test.mjs`; `pnpm check` includes formatting, typecheck, build and tests. Contribution rules require a feature discussion issue, a branch and PR to main. No existing enterprise authentication or PostgreSQL backend was found.

Relevant source: `src/store.ts` owns SQLite schema 8, transactions, notes/history/conflicts; `src/service.ts` enforces local settings; `src/candidates.ts` handles batches/retry receipts; `src/model.ts` defines scopes/content/provenance; `src/mcp.ts` serves stdio; `src/setup.ts`, `src/adapters.ts` integrate hosts. Existing `sourceAgent` is configured provenance, not an authenticated identity. Notes are <=32,000 characters. Local user/project scopes are not security boundaries. Archived notes retain history; purged notes leave content-free tombstones. Conflicts are preserved and excluded from injected context.

Positioning: a shared, permissioned, versioned context and work-transfer layer for multiple agents and humans. General entities support business cases without restricting the product to source code. This service does not run arbitrary agent code, extract transcripts, provide a workflow engine, or promise semantic truth. A Handoff assigns responsibility and protects result publication; it does not make external effects exactly-once.

Keep the current local product operational, offline and account-free. Add `enterprise/` as an independently installable private package with its own package.json, tsconfig, lockfile, migrations and tests. Initially avoid a root workspace conversion. Existing package/build/setup/SQLite remain untouched. Reuse validation ideas, not the SQLite Store class: it is synchronous and assumes a local single-user trust model. PostgreSQL driver `pg`, Node HTTP, Zod and SQL migrations are enough for M1; do not introduce Redis, Kafka, an ORM, embeddings or a framework rewrite. Pin resolved dependencies in its lockfile. Future extraction of common pure validators needs dedicated compatibility tests.

## 2. Domain model

Every business object has UUID id, tenantId, workspaceId, revision (positive bigint represented as decimal JSON string), createdAt/updatedAt (UTC RFC3339), createdBy/updatedBy authenticated principal IDs. Tenant and workspace are immutable. Agent labels/evidence are separate untrusted metadata. IDs are server-generated except explicit validated import mapping. Unknown attribution remains null.

**Context**: kind = note/preference/decision/constraint/lesson, title <=200 chars, content 1..32,000 chars, metadata object <=16 KiB, state active/archived/conflicted/purged, optional expiresAt, classification internal/restricted, ownerId. It represents reusable information, not an assembly of a whole conversation. Append-only revisions record snapshots and actor IDs. Default retrieval excludes archived, conflicted, expired and purged records. History is explicit and requires current access. Permanent purge clears content, titles, sensitive metadata/attributes and evidence in current rows, snapshots, proposals, receipts and derived storage; the object ID and a non-content audit marker remain.

**Entity**: kind and externalKey (<=100/200 chars), displayName <=200, attributes object <=32 KiB, state active/archived/purged, classification, ownerId. Unique `(tenant, workspace, kind, externalKey)` including tombstones prevents accidental resurrection. On purge, replace sensitive external keys with a tenant-keyed digest in a reserved tombstone namespace and retain the digest for import/dedup checks; never retain raw business identifiers as an erasure shortcut. Entity attributes are typed by application-supplied kind schemas in a later milestone; initial attributes are bounded JSON with prohibited prototype keys. A normalized Context–Entity link table has composite foreign keys to both objects. Updating links increments the Context revision and emits a new snapshot. Cross-workspace links are rejected initially.

**Handoff**: title <=200, instructions <=32,000, input references to exact Context/Entity revisions, optional resultContextId/resultRevision, creator, optional assigned principal, state ready/leased/completed/cancelled, revision, leaseOwner, leaseExpiresAt, fencingToken bigint initially 0, attempt count and maxAttempts. Assignment does not grant access to input contexts. Input reads check current authorization and retention even for pinned revisions. Purged/revoked input fails closed; it is never recovered from an embedded payload copy.

State transitions: create -> ready; claim ready or expired leased -> leased and token+1; heartbeat leased -> leased with unchanged token; complete leased -> completed; release leased -> ready, clear lease; creator/admin cancel ready/leased -> cancelled and invalidate lease. Terminal objects cannot be claimed. Failed attempts release with bounded retry/backoff until maxAttempts; exhausted handoffs stay ready but unclaimable and expose needsAttention, requiring explicit admin retry (increments token and resets attempts with audit). Lease TTL defaults 60s, allowed 10..300s; heartbeat at <=TTL/3. All lease time comparisons use DB clock after acquiring row lock.

**Conflicts**: a normal stale PATCH returns 412 and does not overwrite. An explicit proposal endpoint stores the candidate against baseRevision, marks Context conflicted and increments Context revision. Resolution requires expected Context AND conflict revision, preserves audit and commits chosen/merged text as a new revision. This preserves local product semantics without making every network retry create a conflict.

## 3. Authentication, RBAC, ABAC and RLS

M1: opaque bearer service credentials provisioned by an admin CLI; random 256-bit secret shown once, stored only as SHA-256 digest with random key ID, expiration and revocation time. No default token, no plaintext logs, no public bootstrap route. Bootstrap operates on synthetic dev data using migration credentials; runtime cannot grant itself permissions. Request identity comes from validated credential, never X-Tenant-ID or body sourceAgent. A credential binds one principal, tenant and allowed workspace/scopes. Production requires TLS; loopback development explicitly documented. Later human login uses OIDC issuer/audience/signature/expiry validation and tenant membership mapping, not arbitrary email-domain inference.

Permission intersection = active credential scopes ∩ active tenant membership ∩ workspace membership role ∩ classification clearance ∩ object constraints. Role table:

| Role         | Read                      | Context/Entity writes | Claim/complete assigned or unassigned handoff | Resolve/archive  | Manage members/credentials | Purge                |
| ------------ | ------------------------- | --------------------- | --------------------------------------------- | ---------------- | -------------------------- | -------------------- |
| viewer       | yes                       | no                    | no                                            | no               | no                         | no                   |
| contributor  | yes                       | yes                   | yes                                           | own objects only | no                         | no                   |
| manager      | yes                       | yes                   | yes                                           | all in workspace | no                         | no                   |
| tenant admin | membership still required | yes                   | yes                                           | yes              | yes                        | explicit purge scope |

ABAC: restricted rows require restricted clearance; paused workspace rejects delivery and writes; explicit-only policy rejects declared automatic submissions (declaration is not proof of human approval); credential expiry/revocation and assignment checked on every call. Classification downgrades, ownership transfer and permission changes require manager/admin. Public payloads cannot set tenant, actor, revision, lease fields or ACL. Unknown keys rejected. Return 404 for inaccessible resource IDs; 403 only for an authenticated caller's known workspace operation. Error details never include hidden current content.

RLS is a tenant/workspace defense in depth, not a SQL-injection defense. All SQL parameterized, no user SQL endpoint. Runtime/worker roles are NOSUPERUSER NOBYPASSRLS, do not own tables, cannot SET ROLE to owner, cannot change schema, and have no TRUNCATE grant. Enable AND FORCE RLS on all tenant-bearing tables including history, links, proposals, receipts, outbox and audit. A transaction sets `app.tenant_id` and `app.workspace_id` using `set_config(..., true)` only after authenticated membership checks. Missing settings deny all. Connections are never used outside this transaction; pool cleanup rolls back on error. Restrict runtime grants by table/operation; outbox scheduler is separate from user API access. SQL seed in companion file establishes scope isolation, while application RBAC/ABAC remains mandatory; the seed alone is not sufficient deployment authorization.

Revocation serialization: every request transaction checks/locks credential and membership rows FOR SHARE before business data; credential/membership revocation obtains conflicting row locks and increments authorization version. Workspace policy uses the same locking discipline. Once revocation commits, subsequently authorized operations cannot use cached grants. Requests already in progress may finish before revocation commits; document this boundary. Lock order: credential, tenant membership, workspace membership/policy, resource IDs in sorted order. Reauthorize receipt replay and history reads. Do not cache permissioned content in shared CDN/browser storage (`Cache-Control: no-store`).

## 4. REST and OpenAPI contract

Version `/v1/workspaces/{workspaceId}`; tenant inferred from credential. JSON requests bounded to 128 KiB; content character and metadata byte limits checked separately. UTF-8, UUID validation, strict schemas. Cursor pagination `(created_at,id)` with default 50/max 100; signed opaque cursor binds workspace, filter and sort. No offset-based snapshot promise. All mutation routes require `Idempotency-Key` UUID. Updates additionally require strong `If-Match: "<revision>"`; missing=428, stale=412. Token/revision JSON values are strings to avoid JS precision loss. Date fields are timezone-aware strings. Responses include requestId, resource, revision and ETag where applicable.

| Route suffix                                  | Methods and semantics                                         | Milestone |
| --------------------------------------------- | ------------------------------------------------------------- | --------- |
| `/contexts`                                   | POST create (201); GET filtered list (200)                    | M1        |
| `/contexts/{id}`                              | GET; PATCH content/title/metadata by CAS                      | M1        |
| `/contexts/{id}/revisions`                    | GET current-access-checked history                            | M2        |
| `/contexts/{id}/archive`, `/restore`          | POST state transition                                         | M2        |
| `/contexts/{id}/purge`                        | POST explicit privileged content erasure (202)                | M2        |
| `/contexts/{id}/proposals`                    | POST candidate against baseRevision                           | M2        |
| `/contexts/{id}/resolve`                      | POST chosen candidate or merged text plus conflictRevision    | M2        |
| `/entities`, `/entities/{id}`                 | POST/GET, GET/PATCH                                           | M2        |
| `/contexts/{id}/entities`                     | PUT full bounded entity ID set, Context If-Match              | M2        |
| `/handoffs`, `/handoffs/{id}`                 | POST/GET, GET                                                 | M3        |
| `/handoffs/{id}/claim`                        | POST expected revision and TTL; response lease + fencingToken | M3        |
| `/handoffs/{id}/heartbeat`                    | POST lease token + TTL and If-Match                           | M3        |
| `/handoffs/{id}/complete`                     | POST lease token + result content in same transaction         | M3        |
| `/handoffs/{id}/release`, `/cancel`, `/retry` | POST guarded transitions                                      | M3        |
| `/context-query`                              | POST bounded query + maxChars (<=16,000)                      | M4        |
| `/settings`                                   | GET/PATCH manager policy with If-Match                        | M4        |

Errors use `application/problem+json`: type, title, status, code, requestId; optional safe field errors. 400 invalid input/cursor, 401 absent/invalid credential, 403 denied known action, 404 missing/invisible, 409 idempotency mismatch/invalid transition/lease lost, 412 stale revision, 413 payload limit, 422 invalid referenced resource, 428 missing CAS/key, 429 quota, 503 transient database failure. Hide constraint/SQL messages. Successful replay returns original status/resource revision plus `Idempotency-Replayed: true` only if current access and erasure policy permit; stale content is not replayed after purge.

Companion `openapi.json` is the machine-readable M1 contract. This table and transition definitions specify later routes; each milestone must extend OpenAPI with request/response/error schemas before implementing those endpoints. No placeholder later route is advertised as live. Contract tests compare actual HTTP responses with the specification.

## 5. Transactions, revision and idempotency

READ COMMITTED + explicit locks/CAS is the default. A single-resource update is `UPDATE ... SET revision=revision+1 ... WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND revision=$4 RETURNING ...`. History, audit, outbox event and idempotency receipt commit together. No model/provider/network call inside the transaction. Context and entity references use composite tenant/workspace foreign keys, not just UUID references. Multi-resource invariants lock all participating rows; use SERIALIZABLE only for invariants not expressible with constraints/locks and retry the whole pure DB operation on 40001/40P01, at most three times with jitter. Never retry external side effects in that closure.

Idempotency uniqueness `(tenant, workspace, principal, key)`. Hash canonical method, normalized path, validated body, If-Match and authenticated principal; order JSON keys deterministically. Insert a pending receipt inside the mutation transaction before side effects. Concurrent duplicate insert waits; after conflict read committed receipt, compare hash, then replay. Different hash returns 409; timeout while waiting returns retryable 503. Rollback leaves no committed pending receipt. Commit stores status and a minimal resource reference/revision (avoid duplicated content); response reconstruction reads exact revision after current authorization. Replay is checked before CAS so a successful retry is not rejected as stale. Keep receipts 7 days by default; API documents expiration and clients must not retry beyond that without reconciling state. Never remove the receipt earlier than its documented TTL except purge content scrubbing; retain key/hash/status marker so purge cannot recreate a resource through replay. API returns a purged-result marker/410 for such receipt, not a new write. Add this 410 behavior to M2 contract.

Revision increments on every material resource mutation, including links and lease transitions. Creation is revision 1. History snapshots are immutable except governed erasure. Duplicate retries do not increment revision. Exact-content deduplication is workspace-scoped and separate from request idempotency; do not carry the local global fingerprint uniqueness into multi-tenant storage. M1 does not perform automatic semantic merge/deduplication.

## 6. Lease/fencing correctness

Claim locks the Handoff row FOR UPDATE, checks current DB time, assignment/access/state, then increments both fencingToken and revision. Heartbeat, release and completion require authenticated lease owner, token equality, expected revision, state leased and leaseExpiresAt > clock_timestamp() after lock acquisition. Heartbeat cannot revive an expired lease. Cancel increments token, clears owner/expiry and increments revision. Tokens never reset, including explicit retry. Expiry alone does not decrement a token.

Complete writes a new result Context + revision + Handoff terminal state + outbox + receipt in one transaction. Every result mutation made through the handoff path rechecks the same lease guard under lock; accepting a token in HTTP without testing it in the transaction is insufficient. A stale worker cannot publish after takeover, even if its model call finishes late. External systems must enforce idempotency/fencing themselves; email/payment/browser effects are out of scope and must never be presented as exactly-once. A timeout after commit is reconciled by idempotent replay.

## 7. Outbox and worker

Write minimal events `{eventId, tenantId, workspaceId, aggregateKind, aggregateId, aggregateRevision, eventType, occurredAt}`; no context content, credential, instruction or result text. Event uniqueness includes aggregate kind+ID+revision+event type. Worker reads current resource under tenant/workspace policy; deleted/restricted content is never recovered from an event body.

Worker claims due rows via FOR UPDATE SKIP LOCKED in a short transaction, sets claimOwner, leaseUntil and increments claimToken. It commits before processing. Ack/failure update requires owner+token+unexpired lease. Crash before ack means at-least-once delivery; consumers must deduplicate by eventId using an inbox row in the same transaction as their own database effects. An internal M1 consumer may only insert a delivery/inbox marker. Do not claim this demonstrates external exactly-once delivery. Worker attempts exponential backoff+jitter; max 10 attempts then dead-letter state with inspected/redacted error category. Explicit replay is audited. Polling is authoritative; LISTEN/NOTIFY later is only a wake-up hint.

Scope scheduler: enumerate workspace IDs using a narrowly privileged scheduler account and process each workspace with transaction-local tenant/workspace settings; runtime API cannot list all tenants. RLS must remain enabled for workers. M1 worker may take explicit configured tenant/workspace and synthetic fixtures. Aggregate events may arrive out of order; cache consumers reread current state and ignore older aggregate revisions. Strict external event ordering is not promised. Purge emits an invalidation marker and clears materialized content before reporting erasure complete. Metrics: pending count, oldest lag, retry/dead-letter count, lease expiry, conflict/CAS failures, denied access, pool wait and latency; labels must not contain note text or unbounded IDs.

## 8. Schema and deployment

Companion `schema.sql` is a concrete PostgreSQL 16+ design seed, not an applied migration. Production baseline may use 18; CI should pin a supported major and cover upgrade separately. Tables: tenants, principals, tenant memberships, credentials, workspaces, workspace memberships, objects (shared authorization/revision envelope), context_data, entity_data, object_revisions, context_entities, handoff_data, handoff_inputs, proposals, receipts, outbox, inbox and audit. Composite keys preserve tenant/workspace identity. Shared objects prevent unsafe polymorphic history references. Typed data tables must enforce kind via a composite FK including a checked constant kind.

Provision owner/migrator/runtime/worker separately; revoke public schema creation. Authentication lookup uses a separate narrowly privileged connection or hardened SECURITY DEFINER function with a fixed search_path and restricted EXECUTE grant, returning only key digest/identity/expiry; it does not expose arbitrary tenant records. The request then rechecks the credential under its scoped transaction lock. Runtime grants must be explicit and least privilege; migrations do not ship real users/tokens. RLS setup is transactional. Indexes cover `(tenant,workspace,created_at,id)`, object revision, entity key and outbox due time. JSON indexes/search extensions wait for measured need. Real Chinese/code retrieval quality cannot be assumed equivalent to SQLite FTS5; M4 has labeled parity evaluations.

Migrations are numbered, checksummed, forward-only and serialized with a PostgreSQL advisory lock. Startup refuses unknown/newer schema versions; runtime never auto-migrates with elevated credentials. Expand/backfill/validate/contract across releases; lock_timeout and statement_timeout bound deployment locks. Large new indexes use CREATE INDEX CONCURRENTLY in separately tracked non-transactional migration. Back up and test restore first. Do not drop columns until old binaries are retired. Roll back application to a compatible prior binary; database destructive rollback is a restore operation with explicit operational procedure.

## 9. Local compatibility and migration

No automatic upload, SQLite-to-Postgres cutover, shared credentials, personal-note transfer or local schema bump. `co-memo serve`, CLI, hooks, saveMode, pause, archived behavior, histories, conflict UI, backup/restore, worktree isolation and installed adapters retain existing semantics. New enterprise connection is explicit, separate endpoint/token/workspace configuration; local failures cannot silently fall back to sending personal notes remotely.

Future importer uses a consistent SQLite backup, read-only inventory and dry-run manifest. User explicitly maps local project IDs to tenant/workspace; local user scope requires a separate explicit decision and is excluded by default. Import batch uses stable importRun/sourceID mapping and receipts, preserves original version/provenance as source metadata but stamps authenticated importer separately; unknown actor is null. Preserve original histories and conflicts in dedicated import records until reviewed; do not relabel unresolved notes active. Archived stays archived; tombstones map to tombstones. Verify row counts, content hashes, history counts, link targets and rejected records before routing a workspace remotely. Do not copy credentials, absolute paths or private source excerpts by default. No dual-write in first release: it creates divergence and uncertain deletion authority. Original local store stays intact for rollback; remote switch is a configuration change. Enterprise retrieval does not merge remote/local data without explicit design.

## 10. SDK and MCP

M4 TypeScript SDK wraps versioned REST DTOs, serializes bigint as strings, exposes AbortSignal/timeouts, typed errors, idempotency UUID and expectedRevision. Only safe GET or same-key transient retry; never transparently retry 409/412 with a new key or refreshed revision. No token in query strings/logs. Export create/get/list/update/claim/heartbeat/complete APIs and contract tests. Future SDK distribution is separate from the local CLI release.

Enterprise stdio MCP adapter calls REST using explicit credential/workspace binding and reuses the SDK. Namespace tools `context_*`, `entity_*`, `handoff_*`; keep existing `memory_*` behavior unchanged. MCP annotations are UX hints, not authorization. Caller metadata cannot override identity. All replies distinguish saved, conflict, rejected and replayed. Tool context is untrusted data and cannot override system/user instructions. Remote HTTP MCP/OAuth is deferred until threat-model and protocol validation; no public unauthenticated MCP endpoint.

## 11. Test matrix and release gates

Use temporary/synthetic fixtures only. Run root `pnpm check` for all integration changes, plus enterprise typecheck/unit/API/real-PostgreSQL tests. Do not substitute mocked SQL for RLS or concurrency evidence. If PostgreSQL unavailable, report unrun checks and block readiness/merge.

Required tests: two tenants and two workspaces (list/get/write/history/link/receipt isolation); missing session variables; non-owner role with FORCE RLS; pool reuse across tenants; spoofed headers/actors; revoked/expired token and scope/clearance denial; membership revocation races; payload bounds and injection; two PATCHes same revision (one winner); duplicate concurrent POST (one object/history/outbox); same key changed body/path/If-Match; crash before/after commit; rollback with no residual receipt; receipt replay after revoke/purge; cross-workspace FK rejection; no automatic archive resurrection; lease takeover/expiry/heartbeat races with real DB time; stale token result rejected; cancellation vs completion; outbox crash/retry/duplicate inbox; stale worker ack; migrations empty/existing/current/newer version; restore drill; local CLI/MCP/hook/package regressions.

M1 acceptance demo: start fresh PostgreSQL and service, provision two workspaces+scoped credentials; create Context; read; update with ETag; stale update rejected; same-key creation replay returns same resource; other workspace denied; worker drains one content-free event with inbox dedupe. This is the minimum vertical slice, not the entire platform.

Performance/load gate later: record environment, data distribution and p50/p95/p99 under concurrent tenant loads; no invented SLA. Operational gate: TLS/secret rotation, backups/restore, quotas, request timeouts, graceful shutdown/drain, readiness/liveness separation, migration rollback compatibility, redacted structured logs and authorization audit. No enterprise production launch before these gates.

## 12. Phased implementation and review

| Milestone | Deliverable                                                                                                                                                          | Depends | Acceptance                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| M0        | This design, schema seed, M1 OpenAPI, tracking issue and review                                                                                                      | none    | no unresolved design blocker for M1                                       |
| M1        | isolated service package, PostgreSQL migrations, token provisioning, authorization/RLS, Context create/read/list/CAS, atomic history/receipt/outbox, internal worker | M0      | real DB demo and negative/concurrency tests above; local regression check |
| M2        | Entity/linking, history, conflict proposals/resolution, archive/restore/purge lifecycle                                                                              | M1      | composite-FK, erasure, revoked-replay and conflict races                  |
| M3        | Handoff lease/fencing and atomic completion                                                                                                                          | M2      | stale worker/cancel/takeover races                                        |
| M4        | SDK, enterprise MCP, retrieval/settings, dry-run importer                                                                                                            | M3      | contract/parity/compatibility and no implicit upload                      |
| M5        | human OIDC, admin/operational hardening and pilot                                                                                                                    | M4      | security review, restore drill, tenant load tests                         |

Each milestone is a focused draft PR; no automatic merge, package publish or deployment. Start M1 only now; later milestones stay backlog, not falsely reported as started. Implementation may narrow M1 features only if it clearly identifies remaining acceptance criteria; health endpoint + skeleton is insufficient.

### Explicit design review (2026-10-19)

Method: repository-source reconciliation, authorization boundary review, concurrent execution traces, failure/retry analysis and migration rollback analysis. Self-review, not independent security certification or executed runtime tests.

| Finding                                             | Severity | Repair incorporated                                                     | Required implementation evidence |
| --------------------------------------------------- | -------- | ----------------------------------------------------------------------- | -------------------------------- |
| Configured sourceAgent mistaken for auth            | blocker  | validated token principal separate from evidence                        | impersonation test               |
| Tenant-only keys permit cross-workspace links       | blocker  | composite keys and scope checks on every relation                       | FK + API negative tests          |
| Owner/BYPASSRLS makes policies ineffective          | blocker  | runtime non-owner, FORCE RLS, grants audit                              | real runtime-role SQL tests      |
| Replay bypasses revocation or restores purged data  | blocker  | authorize before replay; content-free receipt retention                 | replay/revoke/purge tests        |
| Expired worker can publish after takeover           | blocker  | locked DB-time owner/token/expiry CAS                                   | two-worker race                  |
| Lease alone cannot fence external actions           | blocker  | external effects excluded; guarantee limited to DB                      | docs and API boundary            |
| Outbox ack from expired worker loses retry          | high     | claim generation checked on ack; inbox dedupe                           | crash/stale-ack tests            |
| Cached membership races revocation                  | high     | shared authorization locks, conflicting revocation locks                | transaction race test            |
| Local SQLite replacement breaks current product     | blocker  | independent package and explicit opt-in                                 | existing test/package suite      |
| Scope expands to SaaS/workflow/search before value  | high     | M1 restricted Context vertical slice                                    | acceptance demonstration         |
| Main ref differed from local work branch            | high     | fetched remote main 5e8c5cb; new isolated branch                        | PR base check                    |
| Seed schema could be mistaken for deployed security | high     | label seed; implementation must add grants, lifecycle service and tests | M1 review gate                   |

Conclusion: no unresolved design blocker to start M1 in an isolated branch. Production readiness remains blocked on implementation/test/operational gates. New implementation findings can reopen this decision. No claim that SQL seed has been executed or a service deployed.

## Primary references

PostgreSQL RLS ownership/default-deny/constraints: https://www.postgresql.org/docs/current/ddl-rowsecurity.html . Isolation/retry behavior: https://www.postgresql.org/docs/current/transaction-iso.html . OpenAPI 3.1.1 schema: https://spec.openapis.org/oas/v3.1.1.html . Consulted 2026-10-19; the design choices above are project proposals, not claims that documentation prescribes this architecture.
