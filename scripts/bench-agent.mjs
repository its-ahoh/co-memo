// Opt-in agent benchmark: does Co-memo make a real agent follow rules it was told earlier?
// Compares three arms on the same tasks: no memory, Co-memo, and the rule stated directly
// in the task (oracle). Spends model quota; see evals/benchmark-design.md.
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../dist/store.js';
import { prepareSetup } from '../dist/setup.js';
import { applyAdapter } from '../dist/adapters.js';
import { sync } from '../dist/sync.js';
import { cases, fixtureFor, git, observe, prepareWorkspace } from '../evals/bench/cases.mjs';
import { render } from '../evals/bench/report.mjs';

const { values: opts } = parseArgs({
  options: {
    reps: { type: 'string', default: '3' },
    jobs: { type: 'string', default: '3' },
    cases: { type: 'string' },
    arms: { type: 'string', default: 'none,comemo,oracle' },
    model: { type: 'string' },
    budget: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
    report: { type: 'string' },
  },
});
const reps = Number(opts.reps),
  jobs = Number(opts.jobs);
const arms = opts.arms.split(',');
const selected = opts.cases ? cases.filter((c) => opts.cases.split(',').includes(c.id)) : cases;
if (!selected.length || arms.some((a) => !['none', 'comemo', 'oracle'].includes(a)))
  throw new Error('Unknown case or arm');

const memoryTools = [
  'memory_context',
  'memory_recall',
  'memory_get',
  'memory_settings_get',
  'memory_remember',
  'memory_update',
  'memory_submit',
].map((t) => `mcp__co-memo__${t}`);
// Keep the user's own instructions, plugins, hooks and Claude's native auto-memory out of
// every arm, so Co-memo is the only memory that differs between arms.
const settings = JSON.stringify({
  disableAllHooks: true,
  autoMemoryEnabled: false,
  claudeMdExcludes: [join(homedir(), '.claude', 'CLAUDE.md')],
});

function claude(cwd, prompt, { tools, memory }) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    ...(memory ? ['--mcp-config', join(cwd, '.mcp.json')] : []),
    '--tools',
    tools.join(','),
    '--allowedTools',
    [...tools, ...(memory ? memoryTools : [])].join(','),
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--setting-sources',
    'local',
    '--settings',
    settings,
    '--max-budget-usd',
    opts.budget,
    ...(opts.model ? ['--model', opts.model] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, CO_MEMO_SEMANTIC: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve(parse(stdout, status));
    });
  });
}

/** Only observed tool calls and the host's result event count as evidence. */
function parse(stdout, status) {
  const out = {
    status,
    completed: false,
    final: '',
    commands: [],
    memoryResults: [],
    memoryCalls: [],
  };
  const names = new Map();
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.model) out.model ??= event.model;
    if (event.type === 'result') {
      out.completed = event.is_error === false;
      out.final = event.result ?? '';
      out.cost = event.total_cost_usd ?? 0;
      out.durationMs = event.duration_ms;
      out.turns = event.num_turns;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') {
        names.set(block.id, block.name);
        if (block.name === 'Bash') out.commands.push(String(block.input?.command ?? ''));
        if (block.name.startsWith('mcp__co-memo__'))
          out.memoryCalls.push({
            id: block.id,
            name: block.name.replace('mcp__co-memo__', ''),
            input: block.input,
          });
      } else if (block.type === 'tool_result') {
        if (names.get(block.tool_use_id)?.startsWith('mcp__co-memo__')) {
          const text =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          out.memoryResults.push(text);
          const call = out.memoryCalls.find((c) => c.id === block.tool_use_id);
          if (call) call.result = text.slice(0, 8000);
        }
      }
    }
  }
  return out;
}

function connect(home, dirs) {
  const store = new Store(home);
  try {
    for (const dir of dirs) {
      applyAdapter(prepareSetup(dir, 'claude', home, { toolsOnly: true }));
      store.connect(store.project(dir, true), 'claude');
    }
    sync(store);
  } finally {
    store.close();
  }
}

function notes(home, dir) {
  const store = new Store(home);
  try {
    return store.list(store.project(dir).id).map((m) => ({ content: m.content, scope: m.scope }));
  } finally {
    store.close();
  }
}

const healthy = (run) => run.status === 0 && run.completed;

async function trial(item, arm, rep, root) {
  const base = join(root, `${item.id}-${arm}-${rep}`);
  const home = join(base, 'data');
  const fixture = fixtureFor(item);
  const projects = [...new Set([...item.teach.map((t) => t.project), item.exam.project])];
  const dirs = Object.fromEntries(projects.map((p) => [p, join(base, p)]));
  for (const dir of Object.values(dirs)) prepareWorkspace(dir, fixture);
  const record = { case: item.id, kind: item.kind, arm, rep, cost: 0, durationMs: 0 };
  const memory = arm === 'comemo';
  let lesson = [];
  if (memory) {
    connect(home, Object.values(dirs));
    // Teaching is read-only, so without memory it could not change the exam; only the
    // Co-memo arm needs to run it.
    for (const lesson of item.teach) {
      const run = await claude(dirs[lesson.project], lesson.prompt, {
        tools: ['Read', 'Glob', 'Grep'],
        memory,
      });
      record.cost += run.cost ?? 0;
      record.durationMs += run.durationMs ?? 0;
      if (!healthy(run))
        return {
          ...record,
          error: `teach session failed (exit ${run.status}): ${run.final.slice(0, 200)}`,
        };
    }
    const saved = notes(home, dirs[item.exam.project]);
    record.saved = saved.some((n) => item.memory.test(n.content));
    record.notes = saved;
    // Notes written while teaching, wherever they landed (a harm case teaches elsewhere).
    lesson = item.teach
      .flatMap((t) => notes(home, dirs[t.project]))
      .filter((n) => item.memory.test(n.content));
  }
  const examDir = dirs[item.exam.project];
  git(examDir, 'reset', '-q', '--hard');
  const prompt = arm === 'oracle' ? `${item.oracle}\n\n${item.exam.prompt}` : item.exam.prompt;
  const run = await claude(examDir, prompt, {
    tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
    memory,
  });
  record.model = run.model;
  record.cost += run.cost ?? 0;
  record.durationMs += run.durationMs ?? 0;
  record.turns = run.turns;
  if (!healthy(run))
    return {
      ...record,
      error: `exam session failed (exit ${run.status}): ${run.final.slice(0, 200)}`,
    };
  if (memory) {
    record.memoryCalls = run.memoryCalls;
    // Compare note text, not the rule regex: Co-memo's own instructions can match a regex.
    const flat = (text) => text.replace(/[\\"\s]/g, '');
    record.retrieved = lesson.some((n) =>
      run.memoryResults.some((r) => flat(r).includes(flat(n.content))),
    );
  }
  const verdict = item.check(observe(examDir, fixture, run));
  return { ...record, pass: verdict.pass, detail: verdict.detail };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-bench-')));
const queue = [];
for (let rep = 1; rep <= reps; rep++)
  for (const item of selected)
    for (const arm of arms) if (arm !== 'oracle' || item.oracle) queue.push([item, arm, rep]);
const results = [];
let errors = 0;
async function worker() {
  while (queue.length && errors < 3) {
    const [item, arm, rep] = queue.shift();
    let r;
    try {
      r = await trial(item, arm, rep, root);
    } catch (error) {
      r = { case: item.id, kind: item.kind, arm, rep, error: String(error) };
    }
    if (r.error) errors++;
    results.push(r);
    process.stderr.write(
      `${item.id} ${arm} #${rep}: ${r.error ? 'ERROR ' + r.error : r.pass ? 'pass' : 'fail'}\n`,
    );
  }
}
try {
  process.stderr.write(`Running ${queue.length} trials in ${root}\n`);
  await Promise.all(Array.from({ length: jobs }, worker));
} finally {
  if (opts.keep) process.stderr.write(`Kept workspaces in ${root}\n`);
  else rmSync(root, { recursive: true, force: true });
}

const scored = results.filter((r) => !r.error);
const rate = (rows) => (rows.length ? rows.filter((r) => r.pass).length / rows.length : null);
const pct = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const cell = (rows) => (rows.length ? `${rows.filter((r) => r.pass).length}/${rows.length}` : '—');
const summary = {};
for (const arm of arms)
  for (const kind of ['benefit', 'harm'])
    summary[`${arm}.${kind}`] = rate(scored.filter((r) => r.arm === arm && r.kind === kind));
const memoryRows = scored.filter((r) => r.arm === 'comemo' && r.kind === 'benefit');
const funnel = {
  saved: rate(memoryRows.map((r) => ({ pass: r.saved }))),
  retrieved: rate(memoryRows.map((r) => ({ pass: r.retrieved }))),
  followed: rate(memoryRows),
  harmLeaked: rate(
    scored
      .filter((r) => r.arm === 'comemo' && r.kind === 'harm')
      .map((r) => ({ pass: r.retrieved })),
  ),
};

const pad = (s, n) => String(s).padEnd(n);
const lines = [`\n${pad('case', 20)}${arms.map((a) => pad(a, 10)).join('')}`];
for (const item of selected)
  lines.push(
    pad(`${item.id}${item.kind === 'harm' ? '*' : ''}`, 20) +
      arms
        .map((a) => pad(cell(scored.filter((r) => r.case === item.id && r.arm === a)), 10))
        .join(''),
  );
lines.push(
  pad('benefit total', 20) + arms.map((a) => pad(pct(summary[`${a}.benefit`]), 10)).join(''),
  pad('harm total*', 20) + arms.map((a) => pad(pct(summary[`${a}.harm`]), 10)).join(''),
  `\n* harm cases: memory must not carry over another project's rule or a one-off request.`,
  `Co-memo funnel (benefit cases): saved ${pct(funnel.saved)}, retrieved ${pct(funnel.retrieved)}, followed ${pct(funnel.followed)}`,
  `Harm cases: wrong note returned in ${pct(funnel.harmLeaked)} of Co-memo runs`,
  `Errors: ${results.length - scored.length}; cost $${results.reduce((s, r) => s + (r.cost ?? 0), 0).toFixed(2)}`,
);
process.stderr.write(lines.join('\n') + '\n');

const complete = !queue.length && !errors;
const output = {
  agent: 'claude',
  model: scored.find((r) => r.model)?.model ?? opts.model ?? null,
  timestamp: new Date().toISOString(),
  status: complete ? 'complete' : 'incomplete',
  reps,
  arms,
  summary,
  funnel,
  limits:
    'Small synthetic benchmark with hand-written rules chosen to differ from common defaults. Tools-only Co-memo mode, lexical retrieval. Results vary between runs; compare arms, not absolute scores.',
  results,
};
console.log(JSON.stringify(output, null, 2));
if (opts.report) writeFileSync(opts.report, render([output]));
if (!complete) process.exitCode = 1;
