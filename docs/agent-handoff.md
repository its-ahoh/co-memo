# Agent handoff

Launch each client's `co-memo mcp` process with the same absolute `--db` path and its registered `--agent` ID. Add `--project` when needed. One role can keep its ID across coding engines; separate roles should use distinct IDs.

`memory_record` creates a private candidate. A local user confirms it with `review` and grants access with `share`; both mutations require the current version. Another agent then reads it through `memory_search` or `memory_get` on its next request. Existing model context is not automatically refreshed.

SQLite coordinates local readers and writers. This is shared local storage, not network replication. File watching imports changes from explicitly registered Markdown files; it never rewrites another engine's memory files. The host must retrieve and inject updated context.

See the [MCP configuration](../README.md#mcp-entirely-in-rust) and [task hooks](../README.md#task-hooks).
