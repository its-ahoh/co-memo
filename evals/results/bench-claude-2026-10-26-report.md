# Co-memo agent benchmark

Each case teaches a rule in one session, then gives a fresh session a coding task that never mentions it. Checks inspect files, commands, commits and replies; the model never grades itself.

| Arm | Run | Model | Repetitions | Status |
| --- | --- | --- | --- | --- |
| No memory | 2026-10-26 19:54 | claude-opus-5-5 | 3 | complete |
| Co-memo | 2026-10-26 20:00 | claude-opus-5-5 | 3 | **incomplete** |
| Rule in prompt | 2026-10-26 19:54 | claude-opus-5-5 | 3 | complete |

> **Incomplete:** Co-memo did not finish every case. Rates cover only the cases that ran; the comparison below uses only cases scored in both arms.

## Result

|  | No memory | Co-memo | Rule in prompt |
| --- | --- | --- | --- |
| **Rule followed** (benefit cases) | **52%** | **100%** | **100%** |
| Nothing wrong carried over (harm cases) | 100% | 100% | — |

Co-memo changes the rule-following rate by **+48 points** over no memory (7 shared cases).

## Where Co-memo loses points

For benefit cases in the Co-memo arm:

| Step | Rate | Meaning |
| --- | --- | --- |
| Saved | 100% | the taught rule was stored after the teaching session |
| Retrieved | 100% | a memory tool returned that note during the task |
| Followed | 100% | the objective check passed |

Harm cases: a wrong note was returned in 0% of runs.

## By case

| Case | Kind | No memory | Co-memo | Rule in prompt |
| --- | --- | --- | --- | --- |
| `pnpm-only` | benefit | 2/3 | 2/2 | 3/3 |
| `spec-dir` | benefit | 0/3 | 2/2 | 3/3 |
| `use-logger` | benefit | 3/3 | 1/1 | 3/3 |
| `chinese-errors` | benefit | 0/3 | 1/1 | 3/3 |
| `legacy-frozen` | benefit | 3/3 | 1/1 | 3/3 |
| `jest-corrected` | benefit | 3/3 | 1/1 | 3/3 |
| `commit-style` | benefit | 0/3 | 1/1 | 3/3 |
| `scope-isolation` | harm | 3/3 | 1/1 | — |
| `temporary-request` | harm | 3/3 | 1/1 | — |

## Failures

- `spec-dir` No memory #1: `` {"tests":["test/cart.test.js"]} ``
- `pnpm-only` No memory #1: `` {"usedPnpm":false,"npmCommands":["npm test 2>&1 | tail -20; node -e \"import('./src/cart.js').then(({total})=>{const i=[{price:10,qty:2},{price:5,qty:1}];console.log(total(i),total(i,0.2),total(i,1));try{total(i,1.5)}catch(e){console.log(e.message)}})\""],"lock":false} ``
- `chinese-errors` No memory #1: `` {"throws":["    throw new TypeError(`items[${index}] must be an object`);","    throw new TypeError(`items[${index}].price must be a non-negative number`);","    throw new TypeError(`items[${index}].qty must be a positive integer`);","    throw new TypeError('items must be an array');"]} ``
- `commit-style` No memory #1: `` {"commits":2,"subject":"Clarify variable names in cart total()"} ``
- `spec-dir` No memory #2: `` {"tests":["test/cart.test.js"]} ``
- `chinese-errors` No memory #2: `` {"throws":["    throw new TypeError('items must be an array');","      throw new TypeError(`items[${i}] must be an object`);","      throw new TypeError(`items[${i}].price must be a non-negative number`);","      throw new TypeError(`items[${i}].qty must be a positive integer`);"]} ``
- `commit-style` No memory #2: `` {"commits":2,"subject":"Rename variables in cart total for clarity"} ``
- `spec-dir` No memory #3: `` {"tests":["test/cart.test.js"]} ``
- `chinese-errors` No memory #3: `` {"throws":["    throw new TypeError('items must be an array');","      throw new TypeError(`items[${i}] must be an object`);","      throw new RangeError(`items[${i}].price must be a non-negative number`);","      throw new RangeError(`items[${i}].qty must be a positive integer`);"]} ``
- `commit-style` No memory #3: `` {"commits":2,"subject":"Clarify variable names in cart total"} ``

## Notes

- 59 scored runs, 4 errors, cost $5.32.
- Harm cases check that another project's rule or a one-off request is not carried over; "Rule in prompt" does not apply to them.
- Small synthetic benchmark with hand-written rules chosen to differ from common defaults. Results vary between runs: compare arms, not absolute scores.
- Co-memo runs in the default tools-only mode with lexical retrieval.
