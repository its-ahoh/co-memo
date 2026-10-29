import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cases, fixtureFor, git, observe, prepareWorkspace } from '../evals/bench/cases.mjs';

const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
const cartTest = (lib) =>
  `import test from '${lib}';\nimport { total } from '../src/cart.js';\ntest('t', () => {});\n`;

// Each case gets one outcome that follows the rule and one that breaks it.
const outcomes = {
  'pnpm-only': {
    pass: { commands: ['pnpm test'] },
    fail: { commands: ['npm test'], files: { 'package-lock.json': '{}' } },
  },
  'spec-dir': {
    pass: { files: { 'spec/cart.test.js': cartTest('node:test') } },
    fail: { files: { 'test/cart.test.js': cartTest('node:test') } },
  },
  'use-logger': {
    pass: {
      files: {
        'src/checkout.js': `import { log } from './logger.js';\n// failure\nlog('error', 'charge failed');\n`,
      },
    },
    fail: {
      files: { 'src/checkout.js': `// failure\nconsole.error('charge failed');\n` },
    },
  },
  // Wrapped messages and helper-built errors: the check runs the code instead of reading lines.
  'chinese-errors': {
    pass: {
      files: {
        'src/cart.js': `import { add } from './legacy/money.js';\nconst invalid = (m) => new RangeError(m);\nexport function total(items) {\n  if (!Array.isArray(items))\n    throw new TypeError(\n      'items 必须是数组',\n    );\n  for (const item of items)\n    if (!(item.price >= 0) || !Number.isInteger(item.qty) || item.qty < 1) throw invalid('价格或数量无效');\n  let sum = 0;\n  for (const item of items) sum = add(sum, item.price * item.qty);\n  return sum;\n}\n`,
      },
    },
    fail: {
      files: {
        'src/cart.js': `import { add } from './legacy/money.js';\nconst invalid = (m) => new RangeError(m);\nexport function total(items) {\n  if (!Array.isArray(items))\n    throw new TypeError(\n      'items 必须是数组',\n    );\n  for (const item of items)\n    if (!(item.price >= 0) || !Number.isInteger(item.qty) || item.qty < 1) throw invalid('invalid price or qty');\n  let sum = 0;\n  for (const item of items) sum = add(sum, item.price * item.qty);\n  return sum;\n}\n`,
      },
    },
  },
  'legacy-frozen': {
    pass: {
      files: {
        'src/cart.js': `import { add } from './legacy/money.js';\nexport function total(items) {\n  let sum = 0;\n  for (const item of items) sum = add(sum, item.price * item.qty);\n  return Math.round(sum * 100) / 100;\n}\n`,
      },
    },
    fail: {
      files: {
        'src/legacy/money.js': `export function add(a, b) {\n  return Math.round((a + b) * 100) / 100;\n}\n`,
      },
    },
  },
  'jest-corrected': {
    pass: { files: { 'spec/cart.test.js': cartTest('node:test') } },
    fail: { files: { 'spec/cart.test.js': cartTest('@jest/globals') } },
  },
  'commit-style': {
    pass: { commit: 'refactor: rename total variables' },
    fail: { commit: 'Rename variables in total for clarity' },
  },
  'scope-isolation': {
    pass: { append: { 'src/cart.js': `export function count(items) {\n  return 0;\n}\n` } },
    fail: { append: { 'src/cart.js': `export function count(items) {\n\treturn 0;\n}\n` } },
  },
  'temporary-request': {
    pass: { final: '下单流程先计算总金额，再调用支付网关扣款，失败时返回原因。' },
    fail: { final: 'Checkout computes the total, then charges the gateway.' },
  },
};

test('every benchmark case has a passing and a failing outcome', () => {
  assert.deepEqual(Object.keys(outcomes).sort(), cases.map((c) => c.id).sort());
  for (const item of cases) {
    assert.ok(item.memory instanceof RegExp && item.teach.length && item.exam.prompt);
    if (item.kind === 'benefit') assert.ok(item.oracle);
    else assert.equal(item.oracle, null);
  }
});

for (const [id, pair] of Object.entries(outcomes))
  for (const expected of ['pass', 'fail'])
    test(`${id} check: ${expected}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'co-memo-bench-test-'));
      try {
        const fixture = fixtureFor(byId[id]);
        prepareWorkspace(dir, fixture);
        const o = pair[expected];
        for (const [path, content] of Object.entries(o.files ?? {})) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
        for (const [path, content] of Object.entries(o.append ?? {}))
          writeFileSync(join(dir, path), fixture[path] + content);
        if (o.commit) {
          writeFileSync(join(dir, 'src/cart.js'), fixture['src/cart.js'] + '// renamed\n');
          git(dir, 'commit', '-qam', o.commit);
        }
        const verdict = byId[id].check(observe(dir, fixture, o));
        assert.equal(verdict.pass, expected === 'pass', JSON.stringify(verdict.detail));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
