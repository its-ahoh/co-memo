# CLI and hook integration

The CLI accesses the same local database as the dashboard and MCP. The HTTP server does not need to stay running. Register agents and projects in the dashboard first and use their stable IDs. Names can be duplicated; the CLI does not infer identities from names.

```sh
npm install
npm run build
node dist/cli.js help
node dist/cli.js catalog --db /absolute/path/memory.sqlite
node dist/cli.js recall --db /absolute/path/memory.sqlite --agent AGENT_ID --project PROJECT_ID --query 'Current task'
node dist/cli.js propose --db /absolute/path/memory.sqlite --agent AGENT_ID --project PROJECT_ID --content 'Start technical explanations with the conclusion' --evidence 'The user said: please start with the conclusion'
```

The package declares a `co-memo` executable. Optionally run `npm link` to use commands such as `co-memo recall ...` globally. The project does not change your global environment automatically. You can also use `npm run cli -- recall ...`.

- `recall` prints context within a token budget; `--json` includes the context and the entries actually selected.
- `get --id MEMORY_ID` returns an active entry visible to the configured identity and project.
- `propose` requires content and evidence and creates only private candidates. Confirm and share them in the dashboard.
- `catalog` lists configuration IDs. It is a local administrative command, not a tool for untrusted agents.
- Every command requires an explicit database path. Missing files cause an error rather than silently creating another store.
- `--stage` and `--purpose` further constrain applicability.
- JSON results go to stdout, errors to stderr. Failures return a nonzero exit code. Each invocation reads the latest committed data.

## Generic host lifecycle hooks

These entry points implement **Co-memo's generic JSON protocol**, not native Claude Code or Codex hook configuration. Do not pass native client events through unchanged. A host adapter must translate fields, schedule calls, and supply the returned context to the model. No user-level hooks are installed.

Create a host-controlled `host.json`. Do not let model-supplied event fields overwrite it:

```json
{
  "db": "/absolute/path/memory.sqlite",
  "agentId": "REGISTERED_AGENT_ID",
  "projectId": "REGISTERED_PROJECT_ID"
}
```

Relative database paths resolve against the configuration file's directory. Optional fields are `stageId` and `purposeId`. Keep the same agentId when one role switches engines; use separate IDs for independent roles.

**Task start:** write `{"query":"Current task description"}` to the following process's stdin, close stdin, and read its output:

```sh
node dist/cli.js hook-start --config /absolute/path/host.json
```

The result is `{"context":"...","memories":[{"id":"...","version":2}]}`. Include context as source-backed supporting data and record the versions used. Do not promote memory text into system instructions that override the user's request. An empty query is allowed. This command makes no model calls.

**Task completion:** the host or executing model selects information worth retaining and sends `{"content":"...","evidence":"..."}` to:

```sh
node dist/cli.js hook-end --config /absolute/path/host.json
```

This returns a private candidate. Send `{}` or empty input when there is nothing to retain; the result is skipped and no memory is written. This entry point does not read transcripts, use regular expressions to infer lasting preferences, or call an extraction model. Use the MemoryLearner SDK for background semantic extraction. Caller-supplied evidence still requires review.

Hook input is limited to 64 KiB and accepts only the documented fields. Attempts to change identity, broaden sharing, or activate a candidate are rejected. Repeated proposals use the engine's deduplication rules; do not submit arbitrary new proposals to bypass review. Hosts should set a timeout and report failed reads or writes without claiming synchronization succeeded.

## Runnable host example

```sh
node examples/hook-host.cjs /absolute/path/host.json 'Review project conventions'
```

The example runs both hooks, prints task context, and completes with an empty proposal. It does not launch a coding engine or extract lessons automatically. In a real host, run the model between the two hooks and supply a selected proposal afterward.

**Boundaries:** the local machine and host configuration are trusted. CLI arguments do not provide operating-system isolation; a process that can read the database or edit the configuration can bypass application retrieval boundaries. Explicit file watching is available through the dashboard server; see [Memory inbox](inbox.md). Markdown writeback, native client hook installation, and cross-machine synchronization are not implemented.

## Hook-triggered file import

To scan explicitly registered memory files after your host finishes writing them, invoke `node /absolute/co-memo/dist/cli.js watch --db /absolute/memory.sqlite --once`. This differs from `hook-end`, which accepts a model-produced proposal rather than reading files. Disable the dashboard watcher with `CO_MEMO_WATCH=0` when choosing hook-only import. See [File access and import modes](../README.md#file-access-and-import-modes) for complete configurations and consent boundaries.
