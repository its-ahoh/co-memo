import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { projects } from '../dist/projects.js';

test('inventory outside projects is read-only, reports disconnected/missing roots and no memory content', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-projects-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'data');
  assert.deepEqual((await projects(home)).projects, []);
  assert.equal(existsSync(home), false);
  const store = new Store(home);
  try {
    const one = join(root, 'one'),
      two = join(root, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const a = store.project(one, true),
      b = store.project(two, true);
    store.connect(a, 'claude');
    store.connect(b, 'codex');
    store.add('Private content must never appear', 'project', a.id, 'test');
    rmSync(two, { recursive: true });
    const report = await projects(home, true);
    assert.equal(report.projects.length, 2);
    assert.deepEqual(report.projects.find((p) => p.root === one).agents, ['claude']);
    assert.equal(report.projects.find((p) => p.root === one).memories, 1);
    assert.equal(report.projects.find((p) => p.root === two).exists, false);
    assert.equal(report.projects.find((p) => p.root === two).diagnostics.status, 'needs_attention');
    assert.ok(!JSON.stringify(report).includes('Private content'));
    assert.equal(existsSync(join(one, '.co-memo')), false);
    store.db.exec('PRAGMA user_version=3');
    await assert.rejects(projects(home), /Unsupported schema/);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  } finally {
    store.close();
  }
});
