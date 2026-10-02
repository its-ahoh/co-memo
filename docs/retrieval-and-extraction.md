# Retrieval and extraction

Co-memo 0.5 implements local full-text retrieval and an evidence-backed candidate submission path. The current coding agent performs extraction. Co-memo does not call an extraction model or inspect transcripts in the background. Semantic embeddings and background capture remain future, optional extensions.

## Retrieval

`memory_context({"query":"数据库迁移 SQLite"})`, `memory_recall({"query":"数据库迁移 SQLite"})`, and `co-memo list --query '数据库迁移 SQLite'` share SQLite FTS5/BM25 ranking. Index and query use the same NFKC normalization, Chinese word segmentation, case normalization and splitting of identifier/path separators and camelCase boundaries. Query syntax is treated as ordinary text, not executable FTS syntax. Up to 64 distinct terms from the first 16,000 query characters form an OR search, returning at most 100 matches. This is lexical search; it cannot reliably match synonyms or translate languages.

Project and user scope, deletion and unresolved-conflict filters apply before the result limit. Ordinary recall excludes conflicts; inspect `memory_conflicts` or `conflicts` explicitly. `list --deleted` can inspect tombstones. Without a query, notes are ordered by most recent update. Module labels participate in full-text search; they are not authorization boundaries.

Only preferences explicitly marked `pinned` bypass task matching, under a 2,000-character allocation. The full context, including instructions, is bounded to 16,000 characters. Large notes can be omitted rather than truncated. Old notes default to kind `note`, no evidence/module, and unpinned. Existing user notes are no longer automatically included when unrelated to a task.

## Candidate submission

An agent should extract durable facts rather than summarize the entire conversation. It submits a bounded batch directly; saving searches for related notes and returns a review only when needed. Use `memory_submit`, or writes this JSON to a file and runs `co-memo submit --file /absolute/path/submission.json`:

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

Replace identifiers and evidence with real values; generate a fresh UUID per logical submission. Source is optional/null; unknown session/message identifiers may be omitted or null. Never fabricate evidence. Source snippets are retained in the local database and revision history, but are not copied into ordinary injected context. They must not contain secrets. Evidence is supplied by the agent; Co-memo cannot independently authenticate it or determine whether a proposed fact is true.

Actions:

- `add`: new fact, optional scope follows effective defaultScope. Exact duplicates return their existing ID and metadata, including tombstones. Deleted duplicates are not revived or reported as successful new saves.
- `update`: same fact with new content/evidence; requires `id`, expected `version` and `basis` (`user_correction` or `verified_change`). Records the previous ID/version in `metadata.supersedes`. Supply module/pinned explicitly to preserve them; otherwise they reset to null/false. No semantic match or contradiction is inferred by the server.
- `conflict`: uncertain contradiction; requires the old ID/version and proposed content/evidence. Keeps the old central version, stores the candidate with its own ID, and excludes that memory from recall until explicitly resolved. Resolve using that candidate ID, `current`, or a user-directed merge.
- `skip`: unsupported or temporary information, with a reason; no memory is written.

Types are `note`, `preference`, `decision`, `constraint`, and `lesson`. Only preferences can be pinned. Scope cannot be broadened by update. There is no candidate delete action: use the existing explicit forgetting workflow.

## Reliability and limitations

A submission accepts 1–20 candidates. Its mutations, revisions, full-text index updates and retry record commit atomically; any invalid/stale/inaccessible target rolls back the whole batch. Writes commit directly to SQLite. There is no projection ingestion or publication. Verification confirms central state; maintenance errors are reported separately.

Retrying identical normalized input with the same requestId in the same project never reapplies writes. Reusing that ID for different input fails. Replays recheck receipts against current versions, deletion state and conflicts; an earlier success can now report stale. This is not semantic deduplication across differently worded requests. Skips and conflict candidates are not reported as verified saves. Agents must inspect per-candidate status rather than treating a non-error MCP response as proof of success.

The source, memory type, intent and update basis are agent declarations. The program enforces pause/explicit-only policy, expected versions, scopes and exact-content deduplication. It does not judge evidence quality. Legacy content edits clear obsolete evidence on the new revision; older evidence remains in history. Explicit conflict resolution records a new revision. A save receipt verifies central storage at that instant, not delivery into another agent's active context.

## Upgrade

Schema 3 adds FTS5 and submission records transactionally, indexes existing current notes and retains history without rewriting it. The filename remains `shared-memory-v1.sqlite`. Upgrade all connected CLI installations and rerun `setup AGENT`; older clients reject this schema. No new external database, model credential or service is required.

Schema 6 uses agent connections with no active Markdown replicas. Legacy notes, history, conflicts and registrations are preserved during upgrade; old files remain untouched. Upgrade all clients together and rerun setup.

## Review before saving

Submit directly, or optionally preview with `memory_prepare` / `co-memo prepare --file FILE` and `{ "intent": "automatic", "candidates": [...] }` (the same candidate schema as submit, without requestId/review). This reads scoped lexical matches, including archived and conflicted notes, and returns their versions, metadata and a review token. At most ten ranked matches plus exact matches/targets are returned per candidate. Other projects and other scopes are excluded; different-scope relationships still require agent judgment.

`submit` runs this check under the same process lock as the commit. Related additions or related additions within a batch return `status: needs_review` with no memory/retry-record writes. CLI exits 2. Exact duplicates still reuse existing records; archived exact duplicates remain archived. To confirm that unchanged candidates are distinct, add `review: { "token": "TOKEN_FROM_PREPARE", "reason": "Explanation of why these are distinct facts" }` to the submission. A token is a freshness check, not authentication or proof of semantic correctness. Relevant changes invalidate it. Changed actions/content require a new preparation; successful retries retain the entire original payload.

Choose skip for equivalent facts, update with the existing ID/version and correction basis for clear changes, and conflict for uncertain contradictions. Repeated conflict submissions preserve additional source evidence on the same conflict, up to 100 candidates; they do not silently pick the latest version. Exact content plus identical metadata is deduplicated within a conflict. Explicit resolution selects an existing candidate/current content or a supplied merge and retains revision history.

The review uses local lexical retrieval, not embeddings or a model; paraphrases without shared terms can be missed and similar wording can mean opposite things. No automatic semantic merging is performed. The same pipeline covers submit, add/remember, Markdown import and console creation. Prepare is optional; successful saves include verification. No save/checkpoint call is needed when there is nothing durable to save.

### Batch and concurrent review

Updates and conflict proposals are considered alongside new candidates. A stored exact match that this batch changes is not an automatic exemption from review. After review, updates/conflicts execute before additions in one transaction; receipts remain in the original candidate order. An addition matching an updated note reuses that note.

Only ten ranked matches are displayed, but the review token covers the entire reviewed scope, including archived records and conflict revisions. Any change in that scope invalidates an old token, even a lower-ranked or unrelated note. This conservative check avoids accepting a decision based on stale state.

Conflicts have a separate `revision`, starting at 1 for existing legacy records. Adding new evidence increments it; identical proposals do not. Read conflicts before resolving, then pass `revision` to `memory_resolve`, or `--revision N` to CLI `resolve`. The note's `currentVersion` is not the conflict revision. Missing/stale revisions are rejected; reread and reconsider new evidence instead of automatically retrying the old choice.

Edits and additions use the same trimmed content for storage, fingerprints and receipts. Existing notes written with older untrimmed fingerprints are reused without rewriting history; redundant legacy records can still be archived. Conflict retries report `verification: stale` when new evidence was appended, or `status: conflict_closed` / `verification: closed` when no longer open; neither is a verified save or a new conflict.
