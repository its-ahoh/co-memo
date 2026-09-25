<p align="center"><img src="docs/assets/co-memo-logo.png" width="112" alt="Co-memo" /></p>
<h1 align="center">Co-memo</h1>
<p align="center"><strong>Your memory. Across coding agents.</strong></p>
<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

Co-memo gives **Pi, Claude Code, Codex, and OpenCode one local memory store**. Remember a preference or project decision in one agent, then carry it into the next. Changes and deletions propagate too.

- **Shared by default:** agents are sources, not separate owners of your memory.
- **Two scopes:** project facts, conventions and decisions stay with their workspace; personal (`user`) preferences apply across projects and agents. Agents choose scope from content. Workspaces are detected automatically from Git, common manifests or the agent-supplied workspace path, without a manual connection step. Missing project context never turns a project note into personal memory.
- **Local and model-free synchronization:** SQLite, editable Markdown, no account, API key, embeddings, or extra model service required. Optional semantic retrieval is opt-in. The coding agent still uses its own model to decide what to remember.
- **Reviewable conflicts:** competing edits are preserved. No silent last-writer-wins.
- **Deletion that sticks:** tombstones prevent stale replicas from restoring forgotten notes.

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
npm install -g https://registry.npmjs.org/@ahoh.tech/co-memo/-/co-memo-0.6.0.tgz
```

The automatic workspace detection described here reflects the current checkout. The pinned 0.6.0 tarball predates this change; build from this checkout to test it with that release.

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
| `co-memo init --agents claude,codex --hooks --apply` | Configure lifecycle hooks for automatic context delivery and synchronization.           |
| `co-memo setup AGENT`                                | Configure one agent, with hooks enabled by default. Add `--tools-only` to disable them. |

For MCP agents, generated instructions request `memory_context` at the start of work. Pi uses the CLI in tools-only mode. Re-running `init` without `--hooks` selects tools-only and removes Co-memo's managed hooks.

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

When hooks are enabled and loaded by the host, Pi uses a project extension, Claude Code and Codex use lifecycle hooks, and OpenCode uses a project plugin. These deliver current shared context before prompts/model requests and synchronize edits after turns or tool execution. OpenCode V1 is the default for new connections; `--opencode-api v2` selects its incompatible V2 API. Reconnecting without the option preserves the installed API version. `co-memo watch` optionally reconciles every two seconds while no agent is running.

For tools without lifecycle hooks, use `co-memo setup codex --tools-only` (also available for other agents). The agent must then load context through tools/CLI. The lower-level `connect` command still installs hooks alone.

## Verify memory is loaded

After restarting or reloading your agent, check the connection from your project:

```sh
co-memo doctor claude --probe
# Or inspect all registered projects:
co-memo projects --check
```

For an MCP agent, ask it to call `memory_context` and inspect the actual tool result. For Pi, ask it to run the pinned Co-memo CLI `context` command from its generated instructions. An empty result can be valid when no relevant memories exist.

`doctor --probe` verifies that the configured MCP server responds; it does not prove that your running agent loaded or used it. Diagnostics therefore report `hostMemoryLoaded: "unverified"`. MCP probing does not apply to Pi.

Saving a note makes it available in the shared store. Other agents receive it through their next successful hook delivery or memory-tool/CLI read; an already loaded conversation is not rewritten. The `.co-memo/<agent>.md` files are editable replicas, not files automatically loaded simply because they exist.

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

Settings are persisted and checked by the program. Explicit-only mode rejects automatic tool writes and Markdown ingestion. Intent is declared by the caller; Co-memo does not read conversations to verify it. Pause stops delivery/sync/tool writes, but cannot erase previously loaded context or existing local files.

## Editable Markdown

Each agent configured through `init`, `setup` or `connect` gets an editable projection:

```text
project/
  .co-memo/
    pi.md
    claude.md
    codex.md
    opencode.md
```

Each memory has a stable ID and version marker. Edit the text inside its block to update it. Remove the whole block to forget it. Add one project note between the `co-memo:new` markers. Preserve the document markers and existing IDs/versions.

```sh
co-memo sync
```

Co-memo reconciles these edits with central memory and updates the other projections. It does not copy entire native instruction files between agents. Generated local memory/configuration paths are added to `.gitignore`.

## Bring existing memory

```sh
co-memo import /absolute/path/MEMORY.md
co-memo import /absolute/path/preferences.md --scope user
co-memo import /absolute/path/memory-directory
```

Import is **explicit and one-time**. Each Markdown file becomes one note, preserving its text and source path. A directory imports its immediate `.md` files. Original files are never rewritten or watched. Repeated exact imports reuse the same note; previously deleted exact content remains deleted.

We do not guess where native auto-memory or third-party Pi memory plugins store their data. After import, shared updates go through Co-memo's managed files or CLI. Arbitrary native-memory directory synchronization is outside this first release.

## Change, forget, resolve

```sh
co-memo show MEMORY_ID
co-memo edit MEMORY_ID --version 1 --content 'Use pnpm with a frozen lockfile.'
co-memo forget MEMORY_ID --version 2
co-memo history MEMORY_ID

co-memo conflicts
co-memo resolve CONFLICT_ID --take current
# Or choose a proposal's replicaId from the conflict output:
co-memo resolve CONFLICT_ID --take REPLICA_ID
# Or supply a merged note:
co-memo resolve CONFLICT_ID --content 'Merged decision'
```

Conflicts freeze affected project projections; conflicting notes are excluded from injected context until resolved. All competing text is retained. Removing an entire projection file is **not** interpreted as deleting every memory; use `co-memo repair AGENT` (pi, claude, codex, or opencode) to recreate a missing file.

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

Restore never overwrites an existing destination and detaches old replica registrations. Backups do not include unsynchronized Markdown edits or host configuration. See [backup and restore](docs/backup-and-restore.md) before switching agent bindings to a recovered store.

**Version 0.6 uses SQLite schema 4**, which adds linked worktree roots and multiple same-agent replicas. Existing notes, history and replica bookkeeping are retained during upgrade. Older clients refuse the newer schema: upgrade connected installations together and rerun setup, preserving your intended hook mode and custom `--home`. See [installation maintenance](docs/releasing.md) for pinned-path repair after upgrading Node or moving the installation.

## Storage and boundaries

The central store is `~/.local/share/co-memo/shared-memory-v1.sqlite` (or under `XDG_DATA_HOME`). Override it with `CO_MEMO_HOME` or the global `--home` option. Global options precede the command:

```sh
co-memo --home /path/to/data --project /path/to/project connect pi
```

- A project is identified by its canonical directory. Subdirectories reuse its identity; separate clones and worktrees are isolated by default. Worktrees in the same local Git repository can be [explicitly linked](docs/onboarding-and-worktrees.md) to share all project memories, settings and conflicts. Separate clones are not automatically merged, and there is no branch/task memory scope.
- Memory is shared with all connected agents within its scope. This is a single-user local tool, not a multi-user security boundary.
- No cloud sync, transcript mining, or native memory-path discovery is included. Optional [semantic retrieval](docs/semantic-retrieval.md) combines cached embeddings with local full-text search. The MCP server runs locally over stdio.
- A note is limited to 32,000 characters; a projection/import file to 1 MiB. Injected context is bounded to approximately 16,000 characters; omitted notes remain available through `list` and `show`.
- Filesystem writes use atomic replacement and a last-moment content check. Arbitrary external editors do not participate in the lock; avoid editing a file while it is being replaced.

See [agent setup](docs/agent-configuration.md), [CLI reference](docs/reference.md), [sync architecture](docs/architecture.md), and [development](CONTRIBUTING.md).

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
npm install -g ./ahoh.tech-co-memo-0.6.0.tgz
```

pnpm is only required for development. Co-memo is distributed under the [MIT license](LICENSE).
