# Architecture

Co-memo synchronizes durable notes that users or their coding agents have already written. It does not mine transcripts or call models. The SQLite store is authoritative; per-agent Markdown documents are editable projections.

## Domain

- **Memory:** ID, content, user/project scope, project ID, revision, origin, timestamps, deletion flag, type, optional evidence/module/pinning and prior-version linkage.
- **Project:** canonical directory identity. Agent type is not part of memory ownership or deduplication.
- **Replica:** agent, project, Markdown path, acknowledged snapshot, optional pending publication.
- **Conflict:** central version/content and every competing proposal, including deletion proposals. Resolutions are retained separately.

There is no private candidate queue, per-agent access grant, stage, or purpose hierarchy. A project note is readable by every connected agent in that project. A user note is available in all connected projects. Exact content deduplication is scoped to user or project and preserves case and internal whitespace.

## Reconciliation

All CLI operations acquire a separate SQLite transaction lock (`sync-lock.sqlite`). This serializes Co-memo processes through both database commits and filesystem publications, without holding a memory-database transaction across a file replacement. OS lock release handles process death.

1. Recover pending publications. A generation marker distinguishes the old file, the new file, and external edits to either generation.
2. Read every healthy replica and compare it with its acknowledged snapshot, not merely the current central memory.
3. Collect every proposal before applying any. Same-base identical changes merge. Divergent changes or stale edits become conflicts. Unchanged stale replicas simply receive the central version.
4. In one memory transaction, apply uncontested changes, record conflicts, ingest new notes, acknowledge observed snapshots, and persist publication plans.
5. Replace each healthy file using a temporary file, `fsync`, a content-hash check and rename. Acknowledge the published snapshot in SQLite afterward.

If a crash occurs between steps 4 and 5, the publication plan survives. If it occurs after rename but before acknowledgement, the generation marker identifies the published baseline—even when an agent has subsequently edited it. A later sync reconciles those edits rather than overwriting them.

A pending conflict freezes projections that include that memory. Later edits remain on disk and are reconciled after explicit resolution; they may produce another conflict. Conflicting notes are excluded from injected context. Unaffected notes remain available in context.

## Deletion

Removing a complete memory block archives it and creates a revision. Its stable ID remains in central storage. Stale unchanged copies cannot restore it. A stale edited copy creates a deletion/edit conflict; only explicit resolution can restore that ID. Exact duplicate additions also match archived notes and do not resurrect them.

Missing files, truncated documents, duplicate IDs, unknown generations, and edited version markers produce errors rather than mass deletion. `repair` recreates only an absent replica. The user can restore a malformed file manually using its central notes and version history.

## I/O boundaries

Input data is validated with Zod. Agent projections and source imports must be regular UTF-8 files; symlinked files and parent directories are refused. File size and context size are bounded. Filesystem replacement uses optimistic checks: an external process writing in the final check-to-rename interval can still race with publication. Co-memo's own processes are serialized; filesystem editors are not. This is not a distributed filesystem transaction.

The first release uses bounded two-second reconciliation in `watch`, plus host lifecycle invocations. It does not need an always-on daemon, model service, or native filesystem-watching dependency.

## Modules

| Module            | Responsibility                                         |
| ----------------- | ------------------------------------------------------ |
| `src/model.ts`    | Domain schemas and types                               |
| `src/store.ts`    | SQLite, revisions, tombstones, conflicts, process lock |
| `src/document.ts` | Editable Markdown format and parser                    |
| `src/fs.ts`       | Bounded reads and checked atomic replacement           |
| `src/sync.ts`     | Reconciliation, recovery, context projection           |
| `src/adapters.ts` | Agent configuration, Pi extension, Claude/Codex hooks  |
| `src/opencode.ts` | Self-contained OpenCode V1/V2 plugin generators        |
| `src/cli.ts`      | User commands and lifecycle bridge                     |

The database filename is deliberately new. The old Rust database is not migrated. Earlier shared-memory-v1.sqlite schemas are upgraded transactionally.

## Tools and settings

`src/service.ts` shares memory mutations between CLI and MCP. `src/mcp.ts` exposes a project-bound stdio server using the official SDK; each operation opens the store, acquires the process lock and reads fresh settings. Reports exclude unrelated project conflicts and paths.

`src/settings.ts` defines user/project overrides and effective policy. Schema version 2 added settings; version 3 adds the FTS5 index and submission retry records without moving the database. Global explicit-only/pause restrictions combine with project restrictions; defaultScope uses the most specific value. The sync engine skips paused replicas and refuses edited Markdown in explicit-only mode before collecting proposals, preserving the original file/baseline. Store writes also check intent; user intent itself is caller-declared, not independently authenticated.

`src/setup.ts` prepares MCP configuration and the packaged dialogue skill together with adapters before any setup writes. JSONC edits retain comments; a marked TOML table can be replaced without reformatting other tables. Tools-only setup removes managed command hooks or neutralizes generated native plugins. The sync engine remains available for manual file workflows.

## Retrieval and candidate writes

`src/relevance.ts` normalizes Chinese words and technical identifiers for both indexing and queries. `Store.search` applies scope/deletion/conflict filters and BM25 ranking through SQLite FTS5. Every central write updates the full-text index inside its caller's transaction. Migration rebuilds the index from current notes without rewriting revision payloads. CLI list, MCP recall and context share this path. Context separately reserves a bounded slice for pinned preferences.

`src/candidates.ts` accepts structured candidates from the current agent, not raw transcripts. It reconciles first, then applies the complete candidate batch and its idempotency record in one transaction. Updates require the expected version; unclear contradictions use the existing conflict lifecycle with a separately identified candidate and evidence. Post-commit synchronization publishes projections; verification reports central state separately from publication. Replaying a request rechecks current receipts without reapplying old writes. Evidence, intent and correction basis are caller declarations, not authenticated transcripts or model-quality scores. No embeddings, external inference or background extraction are invoked.

Schema 5 adds a content-free `purged` ID table. Permanent deletion removes the note, revisions, FTS entry, associated conflicts/resolutions and cached submission results, and scrubs replica baselines/pending publications. Sync removes marked blocks for purged IDs before ingestion, including paused or conflict-frozen replicas, without overwriting unrelated edits. Unsafe/missing files are reported; future sync retries cleanup. Existing backups and conversations are outside this deletion operation.
