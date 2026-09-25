# Validation record — 2026-09-22

This record separates protocol/configuration checks from actual model behavior. Tests used synthetic memories in disposable projects; no real preferences were saved. It is a point-in-time local result, not a guarantee for every client version, provider or machine.

| Layer                              | Result                         | Limits                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI 0.155.1 config discovery | Passed                         | `codex mcp get co-memo --json` recognized the generated project config in an isolated, explicitly trusted test project.                                                                                                                                                                                          |
| OpenCode 1.18.31 MCP connection    | Passed                         | Real `opencode mcp list` reported Co-memo connected with isolated host config and data.                                                                                                                                                                                                                          |
| Direct MCP protocol                | Passed                         | Initialize, tool discovery and settings read through `doctor --probe`; not model behavior.                                                                                                                                                                                                                       |
| Codex model retrieval              | Passed                         | Actual MCP `memory_context` and `memory_recall` calls returned a seeded verification value that was not included in the user prompt. For this inference run the generated MCP binding was supplied explicitly with CLI overrides; project trust discovery was tested separately.                                 |
| Codex model write                  | Passed after explicit approval | Following the user’s explicit authorization, the disposable test used normal Codex automatic approval with sandboxing retained. Actual memory_remember saved the synthetic fact and memory_checkpoint returned verified=true. The central record and both Codex/OpenCode projections were independently checked. |
| Codex fresh-session recall         | Passed                         | A separate read-only Codex session called memory_context and returned the saved colour. The new prompt did not contain the colour, the session IDs differed, and no write tools were called.                                                                                                                     |
| OpenCode model retrieval           | Blocked                        | Its selected provider returned HTTP 429 / Token Plan quota exhausted before a usable model turn. MCP connectivity alone is not counted as model retrieval.                                                                                                                                                       |
| Cross-agent model save/recall      | Passed: Codex ↔ Claude Code    | Claude Code 2.1.278 retrieved a Codex-written fixture through MCP, saved a second fixture with a verified receipt, and a fresh Codex session retrieved that second fixture. OpenCode model recall remains unverified.                                                                                            |
| Native hook loading                | Not tested in real hosts       | These runs deliberately used tools-only setup. Generated hook callbacks remain covered by programmatic tests.                                                                                                                                                                                                    |
| Model extraction quality           | Not run                        | Eight labeled cases and a strict grader are supplied, but no actual model extraction run is reported.                                                                                                                                                                                                            |

The first Codex model run attempted a descriptive request ID instead of a UUID and fabricated source identifiers. The tool call was blocked before server-side validation. Tool schema descriptions and server instructions were strengthened to require a UUID and real source IDs, with legacy remember/update as the documented fallback when provenance is unavailable. After the guidance change, the explicitly authorized retry correctly used memory_remember with source=null and verified its receipt with memory_checkpoint. It did not invent source identifiers. This validates the unknown-provenance fallback in one real interaction; evidence-backed memory_submit and general extraction accuracy are not established by this run. The program still cannot independently authenticate source declarations.

## Retrieval baseline

Dataset version 1 contains 11 notes and 13 retrieval cases:

| Group                     | Cases | Macro Recall@5 | Macro returned-result precision@5 | MRR   |
| ------------------------- | ----- | -------------- | --------------------------------- | ----- |
| Lexical                   | 10    | 1.000          | 0.929                             | 1.000 |
| Semantic / cross-language | 3     | 0.000          | N/A (no results)                  | 0.000 |

No foreign-project, deleted or unresolved-conflict notes leaked into tested results or injected context. Empty-result lexical cases produced no false positives. Recall/MRR exclude cases with no expected matches; precision excludes queries returning nothing. These denominators are documented in the evaluation guide.

This baseline confirms basic lexical behavior while demonstrating the missing synonym and cross-language capability. It is too small and hand-authored to establish general retrieval accuracy. Preserve the semantic misses in reports; add reviewed real failure cases before using scores to choose an embedding or reranking approach.

Reproduce protocol/config discovery with `pnpm test:hosts` and retrieval with `pnpm eval`. See [diagnostics and evaluation](diagnostics-and-evaluation.md) for supplying actual extraction outputs and interpreting incomplete runs.

## Optional hybrid retrieval implementation

The optional embedding path is covered by nine local HTTP fixture tests: disabled/invalid configuration, explicit indexing and cache reuse, scope/version/deletion/conflict filtering, malformed vectors and provider failures, concurrent writers, pause during network requests, empty semantic results, timeout fallback, and CLI/MCP integration. These fixture vectors verify mechanics only. No real embedding-model quality result is claimed; `pnpm eval:semantic` now provides the opt-in paired comparison with the lexical baseline. Native hook injection remains lexical.

Validation for this addition: the full Node 26 suite passed all 70 tests, with formatting and type checks passing. The final semantic and MCP/settings suites passed all 25 tests on Node 24, including the evaluation command against a synthetic provider and paused CLI inspection. The deterministic lexical baseline remains Recall@5=1.000 with no scope/deletion/conflict leaks. No production memories were sent to an embedding provider.

## Codex ↔ Claude Code model round trip

At the user's request, Claude Code replaced OpenCode for cross-agent model validation. The disposable project and synthetic store from the original Codex run were reused; `setup claude --tools-only` installed its generated MCP binding without touching the real repository's agent configuration.

- Claude Code 2.1.278 called `memory_context` and retrieved the Codex-written colour `turquoise`; that colour was absent from the Claude prompt.
- Claude called `memory_remember` with explicit project intent to save `Integration return marker is amber-otter-834.` The store returned note `bc45c437-876a-4e71-9f47-51c9e76aeab6`, version 1. `memory_checkpoint` returned `verified: true`. Provenance remained null because actual source identifiers were unavailable.
- An independent SQLite read confirmed the saved record, and the Codex, Claude and OpenCode projection files all contained the return marker.
- A fresh Codex session called `memory_context` and returned exactly `amber-otter-834`; the marker value was absent from its prompt. Its event log contains no shell/file operations or memory writes.

Claude ran with built-in tools disabled, only the generated Co-memo MCP binding, a narrow tool allowlist, no session persistence and hooks disabled. The initial reverse Codex call was denied by the host's `never` approval policy. An attempted broader auto-approval retry was rejected by automatic approval review and did not run. The successful retry retained the `read-only` sandbox and used documented invocation-only per-tool approval overrides for `memory_context`, `memory_recall` and `memory_settings_get`, with only those MCP tools enabled. No global host permission configuration was changed. Embeddings were disabled throughout, so this establishes lexical MCP-based cross-agent sharing, not semantic quality, automatic extraction or native hook loading.

The read/write operations were explicitly requested by the integration prompts. This single successful scenario is not evidence that either agent will always choose to save or recall without prompting. The original OpenCode provider-quota limitation remains separate from this passed Codex/Claude round trip.

## Co-memo 0.6 onboarding and worktree verification

The new `co-memo verify --from codex --to claude --round-trip` command passed both directions using actual installed host models: Codex → Claude in approximately 30.4 seconds and Claude → Codex in approximately 22.3 seconds. Both directions required observed saves, verified receipts, independent central-store checks, fresh-session MCP retrieval of randomly generated values omitted from reader prompts, and no note mutations during the reader phase. Temporary data was removed after completion. Embeddings were disabled; native hooks and autonomous extraction were not tested.

The full Node 26 regression suite passed 78 tests before the final nested-worktree boundary addition. After that fix, all 29 Node 24 onboarding, verification-parser, diagnostics and MCP/settings tests passed, including the new nested-worktree isolation case. Formatting, type checking and the lexical evaluation gate passed. Schema 3 → 4 migration tests preserve notes, replica IDs, baselines and pending publication state. Setup tests verify read-only preview, multi-agent preflight, stale-plan rejection, repeatability and actual MCP probes.

Worktree sharing is deliberately explicit and project-wide. The current version does not add a branch/task memory scope or automatically merge existing independent project stores. See [guided setup and worktrees](onboarding-and-worktrees.md).

## Native Claude hooks — 2026-09-24

The new opt-in `pnpm test:hooks` check passed locally with Claude Code 2.1.281. The real host launched the instrumented generated SessionStart, UserPromptSubmit and Stop commands, all with exit status 0. Both input events delivered the synthetic random memory through Hook output. With MCP and built-in tools disabled, the model returned the random value, which was absent from its prompt. Stop completed synchronization and did not inject context, as intended. No real user memories, repository source or global settings were used or modified; temporary project/data files were cleaned up.

This establishes controlled native Hook dispatch and model-visible delivery for that host version. It does not establish autonomous extraction or behavior with arbitrary user plugins. Earlier entries above describe the checks available at their respective dates.

## Autonomous extraction and scale regression — 2026-09-24

The real Claude autonomous run passed all seven isolated scenarios. Host-reported model: `claude-opus-5-5`. It saved an implicit SQLite/offline project decision and a Chinese-language user preference with `intent=automatic`, and changed the existing npm decision to pnpm on the same memory ID at version 2. Speculation, a one-off response format, explicit-only mode and pause generated no write attempts. Saved synthetic text and actual tool-call summaries are retained in [the evaluation output](../evals/results/claude-autonomous-2026-09-24.json). These narrow content checks were also manually reviewed; no broad model-quality claim follows from seven cases.

The 1,011-memory scale regression passed: lexical Recall@5 1.0, MRR 1.0, precision approximately 0.646, zero forbidden-scope/deletion/conflict leaks, zero empty-query false positives and zero context-budget violations. Local p95 search latency was approximately 1.15 ms; timings vary by machine. All three semantic-only queries remained misses under lexical search. See [the full scale output](../evals/results/retrieval-scale-2026-09-24.json). The observed precision gap is retained transparently rather than masking distractors or weakening expected labels.
