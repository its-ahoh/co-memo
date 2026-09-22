# Dialogue tools and settings

## Install and set up

From a Co-memo checkout, with Node.js 24.12+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm pack
npm install -g ./co-memo-0.4.0.tgz
```

The package is not published to npm. Do not use `npx co-memo` or assume the registry package belongs to this project.

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

## Settings

```sh
co-memo settings get
co-memo settings set --scope user --save-mode explicit
co-memo settings set --scope project --default-scope user
co-memo settings set --scope project --paused true
co-memo settings set --scope project --paused false
co-memo settings set --scope project --reset
```

Settings are stored in SQLite, separate from memory text. Responses show user overrides, project overrides and effective values. Project settings require a registered project; user settings can be changed before setup.

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

| Tool                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `memory_context`      | Bounded shared context and effective settings            |
| `memory_recall`       | Literal search/list; conflicts marked explicitly         |
| `memory_get`          | Full note, current version and optional revision history |
| `memory_remember`     | Save with scope and declared intent                      |
| `memory_update`       | Compare-and-update using the last-read version           |
| `memory_forget`       | Version-checked deletion with tombstone                  |
| `memory_conflicts`    | User/current-project conflicts                           |
| `memory_resolve`      | User-directed choice or merged content                   |
| `memory_settings_get` | Overrides and effective settings                         |
| `memory_settings_set` | Apply a minimal settings patch or reset one scope        |

Writes go directly to the central store and then reconcile projections. A committed write can still return file-publication errors; inspect the returned memory and sync report before retrying. MCP results filter conflicts/errors to the configured project and user scope. The local store remains a single-user system, not a multi-user security boundary.

## Upgrade and verification

0.4 upgrades the existing database schema to version 2 to add settings; memory/history remain intact and the filename remains `shared-memory-v1.sqlite`. Older 0.3 clients refuse this schema; upgrade all connected CLI paths and rerun setup. The old Rust database still is not migrated.

Tests use a real SDK client and stdio server subprocess, execute generated launch commands, and cover configuration preservation, intent enforcement, pause/resume, scope isolation and existing sync behavior. Host UI loading/trust and the model's actual tool choice still require live verification.

Sources: [MCP tools](https://modelcontextprotocol.io/specification/draft/server/index), [Codex MCP](https://developers.openai.com/codex/mcp), [Claude MCP](https://code.claude.com/docs/en/mcp), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [OpenCode V2 MCP](https://opencode.ai/v2/docs/mcp-servers).
