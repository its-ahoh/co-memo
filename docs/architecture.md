# Architecture

Co-memo stores durable notes selected by users or agents in one local SQLite database. It does not mine transcripts or call an extraction model. All agents use MCP tools or CLI commands to read and write that database; there are no active Markdown replicas.

## Storage and concurrency

Memories have stable IDs, user/project scope, versions, content, metadata and history. Agent connections contain an ID, project ID, agent type and workspace root. Connections support multiple worktrees without owning private copies of notes.

Writes and host-configuration changes acquire the shared SQLite process lock. Reads use short, query-only WAL snapshots without that lock, including CLI/MCP retrieval, hook context and the console. Opening a current-schema database skips migration transactions. First-time project registration and schema upgrades still require a write lock. Reads no longer perform cache cleanup; writes and explicit sync/watch retain maintenance. Writes use transactions and expected versions; stale updates fail instead of silently overwriting another agent. Structured candidate submissions commit the batch and retry receipt together. Uncertain contradictions preserve competing proposals as conflicts. Conflicted notes are excluded from context until explicitly resolved. Settings enforce pause and explicit-only policy; intent and evidence are caller declarations.

Retrieval uses FTS5 with Chinese/code-identifier normalization, scope and conflict filters, bounded context and optional semantic ranking. Hooks deliver current database context; tools-only agents call memory_context or CLI context. Existing conversations are not retroactively rewritten.

## Upgrade from file replicas

Schema 7 copies existing replica registrations into the connections table using each legacy file's workspace root. Notes, history, conflicts, settings and worktree links remain intact. Legacy replica bookkeeping stays in the database for recovery and deletion of historical payloads. Legacy project files remain untouched, including unsaved edits, malformed files and missing files. No runtime operation ingests or publishes them. Review intended unsaved text and save it through tools/CLI; do not import whole marked documents.

Upgrade all clients together and rerun setup to replace old file-editing instructions. Older clients refuse schema 7. `sync` and `watch` are compatibility maintenance/reporting entry points; `repair` is removed. No memory watcher or per-agent file is required.

Schema 7 also adds nullable `writer_agent` generated columns to `notes` and `revisions`, exposing `payload.writerAgent` without duplicate storage. A Store receives an immutable configured writer from CLI `--agent-id` (propagated by MCP serve); the write path stamps each committed version and conflict candidate. Caller-declared evidence remains separate and cannot override this writer. Historical payloads are unchanged; unknown writers remain null. Exact duplicate reuse does not create a new revision or change attribution. Submission fingerprints include bound identity so another agent cannot replay the same request as its own write. This is configuration provenance, not authentication. UI edits are unbound, even if an agent launched the console.

## Archive and deletion

Archive retains the note and revisions; exact archived duplicates remain archived. Permanent deletion removes the note, revisions, search data, related conflict/resolution data, submission receipts and vector caches, and scrubs historical replica payloads in the database. A content-free ID remains. External legacy files, exports, backups and conversations are not modified by deletion; review/remove those copies separately.

## I/O boundaries

Zod validates input. Explicit imports accept bounded regular UTF-8 files and reject symlinks. Host configuration still uses checked atomic replacement. Config installation and database registration are not one filesystem transaction. The memory database uses transactions; it no longer depends on file publication or recovery journals.

## Modules

| Module              | Responsibility                                                 |
| ------------------- | -------------------------------------------------------------- |
| `src/store.ts`      | SQLite, connection migration, revisions, conflicts, lock       |
| `src/service.ts`    | Shared CLI/MCP operations and settings checks                  |
| `src/candidates.ts` | Evidence-backed batches, idempotency and verification          |
| `src/sync.ts`       | Compatibility maintenance and bounded context                  |
| `src/document.ts`   | Legacy stored-document decoding for historical payload cleanup |
| `src/locations.ts`  | Database location and scoped connections                       |
| `src/adapters.ts`   | Host instructions and lifecycle integration                    |
| `src/setup.ts`      | MCP settings, skill and adapter preparation                    |

Earlier shared-memory-v1.sqlite schemas upgrade transactionally. The old Rust database is not migrated.

## Busy handling

Acquiring the process lock or a write transaction retries only SQLite BUSY errors, with short SQLite waits and capped exponential backoff plus jitter, for at most about five seconds per acquisition. Transaction callbacks execute once after acquisition. Version conflicts, validation errors, transaction bodies and commits are never replayed automatically. A transaction rolls back on failure. A read snapshot rejects accidental database writes and releases its transaction even when the callback throws. Provider requests run outside snapshots and their results are checked against a fresh snapshot before delivery.
