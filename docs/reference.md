# CLI reference

All data commands emit JSON except `context` (plain text), help/version, and the Claude/Codex lifecycle bridges (host-specific JSON or no output). Global options must precede the command:

```sh
co-memo --home /path/to/data --project /path/to/project COMMAND
```

`--home` overrides `CO_MEMO_HOME`, otherwise storage is under `$XDG_DATA_HOME/co-memo` or `~/.local/share/co-memo`. A fresh `shared-memory-v1.sqlite` is used. `--project` defaults to the working directory and resolves the nearest connected ancestor where applicable.

| Command                                                  | Behavior                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `setup AGENT [--tools-only] [--opencode-api v1\|v2]`     | Install tools, dialogue skill and optional lifecycle hooks                                                     |
| `doctor [AGENT] [--probe]`                               | Inspect local readiness; optional MCP handshake/settings read, no model calls                                  |
| `serve`                                                  | Run project-bound MCP over stdio                                                                               |
| `settings get`                                           | Read settings overrides and effective values                                                                   |
| `settings set --scope user\|project ...`                 | Set saveMode/defaultScope/paused, or --reset overrides                                                         |
| `connect AGENT [--opencode-api v1\|v2]`                  | Register project/agent connection and configure host                                                           |
| `add --content TEXT [--scope project\|user]`             | Save immediately; default scope follows settings                                                               |
| `list [--deleted] [--query TEXT] [--explain]`            | List this project's and user notes; optional hybrid search (up to 100 matches), with mode/fallback diagnostics |
| `show ID`                                                | Full note including current revision and deletion state                                                        |
| `edit ID --version N --content TEXT`                     | Compare-and-update; stale versions fail                                                                        |
| `forget ID --version N`                                  | Compatibility alias for archive                                                                                |
| `history ID`                                             | Every stored version                                                                                           |
| `import PATH [--scope project\|user]`                    | One-time file or nonrecursive directory import; originals untouched                                            |
| `sync`                                                   | Compatibility maintenance and conflict report                                                                  |
| `ui [--port NUMBER] [--no-open]`                         | Start the loopback memory console; open a browser by default; port 0 selects an available port                 |
| `locations ID`                                           | Inspect the central database location and scoped agent connections                                             |
| `watch`                                                  | Check maintenance/conflicts every two seconds; SIGINT/SIGTERM stops cleanly                                    |
| `context [--query TEXT]`                                 | Bounded user/project context; excludes conflicting notes                                                       |
| `conflicts`                                              | Personal and current-project conflicts with preserved proposals                                                |
| `resolve ID --revision N --take current`                 | Keep central version                                                                                           |
| `resolve ID --revision N --take REPLICA_OR_CANDIDATE_ID` | Choose a replica proposal or a submitted candidate                                                             |
| `resolve ID --revision N --content TEXT`                 | Supply an explicit merged resolution                                                                           |
| `status`                                                 | Storage, project, agent connections and conflicts                                                              |
| `bridge --agent NAME --event EVENT`                      | Internal host adapter entry; not a transcript ingestion API                                                    |

Memory commands use the database directly. User notes can be saved without project context; project notes require an identified workspace. CLI/MCP can identify the workspace without installing an agent integration.

Exit codes: `0` success, `1` invalid input/operation failure, `2` pending review, archived duplicates, unverified saves, conflicts or maintenance errors. Inspect the returned memory and report before retrying. Bridges deliver available context with warnings when needed.

`AGENT` is `pi`, `claude`, `codex`, or `opencode`. `--opencode-api` is accepted only by `connect opencode`; new connections default to V1, while reconnecting preserves the installed version unless explicitly changed. Restart OpenCode after switching APIs.

## Format

Memory is stored in SQLite. Use tools/CLI for writes; native instruction files only describe how to use Co-memo. Legacy projections are not synchronized.

Each imported Markdown file becomes one note. Imports accept 1–100 files, each at most 32,000 characters of nonempty content and 1 MiB on disk. Directory import reads only immediate `.md` children. Linked Markdown files are refused. Imports are snapshots, not continuous synchronization of their original paths.

Memory scope is set at creation and is not automatically inferred or broadened. Conflicts can only be resolved explicitly. Project identity currently follows canonical paths rather than Git remote names; worktrees/clones are separate unless a future feature explicitly binds them.

## Dialogue and settings

See [tools and settings](tools-and-settings.md) for MCP schemas, host configuration and pause semantics. `add`, `edit`, and `forget` accept `--intent explicit|automatic` (default explicit); agents saving inferred notes must pass automatic. Omitted add/import scope follows effective defaultScope. Read-only CLI inspection remains available while paused. `serve` reserves stdout for MCP; tool failures return MCP error results, not CLI exit-code JSON.

## Candidate submissions

Optional `prepare --file FILE` reads scoped related memories for `{intent, candidates}` without saving notes. `submit` returns `needs_review` (exit 2, no batch writes) for related additions; after inspecting meaning/evidence, send the returned review token and an explanation for distinct additions, or submit revised actions without the old review token.

`submit --file /path/to/submission.json` accepts the same bounded, evidence-backed batch as `memory_submit`. See [retrieval and extraction](retrieval-and-extraction.md) for the JSON format. The file is read as UTF-8 with the 1 MiB limit and existing symlink protections. `requestId` is required for retry safety. Exit 2 also covers unresolved/stale/deleted-duplicate results; do not describe them as successful saves. A skipped candidate does not cause failure.

`checkpoint --reason task_completed --outcome saved --receipts JSON` optionally rechecks earlier write receipts. Reasons also include `user_correction` and `project_decision`; outcomes also include `nothing_to_save` and `skipped` (without receipts). `memory_submit` already includes current-store verification.

`index [--limit N]` explicitly builds optional embedding caches for eligible user/project memories. It requires provider configuration, sends note text to that provider, defaults to 100 notes, and reports remaining work. See [semantic retrieval](semantic-retrieval.md).

`init [--agents codex,claude] [--apply] [--hooks]` discovers agents and previews setup; noninteractive runs need `--apply` to write. `worktree inspect` shows Git identity; `worktree link --to ROOT` explicitly shares an already connected repository’s project memory. `verify --from codex --to claude [--round-trip] [--keep]` runs real models with temporary synthetic memory and consumes host quota. See [the setup/worktree/verification guide](onboarding-and-worktrees.md) for scope and schema compatibility.

## Disconnect an agent

```sh
co-memo --project /path/to/project disconnect claude
co-memo --project /path/to/project disconnect claude --apply
```

Preview is read-only. Apply removes the selected agent's managed integration and agent connection, archives affected originals in the memory home, and retains central notes and other agents. Close the host first and restart it afterward. See [installation maintenance](releasing.md) for backup, pending-edit and partial-failure behavior.

## Backup and restore

```sh
co-memo backup /path/to/new-backup
co-memo backup-check /path/to/new-backup
co-memo restore /path/to/new-backup --to /path/to/new-home
co-memo restore /path/to/new-backup --to /path/to/new-home --apply
```

These operate on the whole central store, not just the current project. Restore requires a new home and detaches old agent connections. See [backup and restore](backup-and-restore.md) for snapshot scope, unsynchronized files, verification and switching agent bindings.

## Manage connected projects

```sh
co-memo projects
co-memo projects --check
co-memo projects --probe
```

Works outside a project and does not create or migrate a missing store. Lists registered roots and linked worktrees, per-root agents, existence and project-memory counts without printing memory text. `--check` performs read-only diagnostics per root; `--probe` additionally initializes the pinned MCP server after binding validation. Neither launches a host model nor proves its active session loaded memory. Any diagnostic failure returns exit code 2. Use the original project's `disconnect` command to remove an agent; project identities remain listed for access to retained history.

`archive ID --version N` retains content/history; `unarchive ID --version N` restores it. `delete ID --version N` permanently removes the note and history, retaining only a content-free anti-resurrection ID. Deletion does not ingest unrelated edits before removing the selected record; it checks the stored version and then cleans derived caches; legacy files remain untouched. `restore ARCHIVE --to DIRECTORY` continues to restore a database backup.

### Unified save review

`add` and `import` return `needs_review` with exit code 2 when related additions need judgment; nothing in the batch is saved. To confirm unchanged distinct facts, rerun with `--review-token TOKEN --review-reason TEXT`. Changed file contents or related records invalidate the old token. Imports remain atomic for up to 100 files. `memory_remember` accepts the same structured `review` as submit, and the console displays related records before allowing a separate save. Successful responses retain legacy memory/created fields and include verification.

`source` may be omitted/null on submit. When supplied, its agent and excerpt are required; unknown session/message IDs may be omitted/null. Ordinary saves need neither a preparation call nor a follow-up checkpoint. Manual housekeeping can use list/show/history, then version-checked edits/archives after comparing meaning. No scheduled scanning or automatic merging is enabled.

Conflict resolution requires the last-read conflict `revision`: `resolve ID --revision N --take current` (or candidate/merged content). `memory_resolve` requires the same `revision` field. Older clients must read the conflict and supply it; it is never filled in automatically. New conflict evidence increments this revision, while duplicate evidence leaves it unchanged. A stale choice is rejected without changing the note or closing the conflict.

Project commands and host bridges report personal/current-project conflicts only; resolving a foreign project conflict is rejected. Restore reports use the same scope. Global inventory and backup commands remain explicit whole-store operations. Paused projects suppress conflict details in these reports.
