import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { sync, repair, context } from '../dist/sync.js';
import { parse, render } from '../dist/document.js';
import { atomicWrite } from '../dist/fs.js';
import { hash } from '../dist/model.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-test-')));
  const home = join(root, 'data');
  const path = join(root, 'project');
  mkdirSync(path);
  const store = new Store(home);
  const project = store.project(path, true);
  const pi = store.connect(project, 'pi'),
    claude = store.connect(project, 'claude');
  const run = () => store.lock(() => sync(store));
  assert.equal(run().published, 2);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, path, store, project, pi, claude, run };
}
function addFile(replica, text) {
  const original = readFileSync(replica.path, 'utf8');
  writeFileSync(
    replica.path,
    original.replace('<!-- co-memo:new -->\n\n', `<!-- co-memo:new -->\n${text}\n`),
  );
}
function replace(replica, from, to) {
  writeFileSync(replica.path, readFileSync(replica.path, 'utf8').replace(from, to));
}
function remove(replica, id) {
  const text = readFileSync(replica.path, 'utf8');
  writeFileSync(
    replica.path,
    text.replace(
      new RegExp(`<!-- co-memo:memory ${id} \\d+ -->\\n[\\s\\S]*?\\n<!-- co-memo:/memory -->\\n?`),
      '',
    ),
  );
}
function entries(replica) {
  return parse(readFileSync(replica.path, 'utf8'), replica.id).entries;
}

test('Pi add → Claude edit → Pi delete converges; repeated sync is idle', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'Use pnpm for this project.');
  assert.equal(f.run().imported, 1);
  const note = entries(f.claude)[0];
  assert.equal(note.content, 'Use pnpm for this project.');
  replace(f.claude, 'Use pnpm for this project.', 'Use pnpm with a frozen lockfile.');
  assert.equal(f.run().updated, 1);
  assert.equal(entries(f.pi)[0].version, 2);
  remove(f.pi, note.id);
  assert.equal(f.run().deleted, 1);
  assert.deepEqual(entries(f.claude), []);
  assert.equal(f.store.get(note.id).deleted, true);
  assert.equal(f.store.history(note.id).length, 3);
  assert.equal(f.run().published, 0);
});

test('User preferences cross projects; project decisions stay isolated', (t) => {
  const f = fixture(t),
    otherRoot = join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = f.store.project(otherRoot, true),
    r = f.store.connect(other, 'pi');
  f.store.transaction(() => {
    f.store.add('Answer in Chinese', 'user', null, 'user');
    f.store.add('Use pnpm', 'project', f.project.id, 'pi');
  });
  f.run();
  assert.deepEqual(
    entries(r).map((e) => e.content),
    ['Answer in Chinese'],
  );
  assert.equal(entries(f.claude).length, 2);
  replace(r, 'Answer in Chinese', 'Answer in English');
  f.run();
  assert.equal(entries(f.pi)[0].content, 'Answer in English');
});

test('Concurrent divergent edits preserve both proposals and freeze files', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'Use npm');
  f.run();
  replace(f.pi, 'Use npm', 'Use pnpm');
  replace(f.claude, 'Use npm', 'Use yarn');
  const report = f.run();
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.published, 0);
  const conflict = report.conflicts[0];
  assert.deepEqual(
    conflict.proposals.map((p) => p.content),
    ['Use pnpm', 'Use yarn'],
  );
  assert.equal(f.store.get(conflict.memoryId).content, 'Use npm');
  assert.match(context(f.store, f.project.id), /omitted/);
  assert.doesNotMatch(context(f.store, f.project.id), /Use npm/);
  assert.equal(f.run().conflicts.length, 1);
  f.store.transaction(() => f.store.resolve(conflict.id, f.claude.id));
  assert.equal(f.run().conflicts.length, 0);
  assert.equal(entries(f.pi)[0].content, 'Use yarn');
  assert.equal(entries(f.claude)[0].content, 'Use yarn');
});

test('Identical concurrent edits merge without conflict', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'old');
  f.run();
  replace(f.pi, '\nold\n', '\nnew\n');
  replace(f.claude, '\nold\n', '\nnew\n');
  const report = f.run();
  assert.equal(report.updated, 1);
  assert.equal(report.conflicts.length, 0);
  assert.equal(entries(f.pi)[0].version, 2);
});

test('Delete/edit conflict requires explicit resolution, including explicit restoration', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'old');
  f.run();
  const note = entries(f.pi)[0];
  remove(f.pi, note.id);
  replace(f.claude, '\nold\n', '\nnew\n');
  const conflict = f.run().conflicts[0];
  assert.ok(conflict);
  f.store.transaction(() => f.store.resolve(conflict.id, f.pi.id));
  f.run();
  assert.equal(f.store.get(note.id).deleted, true);
  assert.equal(entries(f.claude).length, 0);
  addFile(f.pi, 'old');
  f.run();
  assert.equal(f.store.list(f.project.id).length, 0, 'deleted exact text is not recreated');
});

test('Late edits made while a conflict is open are not overwritten by resolution', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'old');
  f.run();
  replace(f.pi, '\nold\n', '\na\n');
  replace(f.claude, '\nold\n', '\nb\n');
  const conflict = f.run().conflicts[0];
  replace(f.pi, '\na\n', '\nc\n');
  f.store.transaction(() => f.store.resolve(conflict.id, f.claude.id));
  const report = f.run();
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].proposals[0].content, 'c');
  assert.match(readFileSync(f.pi.path, 'utf8'), /\nc\n/);
});

test('Stale unchanged replicas do not resurrect centrally deleted notes', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'durable');
  f.run();
  const note = entries(f.pi)[0];
  f.store.transaction(() => f.store.change(note.id, 1, null, 'user'));
  assert.equal(f.run().conflicts.length, 0);
  assert.equal(entries(f.pi).length, 0);
  assert.equal(entries(f.claude).length, 0);
});

test('Stale edited replicas conflict with centrally deleted notes', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'durable');
  f.run();
  const note = entries(f.pi)[0];
  f.store.transaction(() => f.store.change(note.id, 1, null, 'user'));
  replace(f.pi, 'durable', 'new durable');
  const conflict = f.run().conflicts[0];
  assert.equal(conflict.currentContent, null);
  f.store.transaction(() => f.store.resolve(conflict.id, f.pi.id));
  f.run();
  assert.equal(f.store.get(note.id).deleted, false);
  assert.equal(entries(f.claude)[0].content, 'new durable');
});

test('Missing, truncated and malformed files never delete memories', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'keep');
  f.run();
  const backup = readFileSync(f.pi.path, 'utf8');
  unlinkSync(f.pi.path);
  assert.equal(f.run().errors.length, 1);
  assert.equal(f.store.list(f.project.id).length, 1);
  f.store.lock(() => repair(f.store, 'pi', f.project.id));
  assert.equal(entries(f.pi)[0].content, 'keep');
  const fresh = readFileSync(f.pi.path, 'utf8');
  writeFileSync(f.pi.path, fresh.slice(0, 100));
  assert.equal(f.run().errors.length, 1);
  writeFileSync(f.pi.path, fresh.replace('<!-- co-memo:/memory -->', 'oops'));
  assert.equal(f.run().errors.length, 1);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.ok(backup);
});

test('Forged IDs and version markers cannot change another project', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'keep');
  f.run();
  const fresh = readFileSync(f.pi.path, 'utf8');
  writeFileSync(f.pi.path, fresh.replace(/(<!-- co-memo:memory [\da-f-]+) 1/, '$1 9'));
  assert.equal(f.run().errors.length, 1);
  assert.equal(f.store.get(entries(f.claude)[0].id).version, 1);
});

test('Failed publication leaves a journal and safely retries', (t) => {
  const f = fixture(t);
  f.store.transaction(() => f.store.add('pending', 'project', f.project.id, 'user'));
  const replica = f.store.replicas().find((r) => r.id === f.pi.id);
  const before = readFileSync(replica.path, 'utf8');
  replica.pending = { ...render(replica, f.store.list(f.project.id)), expected: hash(before) };
  f.store.transaction(() => f.store.saveReplica(replica));
  f.run();
  assert.equal(entries(f.pi)[0].content, 'pending');
  assert.equal(f.store.replicas().find((r) => r.id === f.pi.id).pending, null);
});

test('Recovery recognizes an edited publication written before DB acknowledgement', (t) => {
  const f = fixture(t);
  f.store.transaction(() => f.store.add('pending', 'project', f.project.id, 'user'));
  const replica = f.store.replicas().find((r) => r.id === f.pi.id);
  const before = readFileSync(replica.path, 'utf8');
  replica.pending = { ...render(replica, f.store.list(f.project.id)), expected: hash(before) };
  f.store.transaction(() => f.store.saveReplica(replica));
  writeFileSync(
    replica.path,
    replica.pending.text.replace('\npending\n', '\nedited after crash\n'),
  );
  const report = f.run();
  assert.equal(report.updated, 1);
  assert.equal(report.conflicts.length, 0);
  assert.equal(entries(f.claude)[0].content, 'edited after crash');
});

test('Recovery ingests an old-generation edit instead of overwriting it', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'old');
  f.run();
  const note = entries(f.pi)[0];
  f.store.transaction(() => f.store.change(note.id, 1, 'central', 'user'));
  const replica = f.store.replicas().find((r) => r.id === f.pi.id),
    before = readFileSync(replica.path, 'utf8');
  replica.pending = { ...render(replica, f.store.list(f.project.id)), expected: hash(before) };
  f.store.transaction(() => f.store.saveReplica(replica));
  replace(replica, '\nold\n', '\nlocal\n');
  const report = f.run();
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].proposals[0].content, 'local');
});

test('Same-scope exact duplicates share IDs; different projects do not', (t) => {
  const f = fixture(t),
    root = join(f.root, 'other');
  mkdirSync(root);
  const other = f.store.project(root, true);
  const a = f.store.transaction(() => f.store.add('same', 'project', f.project.id, 'pi'));
  const b = f.store.transaction(() => f.store.add('same', 'project', f.project.id, 'claude'));
  const c = f.store.transaction(() => f.store.add('same', 'project', other.id, 'pi'));
  assert.equal(a.memory.id, b.memory.id);
  assert.notEqual(a.memory.id, c.memory.id);
});

test('Atomic publication refuses external changes and symlink targets', (t) => {
  const f = fixture(t),
    old = readFileSync(f.pi.path, 'utf8');
  replace(f.pi, '# Shared memory', '# Changed externally');
  assert.throws(() => atomicWrite(f.pi.path, 'overwrite', hash(old)), /changed/);
  const outside = join(f.root, 'outside');
  writeFileSync(outside, 'keep');
  unlinkSync(f.pi.path);
  symlinkSync(outside, f.pi.path);
  assert.equal(f.run().errors.length, 1);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

test('Reserved markers are rejected and Unicode survives edits', (t) => {
  const f = fixture(t);
  addFile(f.pi, '偏好中文，使用 pnpm。🧠');
  f.run();
  assert.equal(entries(f.claude)[0].content, '偏好中文，使用 pnpm。🧠');
  assert.throws(() =>
    f.store.transaction(() => f.store.add('<!-- co-memo:new -->', 'user', null, 'user')),
  );
});

test('Editing a note into a duplicate preserves both records as a conflict', (t) => {
  const f = fixture(t);
  const [a, b] = f.store.transaction(() => [
    f.store.add('first', 'project', f.project.id, 'user').memory,
    f.store.add('second', 'project', f.project.id, 'user').memory,
  ]);
  f.run();
  replace(f.pi, '\nfirst\n', '\nsecond\n');
  const report = f.run();
  assert.equal(report.conflicts.length, 1);
  assert.equal(f.store.get(a.id).content, 'first');
  assert.equal(f.store.get(b.id).content, 'second');
  assert.equal(f.store.history(a.id).length, 1);
});

test('Database failures roll back the note and never masquerade as a conflict', (t) => {
  const f = fixture(t);
  addFile(f.pi, 'first');
  f.run();
  const note = entries(f.pi)[0];
  f.store.db.exec(
    "CREATE TRIGGER reject_revision BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
  );
  replace(f.pi, '\nfirst\n', '\nchanged\n');
  assert.throws(() => f.run(), /simulated storage failure/);
  assert.equal(f.store.get(note.id).content, 'first');
  assert.deepEqual(f.store.conflicts(), []);
  f.store.db.exec('DROP TRIGGER reject_revision');
  assert.equal(f.run().updated, 1);
  assert.equal(entries(f.claude)[0].content, 'changed');
});
