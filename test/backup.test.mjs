import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/store.js';
import { createBackup, verifyBackup, restoreBackup } from '../dist/backup.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-backup-')));
  const home = join(root, 'data'),
    project = join(root, 'project');
  mkdirSync(project);
  const store = new Store(home);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const id = store.project(project, true).id;
  return { root, home, project, store, id, archive: join(root, 'backup') };
}
test('WAL backup preserves history, deletion, settings and search; restore detaches replicas without touching source', async (t) => {
  const f = fixture(t);
  f.store.connect(f.store.project(f.project), 'claude');
  const note = f.store.add('Use pnpm dependency manager', 'project', f.id, 'test').memory;
  const gone = f.store.add('Old deleted decision', 'project', f.id, 'test').memory;
  f.store.change(gone.id, gone.version, null, 'test');
  f.store.configure(null, { saveMode: 'explicit' });
  const before = await createBackup(f.archive, f.home);
  assert.equal(before.counts.notes, 2);
  assert.equal((await verifyBackup(f.archive)).status, 'verified');
  f.store.add('Written after backup', 'project', f.id, 'test', 'explicit');
  const target = join(f.root, 'restored');
  assert.equal((await restoreBackup(f.archive, target)).status, 'preview');
  assert.equal(existsSync(target), false);
  const result = await restoreBackup(f.archive, target, true);
  assert.equal(result.detachedReplicas, 1);
  const restored = new Store(target);
  try {
    assert.equal(restored.get(note.id).content, note.content);
    assert.equal(restored.get(gone.id).deleted, true);
    assert.equal(restored.replicas().length, 0);
    assert.equal(restored.settings(null).saveMode, 'explicit');
    assert.equal(restored.db.prepare('SELECT count(*) AS n FROM notes').get().n, 2);
    assert.equal(
      restored.db.prepare('SELECT count(*) AS n FROM revisions').get().n,
      before.counts.revisions,
    );
    assert.equal(restored.search(f.id, 'pnpm')[0].id, note.id);
  } finally {
    restored.close();
  }
  assert.equal(f.store.replicas().length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM notes').get().n, 3);
});
test('existing destinations, tampered backup, sidecars and symlinks are rejected without overwriting', async (t) => {
  const f = fixture(t);
  await createBackup(f.archive, f.home);
  await assert.rejects(createBackup(f.archive, f.home));
  await assert.rejects(restoreBackup(f.archive, f.home, true), /must not exist/);
  const empty = join(f.root, 'empty');
  mkdirSync(empty);
  await assert.rejects(restoreBackup(f.archive, empty, true), /must not exist/);
  const path = join(f.archive, 'shared-memory-v1.sqlite');
  writeFileSync(path + '-wal', 'unexpected');
  await assert.rejects(verifyBackup(f.archive));
  rmSync(path + '-wal', { force: true });
  const original = readFileSync(path);
  const broken = Buffer.from(original);
  broken[100] ^= 1;
  writeFileSync(path, broken);
  await assert.rejects(restoreBackup(f.archive, join(f.root, 'bad'), true));
  assert.equal(existsSync(join(f.root, 'bad')), false);
  rmSync(path);
  symlinkSync(join(f.home, 'shared-memory-v1.sqlite'), path);
  await assert.rejects(verifyBackup(f.archive), /regular database/);
});
test('backup refuses missing and newer stores without creating or migrating them', async (t) => {
  const f = fixture(t);
  const missing = join(f.root, 'missing');
  await assert.rejects(createBackup(f.archive, missing));
  assert.equal(existsSync(missing), false);
  f.store.db.exec('PRAGMA user_version=6');
  await assert.rejects(createBackup(f.archive, f.home), /schema 4/);
  assert.equal(existsSync(f.archive), false);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 6);
});
test('CLI backup/check/restore previews then restores a usable database without model calls', (t) => {
  const f = fixture(t);
  f.store.add('CLI backup test', 'project', f.id, 'test');
  const cli = (...args) => {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), '--home', f.home, ...args],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(cli('backup', f.archive).status, 'backed_up');
  assert.equal(cli('backup-check', f.archive).status, 'verified');
  const target = join(f.root, 'target');
  assert.equal(cli('restore', f.archive, '--to', target).applied, false);
  assert.equal(cli('restore', f.archive, '--to', target, '--apply').status, 'restored');
  const db = new DatabaseSync(join(target, 'shared-memory-v1.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
  } finally {
    db.close();
  }
});

test('schema 4 backups remain readable and restored stores migrate without losing archives', async (t) => {
  const f = fixture(t);
  const note = f.store.add('legacy archived note', 'project', f.id, 'test').memory;
  f.store.change(note.id, 1, null, 'test');
  f.store.db.exec('DROP TABLE purged; PRAGMA user_version=4');
  const backup = await createBackup(f.archive, f.home);
  assert.equal(backup.counts.purged, undefined);
  assert.equal((await verifyBackup(f.archive)).schema, 4);
  const target = join(f.root, 'legacy-restored');
  await restoreBackup(f.archive, target, true);
  const restored = new Store(target);
  try {
    assert.equal(restored.get(note.id).deleted, true);
    assert.equal(restored.history(note.id).length, 2);
    assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version, 5);
  } finally {
    restored.close();
  }
});
