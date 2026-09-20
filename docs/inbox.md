# Review incoming memory

Run `co-memo inbox --db /absolute/memory.sqlite` to list candidate and expired active memories. Each item includes `reviewReason` (`candidate` or `expired`). Inspect their content and provenance before confirming them with `review --db FILE --id ID --version N`. For an expired note, review renews its review date. Confirmation does not broaden access; `share` is a separate versioned action.

Run `sources --db FILE` to inspect registered file snapshots, errors, and the latest added/removed comparison. `source-review --db FILE --id ID --version N` acknowledges a source version; it does not confirm its candidate memories.

`inspect --db FILE --id ID` reads a full record in any state for a trusted local administrator. It is not an MCP tool; agent `get` calls still require an active, unexpired, accessible memory.

`history --db FILE --id ID` returns a memory's revision history. The CLI has no web dashboard or per-memory unread view.
