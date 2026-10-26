import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { context } from '../dist/sync.js';
import { retrieve } from '../dist/service.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'co-memo-context-relevance-'));
  const store = new Store(join(root, 'data'));
  const project = store.project(root, true);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    project,
    add: (content, metadata = {}) =>
      store.add(content, 'project', project.id, 'fixture', 'explicit', Metadata.parse(metadata))
        .memory,
  };
}

test('context omits incidental English and Chinese matches while recall remains broad', async (t) => {
  for (const [query, relevant, weak] of [
    ['SQLite invoices', 'SQLite stores invoices offline', 'SQLite powers address lookup'],
    ['数据库 迁移', '数据库迁移必须使用事务', '数据库每天生成备份'],
  ]) {
    const f = fixture(t);
    const good = f.add(relevant),
      noise = f.add(weak);
    const injected = context(f.store, f.project.id, 16000, query);
    assert.ok(injected.includes(good.content));
    assert.ok(!injected.includes(noise.content));
    const result = await retrieve(f.store, f.root, query);
    assert.ok(result.memories.some((m) => m.id === noise.id));
    assert.ok(result.context.includes(good.content));
    assert.ok(!result.context.includes(noise.content));
  }
});

test('weak-only queries inject no notes except explicitly pinned preferences', (t) => {
  const f = fixture(t);
  const noise = f.add('Deployment uses regional containers');
  const pinned = f.add('Prefer concise explanations', { kind: 'preference', pinned: true });
  for (const query of ['deployment astronomy', '!!!', 'the and']) {
    const injected = context(f.store, f.project.id, 16000, query);
    assert.ok(!injected.includes(noise.content));
    assert.ok(injected.includes(pinned.content));
  }
});

test('constraints apply to every task, within their own allocation', (t) => {
  const f = fixture(t);
  const rule = f.add('Run scripts with the bundled task runner only', { kind: 'constraint' });
  const fact = f.add('Deployment uses regional containers');
  const oversized = f.add('y'.repeat(2001), { kind: 'constraint' });
  for (const query of ['add a discount to the cart total', '给购物车加折扣']) {
    const injected = context(f.store, f.project.id, 16000, query);
    assert.ok(injected.includes(rule.content), query);
    assert.ok(!injected.includes(fact.content), query);
    assert.ok(!injected.includes(oversized.content), query);
  }
});

test('single terms, repeated terms, paths, module labels and no-query reads retain matching notes', (t) => {
  const f = fixture(t);
  const note = f.add('Archive invoices annually', { module: 'storage/sqlite' });
  for (const query of ['sqlite', 'ＳＱＬｉｔｅ sqlite', 'storage/sqlite', undefined]) {
    assert.ok(context(f.store, f.project.id, 16000, query).includes(note.content));
  }
  assert.ok(
    !context(f.store, f.project.id, 16000, 'sqlite sqlite astronomy').includes(note.content),
  );
});

test('semantic exemptions require the current version and preserve the context budget', (t) => {
  const f = fixture(t);
  const note = f.add('Cycle to the office');
  const matches = new Map([[note.id, note.version]]);
  assert.ok(
    context(f.store, f.project.id, 16000, 'commuting bicycle', [note], matches).includes(
      note.content,
    ),
  );
  const changed = f.store.change(note.id, note.version, 'Walk to the office', 'fixture');
  assert.ok(
    !context(f.store, f.project.id, 16000, 'commuting bicycle', [changed], matches).includes(
      changed.content,
    ),
  );
  assert.ok(
    context(f.store, f.project.id, 1200, 'commuting bicycle', [note], matches).length <= 1200,
  );
});

test('natural-language prompts keep relevant notes and still drop single-term noise', (t) => {
  for (const [query, relevant, weak] of [
    [
      'How should I run database migrations in this repo?',
      'Database migrations must run inside a transaction',
      'Database backups are encrypted',
    ],
    ['我们应该怎么做数据库迁移？', '数据库迁移必须使用事务', '数据库每天生成备份'],
    [
      'Can you remind me which package manager we use for installing dependencies and updating lockfiles here?',
      'Use pnpm for project dependencies and lockfiles.',
      'Lockfiles are reviewed weekly.',
    ],
  ]) {
    const f = fixture(t);
    const good = f.add(relevant),
      noise = f.add(weak);
    const injected = context(f.store, f.project.id, 16000, query);
    assert.ok(injected.includes(good.content), query);
    assert.ok(!injected.includes(noise.content), query);
  }
});
