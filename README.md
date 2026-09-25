<p align="center"><img src="docs/assets/co-memo-logo.png" width="112" alt="Co-memo" /></p>
<h1 align="center">Co-memo</h1>
<p align="center"><strong>Your memory. Across coding agents.</strong></p>

Co-memo gives **Pi, Claude Code, Codex, and OpenCode one local memory store**. Remember a preference or project decision in one agent, then carry it into the next. Changes and deletions propagate too.

- **Shared by default:** agents are sources, not separate owners of your memory.
- **Two scopes:** project notes stay in their project; user preferences follow you across connected projects.
- **Local and model-free synchronization:** SQLite, editable Markdown, no account, API key, embeddings, or extra model service required. Optional semantic retrieval is opt-in. The coding agent still uses its own model to decide what to remember.
- **Reviewable conflicts:** competing edits are preserved. No silent last-writer-wins.
- **Deletion that sticks:** tombstones prevent stale replicas from restoring forgotten notes.

This is a new implementation in **TypeScript + Node.js**, managed with **pnpm**. It does not migrate the previous Rust database or preserve its CLI.

## Install

**Registry release pending:** the `0.6.0` package is prepared; npm publishing currently requires the maintainer to complete 2FA. Use a local `.tgz` until publication is confirmed. The registry command below is the intended installation flow.

Requires **Node.js 24.12+**. Automatic agent setup supports macOS and Linux.

```sh
npm install -g co-memo
cd /path/to/your/project
co-memo init --agents claude,codex --apply
```

The npm package contains compiled JavaScript. Users do not need pnpm, TypeScript, an API key for Co-memo, or a checkout of this repository. Restart your agents after setup. Add `--hooks` to `init` for automatic lifecycle delivery; without it, agents must call the memory tools.

## Build from this checkout

Requires **Node.js 24.12+**. Automatic agent setup is supported on macOS and Linux.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
npm install -g ./co-memo-0.6.0.tgz
```

pnpm is only required for development. Co-memo is distributed under the [MIT license](LICENSE).

## Connect your agents

For guided setup, run `co-memo init` in your project. For noninteractive setup:

```sh
co-memo init --agents claude,codex --apply
```

`init` defaults to tools-only: the agent must call `memory_context` to load memories. Add `--hooks` for automatic lifecycle delivery. Configuration and MCP probes do not prove that a running agent has loaded memory.

From the project where you use your agents:

```sh
co-memo setup pi
co-memo setup claude
co-memo setup codex
co-memo setup opencode
# For OpenCode V2 instead of V1:
co-memo setup opencode --opencode-api v2
```

Reload Pi with `/reload` and trust the project. Restart Claude Code and approve its project hooks. Restart Codex, trust the project and review its hooks with `/hooks`. Restart OpenCode to load its plugin. Setup preserves unrelated instructions and settings, installs a dialogue skill, and adds project-local MCP tools for Codex, Claude and OpenCode. Pi uses the CLI/native extension.

Pi uses a project extension; Claude Code and Codex use lifecycle hooks; OpenCode uses a project plugin. Each loads current shared context before prompts/model requests and synchronizes edits after turns or tool execution. OpenCode V1 is the default for new connections; `--opencode-api v2` selects its incompatible V2 API. Reconnecting without the option preserves the installed API version. `co-memo watch` optionally reconciles every two seconds while no agent is running.

For tools without lifecycle hooks, use `co-memo setup codex --tools-only` (also available for other agents). The agent must then load context through tools/CLI. The lower-level `connect` command still installs hooks alone.

After setup, speak to your agent: “Use Co-memo to remember this project decision” or “Only save memory when I explicitly ask.” See [dialogue tools and settings](docs/tools-and-settings.md) for installation, host configuration and all available tools.

```sh
co-memo settings get
co-memo settings set --scope user --save-mode explicit
co-memo settings set --scope project --paused true
# Resume:
co-memo settings set --scope project --paused false
```

Settings are persisted and checked by the program. Explicit-only mode rejects automatic tool writes and Markdown ingestion. Intent is declared by the caller; Co-memo does not read conversations to verify it. Pause stops delivery/sync/tool writes, but cannot erase previously loaded context or existing local files.

## Remember once

```sh
# A decision for this project, available to all connected agents immediately.
co-memo add --content 'Use pnpm for this project.'

# A preference for every connected project.
co-memo add --scope user --content 'Prefer concise explanations in Chinese.'

co-memo list
co-memo status
```

Ask your agent to remember a preference or update a project decision. Generated instructions direct it to the shared memory workflow. Like any agent instruction, this depends on the host loading and following it; setup does not force a model to save every conversation.

## Editable Markdown

Each agent gets an editable projection:

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

## Storage and boundaries

The central store is `~/.local/share/co-memo/shared-memory-v1.sqlite` (or under `XDG_DATA_HOME`). Override it with `CO_MEMO_HOME` or the global `--home` option. Global options precede the command:

```sh
co-memo --home /path/to/data --project /path/to/project connect pi
```

- A project is identified by its canonical directory. Subdirectories reuse its identity; separate clones/worktrees are separate projects in this release.
- Memory is shared with all connected agents within its scope. This is a single-user local tool, not a multi-user security boundary.
- No cloud sync, transcript mining, or native memory-path discovery is included. Optional [semantic retrieval](docs/semantic-retrieval.md) combines cached embeddings with local full-text search. The MCP server runs locally over stdio.
- A note is limited to 32,000 characters; a projection/import file to 1 MiB. Injected context is bounded to approximately 16,000 characters; omitted notes remain available through `list` and `show`.
- Filesystem writes use atomic replacement and a last-moment content check. Arbitrary external editors do not participate in the lock; avoid editing a file while it is being replaced.

See [agent setup](docs/agent-configuration.md), [CLI reference](docs/reference.md), [sync architecture](docs/architecture.md), and [development](CONTRIBUTING.md).

## Verification status

MCP tests use a real SDK client/server subprocess and cover settings, project isolation and config preservation. Tests also cover the full Pi → Claude → Pi add/edit/delete loop, user/project scoping, conflicts, tombstones, crash recovery, parallel CLI writers, config preservation, generated hook execution, generated Pi extension callbacks, Codex hook execution, and both OpenCode plugin APIs, including four-agent edit/delete propagation. These host adapters are tested with simulated lifecycle events; a live installed-agent smoke test is still required for your host version and trust settings.

Version 0.5 upgrades the SQLite schema to version 3, adding full-text indexing and idempotent candidate submissions. Existing notes and history are retained; legacy notes receive default metadata when read. Older clients refuse the new schema. Upgrade connected installations together and rerun setup. See [retrieval and extraction](docs/retrieval-and-extraction.md).

## Diagnose and measure

Use `co-memo doctor codex` or `co-memo doctor opencode --probe` to inspect configuration and optional local MCP transport without saving memories. A passing probe does not establish host approval or actual model tool use.

From the checkout, run `pnpm eval` for retrieval quality and `pnpm test:hosts` for disposable real-CLI readiness checks. Extraction accuracy is explicitly unmeasured until actual agent outputs are supplied. See [diagnostics and evaluation](docs/diagnostics-and-evaluation.md) and the [current validation record](docs/validation-record.md).

See [optional semantic retrieval](docs/semantic-retrieval.md) for provider configuration, explicit indexing, cache validity and model evaluation.

For agent discovery and guided setup, run `co-memo init`. See [guided setup, explicit worktree sharing and real-host verification](docs/onboarding-and-worktrees.md) for previews, linking rules and `co-memo verify --round-trip`.

## Installation maintenance

See [release and installation validation](docs/releasing.md) for package verification, upgrades, and repairing pinned paths after moving your installation or changing Node versions.

Back up the central store with `co-memo backup /path/to/new-backup`. Restore first previews and always uses a new data directory; see [backup and restore](docs/backup-and-restore.md).

List connected projects with `co-memo projects`, or inspect them together with `co-memo projects --check`. See [diagnostics and evaluation](docs/diagnostics-and-evaluation.md) for real Hook tests, autonomous saving checks and larger retrieval regressions.
