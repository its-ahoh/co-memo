# Optional semantic retrieval

Co-memo defaults to local SQLite FTS5/BM25. Optional embeddings add synonym and cross-language candidates without replacing the shared store, conflict handling or scope checks. No vector database or new runtime dependency is required.

## Configure and index

Use a service implementing the [OpenAI-compatible embeddings request/response format](https://developers.openai.com/api/reference/resources/embeddings/methods/create). Supply the complete embeddings URL and a model available on that service. Co-memo does not install or download a model.

```sh
export CO_MEMO_SEMANTIC=1
export CO_MEMO_EMBEDDING_URL=http://127.0.0.1:11434/v1/embeddings
export CO_MEMO_EMBEDDING_MODEL=your-installed-embedding-model
# For authenticated services, supply CO_MEMO_EMBEDDING_API_KEY securely.

co-memo --project /path/to/project index
co-memo --project /path/to/project list --query 'preferred package manager' --explain
co-memo --project /path/to/project context --query 'preferred package manager'
```

The URL above illustrates a local compatible server; it must already be running. HTTPS endpoints are also supported. HTTP is limited to loopback. URL credentials, query strings, fragments and redirects are rejected. There is no default remote endpoint and no automatic reuse of agent credentials.

`index` explicitly sends active, nonconflicted **user notes and this project's notes** to the configured provider. Remote services receive that text and may charge for it. Indexing skips existing valid entries, processes at most 100 notes per run (`--limit 1..1000`), stops on the first provider failure, and reports indexed/skipped/failed/remaining. Run again after adding or changing memories. Normal writes and reads never implicitly embed the library.

Queries send only the query text when a valid cache exists. Empty queries, disabled configuration, `--deleted`, paused projects and empty caches make no embedding request. Remove `CO_MEMO_SEMANTIC` to disable. Configuration errors, failures, invalid vectors or a 3-second request timeout fall back to local retrieval. `list --explain` and MCP results expose the mode and reason without provider error bodies or credentials.

## Agent integration

`memory_recall` and `memory_context` use hybrid retrieval when their MCP process receives these environment variables. Configure the environment of the **MCP server process** using your host's configuration; a shell export does not automatically configure an already-running desktop host, and some hosts filter inherited variables. Restart that server after changing configuration. A response with `retrieval.reason=disabled` means its process did not receive the enable flag. Keys belong in a secure environment, not committed project files or memory text.

Native hook/bridge injection still uses local lexical retrieval, keeping its path free of provider latency. Agents can request semantic context through MCP. Co-memo's memory settings (`paused`, `saveMode`, `defaultScope`) remain separate from provider configuration and host approval.

## Ranking and cache validity

Eligible vectors are compared using cosine similarity. Matches below `CO_MEMO_EMBEDDING_THRESHOLD` (default `0.65`, range 0..1) are discarded. Up to 100 semantic and 100 lexical candidates are merged using reciprocal rank fusion (`k=60`), deduplicated and capped at 100. The existing pinned-note and context budget rules still apply. Tune the threshold using evaluations: cosine scores and useful cutoffs vary by model.

Cache files under `<data-home>/embeddings-v1/` contain normalized vectors, content digests and note versions, not note text or query history. Treat vectors as sensitive derived data. Namespace identity includes endpoint, model and optional `CO_MEMO_EMBEDDING_REVISION`; change the revision when a service changes model weights behind an unchanged name. Cache files may remain after deletion or model changes; they are never eligible for deleted or mismatched versions. With Co-memo stopped, the entire `embeddings-v1` directory can be removed to purge or rebuild the derived cache without deleting memories.

Network calls run outside the store lock. Before publishing a vector or returning results, Co-memo checks current versions, scope, conflicts and pause settings again. A pause cannot retract an already-sent HTTP request, but suppresses its output/publication. Notes changed during a request cannot be returned from its stale semantic snapshot. This implementation scans local cached vectors and is intended for small personal memory collections, not million-document search.

## Evaluate actual models

```sh
pnpm eval                  # deterministic local lexical baseline
pnpm eval:semantic         # sends only synthetic evaluation fixtures and queries
pnpm eval:semantic --check # also require lexical/semantic recall >= 0.9 and no empty-query false positives
```

Semantic evaluation uses a disposable store, compares the same fixture queries against the lexical baseline, and reports recall, precision, MRR, false positives, leaks and timings. Provider fallback marks the run incomplete and exits nonzero. The fixture set is small and is not a general accuracy guarantee. Unit tests use a deterministic local HTTP fixture to verify caching, scope, concurrency, timeout and CLI/MCP integration; those tests do not establish real-model semantic quality or extraction accuracy.
