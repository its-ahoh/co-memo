# Development

Co-memo is a TypeScript/Node.js local shared-memory tool. Use Node.js 24.12+ and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

`pnpm check` runs strict type checking, builds executable JavaScript and declarations, and runs Node's test runner. Tests use only temporary projects and synthetic notes. No real agent configuration or personal memory is touched.

The npm package ships `dist/`; users do not need TypeScript, pnpm, Python or Rust. Node's built-in SQLite avoids a separately compiled native addon. CI covers Node 24 and 26 on Linux and macOS. Windows host setup has not been implemented.

## Design rules

- Central memory belongs to the user/project. Agent names are provenance, never a default access barrier.
- A sync must account for additions, edits, deletions, conflicts and restart recovery.
- Never derive deletion from a missing/truncated file or silently resurrect a tombstone.
- Gather all replica proposals before applying edits; do not let replica scan order choose the winner.
- Keep model calls and transcript extraction out of the synchronization path.
- Keep unrelated host settings and instructions intact. Test generated adapters, not just configuration shapes.
- Do not use real agent stores as test fixtures.

See [architecture](docs/architecture.md) and [agent setup](docs/agent-configuration.md). The public license for new work remains undecided; see [NOTICE](NOTICE.md).
