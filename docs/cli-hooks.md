# CLI hooks

The native executable supports two integration paths:

- `co-memo watch --db /absolute/memory.sqlite` stays running and imports registered files through filesystem events and 2-second reconciliation, including when native events are missing.
- `co-memo scan --db /absolute/memory.sqlite` runs after a host's file write, attempts two stable snapshots, and exits. No watcher process is required between invocations.

Register each Markdown source with `source-add --db FILE --agent ID --file /absolute/MEMORY.md` first. Registration authorizes ongoing reads; sources are never rewritten. Inspect JSON output for per-file errors. Host hook installation is not automatic.

For task context, `hook-start --db FILE --agent ID` reads `{"query":"task"}` from stdin and returns context for the host to inject. Long notes are represented by marked excerpts within a 1200-byte text budget; `truncatedIds` identifies notes whose full content can be fetched with `get`. `hook-end --db FILE --agent ID` reads `{"content":"lesson","evidence":"quote"}` and proposes a private candidate. It does not extract a lesson from a transcript; the caller supplies the proposed content. Empty input skips creation.

See [complete configuration](../README.md#file-access-and-two-import-modes).
