import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';
import { sync, context } from '../dist/sync.js';
import { remember, change, recall } from '../dist/service.js';
import { atomicWrite } from '../dist/fs.js';
import { hash } from '../dist/model.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-db-')));
  const home = join(root, 'data'),
    path = join(root, 'project');
  mkdirSync(path);
  const store = new Store(home),
    project = store.project(path, true);
  for (const agent of ['pi', 'claude', 'codex', 'opencode']) store.connect(project, agent);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, path, store, project };
}
test('all agents share database writes without creating Markdown; stale versions are rejected', (t) => {
  const f = fixture(t);
  const note = f.store.lock(() =>
    remember(f.store, f.path, { content: '偏好中文，使用 pnpm。🧠', intent: 'automatic' }, 'pi'),
  ).memory;
  const other = new Store(f.home);
  try {
    assert.equal(other.lock(() => recall(other, f.path)).memories[0].id, note.id);
    other.lock(() =>
      change(
        other,
        f.path,
        { id: note.id, version: 1, content: 'Use npm', intent: 'automatic' },
        'claude',
      ),
    );
    assert.match(context(f.store, f.project.id), /Use npm/);
    assert.throws(
      () =>
        f.store.lock(() =>
          change(
            f.store,
            f.path,
            { id: note.id, version: 1, content: 'stale', intent: 'automatic' },
            'codex',
          ),
        ),
      /Version changed/,
    );
    f.store.lock(() =>
      change(
        f.store,
        f.path,
        { id: note.id, version: 2, content: null, intent: 'automatic' },
        'opencode',
      ),
    );
    assert.deepEqual(other.lock(() => recall(other, f.path)).memories, []);
  } finally {
    other.close();
  }
  assert.equal(f.store.connections().length, 4);
  assert.deepEqual(f.store.replicas(), []);
  assert.equal(f.store.lock(() => sync(f.store)).published, 0);
  assert.equal(existsSync(join(f.path, '.co-memo')), false);
});
test('legacy malformed files and symlinked memory directories are never read, written or ingested', (t) => {
  const f = fixture(t),
    outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'codex.md'), 'unpublished legacy edits');
  symlinkSync(outside, join(f.path, '.co-memo'));
  f.store.connect(f.project, 'codex');
  const note = f.store.lock(() =>
    remember(f.store, f.path, { content: 'database note', intent: 'explicit' }, 'test'),
  ).memory;
  assert.deepEqual(f.store.lock(() => sync(f.store)).errors, []);
  assert.equal(readFileSync(join(outside, 'codex.md'), 'utf8'), 'unpublished legacy edits');
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.equal(f.store.get(note.id).content, 'database note');
});
test('schema 5 upgrade preserves notes, old pending data and connections without accessing legacy files', (t) => {
  const f = fixture(t),
    id = randomUUID(),
    legacy = join(f.path, '.co-memo/codex.md');
  const note = f.store.add('already saved', 'project', f.project.id, 'test').memory;
  mkdirSync(join(f.path, '.co-memo'));
  writeFileSync(legacy, 'unsaved legacy edit');
  f.store.db
    .prepare('INSERT INTO replicas VALUES (?,?,?,?,?,?)')
    .run(id, f.project.id, 'codex', legacy, null, 'legacy pending bytes');
  f.store.db.exec('DROP TABLE connections; PRAGMA user_version=5;');
  const upgraded = new Store(f.home);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.deepEqual(upgraded.connections(), [
      { id, projectId: f.project.id, agent: 'codex', root: f.path },
    ]);
    upgraded.lock(() => sync(upgraded));
    assert.equal(upgraded.get(note.id).content, 'already saved');
    assert.equal(
      upgraded.db.prepare('SELECT pending FROM replicas').get().pending,
      'legacy pending bytes',
    );
    assert.equal(readFileSync(legacy, 'utf8'), 'unsaved legacy edit');
    assert.equal(upgraded.connect(upgraded.project(f.path), 'codex').id, id);
  } finally {
    upgraded.close();
  }
});
test('user notes cross projects while project notes and duplicate identity stay scoped', (t) => {
  const f = fixture(t),
    path = join(f.root, 'other');
  mkdirSync(path);
  const other = f.store.project(path, true);
  const a = f.store.add('same', 'project', f.project.id, 'pi');
  const b = f.store.add('same', 'project', f.project.id, 'claude');
  const c = f.store.add('same', 'project', other.id, 'pi');
  assert.equal(a.memory.id, b.memory.id);
  assert.notEqual(a.memory.id, c.memory.id);
  const personal = f.store.add('personal', 'user', null, 'pi').memory;
  assert.deepEqual(
    new Set(f.store.list(other.id).map((m) => m.id)),
    new Set([c.memory.id, personal.id]),
  );
});
test('database failure rolls back a write and does not create a conflict', (t) => {
  const f = fixture(t),
    note = f.store.add('first', 'project', f.project.id, 'test').memory;
  f.store.db.exec(
    "CREATE TRIGGER reject_revision BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
  );
  assert.throws(
    () =>
      f.store.lock(() =>
        change(
          f.store,
          f.path,
          { id: note.id, version: 1, content: 'changed', intent: 'explicit' },
          'test',
        ),
      ),
    /simulated storage failure/,
  );
  assert.equal(f.store.get(note.id).content, 'first');
  assert.deepEqual(f.store.conflicts(), []);
});
test('atomic host configuration writes reject external changes and symlinks', (t) => {
  const f = fixture(t),
    path = join(f.path, 'config');
  writeFileSync(path, 'changed');
  assert.throws(() => atomicWrite(path, 'overwrite', hash('old')), /changed/);
  symlinkSync(path, join(f.path, 'link'));
  assert.throws(() => atomicWrite(join(f.path, 'link'), 'overwrite', hash('changed')));
  assert.equal(readFileSync(path, 'utf8'), 'changed');
});
