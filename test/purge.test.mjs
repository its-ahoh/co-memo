import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { sync } from '../dist/sync.js';
import { remove, change, restore } from '../dist/service.js';
import { hash } from '../dist/model.js';
import { render } from '../dist/document.js';

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

test('archive retains revisions; restore works; purge erases records and stale replicas stay deleted', (t) => {
  const { store, root, note, other } = fixture(t);
  const replicas = store.replicas();
  const stale = readFileSync(replicas[0].path, 'utf8');
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
  for (const replica of store.replicas()) {
    assert.doesNotMatch(JSON.stringify(replica), /secret durable note/);
    assert.doesNotMatch(readFileSync(replica.path, 'utf8'), /secret durable note/);
  }
  // Old document generations may still report an error, but their purged blocks are removed.
  writeFileSync(replicas[0].path, stale.replace('secret durable note', 'stale changed secret'));
  store.lock(() => sync(store));
  assert.doesNotMatch(readFileSync(replicas[0].path, 'utf8'), /stale changed secret/);
  assert.throws(() => store.get(note.id), /not found/);
  assert.equal(store.get(other.id).content, 'keep this note');
});

test('purge cleans paused/conflicted replicas, pending payloads, resolutions, receipts and vector caches', (t) => {
  const { store, root, project, note, other } = fixture(t);
  const replica = store.replicas()[0];
  const text = readFileSync(replica.path, 'utf8');
  const generated = render(replica, store.list(project.id));
  replica.pending = { ...generated, expected: hash(text) };
  store.transaction(() => {
    store.saveReplica(replica);
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
  for (const r of store.replicas()) {
    assert.doesNotMatch(JSON.stringify(r), /secret durable note/);
    assert.doesNotMatch(readFileSync(r.path, 'utf8'), /secret durable note/);
    assert.match(readFileSync(r.path, 'utf8'), /keep this note/);
  }
});

test('permanent deletion checks scope and version, reports unsafe replicas without overwriting them', (t) => {
  const { store, root, note } = fixture(t);
  assert.throws(
    () => store.lock(() => remove(store, root, { id: note.id, version: 9 })),
    /Version changed/,
  );
  const replica = store.replicas()[0];
  writeFileSync(replica.path, 'unrelated invalid document');
  const result = store.lock(() => remove(store, root, { id: note.id, version: 1 }));
  assert.equal(result.sync.errors.length, 1);
  assert.equal(readFileSync(replica.path, 'utf8'), 'unrelated invalid document');
  assert.throws(() => store.get(note.id), /not found/);
});
