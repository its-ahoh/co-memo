# Dialogue tools and settings

## Install and set up

With Node.js 24.12+:

```sh
npm install -g @ahoh.tech/co-memo
```

No source checkout or pnpm is required. Prefer a persistent installation over `npx`: generated agent configuration pins the installed CLI path.

In your working project, run setup for each agent you use:

```sh
co-memo setup codex
co-memo setup claude
co-memo setup opencode --opencode-api v2
co-memo setup pi
```

Setup adds the existing memory connection, a dialogue skill, MCP configuration where supported, and lifecycle hooks. It preserves unrelated configuration. Pi uses the CLI and its native extension rather than a native MCP server registration.

To use tools without lifecycle hooks:

```sh
co-memo setup codex --tools-only
```

This also disables previously generated Co-memo hooks for that agent, while preserving other hooks. Generated Pi/OpenCode plugin files become inert when disabling an existing plugin. The model must call `memory_context` (or CLI `context`) at the start of work; MCP does not guarantee that a model will do so. Background `watch` is a separate process and is not stopped by this option.

| Agent       | MCP configuration                                                                              | Dialogue skill                      |
| ----------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| Codex       | `.codex/config.toml`, managed `mcp_servers.co-memo` section                                    | `.agents/skills/co-memo/SKILL.md`   |
| Claude Code | `.mcp.json`, `mcpServers.co-memo`                                                              | `.claude/skills/co-memo/SKILL.md`   |
| OpenCode    | Existing `opencode.jsonc` or `opencode.json`, `mcp.co-memo` (V1) or `mcp.servers.co-memo` (V2) | `.opencode/skills/co-memo/SKILL.md` |
| Pi          | CLI fallback                                                                                   | `.pi/skills/co-memo/SKILL.md`       |

Commands pin Node, the installed CLI, project and data directory. They do not modify global host configuration or approve host trust prompts. Restart/reload the host and review its trust prompts; for Codex also inspect `/hooks` when using hooks. Re-run setup after moving the installation. Both OpenCode config filenames existing simultaneously are treated as ambiguous. Malformed config and unmanaged entries named `co-memo` are refused before setup writes. TOML and JSONC comments are preserved. OpenCode V2 uses a different MCP configuration shape; setup can move its own entry between V1/V2 but refuses to migrate unrelated servers automatically.

`connect` remains the lower-level hooks-only setup. Calling it after `setup --tools-only` re-enables lifecycle hooks. It does not remove MCP configuration or the skill.

The packaged [dialogue skill](../skills/co-memo/SKILL.md) can guide an agent through installation when you provide this checkout or skill file. A first-time agent cannot discover a skill that has not yet been installed or supplied.

## Speak to your agent

After setup and host reload, requests can include:

- “Use Co-memo to remember that this project uses pnpm.”
- “Remember my personal preference: answer in Chinese across projects.”
- “Show my saved preferences and forget the old package-manager choice.”
- “Only save memory when I explicitly ask.”
- “Pause shared memory in this project.”

The agent uses memory tools, or the pinned CLI for Pi/fallback. It should report actual tool results, not just acknowledge that it will remember.

## Personal versus project memory

The agent chooses scope from content: `user` for personal preferences and habits that apply across projects; `project` for a workspace's facts, tooling conventions, architecture and decisions. Being inside a repository does not turn a personal preference into a project note. Missing project context does not turn a project note into a personal preference. Agents should pass the chosen scope explicitly; omitted scope still uses `defaultScope` for compatibility.

Memory operations automatically identify a project from the current working directory using registered workspace roots, Git roots/worktrees or common manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, Gradle build files). Git boundaries take priority over package manifests inside a repository. No manual `connect` or `setup` is required to create the internal project identity. Detection does not install hooks or create Markdown replicas; setup still handles host integration.

For non-Git workspaces without a manifest, the agent supplies its known workspace path through CLI `--project PATH` or the optional `projectPath` argument on memory tools. A shared MCP server can use a different `projectPath` per call; it does not retain the previous call's path. Otherwise it detects from its launch directory (or the explicit launch `--project`). The agent must supply the active workspace when that differs from the launch context. Unlinked Git worktrees remain independent.

Reads combine user notes and current-project notes. Without a detected workspace, personal reads and explicit `scope=user` writes work normally; project writes fail with a missing-context message instead of silently changing scope. User and project pause/intent restrictions continue to apply.

## Settings

```sh
co-memo settings get
co-memo settings set --scope user --save-mode explicit
co-memo settings set --scope project --default-scope user
co-memo settings set --scope project --paused true
co-memo settings set --scope project --paused false
co-memo settings set --scope project --reset
```

Settings are stored in SQLite, separate from memory text. Responses show user overrides, project overrides and effective values. Project settings use the automatically detected workspace; user settings can be changed without a project.

| Setting        | Default   | Behavior                                                                                                                                                 |
| -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveMode`     | `auto`    | Automatic and explicit tool writes are allowed. In `explicit`, automatic writes and edited Markdown ingestion are rejected.                              |
| `defaultScope` | `project` | Used by new CLI/tool notes and CLI imports when scope is omitted. It never changes the scope of existing notes. Markdown additions retain project scope. |
| `paused`       | `false`   | Stops synchronization of this project's replicas, memory tool reads/writes and injected notes. Settings tools remain available to resume.                |

Project defaultScope overrides user defaultScope. A user-level pause or explicit-only restriction cannot be weakened by a project override. Reset removes overrides at that scope, revealing inherited/default values.

`auto` does not start an extraction model or mine transcripts: the agent still decides what merits saving. Defaults retain 0.3's Markdown capture behavior. For manual capture only, set user saveMode to explicit.

Tool mutations require `intent=explicit|automatic`. CLI `add`, `edit`, and `forget` default to explicit because they are direct commands; an agent saving inferred information must pass `--intent automatic`. Explicit-only mode checks this declaration. Co-memo cannot independently prove that the user asked: it has no conversation transcript. Settings/resolve tools similarly require `userRequested=true`. These are behavior controls for cooperating agents, not an authorization boundary against an agent with local filesystem access.

Rejected Markdown edits are retained, not imported or overwritten. To accept one, save it explicitly through tools/CLI and restore the local projection to its previous unmodified text before syncing; alternatively re-enable automatic capture to ingest it. Inspect the sync report for files needing attention. Avoid editing managed files in explicit-only mode.

Pause does not erase local files or text already present in a conversation. CLI inspection commands (`list`, `show`, `history`, `conflicts`) remain available for the user to inspect stored state. Resuming may ingest pending file edits. Start a new conversation if you need a context without previously loaded notes.

## MCP tools

The local stdio server is started with:

```sh
co-memo --home /path/to/data --project /path/to/project serve
```

It registers the project if necessary and also works without Markdown replicas or hooks. It exposes no HTTP listener, API key requirement, arbitrary shell tool or caller-selectable project path. Each operation reads current settings and acquires the shared store lock; multiple hosts use the same database.

| Tool                  | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `memory_context`      | Bounded shared context and effective settings                       |
| `memory_recall`       | FTS5/BM25 with optional cached semantic ranking; conflicts excluded |
| `memory_submit`       | Atomic evidence-backed candidates with verified receipts            |
| `memory_checkpoint`   | Verify legacy write receipts against current storage                |
| `memory_get`          | Full note, current version and optional revision history            |
| `memory_remember`     | Save with scope and declared intent                                 |
| `memory_update`       | Compare-and-update using the last-read version                      |
| `memory_forget`       | Version-checked deletion with tombstone                             |
| `memory_conflicts`    | User/current-project conflicts                                      |
| `memory_resolve`      | User-directed choice or merged content                              |
| `memory_settings_get` | Overrides and effective settings                                    |
| `memory_settings_set` | Apply a minimal settings patch or reset one scope                   |

Writes go directly to the central store and then reconcile projections. A committed write can still return file-publication errors; inspect the returned memory and sync report before retrying. MCP results filter conflicts/errors to the configured project and user scope. The local store remains a single-user system, not a multi-user security boundary.

## Upgrade and verification

0.5 upgrades the existing database schema to version 3 to add full-text search and candidate submissions; memory/history remain intact and the filename remains `shared-memory-v1.sqlite`. Older clients refuse this schema; upgrade all connected CLI paths and rerun setup. The old Rust database still is not migrated.

Tests use a real SDK client and stdio server subprocess, execute generated launch commands, and cover configuration preservation, intent enforcement, pause/resume, scope isolation and existing sync behavior. Host UI loading/trust and the model's actual tool choice still require live verification.

Sources: [MCP tools](https://modelcontextprotocol.io/specification/draft/server/index), [Codex MCP](https://developers.openai.com/codex/mcp), [Claude MCP](https://code.claude.com/docs/en/mcp), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [OpenCode V2 MCP](https://opencode.ai/v2/docs/mcp-servers).

## Task selection and save checkpoints

`memory_context({query: "SQLite migrations"})` or `co-memo context --query "SQLite migrations"` ranks matching notes locally. Default ranking uses SQLite FTS5/BM25 with shared Chinese word and code-identifier tokenization. [Optional semantic retrieval](semantic-retrieval.md) merges cached embedding matches through rank fusion; MCP responses include retrieval mode and fallback reason. Native hooks remain lexical. Only deliberately pinned preferences are eligible for a small always-included budget, even without matching words. Other notes, including user preferences, must match the query. Query searches consider at most 100 matches. Without a query, recent notes are preferred. Conflicted and deleted notes are excluded. The complete context, including guidance, fits the 16,000-character budget. Full notes remain available through recall/get and list/show.

Generated Claude/Codex prompt hooks consume the host's `prompt` field from JSON stdin; Pi uses `before_agent_start.prompt`. OpenCode's generated context hooks currently have no task query: use `memory_context` with `query` for task-specific selection. Prompts used for ranking are not persisted. Re-run `setup AGENT` after upgrading to refresh hooks, instructions and the skill.

Before final replies and after durable corrections or decisions, the injected guidance asks the current agent to consider a memory update and verify its receipts. `memory_checkpoint` takes `reason` (`task_completed`, `user_correction`, `project_decision`), `outcome` (`saved`, `nothing_to_save`, `skipped`) and, for `saved`, `receipts` containing the exact `id`, `version`, and `deleted` returned by writes. CLI: `checkpoint --reason task_completed --outcome saved --receipts '[{"id":"UUID","version":1,"deleted":false}]'`.

Checkpoints reconcile first, reject inaccessible, conflicted or stale receipts, and verify central storage only. Sync failures remain visible in the response. They cannot prove delivery into another agent's active context. Non-save outcomes are declarations; paused checkpoints return `verified: false`. Checkpoints do not mine transcripts, create memories, audit the agent's judgment or force another turn. A host or model can ignore a reminder.

See [retrieval and extraction](retrieval-and-extraction.md) for `memory_submit`, provenance, conflict candidates and idempotent retries. Prefer this interface for agent-selected memories; it verifies writes without a second checkpoint call.
