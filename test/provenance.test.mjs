import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { submit } from '../dist/candidates.js';
import { createBackup, restoreBackup } from '../dist/backup.js';
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

for (const version of [5, 6]) {
  test(`schema ${version} gains queryable writer columns without inventing legacy identity`, (t) => {
    const f = fixture(t);
    let store = new Store(f.home);
    const note = store.add('legacy note', 'user', null, 'candidate:claude').memory;
    const { writerAgent: _writer, ...legacy } = note;
    const payload = JSON.stringify(legacy);
    store.db.prepare('UPDATE notes SET payload=?').run(payload);
    store.db.prepare('UPDATE revisions SET payload=?').run(payload);
    store.db.exec(`DROP INDEX notes_writer_agent; ALTER TABLE notes DROP COLUMN writer_agent;
      ALTER TABLE revisions DROP COLUMN writer_agent; PRAGMA user_version=${version};`);
    store.close();
    store = new Store(f.home, 'codex');
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
      for (const table of ['notes', 'revisions']) {
        const row = store.db.prepare(`SELECT payload,writer_agent FROM ${table}`).get();
        assert.equal(row.payload, payload);
        assert.equal(row.writer_agent, null);
      }
      assert.equal(store.get(note.id).writerAgent, null);
      store.change(note.id, 1, 'new content', 'mcp');
      assert.equal(store.get(note.id).writerAgent, 'codex');
      assert.deepEqual(
        store.history(note.id).map((m) => m.writerAgent),
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
    assert.equal(a.get(id).writerAgent, 'claude');
    assert.equal(a.get(id).metadata.source.agent, 'claimed-other');
    assert.equal(a.get(id).metadata.source.sessionId, null);
    assert.equal(a.lock(() => submit(a, f.root, req)).replayed, true);
    assert.throws(() => b.lock(() => submit(b, f.root, req)), /Request ID/);
    const duplicate = b.lock(() => submit(b, f.root, request([candidate('Use pnpm')])));
    assert.equal(duplicate.results[0].status, 'existing');
    assert.equal(b.get(id).writerAgent, 'claude');
    b.change(id, 1, 'Use npm', 'mcp');
    b.change(id, 2, null, 'mcp');
    a.restore(id, 3, 'mcp');
    manual.change(id, 4, 'manual correction', 'ui');
    assert.deepEqual(
      a.history(id).map((m) => m.writerAgent),
      ['claude', 'codex', 'codex', 'claude', null],
    );
    assert.equal(
      a.db.prepare('SELECT writer_agent FROM notes WHERE id=?').get(id).writer_agent,
      null,
    );
    assert.deepEqual(
      a.db
        .prepare('SELECT writer_agent FROM revisions WHERE id=? ORDER BY version')
        .all(id)
        .map((r) => r.writer_agent),
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
      conflict.candidates.map((c) => c.writerAgent),
      ['claude', 'codex'],
    );
    assert.equal(conflict.revision, 2);
    const resolved = b.resolve(conflict.id, 2, conflict.candidates[0].id);
    assert.equal(resolved.writerAgent, 'codex');
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
      assert.equal(got.memory.writerAgent, 'claude');
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
      .writerAgent,
    'pi',
  );
  assert.equal(
    run(['--agent-id', 'cursor', 'add', '--scope', 'user', '--content', 'asteroids']).memory
      .writerAgent,
    'cursor',
  );
  assert.equal(run(['add', '--scope', 'user', '--content', 'glaciers']).memory.writerAgent, null);
  assert.throws(() => new Store(join(f.dir, 'invalid'), 'not a valid id'));
});
