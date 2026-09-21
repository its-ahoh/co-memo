# Agent handoff

Run `co-memo setup --json` in the project first. No SQLite path, data-directory creation, or database environment variable is required for default setup. All clients share Co-memo's default data directory; keep each client's connection configuration in its own supported configuration file.

Launch each client's `co-memo mcp` process with its registered `--agent` and `--project` IDs. The default database is selected automatically. Copying setup's generated MCP command also works: it pins the resolved database path automatically so different client environments still reach the same store. Users do not need to enter that path.

Do not put separate Co-memo databases under `.claude`, `.codex`, or other client folders by default. Separate roles should have distinct IDs in the shared database. One role can retain its ID across coding engines; use `setup --role NAME` for an independent role. Sharing remains explicit.

Only use `--db FILE` when deliberately selecting custom storage or adopting an existing database elsewhere. In that case, keep the same generated database argument in every client's configuration.

`memory_record` creates a private candidate, or returns a scoped duplicate unchanged. A local user confirms a candidate with `review` and grants access with `share`; both mutations require the current version. Another agent then reads it through `memory_search` or `memory_get` on its next request. Existing model context is not automatically refreshed.

SQLite coordinates local readers and writers. This is shared local storage, not network replication. File watching imports changes from explicitly registered Markdown files; it never rewrites another engine's memory files. The host must retrieve and inject updated context.

See the [MCP configuration](../README.md#mcp-entirely-in-rust) and [task hooks](../README.md#task-hooks).
