// Agent benchmark cases: a rule is taught in one session, then a fresh session gets an
// ordinary coding task that never mentions the rule. Checks only inspect objective results
// (files, diffs, shell commands, commits, final text); the model never grades itself.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const baseFixture = {
  'package.json':
    JSON.stringify(
      {
        name: 'bench-shop',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    ) + '\n',
  'src/cart.js': `import { add } from './legacy/money.js';

export function total(items) {
  let sum = 0;
  for (const item of items) sum = add(sum, item.price * item.qty);
  return sum;
}
`,
  'src/legacy/money.js': `// Shared money helpers.
export function add(a, b) {
  return a + b;
}
`,
  'src/checkout.js': `import { total } from './cart.js';

export async function checkout(order, gateway) {
  const amount = total(order.items);
  const result = await gateway.charge(order.customerId, amount);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, amount };
}
`,
  'src/logger.js': `// Structured logger used across the app.
export function log(level, message, fields = {}) {
  process.stderr.write(
    JSON.stringify({ level, message, ...fields, time: new Date().toISOString() }) + '\\n',
  );
}
`,
};

const ignored = new Set(['.git', 'node_modules', '.claude', 'CLAUDE.local.md', '.mcp.json']);
export function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[relative(dir, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return files;
}

export function git(dir, ...args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Write a fixture and commit it so the agent sees an ordinary repository. */
export function prepareWorkspace(dir, fixture) {
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(fixture)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const steps = [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'Bench User'],
    ['config', 'user.email', 'bench@example.com'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'Initial version'],
  ];
  for (const step of steps) {
    const result = git(dir, ...step);
    if (result.status !== 0) throw new Error(`git ${step[0]} failed: ${result.stderr}`);
  }
}

/** Build what checks may look at. `commands` are Bash tool inputs observed in the run. */
export function observe(dir, fixture, { commands = [], final = '' } = {}) {
  const files = snapshot(dir);
  const added = Object.keys(files).filter((p) => !(p in fixture));
  const changed = Object.keys(files).filter((p) => p in fixture && files[p] !== fixture[p]);
  const removed = Object.keys(fixture).filter((p) => !(p in files));
  return { dir, fixture, files, added, changed, removed, commands, final };
}

const testFile = /\.(test|spec)\.[cm]?js$/;
const runs = (tool) => new RegExp(`(^|[\\s;&|(\`])${tool}(\\s|$)`);
const result = (pass, detail) => ({ pass, detail });
const newLines = (before, after) => {
  const old = new Set(before.split('\n'));
  return after.split('\n').filter((line) => !old.has(line));
};
const touched = (o, prefix) =>
  [...o.added, ...o.changed, ...o.removed].filter((p) => p.startsWith(prefix));
const cjk = /[㐀-鿿]/u;

function evaluate(dir, source) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10000,
  });
}

/**
 * kind: "benefit" cases should improve with memory; "harm" cases check memory does not
 * carry the wrong thing over (another project's rule, a one-off request).
 * oracle: the rule stated directly in the exam prompt (null for harm cases).
 * memory: what a correctly saved or retrieved note mentions, for the save/retrieve funnel.
 */
export const cases = [
  {
    id: 'pnpm-only',
    kind: 'benefit',
    memory: /pnpm/i,
    teach: [
      {
        project: 'main',
        prompt:
          '顺便说一下，这个项目统一用 pnpm 跑脚本和管理依赖，不要用 npm。先帮我看看 src/cart.js 大概做什么，简单说两句。',
      },
    ],
    exam: {
      project: 'main',
      prompt:
        '给 src/cart.js 的 total 加一个可选参数 discount（0 到 1 之间的小数，比如 0.2 表示减 20%），默认不打折。改完跑一下项目的测试。',
    },
    oracle: '项目约定：这个项目统一用 pnpm 跑脚本和管理依赖，不要用 npm。',
    check(o) {
      const npm = o.commands.filter((c) => runs('npm').test(c));
      const pnpm = o.commands.some((c) => runs('pnpm').test(c));
      const lock = 'package-lock.json' in o.files;
      return result(pnpm && !npm.length && !lock, { usedPnpm: pnpm, npmCommands: npm, lock });
    },
  },
  {
    id: 'spec-dir',
    kind: 'benefit',
    memory: /spec/i,
    teach: [
      {
        project: 'main',
        prompt:
          '我们这个项目的测试文件统一放在 spec/ 目录下，文件名用 xxx.test.js，不放 test/。你先看一下 src/ 里有哪些模块，简单列一下。',
      },
    ],
    exam: { project: 'main', prompt: '给 src/cart.js 的 total 写几个单元测试，跑一下确认通过。' },
    oracle: '项目约定：测试文件统一放在 spec/ 目录下，文件名用 xxx.test.js，不放 test/。',
    check(o) {
      const tests = o.added.filter((p) => testFile.test(p));
      return result(tests.length > 0 && tests.every((p) => p.startsWith('spec/')), { tests });
    },
  },
  {
    id: 'use-logger',
    kind: 'benefit',
    memory: /logger|console\.log/i,
    teach: [
      {
        project: 'main',
        prompt:
          '这个项目里不要直接用 console.log 之类的打印，日志统一走 src/logger.js 里的 log。先帮我看看 src/checkout.js 的流程，简单说两句。',
      },
    ],
    exam: {
      project: 'main',
      prompt: 'src/checkout.js 里支付失败时现在什么都不记录，排查问题很难。帮我在失败时加上日志。',
    },
    oracle: '项目约定：不要直接用 console.log 之类的打印，日志统一走 src/logger.js 里的 log。',
    check(o) {
      const code = [...o.added, ...o.changed].filter((p) => p.endsWith('.js'));
      const consoleUse = code.filter((p) =>
        newLines(o.fixture[p] ?? '', o.files[p]).some((l) => /console\.\w+\(/.test(l)),
      );
      const usesLogger = /logger(\.js)?['"]/.test(o.files['src/checkout.js'] ?? '');
      return result(o.changed.includes('src/checkout.js') && usesLogger && !consoleUse.length, {
        usesLogger,
        consoleUse,
      });
    },
  },
  {
    id: 'chinese-errors',
    kind: 'benefit',
    memory: /中文|Chinese/i,
    teach: [
      {
        project: 'main',
        prompt:
          '这个项目的用户都在国内，所以代码里抛出的错误信息一律用中文写。先帮我看看 src/cart.js 是做什么的，简单说两句。',
      },
    ],
    // English on purpose: a Chinese task prompt alone would nudge Chinese error messages.
    exam: {
      project: 'main',
      prompt:
        'Add input validation to total in src/cart.js: items must be an array, and each item needs a non-negative numeric price and a positive integer qty. Throw an error on invalid input.',
    },
    oracle: 'Project convention: every thrown error message must be written in Chinese.',
    check(o) {
      const lines = newLines(o.fixture['src/cart.js'], o.files['src/cart.js'] ?? '');
      const throws = lines.filter((l) => /throw\s+new\s+\w*Error\s*\(/.test(l));
      return result(throws.length > 0 && throws.every((l) => cjk.test(l)), { throws });
    },
  },
  {
    id: 'legacy-frozen',
    kind: 'benefit',
    memory: /legacy/i,
    teach: [
      {
        project: 'main',
        prompt:
          'src/legacy/ 下面是另一个团队维护的老代码，我们这边不要改里面的文件，需要的话在外面包一层。先帮我看看 src/ 的结构，简单说两句。',
      },
    ],
    exam: {
      project: 'main',
      prompt:
        'total([{ price: 0.1, qty: 1 }, { price: 0.2, qty: 1 }]) 现在返回 0.30000000000000004，应该是 0.3。帮我修一下金额计算的精度问题。',
    },
    oracle:
      '项目约定：src/legacy/ 是另一个团队维护的老代码，不要改里面的文件，需要的话在外面包一层。',
    check(o) {
      const legacy = touched(o, 'src/legacy/');
      const run = evaluate(
        o.dir,
        `import { total } from './src/cart.js';
const a = total([{ price: 0.1, qty: 1 }, { price: 0.2, qty: 1 }]);
const b = total([{ price: 19.99, qty: 3 }]);
if (a !== 0.3 || b !== 59.97) { console.error(a, b); process.exit(1); }`,
      );
      const fixed = run.status === 0;
      return result(fixed && !legacy.length, { fixed, legacyChanges: legacy });
    },
  },
  {
    id: 'jest-corrected',
    kind: 'benefit',
    memory: /node:test/i,
    fixture: {
      'package.json':
        JSON.stringify(
          { name: 'bench-shop', version: '1.0.0', private: true, type: 'module', scripts: {} },
          null,
          2,
        ) + '\n',
    },
    teach: [
      {
        project: 'main',
        prompt: '这个项目的单元测试用 Jest 写。先看看 src/cart.js 是做什么的，简单说两句。',
      },
      {
        project: 'main',
        prompt:
          '更正一下之前说的：我们已经不用 Jest 了，测试改用 Node 自带的 node:test，不要再引入 Jest。src/checkout.js 是做什么的？简单说两句。',
      },
    ],
    exam: { project: 'main', prompt: '给 src/cart.js 写几个单元测试。' },
    oracle: '项目约定：测试用 Node 自带的 node:test，不用 Jest。',
    check(o) {
      const tests = o.added.filter((p) => testFile.test(p));
      const nodeTest = tests.some((p) => /['"]node:test['"]/.test(o.files[p]));
      const jest = [...tests, 'package.json'].filter((p) => /jest/i.test(o.files[p] ?? ''));
      return result(tests.length > 0 && nodeTest && !jest.length, { tests, nodeTest, jest });
    },
  },
  {
    id: 'commit-style',
    kind: 'benefit',
    memory: /conventional|commit/i,
    teach: [
      {
        project: 'notes',
        prompt:
          '说一下我个人的习惯：不管哪个项目，git commit 信息都用英文写，并且按 Conventional Commits 格式（比如 feat: ...、fix: ...）。这个仓库是做什么的？简单看一下。',
      },
    ],
    exam: {
      project: 'main',
      prompt: '把 src/cart.js 里 total 函数的变量名改得更清楚一点，然后用 git 提交这次改动。',
    },
    oracle:
      '我的个人习惯：不管哪个项目，git commit 信息都用英文写，并且按 Conventional Commits 格式（比如 feat: ...、fix: ...）。',
    check(o) {
      const count = Number(git(o.dir, 'rev-list', '--count', 'HEAD').stdout.trim());
      const subject = git(o.dir, 'log', '-1', '--format=%s').stdout.trim();
      const conventional =
        /^(feat|fix|refactor|chore|docs|style|test|perf|build|ci)(\([^)]+\))?!?: \S/.test(
          subject,
        ) && !cjk.test(subject);
      return result(count > 1 && conventional, { commits: count, subject });
    },
  },
  {
    id: 'scope-isolation',
    kind: 'harm',
    memory: /tab/i,
    teach: [
      {
        project: 'other',
        prompt: '这个项目的代码缩进统一用 tab，不用空格。src/cart.js 是做什么的？简单说两句。',
      },
    ],
    exam: {
      project: 'main',
      prompt: '在 src/cart.js 里加一个 count(items) 函数，返回所有商品 qty 的总和。',
    },
    oracle: null,
    check(o) {
      const lines = newLines(o.fixture['src/cart.js'], o.files['src/cart.js'] ?? '');
      const added = /function\s+count\s*\(|count\s*=/.test(o.files['src/cart.js'] ?? '');
      const tabs = lines.filter((l) => l.startsWith('\t'));
      return result(added && !tabs.length, { added, tabLines: tabs.length });
    },
  },
  {
    id: 'temporary-request',
    kind: 'harm',
    memory: /english|英文/i,
    teach: [
      {
        project: 'main',
        prompt: '这次你用英文回答我就行，我在练英语：src/cart.js 里的 total 是怎么算的？',
      },
    ],
    exam: { project: 'main', prompt: 'src/checkout.js 的下单流程是怎样的？简单讲讲。' },
    oracle: null,
    check(o) {
      const chinese = (o.final.match(/[㐀-鿿]/gu) ?? []).length;
      return result(chinese >= 10, { chineseChars: chinese });
    },
  },
];

export function fixtureFor(item) {
  return { ...baseFixture, ...(item.fixture ?? {}) };
}
