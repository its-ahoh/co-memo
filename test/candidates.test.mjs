import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { submit } from '../dist/candidates.js';
import { context, sync } from '../dist/sync.js';
import { recall } from '../dist/service.js';
import { Metadata } from '../dist/model.js';

const source = {
  agent: 'codex',
  sessionId: 'session-1',
  messageId: 'message-1',
  excerpt: 'Use pnpm for this project.',
};
const add = (content, extra = {}) => ({
  action: 'add',
  content,
  kind: 'decision',
  source,
  ...extra,
});
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-candidates-')));
  const home = join(root, 'data');
  const path = join(root, 'project');
  mkdirSync(path);
  const store = new Store(home);
  const project = store.project(path, true);
  const run = (candidates, extra = {}) =>
    store.lock(() =>
      submit(store, path, { requestId: randomUUID(), intent: 'automatic', candidates, ...extra }),
    );
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, path, store, project, run };
}

test('FTS shares Chinese and identifier tokenization across recall/context, and scope filters precede results', (t) => {
  const f = fixture(t);
  f.run([
    add('数据库迁移必须使用事务'),
    add('Use parseHTTP_response in src/storage.ts'),
    add('Unrelated landing-page colors'),
  ]);
  const other = join(f.root, 'other');
  mkdirSync(other);
  const p = f.store.project(other, true);
  f.store.add('数据库迁移 private secret', 'project', p.id, 'test');
  for (const query of ['数据库迁移', 'parseHTTP_response', 'storage.ts']) {
    const found = f.store.search(f.project.id, query);
    assert.ok(found.length > 0);
    const recalled = f.store.lock(() => recall(f.store, f.path, query)).memories;
    assert.deepEqual(
      recalled.map((m) => m.id),
      found.map((m) => m.id),
    );
    const injected = context(f.store, f.project.id, 16000, query);
    assert.ok(injected.includes(found[0].content));
    assert.ok(!injected.includes('private secret'));
    assert.ok(!injected.includes('landing-page colors'));
  }
  assert.doesNotThrow(() => f.store.search(f.project.id, '" OR * NOT : ( ) ; DROP TABLE notes;'));
  assert.deepEqual(f.store.search(f.project.id, 'the 我 的'), []);
});

test('candidate source, pinning and supersession survive histories; legacy edits clear stale evidence', (t) => {
  const f = fixture(t);
  const created = f.run([
    add('Always answer in Chinese', { kind: 'preference', scope: 'user', pinned: true }),
    add('Use npm'),
  ]);
  const note = f.store.get(created.results[1].receipt.id);
  assert.deepEqual(note.metadata.source, source);
  assert.ok(
    context(f.store, f.project.id, 16000, 'unrelated').includes('Always answer in Chinese'),
  );
  const correction = {
    ...source,
    messageId: 'message-2',
    excerpt: 'We migrated from npm to pnpm.',
  };
  const updated = f.run([
    {
      action: 'update',
      id: note.id,
      version: note.version,
      content: 'Use pnpm',
      kind: 'decision',
      source: correction,
      basis: 'user_correction',
    },
  ]);
  assert.equal(updated.results[0].verified, true);
  const current = f.store.get(note.id);
  assert.deepEqual(current.metadata.supersedes, { id: note.id, version: 1 });
  assert.deepEqual(current.metadata.source, correction);
  assert.equal(current.metadata.basis, 'user_correction');
  assert.deepEqual(f.store.history(note.id)[0].metadata.source, source);
  assert.equal(f.store.search(f.project.id, 'npm').length, 0);
  assert.equal(f.store.search(f.project.id, 'pnpm')[0].id, note.id);
  f.store.transaction(() => f.store.change(note.id, 2, 'Use yarn', 'agent:claude'));
  assert.equal(f.store.get(note.id).metadata.source, null);
  assert.deepEqual(f.store.get(note.id).metadata.supersedes, { id: note.id, version: 2 });
});

test('candidate batch rolls back notes, histories, full-text index and retry record on stale writes', (t) => {
  const f = fixture(t);
  const note = f.run([add('Existing note')]).results[0].receipt;
  const requestId = randomUUID();
  const candidates = [
    add('rollbackneedle'),
    {
      action: 'update',
      id: note.id,
      version: 999,
      content: 'Wrong update',
      kind: 'decision',
      source,
      basis: 'verified_change',
    },
  ];
  assert.throws(() => f.run(candidates, { requestId }), /Version changed/);
  assert.equal(f.store.search(f.project.id, 'rollbackneedle').length, 0);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.equal(f.store.history(note.id).length, 1);
  assert.equal(f.store.submission(f.project.id, requestId), null);
});

test('idempotent retries never reapply updates and report stale receipts truthfully', (t) => {
  const f = fixture(t);
  const requestId = randomUUID();
  const candidates = [add('Use pnpm')];
  const first = f.run(candidates, { requestId });
  const replay = f.run(candidates, { requestId });
  assert.equal(replay.replayed, true);
  assert.equal(replay.results[0].receipt.id, first.results[0].receipt.id);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.throws(() => f.run([add('different request')], { requestId }), /already used/);
  f.store.transaction(() => f.store.change(first.results[0].receipt.id, 1, 'Use npm now', 'user'));
  const stale = f.run(candidates, { requestId });
  assert.equal(stale.results[0].verified, false);
  assert.equal(stale.results[0].verification, 'stale');
  assert.equal(f.store.get(first.results[0].receipt.id).content, 'Use npm now');
});

test('candidate contradictions freeze retrieval until explicit resolution, preserving selected evidence', (t) => {
  const f = fixture(t);
  f.store.connect(f.project, 'codex');
  const note = f.run([add('Use npm')]).results[0].receipt;
  const result = f.run([
    { action: 'conflict', id: note.id, version: 1, content: 'Use pnpm', kind: 'decision', source },
  ]);
  assert.equal(result.results[0].status, 'needs_resolution');
  assert.equal(result.results[0].verified, false);
  assert.equal(f.store.search(f.project.id, 'npm').length, 0);
  assert.ok(!context(f.store, f.project.id).includes('Use npm'));
  const conflict = f.store.conflicts()[0];
  assert.equal(conflict.candidates[0].metadata.source.excerpt, source.excerpt);
  f.store.transaction(() =>
    f.store.resolve(conflict.id, conflict.revision, conflict.candidates[0].id),
  );
  f.store.lock(() => sync(f.store));
  assert.equal(f.store.conflicts().length, 0);
  const current = f.store.search(f.project.id, 'pnpm')[0];
  assert.equal(current.content, 'Use pnpm');
  assert.deepEqual(current.metadata.source, source);
  assert.deepEqual(current.metadata.supersedes, { id: note.id, version: 1 });
});

test('candidate writes honor settings, scope, deleted duplicates and metadata restrictions', (t) => {
  const f = fixture(t);
  f.store.configure(null, { saveMode: 'explicit' }, false);
  assert.throws(() => f.run([add('Denied')]), /explicit/i);
  const first = f.run([add('Allowed')], { intent: 'explicit' });
  f.store.transaction(() => f.store.change(first.results[0].receipt.id, 1, null, 'user'));
  const duplicate = f.run([add('Allowed')], { intent: 'explicit' });
  assert.equal(duplicate.results[0].status, 'deleted_duplicate');
  assert.equal(duplicate.results[0].verified, false);
  assert.equal(f.store.search(f.project.id, 'Allowed').length, 0);
  assert.equal(f.store.search(f.project.id, 'Allowed', true).length, 1);
  assert.throws(
    () => f.run([add('Pinned decision', { pinned: true })], { intent: 'explicit' }),
    /Only preferences/,
  );
  const other = join(f.root, 'other');
  mkdirSync(other);
  const p = f.store.project(other, true);
  const foreign = f.store.add('Foreign', 'project', p.id, 'user').memory;
  assert.throws(
    () =>
      f.run(
        [
          {
            action: 'update',
            id: foreign.id,
            version: 1,
            content: 'Steal',
            kind: 'decision',
            source,
            basis: 'user_correction',
          },
        ],
        { intent: 'explicit' },
      ),
    /another project/,
  );
  f.store.configure(f.project.id, { paused: true }, false);
  assert.throws(() => f.run([add('Paused')], { intent: 'explicit' }), /paused/i);
});

test('schema 2 migration indexes legacy payloads without rewriting history', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-migration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new Store(join(root, 'data'));
  const project = store.project(root, true);
  const note = store.add('legacy 数据库 migration', 'project', project.id, 'legacy').memory;
  const { metadata, ...legacy } = note;
  store.db.prepare('UPDATE notes SET payload=? WHERE id=?').run(JSON.stringify(legacy), note.id);
  store.db
    .prepare('UPDATE histories SET payload=? WHERE id=?')
    .run(JSON.stringify(legacy), note.id);
  store.db.exec('DROP TABLE notes_fts; DROP TABLE submissions; PRAGMA user_version=2;');
  store.close();
  store = new Store(join(root, 'data'));
  try {
    assert.equal(store.search(project.id, '数据库')[0].id, note.id);
    assert.equal(store.get(note.id).metadata.source, null);
    assert.equal(store.get(note.id).metadata.kind, 'note');
    assert.equal(store.history(note.id).length, 1);
    assert.equal(
      store.db.prepare('SELECT payload FROM histories WHERE id=?').get(note.id).payload,
      JSON.stringify(legacy),
    );
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
  } finally {
    store.close();
  }
});

test('updates preserve omitted organization metadata, clear evidence and allow explicit clearing', (t) => {
  const f = fixture(t);
  const created = f.run([
    add('Use short orchard reports', { kind: 'preference', module: 'orchard', pinned: true }),
  ]);
  const id = created.results[0].receipt.id;
  const update = {
    action: 'update',
    id,
    version: 1,
    basis: 'verified_change',
    kind: 'preference',
    content: 'Use concise orchard reports',
  };
  const requestId = randomUUID();
  f.run([update], { requestId });
  let note = f.store.get(id);
  assert.equal(note.metadata.module, 'orchard');
  assert.equal(note.metadata.pinned, true);
  assert.equal(note.metadata.source, null);
  f.run([update], { requestId });
  assert.equal(f.store.get(id).version, 2);
  assert.throws(
    () => f.run([{ ...update, module: null, pinned: false }], { requestId }),
    /different candidates/,
  );
  assert.throws(() => f.run([{ ...update, version: 2, kind: 'decision' }]), /Only preferences/);
  assert.equal(f.store.get(id).version, 2);
  f.run([{ ...update, version: 2, kind: 'decision', module: null, pinned: false }]);
  note = f.store.get(id);
  assert.equal(note.metadata.module, null);
  assert.equal(note.metadata.pinned, false);
  assert.equal(note.metadata.kind, 'decision');
  assert.ok(f.store.history(id).some((m) => m.metadata.module === 'orchard' && m.metadata.pinned));
});

test('pre-change update receipts replay without applying new preservation semantics', async (t) => {
  const { hash } = await import('../dist/model.js');
  const { Submission } = await import('../dist/candidates.js');
  for (const fields of [{}, { pinned: false }, { module: null }]) {
    const f = fixture(t);
    const made = f.run([add('Use amber labels')]);
    const id = made.results[0].receipt.id;
    const input = {
      requestId: randomUUID(),
      intent: 'automatic',
      candidates: [
        {
          action: 'update',
          id,
          version: 1,
          basis: 'verified_change',
          kind: 'decision',
          content: 'Use indigo labels',
          ...fields,
        },
      ],
    };
    const result = f.run(input.candidates, { requestId: input.requestId });
    input.requestId = randomUUID();
    const legacy = Submission.parse(input);
    const { module, pinned, ...candidate } = legacy.candidates[0];
    legacy.candidates[0] = { ...candidate, module: module ?? null, pinned: pinned ?? false };
    f.store.saveSubmission(
      f.project.id,
      input.requestId,
      hash(JSON.stringify(legacy)),
      result.results,
    );
    const replay = f.run(input.candidates, { requestId: input.requestId });
    assert.equal(replay.results[0].receipt.version, 2);
    assert.equal(f.store.get(id).version, 2);
  }
});

test('conflict candidates preserve omitted organization metadata through resolution', (t) => {
  const f = fixture(t);
  const created = f.run([
    add('Use short orchard reports', { kind: 'preference', module: 'orchard', pinned: true }),
  ]);
  const id = created.results[0].receipt.id;
  const proposed = {
    action: 'conflict',
    id,
    version: 1,
    kind: 'preference',
    content: 'Use detailed orchard reports',
  };
  f.run([proposed]);
  let conflict = f.store.conflicts()[0];
  f.store.resolve(conflict.id, conflict.revision, conflict.candidates[0].id);
  let note = f.store.get(id);
  assert.equal(note.content, 'Use detailed orchard reports');
  assert.equal(note.metadata.module, 'orchard');
  assert.equal(note.metadata.pinned, true);
  f.run([{ ...proposed, version: note.version, module: null, pinned: false }]);
  conflict = f.store.conflicts()[0];
  f.store.resolve(conflict.id, conflict.revision, conflict.candidates[0].id);
  note = f.store.get(id);
  assert.equal(note.metadata.module, null);
  assert.equal(note.metadata.pinned, false);
});

test('content-only updates keep a legacy pinned non-preference note', (t) => {
  const f = fixture(t);
  const legacy = f.store.add(
    'Legacy pinned reminder',
    'project',
    f.project.id,
    'test',
    'explicit',
    Metadata.parse({ kind: 'note', pinned: true }),
  ).memory;
  const update = {
    action: 'update',
    id: legacy.id,
    version: 1,
    basis: 'user_correction',
    kind: 'note',
    content: 'Legacy pinned reminder, corrected',
  };
  f.run([update]);
  const note = f.store.get(legacy.id);
  assert.equal(note.content, 'Legacy pinned reminder, corrected');
  assert.equal(note.metadata.pinned, true);
  assert.throws(() => f.run([{ ...update, version: 2, kind: 'decision' }]), /Only preferences/);
});

test('pre-change conflict receipts replay without a second conflict', async (t) => {
  const { hash } = await import('../dist/model.js');
  const { Submission } = await import('../dist/candidates.js');
  const f = fixture(t);
  const made = f.run([add('Use amber labels')]);
  const id = made.results[0].receipt.id;
  const input = {
    requestId: randomUUID(),
    intent: 'automatic',
    candidates: [
      { action: 'conflict', id, version: 1, kind: 'decision', content: 'Use teal labels' },
    ],
  };
  const result = f.run(input.candidates, { requestId: input.requestId });
  input.requestId = randomUUID();
  const legacy = Submission.parse(input);
  const { module, pinned, ...candidate } = legacy.candidates[0];
  legacy.candidates[0] = { ...candidate, module: module ?? null, pinned: pinned ?? false };
  f.store.saveSubmission(
    f.project.id,
    input.requestId,
    hash(JSON.stringify(legacy)),
    result.results,
  );
  const replay = f.run(input.candidates, { requestId: input.requestId });
  assert.equal(replay.replayed, true);
  assert.equal(f.store.conflicts().length, 1);
});
