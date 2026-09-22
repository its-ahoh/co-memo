# Retrieval and extraction

Co-memo 0.5 implements local full-text retrieval and an evidence-backed candidate submission path. The current coding agent performs extraction. Co-memo does not call an extraction model or inspect transcripts in the background. Semantic embeddings and background capture remain future, optional extensions.

## Retrieval

`memory_context({"query":"数据库迁移 SQLite"})`, `memory_recall({"query":"数据库迁移 SQLite"})`, and `co-memo list --query '数据库迁移 SQLite'` share SQLite FTS5/BM25 ranking. Index and query use the same NFKC normalization, Chinese word segmentation, case normalization and splitting of identifier/path separators and camelCase boundaries. Query syntax is treated as ordinary text, not executable FTS syntax. Up to 64 distinct terms from the first 16,000 query characters form an OR search, returning at most 100 matches. This is lexical search; it cannot reliably match synonyms or translate languages.

Project and user scope, deletion and unresolved-conflict filters apply before the result limit. Ordinary recall excludes conflicts; inspect `memory_conflicts` or `conflicts` explicitly. `list --deleted` can inspect tombstones. Without a query, notes are ordered by most recent update. Module labels participate in full-text search; they are not authorization boundaries.

Only preferences explicitly marked `pinned` bypass task matching, under a 2,000-character allocation. The full context, including instructions, is bounded to 16,000 characters. Large notes can be omitted rather than truncated. Old notes default to kind `note`, no evidence/module, and unpinned. Existing user notes are no longer automatically included when unrelated to a task.

## Candidate submission

An agent should extract durable facts rather than summarize the entire conversation. It first searches related notes, then submits a bounded batch through `memory_submit`, or writes this JSON to a file and runs `co-memo submit --file /absolute/path/submission.json`:

```json
{
  "requestId": "c5c21868-211d-48ed-aebb-5556561e9ac9",
  "intent": "explicit",
  "candidates": [
    {
      "action": "add",
      "scope": "project",
      "content": "Use pnpm for project dependencies.",
      "kind": "decision",
      "source": {
        "agent": "codex",
        "sessionId": "actual-session-id",
        "messageId": "actual-message-id",
        "excerpt": "Remember: use pnpm for this project."
      },
      "module": null,
      "pinned": false
    }
  ]
}
```

Replace identifiers and evidence with real values; generate a fresh UUID per logical submission. If the host does not expose reliable identifiers, use legacy remember/update tools with unknown provenance. Never fabricate evidence. Source snippets are retained in the local database and revision history, but are not copied into Markdown projections or ordinary injected context. They must not contain secrets. Evidence is supplied by the agent; Co-memo cannot independently authenticate it or determine whether a proposed fact is true.

Actions:

- `add`: new fact, optional scope follows effective defaultScope. Exact duplicates return their existing ID and metadata, including tombstones. Deleted duplicates are not revived or reported as successful new saves.
- `update`: same fact with new content/evidence; requires `id`, expected `version` and `basis` (`user_correction` or `verified_change`). Records the previous ID/version in `metadata.supersedes`. Supply module/pinned explicitly to preserve them; otherwise they reset to null/false. No semantic match or contradiction is inferred by the server.
- `conflict`: uncertain contradiction; requires the old ID/version and proposed content/evidence. Keeps the old central version, stores the candidate with its own ID, and excludes that memory from recall until explicitly resolved. Resolve using that candidate ID, `current`, or a user-directed merge.
- `skip`: unsupported or temporary information, with a reason; no memory is written.

Types are `note`, `preference`, `decision`, `constraint`, and `lesson`. Only preferences can be pinned. Scope cannot be broadened by update. There is no candidate delete action: use the existing explicit forgetting workflow.

## Reliability and limitations

A submission accepts 1–20 candidates. Its mutations, revisions, full-text index updates and retry record commit atomically; any invalid/stale/inaccessible target rolls back the whole batch. The normal reconciliation before submission is a separate transaction and can import existing legitimate projection edits. Publication after committing can fail independently: central verification and sync errors are returned separately.

Retrying identical normalized input with the same requestId in the same project never reapplies writes. Reusing that ID for different input fails. Replays recheck receipts against current versions, deletion state and conflicts; an earlier success can now report stale. This is not semantic deduplication across differently worded requests. Skips and conflict candidates are not reported as verified saves. Agents must inspect per-candidate status rather than treating a non-error MCP response as proof of success.

The source, memory type, intent and update basis are agent declarations. The program enforces pause/explicit-only policy, expected versions, scopes and exact-content deduplication. It does not judge evidence quality. Markdown or legacy content changes clear obsolete evidence on the new revision; older evidence remains in history. Explicit conflict resolution records a new revision. A save receipt verifies central storage at that instant, not delivery into another agent's active context.

## Upgrade

Schema 3 adds FTS5 and submission records transactionally, indexes existing current notes and retains history without rewriting it. The filename remains `shared-memory-v1.sqlite`. Upgrade all connected CLI installations and rerun `setup AGENT`; older clients reject this schema. No new external database, model credential or service is required.
