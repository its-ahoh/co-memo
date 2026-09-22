# Agent connections

For the recommended dialogue-based workflow, use `co-memo setup AGENT` to add MCP/CLI tools and the Co-memo skill alongside these hooks. Use `--tools-only` to disable Co-memo hooks. See [tools and settings](tools-and-settings.md). The `connect` commands below remain the hooks-only workflow.

Run `co-memo connect AGENT` in the project root, where AGENT is `pi`, `claude`, `codex`, or `opencode`. All share one project identity and central store. Commands are idempotent and preserve unrelated settings.

## Pi

Setup writes:

- `.pi/extensions/co-memo.ts`: a generated extension using `session_start`, `before_agent_start`, and `agent_end`.
- A marked Co-memo instruction block in `AGENTS.md`.
- `.co-memo/pi.md`: editable shared memory.
- Local ignore rules in `.gitignore`.

Trust the project and run `/reload`. Before each agent turn, the extension runs sync and appends bounded shared context to the existing system prompt. At the end of an agent run it syncs edits back to central storage. Failures are reported through Pi's UI. No transcript is sent to Co-memo and no model request is made by the extension.

The generated extension uses only Node built-ins and the host's event registration API. It does not depend on a particular third-party Pi memory plugin.

Official reference: [Pi extensions](https://pi.dev/docs/latest/extensions).

## Claude Code

Setup writes:

- `.claude/settings.local.json`: managed `SessionStart`, `UserPromptSubmit`, and `Stop` command hooks.
- A marked instruction block in `CLAUDE.local.md`.
- `.co-memo/claude.md`: editable shared memory.
- Local ignore rules in `.gitignore`.

Restart Claude Code and approve its project hooks. Session/prompt hooks return `hookSpecificOutput.additionalContext`; Stop only syncs and never requests a continuation. Existing hook groups and settings are retained. JSONC or malformed JSON fails without replacing the file.

Co-memo does not change Claude's auto-memory directory, disable native memory, or overwrite `CLAUDE.md`. Explicitly import existing native notes with `co-memo import PATH`; subsequent Co-memo updates use the shared projection or CLI.

Official references: [Claude memory](https://code.claude.com/docs/en/memory), [Claude hooks](https://code.claude.com/docs/en/hooks).

## Codex

`co-memo connect codex` writes `.codex/hooks.json` with `SessionStart`, `UserPromptSubmit`, and `Stop` handlers, a marked instruction block in `AGENTS.md`, and `.co-memo/codex.md`. Existing hook groups remain intact; malformed JSON fails before setup writes. `config.toml` is untouched.

Use a Codex version supporting these lifecycle hooks. Restart Codex, trust the project, and use `/hooks` to review and enable the generated commands. Session/prompt handlers return additional context; Stop synchronizes without requesting continuation. Hook trust belongs to Codex and is not bypassed by setup. Existing inline TOML hooks also run, so avoid manually registering duplicate Co-memo hooks there.

Official reference: [Codex hooks](https://developers.openai.com/codex/hooks).

## OpenCode

```sh
co-memo connect opencode                    # V1 on a new connection
co-memo connect opencode --opencode-api v2   # OpenCode V2
```

Setup writes `.opencode/plugins/co-memo.ts`, a marked instruction block in `AGENTS.md`, and `.co-memo/opencode.md`. Restart OpenCode to load the plugin. Existing `opencode.json` / JSONC settings are untouched. Reconnecting without the option retains the installed API version; passing it explicitly replaces the managed plugin for that version.

V1 appends context through `experimental.chat.system.transform` and synchronizes after tools and on `session.idle`. V2 registers a session `context` hook and a tool `execute.after` hook. Thus edits made through tools are published immediately; external edits are reconciled at the next model request or by `co-memo watch`. V2 does not rely on V1 session events.

The generated plugins use Node built-ins and structural host interfaces, with no SDK runtime dependency. V2 exports the definition object accepted by the SDK (`Plugin.define` in `@opencode/plugin` 2.0.12 is an identity helper). SQLite executes in the pinned Node subprocess, including when OpenCode runs on Bun. Failures produce a diagnostic and an unavailable-memory context message instead of failing the model request. V1 and V2 plugin implementations are not interchangeable.

Official references: [OpenCode V1 plugins](https://opencode.ai/docs/plugins/), [V2 plugins](https://opencode.ai/v2/docs/build/plugins/), [V1 to V2 migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

## Verify

```sh
co-memo status
co-memo sync
```

In any connected agent, ask the agent to remember a small project preference, then inspect `co-memo list`. Switch agents and start a new prompt; verify that the note is available. Edit it in the other agent and inspect the first projection. Test in a disposable project if you do not want to create real memory.

Automated tests execute generated commands and extension callbacks in temporary projects. They do not establish that your installed host has loaded the integration; trust and host-version behavior still need live verification.

## Existing files and failures

All configuration edits are prepared before any are written. Each replacement is atomic, but setup's database registration and multiple files are not one transaction. An I/O failure can leave a partial setup; fix the error and rerun the same connect command.

Malformed instruction markers, unregistered existing projection files, symlinks, and unmanaged `.pi/extensions/co-memo.ts` or `.opencode/plugins/co-memo.ts` files are refused. Generated hooks pin the absolute Node executable, CLI entry, project and data paths. Re-run connect after moving the installation. Configurations are machine-specific.

These adapters target macOS/Linux shells. Windows automatic setup is not implemented. Connecting a nested folder explicitly creates a separate project; otherwise commands inside subdirectories reuse the closest connected ancestor.
