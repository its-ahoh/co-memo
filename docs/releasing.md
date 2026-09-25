# Packaging, releases and installation maintenance

## Publication status

The public npm package is [`@ahoh.tech/co-memo`](https://www.npmjs.com/package/@ahoh.tech/co-memo), distributed under the MIT license. Install a specific release with `npm install -g @ahoh.tech/co-memo@0.6.0`, or the latest release with `npm install -g @ahoh.tech/co-memo`.

Users of the package need Node.js 24.12+ and npm; they do not need pnpm, TypeScript, or the source repository. Automatic agent configuration currently supports macOS and Linux.

## Validate the distributable

Maintainers run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:package
pnpm pack
```

`test:package` builds once, packs the actual distributable, and installs it with npm into a temporary global prefix with development dependencies and install scripts disabled. It checks the installed executable, all four setup adapters, Claude/Codex/OpenCode MCP initialization, and preservation of a synthetic memory when the old installation is removed and setup is rerun from a new prefix. It never imports implementation modules from the checkout. It needs registry access for runtime dependencies and removes temporary files on completion or handled failure.

This proves package installation and local protocol readiness. It does not prove that a host model loaded the tools, that native hooks fired, or that automatic extraction succeeded. CI runs this check on macOS/Linux with Node 24 and 26.

## Install without cloning

Install from npm:

```sh
npm install -g @ahoh.tech/co-memo
cd /path/to/your/project
co-memo init --agents claude,codex --apply
```

Restart the selected agents and accept their project/tool trust prompts. `init` defaults to tools-only; use `--hooks` if automatic lifecycle delivery is desired. Ask the running agent to call `memory_context` to confirm it can actually retrieve shared context.

Local archives are also supported with `npm install -g /path/to/ahoh.tech-co-memo-0.6.0.tgz`. Prefer a persistent installation over `npx`/`pnpm dlx`: generated MCP, hook and skill instructions pin the Node executable and CLI to absolute paths, and disposable caches may disappear.

## Upgrade or repair an installation path

Run `npm install -g @ahoh.tech/co-memo@latest` (or install a new archive), then rerun setup from the new executable in each connected project. Keep the same `--home` if you originally selected a custom memory directory. Preview first:

```sh
co-memo init --agents claude,codex
co-memo init --agents claude,codex --apply
co-memo doctor claude --probe
co-memo doctor codex --probe
```

Specify the agents actually connected in that project. Include `--hooks` in both init commands if you want hooks to remain enabled; omitting it selects tools-only and removes Co-memo's managed hooks. Existing OpenCode API selection is preserved unless overridden. These are the same commands for repairing paths after changing Node versions or moving an installation. Unmanaged entries are refused; unrelated configuration and central memories are retained. Restart the hosts afterward.

A successful MCP probe means the configured server can start and respond. It does not prove that an existing host session has refreshed its tools. Schema upgrades may prevent older Co-memo versions from opening the database; upgrade all connected installations and consult the storage compatibility notes before downgrading.

Before uninstalling, close the host and disconnect each agent in each connected project:

```sh
co-memo disconnect claude
co-memo disconnect claude --apply
```

The first command previews file changes without opening or migrating the store. `--apply` removes only managed instructions, hooks, MCP entries, plugins and skills. It archives exact originals and the local memory projection under `<memory-home>/disconnected/<id>/`, including a manifest of original paths. Pending Markdown edits are archived without being imported. The replica registration is removed so future syncs stop targeting it; central notes, history, conflicts, settings, other agents and other worktrees remain intact. Existing `.gitignore` entries stay in place. Use the same custom `--home` used during setup.

Malformed, unmanaged or symlinked files are refused before changes. Changes detected after preview are also refused. Multi-file removal is not one filesystem transaction: an I/O failure can leave a partial disconnect; backups are written before changes, and retrying after fixing the error is supported. Restart the host after removal: already loaded tools and text cannot be removed from a live session by this command. Reconnecting creates a fresh projection from central memory; archived unsaved edits are not automatically restored.

Then `npm uninstall -g @ahoh.tech/co-memo` removes the installed program only; it never deletes the central memory store.

## Maintainer publication checklist

1. Confirm the npm account owns the chosen name; use an owned scope if necessary. A missing package is not proof that npm will allow registration.
2. Confirm the version, MIT LICENSE, original attribution, repository metadata, and packed file list. Do not publish runtime memories or configuration files.
3. Pass the checks above on the final source. Inspect `npm pack --dry-run --ignore-scripts --json` after building.
4. Publish the reviewed archive through an authenticated npm account, with explicit authorization for that package name and version. This repository has no automatic publish-on-push workflow.
5. Verify the registry's version and integrity, install that exact registry version in a clean environment, then update installation instructions to the verified package name.

For subsequent releases, npm trusted publishing can connect GitHub Actions to the package through OIDC without a long-lived publishing token. Configure it only after package ownership and the release workflow are established: <https://docs.npmjs.com/trusted-publishers/>.
