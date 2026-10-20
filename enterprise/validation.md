# M1 validation record

Executed locally on 2026-10-19 (America/Toronto), macOS arm64, Node 26.8.1, pnpm 11.21.0, real PostgreSQL 18.4 from locked embedded-postgres development binaries. PostgreSQL ran in a temporary loopback-only cluster with generated credentials. Docker was unavailable; no mocked SQL/database was used.

## Passed

- `cd enterprise && pnpm check`: strict TypeScript compilation; **19/19 Node test results** (18 scenario groups plus their parent test), no skipped tests.
- `cd enterprise && pnpm demo`: create/read/update; stale revision 412; exact original receipt replay; cross-workspace 404; content-free events acknowledged with inbox markers.
- Root `pnpm check`: formatting, type checking, build and **151/151 existing tests**.
- Root `pnpm test:package`: actual 0.8.2 package installation, CLI/MCP, relocation, disconnect, backup/restore and project isolation passed; actual host-model use is not claimed.

Enterprise tests use actual HTTP requests and validate success/error JSON, content types, cache headers and ETags against the OpenAPI schemas. Coverage includes same-key concurrent requests (one object/history/audit/event), mismatched method/path/body/If-Match, simultaneous CAS winners, bigint values above JS safe integer precision, signed pagination, two tenants and same-tenant sibling workspace isolation, spoofed identity, missing RLS session settings, FORCE RLS/non-owner grants, a single physical connection alternating tenants and rolling back, credential expiry/revocation, scope/role/membership/clearance/policy denials, shared-lock revocation serialization, actual provisioning/revocation CLI execution, transactional failure injection and serialization retry, worker lease takeover/stale ack, duplicate inbox, concurrent claims, failed ack rollback, retry exhaustion and pause, migration rerun/drift/newer-version rejection.

## Not claimed / remaining gates

- This is local macOS/Node 26 evidence. The added CI matrix covers macOS/Linux with Node 24/26, but remote CI results must be checked on the PR; this record does not predeclare them successful.
- No PostgreSQL version matrix, upgrade/restore drill, production load/security audit, tenant scheduler, external side-effect exactly-once guarantee or production deployment was performed.
- M2–M5 are backlog only. No live-memory migration, host configuration change, package publication or merge was performed.
- The independent checkout's branch starts at design commit `14b9f55`; draft implementation PR targets `docs/enterprise-platform-design` until PR #20 merges, then needs retargeting to `main`.

Implementation self-review fixed raw prototype-key validation before Zod normalization, timestamp microsecond preservation in cursors, post-lock lease expiry checks, inert-column grants for authorization locks, credential identity recheck after lookup, paused worker policy, and normalized-jsonb versus wire metadata size limits. This is not an independent security review.
