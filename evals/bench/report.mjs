// Render benchmark results as a Markdown report. Later runs replace earlier runs' results
// for the same arm, so a re-run of one arm can be compared against an older baseline.
import { cases } from './cases.mjs';

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const rate = (rows, key = 'pass') =>
  rows.length ? rows.filter((r) => r[key]).length / rows.length : null;
const cell = (rows) => (rows.length ? `${rows.filter((r) => r.pass).length}/${rows.length}` : '—');
const order = ['none', 'comemo', 'oracle'];
const label = { none: 'No memory', comemo: 'Co-memo', oracle: 'Rule in prompt' };

export function merge(runs) {
  const byArm = new Map();
  for (const run of runs) for (const arm of run.arms) byArm.set(arm, run);
  const arms = order.filter((a) => byArm.has(a));
  const results = arms.flatMap((arm) => byArm.get(arm).results.filter((r) => r.arm === arm));
  return { arms, results, sources: arms.map((arm) => [arm, byArm.get(arm)]) };
}

export function render(runs) {
  const { arms, results, sources } = merge(runs);
  const scored = results.filter((r) => !r.error);
  const errors = results.length - scored.length;
  const cost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
  const of = (filter) => scored.filter(filter);
  const benefit = (arm) => of((r) => r.arm === arm && r.kind === 'benefit');
  const harm = (arm) => of((r) => r.arm === arm && r.kind === 'harm');
  const memory = benefit('comemo');
  const lines = [];
  const row = (...cells) => lines.push(`| ${cells.join(' | ')} |`);
  const rule = (n) => row(...Array(n).fill('---'));

  lines.push('# Co-memo agent benchmark', '');
  lines.push(
    'Each case teaches a rule in one session, then gives a fresh session a coding task that ' +
      'never mentions it. Checks inspect files, commands, commits and replies; the model never ' +
      'grades itself.',
    '',
  );
  row('Arm', 'Run', 'Model', 'Repetitions');
  rule(4);
  for (const [arm, run] of sources)
    row(
      label[arm],
      run.timestamp?.slice(0, 16).replace('T', ' ') ?? '—',
      run.model ?? '—',
      run.reps,
    );
  lines.push('', '## Result', '');
  row('', ...arms.map((a) => label[a]));
  rule(arms.length + 1);
  row('**Rule followed** (benefit cases)', ...arms.map((a) => `**${pct(rate(benefit(a)))}**`));
  row('Nothing wrong carried over (harm cases)', ...arms.map((a) => pct(rate(harm(a)))));
  if (arms.includes('none') && arms.includes('comemo')) {
    const gain = rate(benefit('comemo')) - rate(benefit('none'));
    lines.push(
      '',
      `Co-memo changes the rule-following rate by **${gain >= 0 ? '+' : ''}${Math.round(gain * 100)} points** over no memory.`,
    );
  }
  if (memory.length) {
    lines.push('', '## Where Co-memo loses points', '');
    lines.push('For benefit cases in the Co-memo arm:', '');
    row('Step', 'Rate', 'Meaning');
    rule(3);
    row(
      'Saved',
      pct(rate(memory, 'saved')),
      'the taught rule was stored after the teaching session',
    );
    row(
      'Retrieved',
      pct(rate(memory, 'retrieved')),
      'a memory tool returned that note during the task',
    );
    row('Followed', pct(rate(memory)), 'the objective check passed');
    const leaked = harm('comemo');
    if (leaked.length)
      lines.push(
        '',
        `Harm cases: a wrong note was returned in ${pct(rate(leaked, 'retrieved'))} of runs.`,
      );
  }
  lines.push('', '## By case', '');
  row('Case', 'Kind', ...arms.map((a) => label[a]));
  rule(arms.length + 2);
  for (const item of cases) {
    const rows = arms.map((a) => of((r) => r.case === item.id && r.arm === a));
    if (rows.every((r) => !r.length)) continue;
    row(`\`${item.id}\``, item.kind, ...rows.map(cell));
  }
  const failures = scored.filter((r) => !r.pass);
  if (failures.length) {
    lines.push('', '## Failures', '');
    for (const r of failures) {
      const funnel =
        r.arm === 'comemo' ? ` (saved: ${!!r.saved}, retrieved: ${!!r.retrieved})` : '';
      lines.push(
        `- \`${r.case}\` ${label[r.arm]} #${r.rep}${funnel}: \`\` ${JSON.stringify(r.detail)} \`\``,
      );
    }
  }
  lines.push('', '## Notes', '');
  lines.push(`- ${scored.length} scored runs, ${errors} errors, cost $${cost.toFixed(2)}.`);
  lines.push(
    '- Harm cases check that another project\'s rule or a one-off request is not carried over; "Rule in prompt" does not apply to them.',
    '- Small synthetic benchmark with hand-written rules chosen to differ from common defaults. Results vary between runs: compare arms, not absolute scores.',
    '- Co-memo runs in the default tools-only mode with lexical retrieval.',
  );
  return lines.join('\n') + '\n';
}
