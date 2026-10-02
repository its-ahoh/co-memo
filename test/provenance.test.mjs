import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { submit, Submission } from '../dist/candidates.js';
import { hash } from '../dist/model.js';
import { createBackup, restoreBackup, verifyBackup } from '../dist/backup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareSetup } from '../dist/setup.js';
import { applyAdapter } from '../dist/adapters.js';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-provenance-')));
  const home = join(dir, 'data'),
    root = join(dir, 'project');
  mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home, root };
}
const candidate = (content) => ({ action: 'add', kind: 'note', scope: 'user', content });
const request = (candidates) => ({ requestId: randomUUID(), intent: 'explicit', candidates });

test('schema 7 renames histories and source identity without losing backups, conflict evidence or retry receipts', async (t) => {
  const f = fixture(t);
  let store = new Store(f.home, 'claude');
  const req = request([candidate('literal writerAgent and sourceAgent in content')]);
  const saved = store.lock(() => submit(store, f.root, req));
  const note = store.get(saved.results[0].receipt.id);
  store.change(note.id, 1, 'updated text', 'mcp');
  const proposal = (id) => ({
    action: 'conflict',
    id,
    version: store.get(id).version,
    content: 'proposal with writerAgent',
    kind: 'decision',
  });
  store.lock(() => submit(store, f.root, request([proposal(note.id)])));
  const conflict = store.conflicts()[0];
  store.resolve(conflict.id, conflict.revision, conflict.candidates[0].id);
  const open = store.add('pending record', 'user', null, 'mcp').memory;
  store.lock(() => submit(store, f.root, request([proposal(open.id)])));
  const expectedHistory = store.history(note.id);
  const expectedConflict = store.conflicts()[0];
  const expectedResolution = JSON.parse(
    store.db.prepare('SELECT payload FROM resolutions').get().payload,
  );
  // Recreate the actual schema 7 layout and JSON keys, rather than just lowering its version.
  store.db.exec('DROP INDEX notes_source_agent');
  for (const table of ['notes', 'histories']) {
    store.db.exec(`ALTER TABLE ${table} DROP COLUMN source_agent;
      UPDATE ${table} SET payload=json_remove(json_set(payload, '$.writerAgent', json_extract(payload, '$.sourceAgent')), '$.sourceAgent');
      ALTER TABLE ${table} ADD COLUMN writer_agent TEXT GENERATED ALWAYS AS (json_extract(payload, '$.writerAgent')) VIRTUAL;`);
  }
  for (const table of ['conflicts', 'resolutions']) {
    for (const row of store.db.prepare(`SELECT id,payload FROM ${table}`).all()) {
      const value = JSON.parse(row.payload);
      value.candidates = value.candidates.map(({ sourceAgent, ...rest }) => ({
        ...rest,
        writerAgent: sourceAgent,
      }));
      store.db
        .prepare(`UPDATE ${table} SET payload=? WHERE id=?`)
        .run(JSON.stringify(value), row.id);
    }
  }
  store.db
    .prepare('UPDATE submissions SET fingerprint=? WHERE request_id=?')
    .run(hash(JSON.stringify({ ...Submission.parse(req), writerAgent: 'claude' })), req.requestId);
  store.db.exec(
    'ALTER TABLE histories RENAME TO revisions; CREATE INDEX notes_writer_agent ON notes(writer_agent); PRAGMA user_version=7;',
  );
  store.close();
  const archive = join(f.dir, 'legacy-backup'),
    restoredPath = join(f.dir, 'restored');
  const backup = await createBackup(archive, f.home);
  assert.equal(backup.schema, 7);
  assert.equal(backup.counts.revisions, 4);
  assert.equal(backup.counts.histories, undefined);
  assert.equal((await verifyBackup(archive)).status, 'verified');
  await restoreBackup(archive, restoredPath, true);
  for (const home of [f.home, restoredPath]) {
    store = new Store(home, 'claude');
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
      assert.equal(
        store.db.prepare("SELECT name FROM sqlite_schema WHERE name='revisions'").get(),
        undefined,
      );
      assert.equal(
        store.db.prepare('SELECT source_agent FROM notes WHERE id=?').get(note.id).source_agent,
        'claude',
      );
      assert.equal(
        store.db
          .prepare('PRAGMA table_xinfo(histories)')
          .all()
          .some((c) => c.name === 'writer_agent'),
        false,
      );
      assert.deepEqual(store.history(note.id), expectedHistory);
      assert.deepEqual(store.conflicts()[0], expectedConflict);
      assert.deepEqual(
        JSON.parse(store.db.prepare('SELECT payload FROM resolutions').get().payload),
        expectedResolution,
      );
      const raw = JSON.parse(
        store.db.prepare('SELECT payload FROM notes WHERE id=?').get(note.id).payload,
      );
      assert.equal(Object.hasOwn(raw, 'writerAgent'), false);
      assert.equal(store.lock(() => submit(store, f.root, req)).replayed, true);
      const other = new Store(home, 'codex');
      try {
        assert.throws(() => other.lock(() => submit(other, f.root, req)), /Request ID/);
      } finally {
        other.close();
      }
    } finally {
      store.close();
    }
  }
});

for (const version of [5, 6]) {
  test(`schema ${version} gains queryable writer columns without inventing legacy identity`, (t) => {
    const f = fixture(t);
    let store = new Store(f.home);
    const note = store.add('legacy note', 'user', null, 'candidate:claude').memory;
    const { sourceAgent: _writer, ...legacy } = note;
    const payload = JSON.stringify(legacy);
    store.db.prepare('UPDATE notes SET payload=?').run(payload);
    store.db.prepare('UPDATE histories SET payload=?').run(payload);
    store.db.exec(`DROP INDEX notes_source_agent; ALTER TABLE notes DROP COLUMN source_agent;
      ALTER TABLE histories DROP COLUMN source_agent;
      ALTER TABLE histories RENAME TO revisions; PRAGMA user_version=${version};`);
    store.close();
    store = new Store(f.home, 'codex');
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
      for (const table of ['notes', 'histories']) {
        const row = store.db.prepare(`SELECT payload,source_agent FROM ${table}`).get();
        assert.equal(row.payload, payload);
        assert.equal(row.source_agent, null);
      }
      assert.equal(store.get(note.id).sourceAgent, null);
      store.change(note.id, 1, 'new content', 'mcp');
      assert.equal(store.get(note.id).sourceAgent, 'codex');
      assert.deepEqual(
        store.history(note.id).map((m) => m.sourceAgent),
        [null, 'codex'],
      );
    } finally {
      store.close();
    }
  });
}

test('bound writers survive history and backup; evidence and duplicates never replace attribution', async (t) => {
  const f = fixture(t),
    a = new Store(f.home, 'claude'),
    b = new Store(f.home, 'codex'),
    manual = new Store(f.home);
  try {
    const req = request([
      { ...candidate('Use pnpm'), source: { agent: 'claimed-other', excerpt: 'Use pnpm' } },
    ]);
    const result = a.lock(() => submit(a, f.root, req));
    const id = result.results[0].receipt.id;
    assert.equal(a.get(id).sourceAgent, 'claude');
    assert.equal(a.get(id).metadata.source.agent, 'claimed-other');
    assert.equal(a.get(id).metadata.source.sessionId, null);
    assert.equal(a.lock(() => submit(a, f.root, req)).replayed, true);
    assert.throws(() => b.lock(() => submit(b, f.root, req)), /Request ID/);
    const duplicate = b.lock(() => submit(b, f.root, request([candidate('Use pnpm')])));
    assert.equal(duplicate.results[0].status, 'existing');
    assert.equal(b.get(id).sourceAgent, 'claude');
    b.change(id, 1, 'Use npm', 'mcp');
    b.change(id, 2, null, 'mcp');
    a.restore(id, 3, 'mcp');
    manual.change(id, 4, 'manual correction', 'ui');
    assert.deepEqual(
      a.history(id).map((m) => m.sourceAgent),
      ['claude', 'codex', 'codex', 'claude', null],
    );
    assert.equal(
      a.db.prepare('SELECT source_agent FROM notes WHERE id=?').get(id).source_agent,
      null,
    );
    assert.deepEqual(
      a.db
        .prepare('SELECT source_agent FROM histories WHERE id=? ORDER BY version')
        .all(id)
        .map((r) => r.source_agent),
      ['claude', 'codex', 'codex', 'claude', null],
    );
    const backup = join(f.dir, 'backup'),
      restoredPath = join(f.dir, 'restored');
    await createBackup(backup, f.home);
    await restoreBackup(backup, restoredPath, true);
    const restored = new Store(restoredPath);
    try {
      assert.deepEqual(restored.history(id), a.history(id));
    } finally {
      restored.close();
    }
  } finally {
    a.close();
    b.close();
    manual.close();
  }
});

test('conflict candidates retain their submitting agents and resolution records its own writer', (t) => {
  const f = fixture(t),
    a = new Store(f.home, 'claude'),
    b = new Store(f.home, 'codex');
  try {
    const note = a.add('initial', 'user', null, 'mcp').memory;
    const proposal = {
      action: 'conflict',
      id: note.id,
      version: 1,
      content: 'proposed',
      kind: 'decision',
    };
    a.lock(() => submit(a, f.root, request([proposal])));
    b.lock(() => submit(b, f.root, request([proposal])));
    const conflict = a.conflicts()[0];
    assert.deepEqual(
      conflict.candidates.map((c) => c.sourceAgent),
      ['claude', 'codex'],
    );
    assert.equal(conflict.revision, 2);
    const resolved = b.resolve(conflict.id, 2, conflict.candidates[0].id);
    assert.equal(resolved.sourceAgent, 'codex');
    assert.equal(resolved.metadata.source, null);
  } finally {
    a.close();
    b.close();
  }
});

test('generated MCP configuration binds the writer even when source is absent or declares another agent', async (t) => {
  const f = fixture(t);
  applyAdapter(prepareSetup(f.root, 'claude', f.home, { toolsOnly: true }));
  const config = JSON.parse(readFileSync(join(f.root, '.mcp.json'), 'utf8')).mcpServers['co-memo'];
  const client = new Client({ name: 'different-client-name', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    const result = await call(
      'memory_submit',
      request([
        candidate('zebras'),
        { ...candidate('satellites'), source: { agent: 'codex', excerpt: 'satellites' } },
      ]),
    );
    for (const item of result.results) {
      const got = await call('memory_get', { id: item.receipt.id });
      assert.equal(got.memory.sourceAgent, 'claude');
    }
    const first = await call('memory_get', { id: result.results[0].receipt.id });
    assert.equal(first.memory.metadata.source, null);
  } finally {
    await client.close();
  }
});

test('Pi pinned CLI carries its identity; manual clients can bind custom IDs and unbound writes remain unknown', (t) => {
  const f = fixture(t);
  applyAdapter(prepareSetup(f.root, 'pi', f.home, { toolsOnly: true }));
  const text = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.match(text, /'--agent-id' 'pi'/);
  const base = [resolve('dist/cli.js'), '--home', f.home, '--project', f.root];
  const run = (args) => {
    const r = spawnSync(process.execPath, [...base, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(
    run(['--agent-id', 'pi', 'add', '--scope', 'user', '--content', 'tangerines']).memory
      .sourceAgent,
    'pi',
  );
  assert.equal(
    run(['--agent-id', 'cursor', 'add', '--scope', 'user', '--content', 'asteroids']).memory
      .sourceAgent,
    'cursor',
  );
  assert.equal(run(['add', '--scope', 'user', '--content', 'glaciers']).memory.sourceAgent, null);
  assert.throws(() => new Store(join(f.dir, 'invalid'), 'not a valid id'));
});
