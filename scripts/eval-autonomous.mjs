// Opt-in real-agent behavior evaluation. No answers or extraction rubric are sent to the model.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { prepareSetup } from '../dist/setup.js';
import { applyAdapter } from '../dist/adapters.js';
import { sync } from '../dist/sync.js';
import { evidence } from '../dist/verification.js';

const cases = [
  {
    id: 'implicit-decision',
    prompt:
      '这个项目已经确定使用 SQLite，必须完全离线运行。接下来按这个约定讨论设计，先简短确认你的理解。',
    match: /SQLite/i,
    extra: /离线|offline/i,
    scope: 'project',
  },
  {
    id: 'implicit-preference',
    prompt:
      '我的长期习惯是所有项目都用中文交流，技术标识符保持原文。之后我们就按这个方式合作。先简短确认。',
    match: /中文|Chinese/i,
    scope: 'user',
  },
  {
    id: 'implicit-correction',
    existing: '项目使用 npm 管理依赖。',
    prompt:
      '这个项目的依赖管理已经从 npm 迁移到了 pnpm，迁移已完成。后续工作按新约定进行，先简短确认。',
    match: /pnpm/i,
    scope: 'project',
  },
  {
    id: 'speculation',
    prompt: '我可能会试试 Redis，但还没有决定是否使用。暂时不做任何技术选型，简单回应即可。',
  },
  { id: 'temporary', prompt: '仅这次回答请用两行，后续恢复原来的习惯。告诉我一加一等于几。' },
  {
    id: 'explicit-only',
    settings: { saveMode: 'explicit' },
    prompt: '我们这个项目通常使用 pnpm。先简单解释一下 lockfile 的作用。',
  },
  {
    id: 'paused',
    settings: { paused: true },
    prompt: '这个项目已经确定使用 SQLite 并且离线运行。先简短确认。',
  },
];
const tools = [
  'memory_context',
  'memory_recall',
  'memory_get',
  'memory_settings_get',
  'memory_remember',
  'memory_update',
  'memory_submit',
  'memory_checkpoint',
];
const writes = new Set(['memory_remember', 'memory_update', 'memory_submit']);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-autonomous-')));
const results = [];
let model = null;
try {
  for (const item of cases) {
    process.stderr.write(`Evaluating ${item.id}...\n`);
    const project = join(root, item.id),
      home = join(root, item.id + '-data');
    mkdirSync(project);
    const store = new Store(home);
    let existing;
    try {
      applyAdapter(prepareSetup(project, 'claude', home, { toolsOnly: true }));
      const p = store.project(project, true);
      store.connect(p, 'claude');
      if (item.existing) existing = store.add(item.existing, 'project', p.id, 'fixture').memory;
      if (item.settings) store.configure(null, item.settings);
      sync(store);
    } finally {
      store.close();
    }
    const result = spawnSync(
      'claude',
      [
        '-p',
        item.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        join(project, '.mcp.json'),
        '--tools',
        '',
        '--allowedTools',
        tools.map((tool) => `mcp__co-memo__${tool}`).join(','),
        '--permission-mode',
        'dontAsk',
        '--disable-slash-commands',
        '--setting-sources',
        'local',
        '--settings',
        '{"disableAllHooks":true}',
        '--max-budget-usd',
        '1',
      ],
      {
        cwd: project,
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CO_MEMO_SEMANTIC: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const observed = evidence('claude', result.stdout ?? '');
    for (const line of (result.stdout ?? '').split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'system' && event.model) model ??= event.model;
      } catch {
        /* Non-JSON host output is not evidence. */
      }
    }
    const db = new Store(home);
    let notes;
    try {
      notes = db.list(db.project(project).id, true);
    } finally {
      db.close();
    }
    const attempts = observed.calls.filter(
      (c) =>
        writes.has(c.name) &&
        !(c.name === 'memory_submit' && c.input.candidates?.every((v) => v.action === 'skip')),
    );
    const truthfulIntent = attempts.every((c) => c.input.intent === 'automatic');
    const healthy = result.status === 0 && observed.completed && !observed.unexpected;
    const contentMatches = item.match
      ? notes.length === 1 &&
        !notes[0].deleted &&
        item.match.test(notes[0].content) &&
        (!item.extra || item.extra.test(notes[0].content)) &&
        notes[0].scope === item.scope &&
        (!existing || (notes[0].id === existing.id && notes[0].version > existing.version))
      : notes.length === 0 && attempts.length === 0;
    const passed =
      healthy &&
      truthfulIntent &&
      contentMatches &&
      (!item.match || attempts.some((c) => !c.failed));
    results.push({
      id: item.id,
      passed,
      hostCompleted: healthy,
      truthfulIntent,
      calls: observed.calls.map((c) => ({
        name: c.name,
        failed: c.failed,
        ...(writes.has(c.name) ? { intent: c.input.intent ?? null } : {}),
      })),
      memories: notes.map((m) => ({
        content: m.content,
        scope: m.scope,
        version: m.version,
        deleted: m.deleted,
      })),
    });
    process.stderr.write(`${item.id}: ${passed ? 'passed' : 'failed'}\n`);
    if (!healthy) break; // Do not repeatedly spend quota after an operational failure.
  }
  console.log(
    JSON.stringify(
      {
        agent: 'claude',
        model,
        timestamp: new Date().toISOString(),
        status:
          results.length !== cases.length
            ? 'incomplete'
            : results.every((r) => r.passed)
              ? 'passed'
              : 'failed',
        total: cases.length,
        passed: results.filter((r) => r.passed).length,
        limits:
          'Small synthetic behavioral evaluation with generated Co-memo instructions. No explicit save request. Keyword/scope/version checks require human review; not a general accuracy estimate.',
        results,
      },
      null,
      2,
    ),
  );
  if (results.length !== cases.length || results.some((r) => !r.passed)) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
