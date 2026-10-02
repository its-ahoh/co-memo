import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { locationReader } from '../dist/locations.js';

test('locations report central storage and scoped connections, never file replicas or delivery claims', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-locations-'));
  const store = new Store(join(dir, 'data'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const projects = ['one', 'two'].map((name) => {
    const root = join(dir, name);
    mkdirSync(root);
    return store.project(root, true);
  });
  projects.forEach((p) => store.connect(p, 'codex'));
  const note = store.add('project', 'project', projects[0].id, 'test').memory;
  const personal = store.add('personal', 'user', null, 'test').memory;
  const location = locationReader(store)(note);
  assert.equal(location.database, join(store.home, 'shared-memory-v1.sqlite'));
  assert.deepEqual(location.connections, [{ agent: 'codex', root: projects[0].root }]);
  assert.equal(locationReader(store)(personal).connections.length, 2);
  assert.equal('replicas' in location, false);
  assert.equal(existsSync(join(projects[0].root, '.co-memo')), false);
});
