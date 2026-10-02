import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { sync } from '../dist/sync.js';
import { remove, change, restore } from '../dist/service.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-purge-'));
  const root = join(dir, 'project');
  mkdirSync(root);
  const store = new Store(join(dir, 'data'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.project(root, true);
  store.connect(project, 'codex');
  store.connect(project, 'claude');
  const note = store.transaction(() =>
    store.add('secret durable note', 'project', project.id, 'test'),
  ).memory;
  const other = store.transaction(() =>
    store.add('keep this note', 'project', project.id, 'test'),
  ).memory;
  store.lock(() => sync(store));
  return { store, root, project, note, other };
}

test('archive retains histories; restore works; purge erases records and deleted notes stay absent', (t) => {
  const { store, root, note, other } = fixture(t);

  store.lock(() =>
    change(store, root, { id: note.id, version: 1, content: null, intent: 'explicit' }, 'test'),
  );
  assert.equal(store.get(note.id).deleted, true);
  assert.equal(store.history(note.id).length, 2);
  store.lock(() => restore(store, root, { id: note.id, version: 2 }, 'test'));
  assert.equal(store.get(note.id).deleted, false);
  const result = store.lock(() => remove(store, root, { id: note.id, version: 3 }));
  assert.deepEqual(result.sync.errors, []);
  assert.throws(() => store.get(note.id), /not found/);
  assert.deepEqual(store.history(note.id), []);
  assert.equal(store.db.prepare('SELECT count(*) n FROM notes_fts WHERE id=?').get(note.id).n, 0);
  assert.throws(() => store.get(note.id), /not found/);
  assert.equal(store.get(other.id).content, 'keep this note');
});

test('purge cleans resolutions, receipts and vector caches even during later pause', (t) => {
  const { store, root, project, note, other } = fixture(t);
  store.transaction(() => {
    store.conflict(other, []);
    store.configure(project.id, { paused: true });
    store.db
      .prepare('INSERT INTO resolutions VALUES (?,?)')
      .run('old', JSON.stringify({ memoryId: note.id, content: note.content }));
    store.saveSubmission(project.id, 'retry', 'digest', [
      { action: 'add', status: 'created', receipt: { id: note.id, version: 1, deleted: false } },
    ]);
  });
  const cache = join(store.home, 'embeddings-v1', 'provider', note.id + '.json');
  mkdirSync(join(cache, '..'), { recursive: true });
  writeFileSync(cache, '{"vector":[1]}');
  // Store-level transaction is used here because normal user writes respect project pause.
  store.transaction(() => store.configure(project.id, { paused: false }));
  store.lock(() => store.transaction(() => store.purge(note.id, 1)));
  store.transaction(() => store.configure(project.id, { paused: true }));
  const report = store.lock(() => sync(store));
  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(cache), false);
  assert.equal(store.db.prepare('SELECT count(*) n FROM resolutions').get().n, 0);
  assert.match(JSON.stringify(store.submission(project.id, 'retry').result), /permanently deleted/);
  assert.equal(existsSync(join(root, '.co-memo')), false);
  assert.equal(store.get(other.id).content, 'keep this note');
});

test('permanent deletion checks scope and version, ignores legacy files without overwriting them', (t) => {
  const { store, root, note } = fixture(t);
  assert.throws(
    () => store.lock(() => remove(store, root, { id: note.id, version: 9 })),
    /Version changed/,
  );
  mkdirSync(join(root, '.co-memo'));
  const legacy = join(root, '.co-memo/codex.md');
  writeFileSync(legacy, 'unrelated invalid document');
  const result = store.lock(() => remove(store, root, { id: note.id, version: 1 }));
  assert.equal(result.sync.errors.length, 0);
  assert.equal(readFileSync(legacy, 'utf8'), 'unrelated invalid document');
  assert.throws(() => store.get(note.id), /not found/);
});

test('restore reports exclude other projects conflicts', (t) => {
  const f = fixture(t);
  const otherRoot = join(f.root, 'foreign');
  mkdirSync(otherRoot);
  const foreignProject = f.store.project(otherRoot, true);
  const foreign = f.store.add('Foreign secret', 'project', foreignProject.id, 'fixture').memory;
  f.store.conflict(foreign, []);
  f.store.change(f.note.id, 1, null, 'fixture');
  const result = f.store.lock(() =>
    restore(f.store, f.root, { id: f.note.id, version: 2 }, 'fixture'),
  );
  assert.equal(result.memory.deleted, false);
  assert.deepEqual(result.sync.conflicts, []);
  assert.equal(f.store.conflicts().length, 1);
});
