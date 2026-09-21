# Agent handoff

Run the client setup command in the project, for example `co-memo setup --client codex` or `co-memo setup --client claude`. It creates or reuses the selected client's identity and the project's identity, writes the connection configuration, and adds memory instructions. Users do not supply or copy SQLite paths or IDs. Restart the client and complete its normal trust/MCP approval.

Generated connections pin the resolved database and identities automatically, so reads and writes keep their scope even when clients launch from another directory. Project scope applies to retrieval as well as new records. For manual integrations, `setup --json` prints the complete connection without editing client files.

Do not put separate Co-memo databases under `.claude`, `.codex`, or other client folders by default. Separate roles should have distinct IDs in the shared database. One role can retain its ID across coding engines; use `setup --role NAME` for an independent role. Sharing remains explicit.

Only use `--db FILE` when deliberately selecting custom storage or adopting an existing database elsewhere. In that case, keep the same generated database argument in every client's configuration.

`memory_record` creates a private candidate, or returns a scoped duplicate unchanged. A local user confirms a candidate with `review` and grants access with `share`; both mutations require the current version. Another agent then reads it through `memory_search` or `memory_get` on its next request. Existing model context is not automatically refreshed.

SQLite coordinates local readers and writers. This is shared local storage, not network replication. File watching imports changes from explicitly registered Markdown files; it never rewrites another engine's memory files. The host must retrieve and inject updated context.

See the [MCP configuration](../README.md#mcp-entirely-in-rust) and [task hooks](../README.md#task-hooks).
