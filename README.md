<p align="center"><img src="docs/assets/co-memo-logo.png" width="112" alt="Co-memo" /></p>
<h1 align="center">Co-memo</h1>
<p align="center"><strong>Your memory. Across coding agents.</strong></p>
<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

Co-memo gives **coding agents one local memory store**, with built-in setup for Pi, Claude Code, Codex, and OpenCode, plus manual access from compatible MCP clients. Remember a preference or project decision in one agent, then carry it into the next. Changes and deletions propagate too.

- **Shared by default:** agents are sources, not separate owners of your memory.
- **Two scopes:** project facts, conventions and decisions stay with their workspace; personal (`user`) preferences apply across projects and agents. Agents choose scope from content. Workspaces are detected automatically from Git, common manifests or the agent-supplied workspace path, without a manual connection step. Missing project context never turns a project note into personal memory.
- **Local and model-free synchronization:** SQLite with direct MCP/CLI access, no account, API key, embeddings, or extra model service required. Optional semantic retrieval is opt-in. The coding agent still uses its own model to decide what to remember.
- **Reviewable conflicts:** competing edits are preserved. No silent last-writer-wins.
- **Deletion that sticks:** version checks and deletion markers protect stored records.

## Personal and project memory

| Scope               | What belongs here                                        | Example                                          |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Personal (`user`)   | Preferences and habits that apply across projects        | “Keep explanations short and answer in Chinese.” |
| Project (`project`) | Facts, conventions and decisions specific to a workspace | “This project uses pnpm and SQLite.”             |

The agent chooses scope from the content. A personal preference stays personal even when discussed inside a repository. If a project-specific fact has no identifiable workspace, it must not be silently saved as personal memory. Callers that omit scope retain the configured `defaultScope` for compatibility.

Co-memo detects project context from registered roots, Git roots/worktrees and common manifests. For a workspace without those markers, the agent can supply its known path through CLI `--project PATH` or MCP `projectPath`; the user does not need a separate binding step. A shared MCP server should receive the current workspace path on each call when it differs from its launch context.

Reads combine personal and current-project memory. Outside a detected project, personal memory remains readable and explicit `--scope user` writes work. Agents using the same store share those personal notes. Project detection creates an internal identity only; **installing tools, skills and hooks into an agent is a separate setup step**.

## Install

Requires **Node.js 24.12+**. Automatic agent setup supports macOS and Linux.

```sh
npm install -g @ahoh.tech/co-memo
cd /path/to/your/project
co-memo init --agents claude,codex --apply
```

You can also install the exact release directly from the official npm tarball, including while a new version is unavailable through the package index:

```sh
npm install -g https://registry.npmjs.org/@ahoh.tech/co-memo/-/co-memo-0.7.0.tgz
```

Version 0.7.0 includes automatic workspace detection, the memory console, file-location inspection, namespaced shortcuts, and separate archive/permanent-delete actions. It upgrades the memory database to schema 5; update all connected Co-memo installations together.

The schema 8 database-only workflow and save-time duplicate review described below are **unreleased checkout changes**, not part of the published 0.7.0 package. See [Build from this checkout](#build-from-this-checkout) to try them. The latest changes have automated coverage but have not yet been revalidated in each real agent host.

The npm package contains compiled JavaScript. Users do not need pnpm, TypeScript, an API key for Co-memo, or a checkout of this repository. Restart your agents after setup. Add `--hooks` to `init` for automatic lifecycle delivery; without it, agents must call the memory tools.

## Connect your agents

For guided setup, run `co-memo init` in your project. For noninteractive setup:

```sh
co-memo init --agents claude,codex --apply
```

Choose how shared memory enters the agent's context:

| Command                                              | Default behavior                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `co-memo init --agents claude,codex --apply`         | Tools-only: the agent must request memory through tools or CLI.                         |
| `co-memo init --agents claude,codex --hooks --apply` | Configure lifecycle hooks for automatic context delivery and database maintenance.      |
| `co-memo setup AGENT`                                | Configure one agent, with hooks enabled by default. Add `--tools-only` to disable them. |

For MCP agents without hooks, generated instructions request `memory_context` when relevant context is missing. Pi uses the CLI in tools-only mode. Re-running `init` without `--hooks` selects tools-only and removes Co-memo's managed hooks.

To connect individual agents with hooks, run these from your project:

```sh
co-memo setup pi
co-memo setup claude
co-memo setup codex
co-memo setup opencode
# For OpenCode V2 instead of V1:
co-memo setup opencode --opencode-api v2
```

Reload Pi with `/reload` and trust the project. Restart Claude Code and approve its project hooks. Restart Codex, trust the project and review its hooks with `/hooks`. Restart OpenCode to load its plugin. Setup preserves unrelated instructions and settings, installs a dialogue skill, and adds project-local MCP tools for Codex, Claude and OpenCode. Pi uses the CLI/native extension.

When hooks are enabled and loaded by the host, Pi uses a project extension, Claude Code and Codex use lifecycle hooks, and OpenCode uses a project plugin. These deliver current database context before prompts/model requests. Writes commit through tools or CLI. OpenCode V1 is the default for new connections; `--opencode-api v2` selects its incompatible V2 API. Reconnecting without the option preserves the installed API version. No background watcher is needed for sharing memory.

For tools without lifecycle hooks, use `co-memo setup codex --tools-only` (also available for the other built-in agents). The agent must then load context through tools/CLI. The lower-level `connect` command still installs hooks alone.

## Other coding agents

Co-memo exposes a standard local **stdio MCP server** through `co-memo serve`. The clients below document support for that transport. This establishes protocol compatibility; it is not an end-to-end Co-memo host test. Official documentation was checked on October 2, 2026.

| Client                    | Official configuration guide                                                               | Co-memo integration status              |
| ------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| Cursor                    | [MCP](https://cursor.com/docs/mcp)                                                         | Manual MCP configuration; host untested |
| Gemini CLI                | [MCP servers](https://geminicli.com/docs/tools/mcp-server/)                                | Manual MCP configuration; host untested |
| GitHub Copilot in VS Code | [MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) | Manual MCP configuration; host untested |
| Windsurf / Cascade        | [Cascade MCP configuration](https://docs.devin.ai/desktop/cascade/mcp)                     | Manual MCP configuration; host untested |
| Cline                     | [MCP](https://docs.cline.bot/mcp/mcp-overview)                                             | Manual MCP configuration; host untested |
| Continue                  | [MCP setup](https://docs.continue.dev/customize/deep-dives/mcp)                            | Manual MCP configuration; host untested |

`init`, `setup`, `connect`, and agent-specific `doctor` currently accept only `pi`, `claude`, `codex`, and `opencode`. The clients above do not have Co-memo-managed hooks, skills, or shortcuts. MCP gives them memory tools; it does not automatically inject memory before every prompt or guarantee that the model saves notes. No per-agent memory Markdown is required.

For clients using an `mcpServers` JSON object, add an entry like this after installing Co-memo:

```json
{
  "mcpServers": {
    "co-memo": {
      "command": "/absolute/path/to/co-memo",
      "args": [
        "--home",
        "/absolute/path/to/data",
        "--project",
        "/absolute/path/to/workspace",
        "--agent-id",
        "cursor",
        "serve"
      ]
    }
  }
}
```

Replace the paths with the installed executable, your existing Co-memo data directory, and the actual workspace. Replace `cursor` with the client ID you are configuring, such as `gemini` or `cline`. Use the same data directory across local clients to share memory, but a separate configured process per agent identity. For VS Code's `.vscode/mcp.json`, use a top-level `servers` object and add `"type": "stdio"` to the server entry. Follow each client's guide for the configuration location and approval settings.

Restart or reload the client, enable the tools, and ask it to call `memory_context`; check the actual tool result. Use `memory_submit` for durable notes and handle `needs_review` before claiming a save. For a server shared across workspaces, supply the current `projectPath` on each call. Local MCP processes need Node.js 24.12+ and access to the data directory. A cloud or remote agent cannot access your local database merely by copying this configuration; Co-memo does not currently expose an HTTP MCP endpoint.

## Visual memory manager

Run `co-memo ui` to start the local server and open your default browser (default <http://127.0.0.1:4318>). From source, run `pnpm ui`. Use `--no-open` to start without opening a browser, or `--port 0` to choose an available port.

The English console offers System, Dark, and Light themes. Your choice is saved in this browser and applied before the page renders. System follows your operating system’s color preference.

The browser UI lists personal memories and registered projects, with search, filters and add/edit/archive/restore/delete actions. All operations use the database directly with version and conflict checks. Archive retains content/history; Restore makes it active again; Delete removes the record, revisions, conflict data and derived caches. Existing backups, legacy Markdown copies and conversations are unaffected. Resolve conflicts with `co-memo conflicts` and `co-memo resolve`.

Use `co-memo --home /path/to/data ui --port 4319` to select a data directory and port. The server binds only to `127.0.0.1`; press Ctrl+C to stop.

Open the console through the Co-memo skill by asking “Open the Co-memo memory console.” Expand **Storage and connected agents** to inspect the database path, record ID and scoped agent connections. CLI equivalent: `co-memo --project /path/to/project locations MEMORY_ID`. A connection does not prove that a running agent loaded the note.

## Invoke Co-memo from your agent

Install or refresh the integration with `co-memo --project /path/to/project setup AGENT`, where `AGENT` is `claude`, `codex`, `opencode`, or `pi`. Preserve `--tools-only` if you do not want lifecycle hooks; preserve `--opencode-api v2` when using OpenCode V2. Reload or restart the host after setup.

| Agent           | Open the console | Show available actions |
| --------------- | ---------------- | ---------------------- |
| Claude Code     | `/co-memo:ui`    | `/co-memo:help`        |
| OpenCode        | `/co-memo:ui`    | `/co-memo:help`        |
| Pi              | `/co-memo:ui`    | `/co-memo:help`        |
| Codex CLI / app | `$co-memo ui`    | `$co-memo help`        |

Enter these in the agent's conversation, not your shell. In Codex CLI you can also use `/skills`, select `co-memo`, and enter your request. Codex uses its native skill interface rather than the `/co-memo:ACTION` aliases. The original `/co-memo ui` entry in Claude/OpenCode and `/skill:co-memo ui` in Pi remain available.

| Action after `/co-memo:` | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `ui`                     | Open the memory console                                  |
| `recall QUERY`           | Search personal and current-project memories             |
| `remember TEXT`          | Save a fact with the appropriate scope                   |
| `edit ID CHANGE`         | Update a memory using its current version                |
| `archive ID`             | Archive a memory and retain history                      |
| `delete ID`              | Permanently delete a memory and history                  |
| `restore ID`             | Restore an archived memory                               |
| `forget ID`              | Compatibility alias for archive                          |
| `locations ID`           | Inspect database and Agent file paths                    |
| `history ID`             | Inspect revision history                                 |
| `settings [REQUEST]`     | Inspect settings or apply an explicitly requested change |
| `status`                 | Inspect storage and Agent connections                    |
| `sync`                   | Check database maintenance and conflicts                 |
| `conflicts`              | List unresolved conflicts                                |
| `resolve ID CHOICE`      | Resolve a conflict using your explicit choice            |
| `help`                   | Show actions and examples                                |

For Codex, use `$co-memo ACTION` with the same arguments. For example:

```text
$co-memo recall package manager
$co-memo remember This project uses pnpm.
```

Shortcuts load the same Co-memo skill and preserve its scope, version, and conflict checks. Claude uses command files, OpenCode uses command wrappers, and Pi uses prompt templates. Pi project templates require project trust and enabled template discovery. Setup installs these entry points; `connect` alone does not. See [tools and settings](docs/tools-and-settings.md) for paths and details.

Tests cover generated setup, idempotency, collision protection, and disconnect cleanup. Local Pi/OpenCode loaders have verified discovery and argument expansion/configuration; this does not establish successful model execution of every shortcut in every host.

## Verify memory is loaded

After restarting or reloading your agent, check the connection from your project:

```sh
co-memo doctor claude --probe
# Or inspect all registered projects:
co-memo projects --check
```

For an MCP agent, ask it to call `memory_context` and inspect the actual tool result. For Pi, ask it to run the pinned Co-memo CLI `context` command from its generated instructions. An empty result can be valid when no relevant memories exist.

`doctor --probe` verifies that the configured MCP server responds; it does not prove that your running agent loaded or used it. Diagnostics therefore report `hostMemoryLoaded: "unverified"`. MCP probing does not apply to Pi.

Saving a note makes it available in the shared store. Other agents receive it through their next successful hook delivery or memory-tool/CLI read; an already loaded conversation is not rewritten. No per-agent Markdown copy is needed.

## Remember once

```sh
# Save a project decision for connected agents to retrieve on their next read.
co-memo add --scope project --content 'Use pnpm for this project.'

# A personal preference shared across projects and agents.
co-memo add --scope user --content 'Prefer concise explanations in Chinese.'

co-memo list
co-memo status
```

Ask your agent to remember a preference or update a project decision. Generated instructions direct it to the shared memory workflow. Like any agent instruction, this depends on the host loading and following it; setup does not force a model to save every conversation.

## Control saving and sharing

After setup, speak to your agent: “Use Co-memo to remember this project decision” or “Only save memory when I explicitly ask.” See [dialogue tools and settings](docs/tools-and-settings.md) for installation, host configuration and all available tools.

```sh
co-memo settings get
co-memo settings set --scope user --save-mode explicit
co-memo settings set --scope project --paused true
# Resume:
co-memo settings set --scope project --paused false
```

Settings are persisted and checked by the program. Explicit-only mode rejects automatic tool writes. Intent is declared by the caller; Co-memo does not read conversations to verify it. Pause stops delivery and tool writes, but cannot erase previously loaded context or existing local files.

## Database-only memory

All agents read and write the same SQLite store through MCP tools or the CLI. `init`, `setup` and `connect` register agent connections and install instructions/configuration; they do not create `.co-memo/<agent>.md` files. Native instruction files such as `AGENTS.md` and `CLAUDE.local.md` still explain how to use Co-memo.

Schema 8 migrates existing agent registrations into database connections. Existing notes, versions, conflicts and settings are retained. Legacy Markdown files and their stored bookkeeping are retained for manual recovery but are never read, ingested, recreated or updated by the new runtime. Review any unsaved legacy edits and save the intended content through tools/CLI before archiving those files yourself. Do not import a whole marked projection: save individual note text without its Co-memo markers.

Upgrade all installations sharing the store together and rerun setup to replace old file-editing instructions. Older clients reject schema 8. `sync` and `watch` remain compatibility commands for maintenance/conflict reporting; `repair` is removed because there are no active memory files to rebuild.

### Which agent wrote a memory?

Built-in setup binds the agent ID in the generated MCP command and pinned CLI invocation using `--agent-id`. The program records this as `sourceAgent` on each new memory version, including edits, archive/restore, and conflict resolution. Conflict candidates retain their own submitting writer. An exact duplicate reuses the existing record without changing its writer or history.

Both `notes` and `histories` expose a queryable `source_agent` column derived from the saved JSON payload. The current note shows its latest writer; `co-memo history ID` shows each version's writer, including the initial save. The console displays the latest writer and supports searching by agent ID.

Schema 8 automatically renames the earlier `revisions` table and `writer_agent` / `writerAgent` fields to `histories` and `source_agent` / `sourceAgent`. Existing memory history, conflict evidence, and recorded agent identities are preserved; older backups remain restorable.

This configured identity is separate from optional `metadata.source` evidence (claimed agent, excerpt, session/message IDs). Evidence cannot override the configured writer. Legacy notes and unbound CLI/MCP writes retain `null` for unknown writers; manual console edits are unbound as well. Migration never guesses attribution from a connection or old evidence. This identifies the configured integration, not an authenticated user or a particular model. Rerun setup after upgrading to bind existing integrations; manual clients add `--agent-id` before `serve` or another CLI command.

## Bring existing memory

```sh
co-memo import /absolute/path/MEMORY.md
co-memo import /absolute/path/preferences.md --scope user
co-memo import /absolute/path/memory-directory
```

Import is **explicit and one-time**. Each Markdown file becomes one note, preserving its text and source path. A directory imports its immediate `.md` files. Original files are never rewritten or watched. Repeated exact imports reuse the same note; archived exact content remains archived.

We do not guess where native auto-memory or third-party Pi memory plugins store their data. After import, shared updates go through Co-memo's tools or CLI. Arbitrary native-memory directory synchronization is outside this first release.

## Change, forget, resolve

```sh
co-memo show MEMORY_ID
co-memo edit MEMORY_ID --version 1 --content 'Use pnpm with a frozen lockfile.'
co-memo archive MEMORY_ID --version 2
co-memo unarchive MEMORY_ID --version 3
co-memo delete MEMORY_ID --version 4
co-memo history MEMORY_ID

co-memo conflicts
# N is the conflict revision from conflicts, not the note currentVersion
co-memo resolve CONFLICT_ID --revision N --take current
# Or choose a candidate ID from the conflict output:
co-memo resolve CONFLICT_ID --revision N --take CANDIDATE_ID
# Or supply a merged note:
co-memo resolve CONFLICT_ID --revision N --content 'Merged decision'
```

Conflicting notes are excluded from injected context until explicitly resolved. Competing proposals remain in the database. Deleting legacy Markdown files does not change stored memories.

## Installation maintenance

Inspect connected projects and manage their integration:

```sh
co-memo projects --check
co-memo disconnect claude          # Preview only
co-memo disconnect claude --apply  # Archive local files and remove managed integration
```

Disconnect retains central memories and other agents' configuration. Close the selected agent first, then restart it afterward; already loaded context cannot be removed remotely.

Back up the whole central store or restore into a new data directory:

```sh
co-memo backup /path/to/new-backup
co-memo backup-check /path/to/new-backup
co-memo restore /path/to/new-backup --to /path/to/new-data          # Preview
co-memo restore /path/to/new-backup --to /path/to/new-data --apply
```

Restore never overwrites an existing destination and detaches old agent connections. Backups do not include unsynchronized Markdown edits or host configuration. See [backup and restore](docs/backup-and-restore.md) before switching agent bindings to a recovered store.

**The current runtime uses SQLite schema 8.** See the database-only migration notes above and [installation maintenance](docs/releasing.md).

## Storage and boundaries

The central store is `~/.local/share/co-memo/shared-memory-v1.sqlite` (or under `XDG_DATA_HOME`). Override it with `CO_MEMO_HOME` or the global `--home` option. Global options precede the command:

```sh
co-memo --home /path/to/data --project /path/to/project connect pi
```

- A project is identified by its canonical directory. Subdirectories reuse its identity; separate clones and worktrees are isolated by default. Worktrees in the same local Git repository can be [explicitly linked](docs/onboarding-and-worktrees.md) to share all project memories, settings and conflicts. Separate clones are not automatically merged, and there is no branch/task memory scope.
- Memory is shared with all connected agents within its scope. This is a single-user local tool, not a multi-user security boundary.
- No cloud sync, transcript mining, or native memory-path discovery is included. Optional [semantic retrieval](docs/semantic-retrieval.md) combines cached embeddings with local full-text search. The MCP server runs locally over stdio.
- A note is limited to 32,000 characters; an import file to 1 MiB. Injected context is bounded to approximately 16,000 characters; omitted notes remain available through `list` and `show`.
- Filesystem writes use atomic replacement and a last-moment content check. Arbitrary external editors do not participate in the lock; avoid editing a file while it is being replaced.

See [agent setup](docs/agent-configuration.md), [CLI reference](docs/reference.md), [architecture](docs/architecture.md), and [development](CONTRIBUTING.md).

## Verification status

Automated tests cover synchronization, scoped retrieval, conflicts, deletion tombstones, configuration preservation, backup/restore, disconnect, worktree sharing, concurrency and simulated lifecycle events for all four adapters. Independent npm installation checks exercise the packaged CLI, MCP startup and installation-path repair.

Real-host validation has also passed:

- **Codex ↔ Claude Code:** explicitly requested saves and fresh-session retrieval in both directions, with observed tool calls and independently checked central records.
- **Claude Code hooks:** SessionStart, UserPromptSubmit and Stop ran in the actual host; the model recalled a random value delivered by hooks while MCP and built-in tools were disabled.
- **Claude automatic saving:** seven isolated scenarios passed, covering implicit decisions/preferences/corrections and non-save behavior for speculation, temporary instructions, explicit-only mode and pause.

These are controlled, version-specific results, not a guarantee for every host configuration or a general extraction-accuracy estimate. Other adapters' simulated lifecycle tests do not establish that their real hosts loaded the integration. See the [validation record](docs/validation-record.md) for versions, evidence and limits.

## Diagnose and measure

Use `co-memo doctor codex` or `co-memo doctor opencode --probe` to inspect configuration and optional local MCP transport without saving memories. A passing probe does not establish host approval or actual model tool use.

From the checkout:

- `pnpm eval` runs the retrieval baseline; `pnpm eval:scale` adds 1,000 synthetic distractors.
- `pnpm test:package` checks independent npm installation and maintenance commands.
- `pnpm test:hosts` checks installed Codex/OpenCode CLI readiness without invoking a model.
- `pnpm test:hooks` and `pnpm eval:autonomous` run real Claude models using existing authentication and quota. They are opt-in, not ordinary CI checks.

The larger evaluation found all labeled relevant memories for the lexical queries in the top five, with no scope/deletion/conflict leaks, but also returned weak partial matches. The three semantic-only queries remained misses under lexical search; actual embedding-model quality is still unmeasured. Optional embeddings remain disabled by default. See [diagnostics and evaluation](docs/diagnostics-and-evaluation.md) for metrics and limitations.

See [optional semantic retrieval](docs/semantic-retrieval.md) for provider configuration, explicit indexing, cache validity and model evaluation.

For agent discovery and guided setup, run `co-memo init`. See [guided setup, explicit worktree sharing and real-host verification](docs/onboarding-and-worktrees.md) for previews, linking rules and `co-memo verify --round-trip`.

## Build from this checkout

This is a new implementation in **TypeScript + Node.js**, managed with **pnpm**. It does not migrate the previous Rust database or preserve its CLI.

Requires **Node.js 24.12+** and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
npm install -g ./ahoh.tech-co-memo-0.7.0.tgz
```

pnpm is only required for development. Co-memo is distributed under the [MIT license](LICENSE).

Archive uses the legacy `deleted` field internally; CLI `list --deleted` includes archived records. `forget` / `memory_forget` remain compatibility aliases for archive. Use `delete` / `memory_delete` for permanent deletion. The `restore` skill action calls CLI `unarchive` (CLI `restore` is reserved for database backups). New installations include these shortcuts; rerun setup to update an existing installation.

Submit directly; `memory_prepare` / `co-memo prepare --file FILE` is an optional preview. Related additions return `needs_review` without saving the batch. The agent chooses add/update/skip/conflict, or confirms distinct additions with a fresh review token and explanation. This is lexical review, not automatic semantic merging. Add/remember, imports and the console share the same review gate; sources may be omitted/null. See [review before saving](docs/retrieval-and-extraction.md#review-before-saving).
