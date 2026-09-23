# Guided setup, worktrees and real-host verification

## Guided setup

```sh
co-memo --project /path/to/project init
```

In a terminal, `init` lists detected agent executables and project configuration directories, asks which agents to connect, previews affected paths, and applies the chosen plan after confirmation. Detection reads PATH/filesystem entries; it does not run discovered executables. Detection is a hint, not proof that an agent is authenticated, compatible or loaded.

Without a terminal, it only previews unless `--apply` is present:

```sh
co-memo --project /path/to/project init --agents codex,claude
co-memo --project /path/to/project init --agents codex,claude --apply
```

The default is tools-only. Add `--hooks` to include lifecycle hooks; use `--opencode-api v2` if appropriate. `--home` selects the shared store and must precede `init`. Explicit agent selection works even when the CLI is absent, for example when setting up a desktop host.

The preview shows create/update/unchanged paths and the memory home without printing existing configuration contents or credentials. Every selected agent is validated before the first setup write. The plan is checked again before applying, and managed-file updates use compare-and-replace. Multi-file/multi-agent installation is not a filesystem-wide transaction: an I/O failure may leave a partial setup, which is reported as `needs_attention`; fix the cause and rerun. Existing unmanaged entries are not overwritten.

After applying, MCP agents receive an initialize/tools/settings probe using this installation's pinned Co-memo command. Pi uses the CLI and receives static checks. Probes do not launch a model or prove host trust. Restart/reload agents and review their project/tool approvals. JSON results distinguish protocol success from `hostVerified: false`.

## Worktree sharing rules

Worktrees remain independent by default, including a worktree nested inside another connected project. Personal (`user`) memories still apply across projects as before. Project memories are scoped to their registered project identity.

For a new worktree that should share **all repository-wide project memory**, explicitly link it before running setup there:

```sh
co-memo --project /path/to/main init --agents codex --apply
co-memo --project /path/to/worktree worktree inspect
co-memo --project /path/to/worktree worktree link --to /path/to/main
co-memo --project /path/to/worktree init --agents codex,claude --apply
```

Paths must be distinct checkout roots with the same Git common directory. Separate clones with the same remote are not automatically equivalent. Link registration verifies Git identity, and later reads reject a link whose path now points to another repository. Run setup at the checkout root; ordinary recall from subdirectories resolves to that root.

Linked worktrees share:

- Project notes, revisions, deduplication and submission retries.
- Project settings, including pause and explicit-only mode.
- Conflicts and their explicit resolutions.

Each checkout retains its own generated configuration and `.co-memo/<agent>.md` projection. The same agent can have several replicas in one shared project. `repair AGENT` targets the current checkout's replica. `status` reports the central repository path and linked worktrees. Missing/deleted checkout files are reported as sync errors, never interpreted as a request to delete central notes.

**Linking does not introduce a branch/task memory scope.** Once linked, every `project` note is shared. Repository conventions belong here; branch-specific experiments and temporary task progress should remain in the agent's session, or use an independently connected worktree. If durable branch isolation is needed, do not link that worktree. Existing independently registered worktrees are not automatically merged, and there is no automatic unlink/split operation in this version.

## Repeatable real-host verification

```sh
co-memo verify --from codex --to claude
co-memo verify --from codex --to claude --round-trip
```

This command launches **real host models**, uses their existing login/provider configuration and consumes their quota. Currently the supported pair is Codex and Claude Code; unsupported hosts are rejected explicitly. No model is selected or downloaded by Co-memo.

For each direction it:

1. Creates a temporary project, isolated Co-memo store, tools-only bindings and random fixture value.
2. Asks the source host to explicitly save it and verify the returned receipt.
3. Independently checks the central stored record.
4. Starts a fresh destination session whose prompt contains the lookup label, not the answer.
5. Requires an observed successful MCP recall containing the stored ID/value, a correct final answer, and an unchanged memory store after reading.

Codex retains its read-only shell sandbox and receives invocation-only approval for the selected Co-memo tools; the temporary MCP server can save synthetic notes during the writer phase. Reader phases expose only context/recall/settings tools. Claude has built-in tools disabled and a narrow Co-memo allowlist. There is no global permission bypass or configuration change. Unexpected non-Co-memo tools cause validation failure. Host-specific global/custom instructions may still affect model behavior, so these are controlled integration runs, not a hermetic model benchmark.

Embeddings are disabled, no production memory home is used, and each host invocation has a 120-second timeout and bounded captured output. Claude also has a per-invocation $1 API budget; Codex usage follows the host account's limits. Progress goes to stderr and the final structured report to stdout. Authentication, quota, approval, timeout, missing tools or incorrect behavior produce a nonzero result; a protocol handshake alone never counts as model success.

Temporary data is removed after normal completion or handled failure. `--keep` retains the synthetic store/configuration and a `verification.json` report; raw model logs are not written. A forcibly killed parent process may leave its temporary directory behind. This test establishes explicitly prompted save/recall only, not native Hook behavior, autonomous extraction, semantic quality or universal host-version compatibility.

## Storage compatibility

Co-memo 0.6 upgrades the store to schema 4 to support linked checkout roots and multiple same-agent replicas. The upgrade retains note history, replica IDs, baselines and pending publication records. Upgrade all connected Co-memo installations before using the new schema: older versions refuse to open it. The store filename remains `shared-memory-v1.sqlite`.
