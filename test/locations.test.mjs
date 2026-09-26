import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { sync } from '../dist/sync.js';
import { locationReader } from '../dist/locations.js';

test('locations inspect real file presence, content, scope and line numbers without syncing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-locations-'));
  const store = new Store(join(dir, 'data'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const roots = [join(dir, 'one'), join(dir, 'two')];
  roots.forEach((root) => mkdirSync(root));
  const projects = roots.map((root) => store.project(root, true));
  const replicas = projects.map((project) => store.connect(project, 'codex'));
  const note = store.transaction(
    () => store.add('A project note', 'project', projects[0].id, 'test').memory,
  );
  const personal = store.transaction(
    () => store.add('A personal note', 'user', null, 'test').memory,
  );
  store.lock(() => sync(store));
  let location = locationReader(store)(note);
  assert.equal(location.database, join(store.home, 'shared-memory-v1.sqlite'));
  assert.equal(location.replicas.length, 1);
  assert.equal(location.replicas[0].status, 'current');
  const original = readFileSync(replicas[0].path, 'utf8');
  assert.equal(original.split('\n')[location.replicas[0].line - 1], note.content);
  assert.equal(locationReader(store)(personal).replicas.length, 2);
  writeFileSync(replicas[0].path, original.replace(note.content, 'Unsynchronized change'));
  assert.equal(locationReader(store)(note).replicas[0].status, 'different');
  assert.equal(store.get(note.id).content, note.content);
  writeFileSync(replicas[0].path, 'invalid');
  assert.equal(locationReader(store)(note).replicas[0].status, 'unreadable');
  unlinkSync(replicas[0].path);
  assert.equal(locationReader(store)(note).replicas[0].status, 'missing');
  writeFileSync(replicas[0].path, original);
  store.transaction(() => store.change(note.id, note.version, null, 'test'));
  store.lock(() => sync(store));
  location = locationReader(store)(store.get(note.id));
  assert.equal(location.replicas[0].status, 'not_present');
  assert.equal(location.replicas[0].line, null);
});
