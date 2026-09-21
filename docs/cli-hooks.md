# CLI hooks

Run `co-memo setup` once in the project. No database path is required; the commands below use the default Co-memo database. Only add `--db FILE` if you deliberately chose a custom location.

The native executable supports two integration paths:

- `co-memo watch` stays running and imports registered files through filesystem events and 2-second reconciliation, including when native events are missing.
- `co-memo scan` runs after a host's file write, attempts two stable snapshots, and exits. No watcher process is required between invocations.

Register each Markdown source with `source-add --agent ID --project PROJECT_ID --file /absolute/MEMORY.md` first. Registration authorizes ongoing reads; sources are never rewritten. Inspect JSON output for per-file errors. Host hook installation is not automatic.

For task context, `hook-start --agent ID --project PROJECT_ID` reads `{"query":"task"}` from stdin and returns context for the host to inject. Long notes are represented by marked excerpts within a 1200-byte text budget; `truncatedIds` identifies notes whose full content can be fetched with `get`. `hook-end --agent ID --project PROJECT_ID` reads `{"content":"lesson","evidence":"quote"}` and proposes a private candidate. It does not extract a lesson from a transcript; the caller supplies the proposed content. Empty input skips creation.

Hooks launched inside a configured project may omit the identity flags and use the saved role. Keep explicit IDs when the host can launch a hook from another working directory.

See [complete configuration](../README.md#file-access-and-two-import-modes).
