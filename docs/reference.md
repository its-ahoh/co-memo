# CLI reference

All data commands emit JSON except `context` (plain text), help/version, and the Claude/Codex lifecycle bridges (host-specific JSON or no output). Global options must precede the command:

```sh
co-memo --home /path/to/data --project /path/to/project COMMAND
```

`--home` overrides `CO_MEMO_HOME`, otherwise storage is under `$XDG_DATA_HOME/co-memo` or `~/.local/share/co-memo`. A fresh `shared-memory-v1.sqlite` is used. `--project` defaults to the working directory and resolves the nearest connected ancestor where applicable.

| Command                                              | Behavior                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `setup AGENT [--tools-only] [--opencode-api v1\|v2]` | Install tools, dialogue skill and optional lifecycle hooks                                                     |
| `doctor [AGENT] [--probe]`                           | Inspect local readiness; optional MCP handshake/settings read, no model calls                                  |
| `serve`                                              | Run project-bound MCP over stdio                                                                               |
| `settings get`                                       | Read settings overrides and effective values                                                                   |
| `settings set --scope user\|project ...`             | Set saveMode/defaultScope/paused, or --reset overrides                                                         |
| `connect AGENT [--opencode-api v1\|v2]`              | Register project/replica, configure host, publish memory                                                       |
| `add --content TEXT [--scope project\|user]`         | Save immediately; default scope follows settings                                                               |
| `list [--deleted] [--query TEXT] [--explain]`        | List this project's and user notes; optional hybrid search (up to 100 matches), with mode/fallback diagnostics |
| `show ID`                                            | Full note including current revision and deletion state                                                        |
| `edit ID --version N --content TEXT`                 | Compare-and-update; stale versions fail                                                                        |
| `forget ID --version N`                              | Tombstone a note and propagate deletion                                                                        |
| `history ID`                                         | Every stored version                                                                                           |
| `import PATH [--scope project\|user]`                | One-time file or nonrecursive directory import; originals untouched                                            |
| `sync`                                               | Reconcile every registered replica across local projects                                                       |
| `watch`                                              | Reconcile every two seconds; SIGINT/SIGTERM stops cleanly                                                      |
| `context [--query TEXT]`                             | Bounded user/project context; excludes conflicting notes                                                       |
| `conflicts`                                          | All unresolved conflicts with preserved proposals                                                              |
| `resolve ID --take current`                          | Keep central version                                                                                           |
| `resolve ID --take REPLICA_OR_CANDIDATE_ID`          | Choose a replica proposal or a submitted candidate                                                             |
| `resolve ID --content TEXT`                          | Supply an explicit merged resolution                                                                           |
| `repair AGENT`                                       | Recreate a missing projection; existing files are never replaced                                               |
| `status`                                             | Storage, project, replicas, pending writes, conflicts                                                          |
| `bridge --agent NAME --event EVENT`                  | Internal host adapter entry; not a transcript ingestion API                                                    |

`add`, `edit`, `forget`, `import`, `list`, and `context` reconcile as part of the command. `show`, `history`, `conflicts`, and `status` inspect saved state without importing edits. User notes can be added without a connected project; project notes require a connection.

Exit codes: `0` success, `1` invalid input/operation failure, `2` a completed sync reported conflicts or file errors. Successful central writes may coexist with a publication error; inspect the returned note and sync report rather than blindly retrying. Host bridges deliver available context with a warning instead of blocking the user's prompt.

`AGENT` is `pi`, `claude`, `codex`, or `opencode`. `--opencode-api` is accepted only by `connect opencode`; new connections default to V1, while reconnecting preserves the installed version unless explicitly changed. Restart OpenCode after switching APIs.

## Format

Projection files have a document ID, generation, stable memory IDs/revisions, and a new-memory section. They are dedicated managed files. Only memory-block content and the new-memory section are editable; unrelated prose outside those regions is not a memory and may be replaced.

- Edit content inside `co-memo:memory` / `co-memo:/memory`.
- Delete the entire block to forget that note within its scope (a user note is removed across projects).
- Add one note inside `co-memo:new` / `co-memo:/new`. It defaults to project scope. Use the CLI for user scope.
- Preserve IDs, revision numbers, the document header and footer.
- An empty memory block is invalid; remove the complete block to delete.

Each imported Markdown file becomes one note. Imports accept 1–100 files, each at most 32,000 characters of nonempty content and 1 MiB on disk. Directory import reads only immediate `.md` children. Linked Markdown files are refused. Imports are snapshots, not continuous synchronization of their original paths.

Memory scope is set at creation and is not automatically inferred or broadened. Conflicts can only be resolved explicitly. Project identity currently follows canonical paths rather than Git remote names; worktrees/clones are separate unless a future feature explicitly binds them.

## Dialogue and settings

See [tools and settings](tools-and-settings.md) for MCP schemas, host configuration and pause semantics. `add`, `edit`, and `forget` accept `--intent explicit|automatic` (default explicit); agents saving inferred notes must pass automatic. Omitted add/import scope follows effective defaultScope. Read-only CLI inspection remains available while paused. `serve` reserves stdout for MCP; tool failures return MCP error results, not CLI exit-code JSON.

## Candidate submissions

`submit --file /path/to/submission.json` accepts the same bounded, evidence-backed batch as `memory_submit`. See [retrieval and extraction](retrieval-and-extraction.md) for the JSON format. The file is read as UTF-8 with the 1 MiB limit and existing symlink protections. `requestId` is required for retry safety. Exit 2 also covers unresolved/stale/deleted-duplicate results; do not describe them as successful saves. A skipped candidate does not cause failure.

`checkpoint --reason task_completed --outcome saved --receipts JSON` verifies legacy write receipts. Reasons also include `user_correction` and `project_decision`; outcomes also include `nothing_to_save` and `skipped` (without receipts). `memory_submit` already includes current-store verification.

`index [--limit N]` explicitly builds optional embedding caches for eligible user/project memories. It requires provider configuration, sends note text to that provider, defaults to 100 notes, and reports remaining work. See [semantic retrieval](semantic-retrieval.md).

`init [--agents codex,claude] [--apply] [--hooks]` discovers agents and previews setup; noninteractive runs need `--apply` to write. `worktree inspect` shows Git identity; `worktree link --to ROOT` explicitly shares an already connected repository’s project memory. `verify --from codex --to claude [--round-trip] [--keep]` runs real models with temporary synthetic memory and consumes host quota. See [the setup/worktree/verification guide](onboarding-and-worktrees.md) for scope and schema compatibility.
