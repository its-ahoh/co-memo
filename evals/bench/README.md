# Agent benchmark

Measures whether Co-memo makes a real coding agent follow rules it was told earlier.

Each case has two parts:

1. **Teach**: a read-only session where the user mentions a rule in passing (for example, "this project uses pnpm, not npm").
2. **Exam**: a fresh session that gets an ordinary coding task and never mentions the rule. A script checks whether the agent followed it anyway.

The same tasks run in three arms:

| Arm      | What it does                                            | Why                   |
| -------- | ------------------------------------------------------- | --------------------- |
| `none`   | No memory                                               | Baseline              |
| `comemo` | Co-memo installed; the agent decides what to save       | What we are measuring |
| `oracle` | No memory, but the rule is written into the exam prompt | Best possible score   |

Two **harm** cases check the opposite: another project's rule, or a one-off request, must not be carried over.

## Before you start

- Node `>= 24.12`, `pnpm`, `git`
- The `claude` CLI installed and logged in (the benchmark uses your normal Claude login)
- Run from the repository root

The benchmark spends real model usage and counts against your Claude session limits. It is not part of CI.

## Run it

```sh
# Full run: all 3 arms, 3 repetitions (about 30–60 min, roughly $7–10)
pnpm bench --report report.md > results.json

# Only the Co-memo arm (about 15 min, roughly $5)
pnpm bench --arms comemo --report report.md > results.json

# Quick try: one case, once (about 2 min, well under $1)
pnpm bench --reps 1 --cases pnpm-only
```

`pnpm bench` builds the project first. Each run uses fresh temporary folders and a temporary database. It never touches your real memories, and it ignores your own `CLAUDE.md`, hooks, plugins and Claude's built-in auto-memory.

## Options

| Option          | Default              | Meaning                                                      |
| --------------- | -------------------- | ------------------------------------------------------------ |
| `--reps N`      | `3`                  | Repetitions per case and arm (agents vary between runs)      |
| `--jobs N`      | `3`                  | Sessions to run in parallel                                  |
| `--cases a,b`   | all                  | Only these case IDs (see `cases.mjs`)                        |
| `--arms a,b`    | `none,comemo,oracle` | Only these arms                                              |
| `--model NAME`  | CLI default          | Model passed to `claude --model`                             |
| `--budget USD`  | `1`                  | Spending cap per session                                     |
| `--report PATH` | none                 | Also write a Markdown report                                 |
| `--keep`        | off                  | Keep the temporary project folders to see what the agent did |

## Read the results

- **Terminal**: a short table per case and arm, then the totals.
- **`report.md`**: the full report, with the headline numbers, the Co-memo funnel, a per-case table and every failure with its details.
- **`results.json`**: raw data for every run (commands, saved notes, memory tool calls, check details, cost).

The headline number is **rule followed (benefit cases)** for each arm. Compare arms with each other rather than reading a single score on its own.

For the Co-memo arm, the funnel shows where points are lost:

| Step      | Question                                            | If this is low, look at…   |
| --------- | --------------------------------------------------- | -------------------------- |
| Saved     | Was the rule stored after the teach session?        | saving instructions        |
| Retrieved | Did a memory tool return that note during the exam? | context selection / search |
| Followed  | Did the check pass?                                 | how notes are presented    |

## Compare runs

Merge several result files into one report. For each arm, the last file that has it wins. This lets you re-run only Co-memo and compare it with an older baseline:

```sh
node scripts/bench-report.mjs evals/results/bench-claude-2026-10-26.json results.json > report.md
```

To keep a run, save it as `evals/results/bench-claude-YYYY-MM-DD.json` (and the report as `...-report.md`).

## If it stops early

The run stops after 3 errors and is marked `incomplete`. The usual cause is the Claude session limit. Each error's message is saved in `results.json`. Wait for the limit to reset, then run again.

## Add or change a case

All cases live in `cases.mjs`. Each one has `teach` prompts, an `exam` prompt, an `oracle` rule (or `null` for harm cases), a `memory` pattern for the funnel, and a `check` function that looks only at objective results (files, diffs, shell commands, commits, final reply).

Good cases use rules that differ from what an agent would do by default. If the `none` arm already passes a case almost every time, the case is too easy.

After any change, add a passing and a failing outcome for the case to `test/bench-cases.test.mjs` and run it. This is free and calls no model:

```sh
node --test test/bench-cases.test.mjs
```

Design notes (in Chinese): [`../benchmark-design.md`](../benchmark-design.md).
