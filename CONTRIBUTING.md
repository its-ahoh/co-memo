# Contributing to Co-memo

Thanks for helping improve Co-memo! Bug reports, feature suggestions, documentation improvements, fixes and new coding-agent integrations are welcome.

## Getting started

- For bugs, open an issue using the bug report template. Include reproduction steps, expected and actual behavior, and your environment.
- For feature ideas or new agent integrations, use the feature request template and describe the problem and a concrete use case.
- Before starting a large change, open an issue to discuss the approach and avoid duplicate work. Small fixes and documentation improvements can go straight to a pull request.

## Development workflow

1. Fork the repository and clone your fork.
2. Create a branch from the latest `main` for your change.
3. Install dependencies and make a focused change using the development instructions below.
4. Run `pnpm check`. For package or installation changes, also follow [release and installation validation](docs/releasing.md).
5. Commit your changes, push your branch and open a pull request against `main`.

## Pull requests

Use the pull request template to explain what changed, why it is needed and how you verified it. Link any related issue.

- Keep each PR focused on one change.
- Add or update tests when behavior changes, and update documentation when setup or usage changes.
- Use a clear commit message, such as `fix: preserve deleted memories during sync` or `docs: clarify agent setup`.
- If a check could not be run, explain why and what you verified instead.

Changes to `main` must go through a pull request and pass the required checks.

## Coding-agent integrations

For a new or updated integration, include the agent name and version tested, setup instructions, and any additional permissions required. Test with synthetic notes and temporary agent configuration, and preserve unrelated host settings and instructions.

## Privacy

Remove API keys, credentials, real memories and private repository content from issues, logs, screenshots and pull requests. Use synthetic examples and temporary projects for tests.

## Development

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
- Read and write memory through the database; do not create or ingest per-agent Markdown copies.
- Preserve existing legacy files during upgrades; never infer deletion from them.
- Use transactions, expected versions and idempotent submissions; preserve conflicting proposals for explicit resolution.
- Keep model calls and transcript extraction out of the memory storage path.
- Keep unrelated host settings and instructions intact. Test generated adapters, not just configuration shapes.
- Do not use real agent stores as test fixtures.

See [architecture](docs/architecture.md) and [agent setup](docs/agent-configuration.md). The project uses the [MIT license](LICENSE); retain the attribution in [NOTICE](NOTICE.md). See [release and installation validation](docs/releasing.md) before publishing.
