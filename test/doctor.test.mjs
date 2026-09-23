import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { doctor } from '../dist/doctor.js';
import { cases, evaluate, extractionMetrics } from '../scripts/eval-quality.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-doctor-')));
  const home = join(root, 'data');
  const project = join(root, 'project');
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), '--home', home, '--project', project, ...args],
      { encoding: 'utf8', timeout: 20000 },
    );
  return { root, home, project, cli };
}

test('doctor does not create a store or upgrade old schemas, and returns actionable JSON', async (t) => {
  const f = fixture(t);
  const absent = f.cli('doctor', 'codex');
  assert.equal(absent.status, 2);
  assert.equal(JSON.parse(absent.stdout).status, 'needs_attention');
  assert.equal(existsSync(f.home), false);
  f.cli('setup', 'codex', '--tools-only');
  const store = new Store(f.home);
  store.db.exec('PRAGMA user_version=2;');
  const result = await doctor({ root: f.project, home: f.home, agent: 'codex' });
  assert.equal(result.status, 'needs_attention');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.close();
});

test('doctor probes actual MCP without saving notes, syncing edited projections, or claiming host verification', async (t) => {
  const f = fixture(t);
  assert.equal(f.cli('setup', 'codex', '--tools-only').status, 0);
  const projection = join(f.project, '.co-memo/codex.md');
  const text = readFileSync(projection, 'utf8').replace(
    '<!-- co-memo:new -->\n\n',
    '<!-- co-memo:new -->\nUnimported note\n',
  );
  writeFileSync(projection, text);
  const result = await doctor({ root: f.project, home: f.home, agent: 'codex', probe: true });
  assert.equal(result.transport, 'passed');
  assert.equal(result.hostVerified, false);
  assert.equal(result.checks.find((c) => c.id === 'codex:replica').status, 'warn');
  assert.equal(readFileSync(projection, 'utf8'), text);
  const store = new Store(f.home);
  assert.equal(store.list(store.project(f.project).id).length, 0);
  store.close();
});

test('doctor refuses malformed or foreign commands and reports missing skills, pending publication and conflicts', async (t) => {
  const f = fixture(t);
  f.cli('setup', 'opencode', '--tools-only');
  rmSync(join(f.project, '.opencode/skills/co-memo/SKILL.md'));
  const stale = await doctor({ root: f.project, home: f.home, agent: 'opencode' });
  assert.equal(stale.checks.find((c) => c.id === 'opencode:files').status, 'warn');
  const config = join(f.project, 'opencode.json');
  const original = JSON.parse(readFileSync(config, 'utf8'));
  original.mcp['co-memo'].command = [
    '/bin/sh',
    '-c',
    `touch '${join(f.root, 'should-not-execute')}'`,
  ];
  writeFileSync(config, JSON.stringify(original));
  const refused = await doctor({ root: f.project, home: f.home, agent: 'opencode', probe: true });
  assert.equal(refused.transport, 'blocked');
  assert.equal(refused.status, 'needs_attention');
  assert.equal(existsSync(join(f.root, 'should-not-execute')), false);
  writeFileSync(config, '{broken');
  assert.equal(
    (await doctor({ root: f.project, home: f.home, agent: 'opencode' })).status,
    'needs_attention',
  );
  const store = new Store(f.home);
  store.lock(() => {
    const note = store.add(
      'Private content must not appear in diagnostics',
      'project',
      store.project(f.project).id,
      'test',
    ).memory;
    store.conflict(note, []);
    store.configure(null, { paused: true });
  });
  store.close();
  const result = await doctor({ root: f.project, home: f.home, agent: 'opencode' });
  assert.equal(result.checks.find((c) => c.id === 'paused').status, 'warn');
  assert.equal(result.checks.find((c) => c.id === 'conflicts').status, 'warn');
  assert.ok(!JSON.stringify(result).includes('Private content'));
});

test('quality evaluation separates semantic gaps and unrun extraction; grading catches duplicates and missing cases', () => {
  const report = evaluate();
  assert.equal(report.retrieval.leaks, 0);
  assert.ok(report.retrieval.groups.lexical.recallAt5 >= 0.9);
  assert.equal(report.extraction.status, 'not_run');
  assert.equal(report.retrieval.groups.semantic.cases, 3);
  // Synthetic oracle is only a grader test, never reported as actual extraction performance.
  const oracle = {
    run: {
      agent: 'grader-unit-test',
      model: 'synthetic-oracle',
      timestamp: '2026-09-22T00:00:00Z',
    },
    cases: cases.extraction.map((item) => ({
      caseId: item.id,
      memories: item.expected.map(({ aliases, ...expected }) => ({
        ...expected,
        content: aliases[0],
      })),
    })),
  };
  assert.equal(extractionMetrics(oracle).recall, 1);
  oracle.cases[0].memories.push({ ...oracle.cases[0].memories[0] });
  assert.equal(extractionMetrics(oracle).falsePositives, 1);
  oracle.cases.shift();
  assert.equal(extractionMetrics(oracle).status, 'incomplete');
  assert.equal(extractionMetrics(oracle).missed, 1);
  assert.throws(
    () => extractionMetrics({ ...oracle, cases: [{ caseId: 'unknown', memories: [] }] }),
    /unknown/,
  );
});
