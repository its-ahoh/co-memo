# Co-memo

A local-first workspace for managing memory across AI agents. **Standalone first version.**

See what agents know together, keep private memories private, organize lasting knowledge by stage and purpose, and attach context to projects. No Codey installation, agent framework, model account, cloud database or runtime npm dependency is required for the dashboard.

## Run independently

Requires **Node.js 22.13+** (native SQLite).

```sh
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4317`. Register an agent, add a memory, and choose who can read it. The first launch contains no agents or personal memories. Starter stages and purposes can be renamed or archived.

```sh
npm run demo       # separate .data/demo.sqlite containing synthetic examples
npm test          # compile + Node's built-in test runner
npm run eval:memory # offline retrieval checks; no model calls
```

Copy this entire directory into its own repository to use it independently. Its package.json, tsconfig, lockfile, source, tests and web assets are self-contained. It is deliberately outside Codey's npm workspace list.

`CO_MEMO_DB` changes the database path; `PORT` changes the port. The default is `.data/memory.sqlite`, relative to the working directory. Keep that file and its WAL state with proper SQLite backup tooling; stop the server before making a plain file copy. The UI's **Export** downloads all notes, catalog metadata and revision history as JSON for inspection or migration. JSON import is not implemented yet.

## Try the guided handoff demo

After `npm install`, run `npm run demo` and open **http://127.0.0.1:4317/demo**.
No API key or coding engine is needed. Follow three short steps: save a preference, approve sharing, and let the second agent retrieve it. Each screen introduces one action; technical details stay collapsed. It uses the real engine and a separate demo SQLite database; the Claude Code / Codex labels simulate clients, not live model calls or semantic extraction. Demo writes are disabled on the normal server. Each run creates isolated demo identities and a project.

[How Claude Code / Codex share memory, extraction, and file-sync boundaries](docs/agent-handoff.md). Integrations generates Claude Code JSON and Codex TOML configuration. Both clients must use the same absolute database path. New queries see committed changes; existing model context is not pushed, and file watching requires explicit registration in Memory inbox.

## File access and import modes

**Registering a file grants ongoing read access in Co-memo.** Use Memory inbox → Watched memory files, or `source-add` below, to explicitly choose its path, owner, and project. Only registered files are read. There is no confirmation prompt on every read; operating-system permissions still apply. Pause a source to stop subsequent scans. Co-memo does not request additional OS privileges or bypass denied access.

Changed paragraphs are automatically written to the local database as **private candidates**. Reading or importing does not approve or share them. Review candidates in the dashboard to confirm them and choose recipients. Co-memo never writes to the original Markdown files, so there is no source-file write approval step. This is file-to-library import, not bidirectional file synchronization.

### Shared setup: explicitly register sources

Initialize the database and register agents/projects using the dashboard first. Get their stable IDs from `catalog`, then register each source once:

```sh
node dist/cli.js catalog --db /absolute/memory.sqlite
node dist/cli.js source-add --db /absolute/memory.sqlite \
  --agent AGENT_ID --project PROJECT_ID --file /absolute/project/MEMORY.md
```

Registration is persisted. The first import includes existing paragraphs. Do not register files containing secrets; the mechanical file importer does not automatically redact them. Both modes below use these same registrations and review rules.

### Mode A: continuous automatic import

Choose either the dashboard service or the standalone watcher:

```sh
# Dashboard + built-in watcher (default)
CO_MEMO_DB=/absolute/memory.sqlite npm start

# Or: watcher only, without an HTTP server
node dist/cli.js watch --db /absolute/memory.sqlite
```

Keep the chosen process running. File-system events trigger debounced reads; a second stable snapshot is required before import. Startup reconciliation and a 30-second fallback scan catch missed events and recover directory watchers. `--interval 60000` changes the standalone fallback interval in milliseconds. Ctrl+C stops the process. No system service or automatic login startup is installed.

### Mode B: import only when a host hook runs

Do not run `watch` continuously. If you need the dashboard for review, disable its built-in watcher:

```sh
CO_MEMO_DB=/absolute/memory.sqlite CO_MEMO_WATCH=0 npm start
```

Configure your host's after-file-write or task-completion hook to execute:

```sh
node /absolute/co-memo/dist/cli.js watch --db /absolute/memory.sqlite --once
```

This performs two scan attempts 250 ms apart and exits; no watcher remains running. It checks all enabled sources registered in this database. The host should run it after writes finish and check its exit status and JSON output for per-file errors. A still-changing file or a scan lease held by another process may require another invocation. Zero exit status means the scan command completed, not that every source imported successfully.

The command is a generic hook target, **not** a native Claude Code/Codex event configuration. Your host must supply the trigger. Native hook installation is not included. Changes outside that trigger are discovered only on the next invocation.

For model-produced proposals instead of file scanning, use `hook-end --config ...`. To load approved context at task start, use `hook-start --config ...`. These are separate operations; see the [CLI and hook guide](docs/cli-hooks.md).

| Behavior | Continuous mode | Hook-triggered mode |
| --- | --- | --- |
| Long-running importer | Dashboard or watcher | None |
| Trigger | File events + fallback scan | Host invokes `watch --once` |
| Per-read confirmation | No, registration authorizes reads | No, registration authorizes reads |
| Import result | Private candidates | Private candidates |
| Confirm/share | Explicit dashboard action | Explicit dashboard action |
| Rewrite source files | Never | Never |

## The model

| Dimension | Meaning | Example |
| --- | --- | --- |
| Owner | Stable agent identity that owns a note | Research assistant |
| Sharing | Owner only, selected agents plus owner, or all agents | Writer + Reviewer |
| Project | Optional project applicability, independent of sharing | Website redesign |
| Stage | Optional user-defined phase; does not imply age or access | Explore, Build, Maintain |
| Purposes | User-defined uses, multiple per note | Preferences, Decisions, Knowledge |
| Lifecycle | Candidate, active, forgotten; review due is computed separately | Awaiting confirmation |
| Kind | Preference, fact, experience, lesson | A project convention |

An all-agent note can still be restricted to one project. A private note can be used in any project. Changing classification never broadens sharing. A supplied stage/purpose filters to matching or unclassified notes; leaving it unspecified includes all classifications within the allowed agent/project scope. These classifications are routing metadata, not a security boundary.

IDs survive renaming. Archiving catalog entries retains existing references. Archived agents cannot use the MCP connection; the human dashboard can still inspect their history.

## Dashboard

- **Memory inbox**: incoming agent/file memories with persistent unread markers, source details, and registered Markdown file import. See [the inbox guide](docs/inbox.md).
- **Shared memory**: notes intentionally shared beyond their owner, with owner and applicability labels.
- **All memories / By project**: searchable library with agent, project, stage and purpose filters.
- **Needs review**: candidates, conflicts and overdue facts/experiences.
- **Forgotten**: read-only retained history, excluded from recall.
- **Agents**: register and rename provider-independent identities.
- **Stages & purposes**: configure classifications and projects.
- **Agent view**: preview the exact budgeted context for a selected agent and task.
- **Integrations**: generate a host-bound MCP configuration without connecting automatically.

Notes can be edited, shared, confirmed, forgotten and inspected by source/version. Conflicting candidates retain the earlier note until an explicit confirmation; stale versions are rejected. Forgotten records remain in the audit log: this is not a secure deletion API.

## Integrate an agent

### CLI and generic host hooks

Monitor registered Markdown files without a web server using `node dist/cli.js watch --db /absolute/memory.sqlite`. See [file watching](docs/inbox.md#run-without-the-dashboard).

Read and propose memories without MCP using `node dist/cli.js recall` and `node dist/cli.js propose`. `hook-start` / `hook-end` accept bounded JSON on stdin with identity bound by a host configuration file. All paths use the same database and review rules. See the [CLI and Hook guide](docs/cli-hooks.md) and runnable `examples/hook-host.cjs`.

These are generic host entry points, not installed native Claude Code or Codex hooks. The host must inject returned context and supply extracted proposals; Co-memo does not automatically capture conversations.

### MCP

Generate client configuration in **Integrations**, or start the stdio server directly:

```sh
node dist/engine/mcp.js --db /absolute/path/memory.sqlite \
  --agent REGISTERED_AGENT_ID --project PROJECT_ID \
  --stage STAGE_ID --purpose PURPOSE_ID
```

Project, stage and purpose are optional. The agent must be registered; IDs can be found by opening the entity editor or generated MCP configuration. Each host process binds exactly one identity and scope. Tools do not accept another identity in their arguments.

Tools: `memory_search` (compact index), `memory_get` (visible active note and source), `memory_record` (private candidate only). The minimal stdio implementation supports MCP protocol version `2024-11-05`; this is not a remote multi-user MCP service. Do not expose administrative HTTP routes as agent tools.

### SDK

```js
const { MemoryEngine } = require('./dist');
const memory = new MemoryEngine('/absolute/path/memory.sqlite');
const actor = {
  agentId: 'registered-agent-id',
  projectId: 'project-id',
  stageId: 'stage-build',
  purposeId: 'purpose-preferences',
};
const { text, entries } = memory.contextWithEntries(actor, 'Review this design');
// Include text in your agent prompt; entries records exactly what was included.
memory.close();
```

SDK administrative methods are trusted-host operations. The host must bind identities and validate catalog references. Use `Catalog.validateActor`, `Catalog.validateMemory` and the constrained tool adapter for untrusted callers.

### Optional background learning

The extracted engine includes `MemoryLearner`, durable learning jobs, semantic proposal parsing and an injectable extractor. The dashboard intentionally makes **no model calls**. Integrating automatic learning requires your agent host to:

1. Add `MEMORY_PROPOSAL_INSTRUCTIONS` to the execution prompt when appropriate.
2. Hide the candidate metadata using `memoryProposalStream` and parse it with `parseMemoryProposals`.
3. Enqueue a `MemoryObservation` with host-bound agent/project/stage/purpose and the parsed proposals.
4. Supply a `MemoryExtractor` that returns the requested parsed JSON; bound its timeout and token budget in your host.
5. Call `resume(extractor)` on startup and `flush()` before shutdown.

Temporary requirements are discarded. Uncertain duration and assistant-only lessons remain candidates. The semantic reviewer compares a bounded same-owner/project/classification set for duplicates and contradictions. Exact evidence is required, but quotes do not prove correctness. Facts default to a 30-day review horizon, experiences to 90 days; overdue notes are excluded from recall until reviewed. Failed jobs retry on restart up to three recorded failures. A crash may repeat an unfinished model request; committed events are idempotent.

`evaluateMemory(runner)` in `dist/engine/evaluation` supports paired synthetic answer evaluation. Its default CLI is offline and explicitly reports no answer-quality score. A custom Node adapter can be supplied with `--runner`; no Codey configuration or credentials are imported.

## Local data and boundaries

- Binds only to `127.0.0.1`; validates Host and Origin, and requires a session token for writes.
- Same-machine processes are trusted. This is a single-user local application, **not** an authenticated team server. Anyone with filesystem access to the SQLite file can read it.
- Stage/purpose/project/agent controls restrict application retrieval, not an agent that can independently read the database from disk.
- No telemetry, cloud sync, remote fonts, external scripts or live model calls in the dashboard.
- Raw observations and exports may contain sensitive information. Common secrets are redacted by the optional learner, but redaction is not exhaustive.
- No existing Codey databases, gateway configuration, credentials, user conversations or real memories were copied into this project. Demo content is synthetic.

## Project status and publication

This is an independent, runnable early-stage project. The source repository is [its-ahoh/co-memo](https://github.com/its-ahoh/co-memo). npm package publication is disabled (`private: true`). A public license for the new work has not yet been selected; public source visibility is not an open-source license. See [NOTICE.md](NOTICE.md) for the existing MIT-licensed engine's provenance and retained license.

Before a stable release: choose the public license, add migration/versioning policy, broaden client compatibility checks, and evaluate against real domain-specific tasks. Semantic retrieval, cloud/team authentication, JSON restore and dedicated connectors are not implemented in this first version.
