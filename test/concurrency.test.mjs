import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../dist/store.js';
import { beginImmediate } from '../dist/sqlite.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-concurrency-')),
    root = join(dir, 'project');
  mkdirSync(root);
  const store = new Store(join(dir, 'home')),
    project = store.project(root, true);
  const note = store.add('committed content', 'project', project.id, 'test').memory;
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, root, project, note };
}
test('new connections and public CLI readers do not wait for the application lock or an uncommitted writer', (t) => {
  const f = fixture(t),
    mutex = new DatabaseSync(join(f.store.home, 'sync-lock.sqlite'));
  mutex.exec('BEGIN IMMEDIATE');
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    f.store.change(f.note.id, 1, 'uncommitted content', 'test');
    const reader = new Store(f.store.home);
    try {
      assert.equal(reader.read(() => reader.get(f.note.id)).content, 'committed content');
    } finally {
      reader.close();
    }
    for (const args of [
      ['show', f.note.id],
      ['list'],
      ['context'],
      ['history', f.note.id],
      ['settings', 'get'],
      ['status'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), '--home', f.store.home, '--project', f.root, ...args],
        { encoding: 'utf8', timeout: 2000 },
      );
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.doesNotMatch(result.stdout, /uncommitted content/);
    }
  } finally {
    f.store.db.exec('ROLLBACK');
    mutex.exec('ROLLBACK');
    mutex.close();
  }
});
test('read snapshots stay consistent across commits and reject accidental writes', (t) => {
  const f = fixture(t),
    other = new Store(f.store.home);
  try {
    f.store.read(() => {
      assert.equal(f.store.get(f.note.id).version, 1);
      other.lock(() =>
        other.transaction(() => other.change(f.note.id, 1, 'new committed content', 'test')),
      );
      assert.equal(f.store.get(f.note.id).version, 1);
      assert.throws(() => f.store.add('forbidden', 'user', null, 'test'), /readonly/);
    });
    assert.equal(f.store.read(() => f.store.get(f.note.id)).version, 2);
    assert.throws(
      () =>
        f.store.read(() => {
          throw new Error('read failure');
        }),
      /read failure/,
    );
    f.store.lock(() =>
      f.store.transaction(() => f.store.add('after read failure', 'user', null, 'test')),
    );
  } finally {
    other.close();
  }
});
test('busy acquisition has a bounded timeout without invoking a transaction body', (t) => {
  const f = fixture(t),
    blocker = new DatabaseSync(join(f.store.home, 'shared-memory-v1.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const start = performance.now();
    assert.throws(
      () => beginImmediate(f.store.db, 50),
      (e) => (e.errcode & 255) === 5,
    );
    assert.ok(performance.now() - start < 1000);
    assert.equal(f.store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});
test('busy acquisition retries until release; transaction bodies and version failures are never replayed', async (t) => {
  const f = fixture(t);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready\\n'); setTimeout(()=>{db.exec('ROLLBACK');db.close();},600);`,
      join(f.store.home, 'shared-memory-v1.sqlite'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const ended = once(child, 'exit');
  await once(child.stdout, 'data');
  let calls = 0;
  f.store.transaction(() => {
    calls++;
    f.store.change(f.note.id, 1, 'saved once', 'test');
  });
  assert.equal(calls, 1);
  assert.equal(f.store.history(f.note.id).length, 2);
  assert.throws(
    () =>
      f.store.transaction(() => {
        calls++;
        f.store.change(f.note.id, 1, 'stale', 'test');
      }),
    /Version changed/,
  );
  assert.equal(calls, 2);
  assert.equal(f.store.get(f.note.id).content, 'saved once');
  assert.equal((await ended)[0], 0);
});

test('MCP startup and reads bypass an active writer lock and see only committed data', async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const f = fixture(t),
    mutex = new DatabaseSync(join(f.store.home, 'sync-lock.sqlite'));
  const client = new Client({ name: 'concurrency-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), '--home', f.store.home, '--project', f.root, 'serve'],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  mutex.exec('BEGIN IMMEDIATE');
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    f.store.change(f.note.id, 1, 'uncommitted secret', 'test');
    await client.connect(transport, { timeout: 2000 });
    for (const [name, args] of [
      ['memory_get', { id: f.note.id }],
      ['memory_recall', {}],
      ['memory_context', {}],
      ['memory_settings_get', {}],
    ]) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /uncommitted secret/);
      if (name !== 'memory_settings_get') assert.match(JSON.stringify(result), /committed content/);
    }
  } finally {
    f.store.db.exec('ROLLBACK');
    mutex.exec('ROLLBACK');
    mutex.close();
    await client.close();
  }
});
