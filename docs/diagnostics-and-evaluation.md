# Diagnostics and quality evaluation

## Diagnose an installation

```sh
co-memo --home /path/to/data --project /path/to/project doctor codex
co-memo --home /path/to/data --project /path/to/project doctor opencode --probe
```

Omit the agent to inspect every registered replica in the project. Static checks open the database read-only, check schema/integrity/project registration, inspect effective pause/explicit-only state, count scoped conflicts, compare projections with the central store, check index coverage, and inspect generated configuration/skills/instructions. They do not create or migrate a database, repair files, import pending Markdown edits, or execute commands found in configuration files. Diagnostics return paths/counts, not stored memory text, evidence or credentials.

The optional probe starts **this installation's pinned Node/CLI**, only after finding a matching project/store MCP binding. It initializes MCP, discovers tools and reads settings. It never requests memory writes, synchronization or model inference. Opening the existing current-schema store can create SQLite journal/lock files; this is why probing is explicit. Arbitrary configured executables, shell hooks and plugins are never run by doctor. Pi uses the CLI, so MCP probing does not apply.

Checks return `pass`, `info`, `warn`, or `fail`, with remedies. CLI exit 2 means at least one failure; warnings alone exit 0. `hostVerified` remains false (an informational finding, not a failed check): checking files or speaking MCP directly cannot prove a host loaded its project config, approved hooks, or that a model followed memory instructions. Re-run `setup AGENT` to refresh generated files, preserving `--tools-only` and the intended OpenCode API version.

The `readiness` field separates configuration inspection, protocol probe results, and `hostMemoryLoaded: "unverified"`. This last state is deliberate: no durable observation of your currently running host is recorded. Ask that host to call `memory_context` and inspect its tool result. `init` also reports `delivery`: `agent-tool-call-required` for tools-only, or `hooks-configured-host-reload-required` when hooks are enabled.

## Real host readiness checks

```sh
pnpm test:hosts
```

This opt-in script discovers local Codex/OpenCode binaries, creates disposable stores/projects and isolated host configuration, and checks:

- Codex's own `mcp get` discovers the trusted disposable project's generated entry.
- OpenCode's own `mcp list` establishes a connection to the generated server.
- A direct protocol probe initializes the server, lists tools and reads settings.

It does not invoke a model, use provider credentials, modify real host configuration, or test hooks. Missing hosts and failed checks are reported rather than counted as passing. Ordinary CI does not require installed or authenticated coding agents.

For full model validation, use a disposable project and a synthetic fact: ask one host to save it with Co-memo, start a new task in the other host and ask it to recall the fact without putting the answer in the prompt. Inspect tool-call events and the central record/versions; an assistant merely repeating the test prompt is not proof. Test correction/deletion and a fresh conversation separately. Co-memo saveMode does not grant host tool approval. A noninteractive host with approval=never may read successfully while rejecting writes; use the host’s normal approval workflow, not disabled approvals or sandboxing. Model validation may consume account usage and requires an available authenticated provider.

Codex project MCP configuration depends on project trust; a successful direct server probe does not establish that trust. See the [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). OpenCode configuration precedence is described in its [official configuration documentation](https://opencode.ai/docs/config/).

## Retrieval evaluation

```sh
pnpm eval
# CI regression gate, after build:
node scripts/eval-quality.mjs --check
```

The versioned fixture in `evals/quality-cases.json` contains multilingual notes, technical identifiers, module labels, another project's notes, tombstones and unresolved conflicts. It measures actual `Store.search` top-five results and checks that context excludes forbidden notes. Lexical and semantic cases are reported separately, including returned keys so failures can be inspected.

Metrics include macro recall@5 and reciprocal rank over queries with relevant notes; precision is averaged over queries returning results (the denominator is the number actually returned, capped at five). Empty-result expectations have a separate false-positive count. No-result precision is null, not silently treated as 100%. Timings are diagnostic, not a cross-machine performance guarantee.

The CI gate requires lexical recall >= 0.9, no false positives for empty-result lexical cases, and no scope/deletion/conflict leakage. Semantic misses are reported without pretending lexical search can solve them. This small hand-authored fixture is a regression baseline, not a general benchmark or a claim about real-world accuracy. Extend it with reviewed, anonymized failure cases before tuning retrieval.

## Extraction evaluation

Default evaluation returns `extraction.status = not_run`. Persistence tests and authored candidates are not evidence that a model extracted the right memories.

Eight labeled cases cover preferences, decisions, corrections, speculation, temporary requests, unverified assistant claims, explicit-only mode and pause. Generate blind inputs with `node scripts/eval-quality.mjs --extraction-inputs`. Feed **only the messages, settings and existing notes**, not the expected answers, to the agent under evaluation. Record its actual output as:

```json
{
  "run": {
    "agent": "actual-agent",
    "model": "actual-model",
    "timestamp": "2026-09-22T00:00:00Z"
  },
  "cases": [
    {
      "caseId": "preference",
      "memories": [
        {
          "content": "the actual extracted text",
          "kind": "preference",
          "scope": "user",
          "sourceMessageId": "u1"
        }
      ]
    }
  ]
}
```

Include every case, using `memories: []` when nothing should be saved; correction predictions include `replaces` with the existing fact's key. Then run:

```sh
node scripts/eval-quality.mjs --extractions /path/to/actual-output.json --check
```

The grader checks reviewed text aliases, kind, scope, evidence-message ID and replacement target. Duplicate predictions count as false positives, missing expected facts as false negatives, and omitted cases make the run incomplete. Unknown/duplicate case IDs are rejected. This deliberately strict grader can reject a valid paraphrase: inspect errors and review aliases rather than describing it as semantic accuracy. Run metadata is caller-declared, not authenticated. Synthetic oracle outputs appear only in grader unit tests, never as reported model extraction performance.

## Optional embedding comparison

`pnpm eval:semantic` runs the same synthetic retrieval fixture with an explicitly configured embedding provider and compares it with the lexical baseline. It uses a temporary store, never production memories. Provider fallback makes the report incomplete. See [semantic retrieval](semantic-retrieval.md) for configuration, thresholds and the optional quality gate. The deterministic baseline above remains model-free.

## Real Claude lifecycle hooks

```sh
pnpm test:hooks
```

This opt-in check uses the installed Claude CLI and existing login/model quota (one invocation with `--max-budget-usd 1`), never ordinary CI. It creates a disposable project/store with a random synthetic fact and instruments the generated local Hook commands to record their actual completion. Only local settings are selected; MCP servers, built-in tools and slash commands are disabled. The model must return a random value absent from its prompt, and SessionStart/UserPromptSubmit must have delivered it through `additionalContext`. Stop must also complete successfully. No broad permission bypass is used.

The script prints only verification results and removes its temporary data on completion or handled failure. An externally killed process can leave temporary files. Host authentication, quota, project trust or incompatible CLI behavior can cause failure. This validates native event dispatch plus memory delivery under these controlled settings; it does not validate automatic memory extraction, arbitrary global plugin combinations, or every host version.

## Autonomous saving evaluation

```sh
pnpm eval:autonomous
```

This opt-in evaluation runs seven isolated Claude sessions using the installed CLI and existing authentication, with a per-invocation budget flag of USD 1. It is not part of CI. Prompts describe ordinary project decisions/preferences/corrections or temporary/speculative requests; none explicitly requests memory saving. Generated Co-memo instructions and its MCP tools remain available, while built-in tools, hooks and slash commands are disabled. Only local settings are loaded. No target answer or grading rubric is sent to the model.

The evaluator checks actual successful tool calls, `automatic` intent, central-store contents, user/project scope, and same-ID version advancement for a correction. Non-save cases must not even attempt a write: a policy-rejected attempted save does not count as good extraction. A launch/quota/model failure stops the run as incomplete. Regex-based content checks are deliberately narrow and the output includes synthetic saved text for manual review. Passing these seven examples is not a general accuracy estimate, evidence of factual verification, or proof across all models and long conversations.

## Larger retrieval regression

```sh
pnpm eval:scale
```

Dataset version 2 adds full-width characters, mixed-language terms, path separators, quoted queries and negative/punctuation queries. Scale mode adds 1,000 reproducible synthetic distractors, including partial keyword overlap and inaccessible foreign-project notes. CI checks Recall@5 >= 0.9, zero forbidden-memory leaks/false positives for empty-result queries, and the context character budget. Reports include precision and p95 query latency; there is no hardware-independent latency gate.

This is a stress regression, not a real-user benchmark. The current large-corpus run still retrieves some weak partial matches, and lexical search still misses the three semantic-only cases. Do not tune away these limits by relabeling the fixtures or claim embedding accuracy without running an actual provider evaluation. Optional semantic retrieval remains off by default.
