import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';
import { prepare, submit } from '../dist/candidates.js';
import { context } from '../dist/sync.js';
const source = {
  agent: 'test',
  sessionId: 'fixture-session',
  messageId: 'fixture-message',
  excerpt: 'synthetic test evidence',
};
const add = (content, scope = 'project') => ({
  action: 'add',
  content,
  scope,
  source,
  kind: 'decision',
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-review-')),
    root = join(dir, 'project');
  mkdirSync(root);
  const store = new Store(join(dir, 'home')),
    project = store.project(root, true);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const make = (candidates) => ({ requestId: randomUUID(), intent: 'automatic', candidates });
  return {
    store,
    root,
    project,
    make,
    run: (args) => store.lock(() => submit(store, root, args)),
    review: (args) =>
      store.lock(() => prepare(store, root, { intent: args.intent, candidates: args.candidates })),
  };
}
test('related addition returns evidence and saves nothing in the entire batch until reviewed', (t) => {
  const f = fixture(t),
    old = f.store.add('Use pnpm for builds', 'project', f.project.id, 'test').memory;
  const args = f.make([add('Use pnpm for tests'), add('Unrelated architecture decision')]);
  const pending = f.run(args);
  assert.equal(pending.status, 'needs_review');
  assert.equal(pending.review.items[0].related[0].id, old.id);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.equal(f.store.submission(f.project.id, args.requestId), null);
  const reviewed = {
    ...args,
    review: {
      token: pending.review.token,
      reason: 'Build and test configurations are distinct facts.',
    },
  };
  assert.ok(f.run(reviewed).results.every((r) => r.verified));
  assert.equal(f.run(reviewed).replayed, true);
});
test('changed related memories and concurrent related additions invalidate a review', (t) => {
  const f = fixture(t),
    old = f.store.add('Use pnpm for builds', 'project', f.project.id, 'test').memory;
  const args = f.make([add('Use pnpm for tests')]);
  let review = f.review(args);
  f.store.change(old.id, 1, 'Use npm for builds', 'test');
  assert.equal(
    f.run({ ...args, review: { token: review.token, reason: 'distinct' } }).status,
    'needs_review',
  );
  review = f.review(args);
  const second = new Store(f.store.home);
  try {
    second.lock(() =>
      second.transaction(() =>
        second.add('Use pnpm for tests locally', 'project', f.project.id, 'other'),
      ),
    );
  } finally {
    second.close();
  }
  assert.equal(
    f.run({ ...args, review: { token: review.token, reason: 'distinct' } }).status,
    'needs_review',
  );
});
test('exact duplicates remain idempotent; archives never resurrect; foreign scopes do not leak', (t) => {
  const f = fixture(t),
    old = f.store.add('Use pnpm', 'project', f.project.id, 'test').memory;
  assert.equal(f.run(f.make([add('Use pnpm')])).results[0].status, 'existing');
  f.store.change(old.id, 1, null, 'test');
  assert.equal(f.run(f.make([add('Use pnpm')])).results[0].status, 'deleted_duplicate');
  f.store.add('Use pnpm personal secret', 'user', null, 'test');
  const other = join(f.root, 'other');
  mkdirSync(other);
  const p = f.store.project(other, true);
  f.store.add('Use pnpm foreign secret', 'project', p.id, 'test');
  const review = f.review(f.make([add('Use pnpm carefully')]));
  assert.doesNotMatch(JSON.stringify(review), /personal secret|foreign secret/);
  assert.equal(review.items[0].related[0].deleted, true);
});
test('similarity and negation require a decision, never an automatic merge; batch peers are reviewed', (t) => {
  const f = fixture(t);
  const args = f.make([add('Use pnpm for builds'), add('Do not use pnpm for builds')]);
  const result = f.run(args);
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.review.items[0].peers, [1]);
  assert.deepEqual(f.store.list(f.project.id), []);
  assert.deepEqual(f.store.conflicts(), []);
});
test('uncertain contradictions accumulate evidence while explicit resolution unblocks context', (t) => {
  const f = fixture(t),
    old = f.store.add('Use npm', 'project', f.project.id, 'test').memory;
  const candidate = (content) => ({
    action: 'conflict',
    id: old.id,
    version: 1,
    content,
    kind: 'decision',
    source,
  });
  const first = f.run(f.make([candidate('Use pnpm')]));
  const second = f.run(f.make([candidate('Use yarn')]));
  assert.equal(first.results[0].conflictId, second.results[0].conflictId);
  f.run(f.make([candidate('Use pnpm')]));
  const conflict = f.store.conflicts()[0];
  assert.equal(conflict.candidates.length, 2);
  assert.doesNotMatch(context(f.store, f.project.id), /Use npm/);
  const prepared = f.review(f.make([add('Use npm for builds')]));
  assert.equal(prepared.items[0].related[0].conflict.id, conflict.id);
  const resolved = f.store.lock(() =>
    f.store.transaction(() =>
      f.store.resolve(conflict.id, conflict.revision, conflict.candidates[0].id),
    ),
  );
  assert.equal(resolved.content, 'Use pnpm');
  assert.deepEqual(resolved.metadata.source, source);
  assert.equal(f.store.history(old.id).length, 2);
  assert.match(context(f.store, f.project.id), /Use pnpm/);
});
test('verified correction updates the existing ID; stale versions and paused/explicit settings still apply', (t) => {
  const f = fixture(t),
    old = f.store.add('Use npm', 'project', f.project.id, 'test').memory;
  const args = f.make([
    {
      action: 'update',
      id: old.id,
      version: 1,
      content: 'Use pnpm',
      kind: 'decision',
      source,
      basis: 'user_correction',
    },
  ]);
  assert.equal(f.run(args).results[0].receipt.id, old.id);
  assert.throws(() => f.run({ ...args, requestId: randomUUID() }), /Version changed/);
  f.store.configure(f.project.id, { paused: true });
  assert.throws(() => f.review(f.make([add('anything')])), /paused/);
  f.store.configure(f.project.id, { paused: false, saveMode: 'explicit' });
  assert.throws(() => f.run(f.make([add('anything')])), /Explicit-only/);
});

test('scope filtering happens before the search result cap', (t) => {
  const f = fixture(t);
  const note = f.store.add(
    'Use pnpm for builds entry original',
    'project',
    f.project.id,
    'test',
  ).memory;
  for (let i = 0; i < 110; i++) f.store.add(`Use pnpm for builds entry ${i}`, 'user', null, 'test');
  const result = f.review(f.make([add('Use pnpm for builds entry proposed')]));
  assert.equal(result.required, true);
  assert.deepEqual(
    result.items[0].related.map((m) => m.id),
    [note.id],
  );
});

test('direct saves allow unknown provenance and preserve partial truthful evidence', (t) => {
  const f = fixture(t);
  const first = f.run(f.make([{ action: 'add', content: 'Use pnpm', kind: 'decision' }]));
  assert.equal(first.results[0].verified, true);
  assert.equal(f.store.get(first.results[0].receipt.id).metadata.source, null);
  const corrected = f.run(
    f.make([
      {
        action: 'update',
        id: first.results[0].receipt.id,
        version: 1,
        basis: 'user_correction',
        content: 'Use npm',
        kind: 'decision',
        source: { agent: 'test', excerpt: 'Use npm', messageId: 'actual-test-message' },
      },
    ]),
  );
  const stored = f.store.get(corrected.results[0].receipt.id);
  assert.deepEqual(stored.metadata.source, {
    agent: 'test',
    excerpt: 'Use npm',
    messageId: 'actual-test-message',
    sessionId: null,
  });
  assert.equal(f.store.history(stored.id)[0].metadata.source, null);
});

test('legacy remember uses the shared review gate, detects stale reviews and verifies writes', async (t) => {
  const { remember, change } = await import('../dist/service.js');
  const f = fixture(t);
  const run = (input) =>
    f.store.lock(() => remember(f.store, f.root, { intent: 'explicit', ...input }, 'test'));
  const first = run({ content: 'Use pnpm for builds' });
  assert.equal(first.verified, true);
  const content = 'Use pnpm for tests';
  const pending = run({ content });
  assert.equal(pending.status, 'needs_review');
  assert.equal(f.store.list(f.project.id).length, 1);
  const correction = f.store.lock(() =>
    change(
      f.store,
      f.root,
      {
        id: first.memory.id,
        version: 1,
        content: 'Use yarn for builds',
        intent: 'explicit',
      },
      'test',
    ),
  );
  assert.equal(correction.verified, true);
  const stale = run({ content, review: { token: pending.review.token, reason: 'Distinct' } });
  assert.equal(stale.status, 'needs_review');
  const saved = run({
    content,
    review: { token: stale.review.token, reason: 'Tests use a separate toolchain' },
  });
  assert.equal(saved.verified, true);
  assert.equal(saved.memory.origin, 'test');
  assert.equal(run({ content }).created, false);
});

test('batch corrections invalidate old exact exemptions in either input order', (t) => {
  for (const addFirst of [false, true]) {
    const f = fixture(t);
    const old = f.store.add('Use pnpm for builds', 'project', f.project.id, 'fixture').memory;
    const update = {
      action: 'update',
      id: old.id,
      version: 1,
      basis: 'user_correction',
      content: 'Use npm for builds',
      kind: 'decision',
    };
    const addition = add(old.content);
    const args = f.make(addFirst ? [addition, update] : [update, addition]);
    const pending = f.run(args);
    assert.equal(pending.status, 'needs_review');
    const index = addFirst ? 0 : 1;
    assert.deepEqual(pending.review.items[index].peers, [1 - index]);
    assert.equal(f.store.get(old.id).version, 1);
    assert.equal(f.store.list(f.project.id).length, 1);
    const result = f.run({
      ...args,
      review: { token: pending.review.token, reason: 'Synthetic separate configurations' },
    });
    assert.ok(result.results.every((r) => r.verified));
    assert.equal(result.results[index].action, 'add');
    assert.equal(result.results[index].status, 'created');
    assert.equal(result.results[1 - index].receipt.id, old.id);
    assert.equal(f.store.list(f.project.id).length, 2);
  }
});

test('additions matching a planned update reuse its final record in either input order', (t) => {
  for (const addFirst of [true, false]) {
    const f = fixture(t);
    const old = f.store.add('Legacy toolchain', 'project', f.project.id, 'fixture').memory;
    const update = {
      action: 'update',
      id: old.id,
      version: 1,
      basis: 'verified_change',
      content: 'Use pnpm for builds',
      kind: 'decision',
    };
    const addition = add(update.content);
    const args = f.make(addFirst ? [addition, update] : [update, addition]);
    const pending = f.run(args);
    assert.equal(pending.status, 'needs_review');
    assert.deepEqual(pending.review.items[addFirst ? 0 : 1].peers, [addFirst ? 1 : 0]);
    const result = f.run({
      ...args,
      review: { token: pending.review.token, reason: 'Same final fact; reuse updated note' },
    });
    assert.equal(result.results[addFirst ? 0 : 1].status, 'existing');
    assert.ok(
      result.results.every((r) => r.verified && r.receipt.id === old.id && r.receipt.version === 2),
    );
    assert.equal(f.store.list(f.project.id).length, 1);
    assert.equal(f.store.history(old.id).length, 2);
  }
});

test('freshness covers records beyond both display and search limits and ignores other scopes', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 110; i++)
    f.store.add(`Use pnpm for tests variant${i}`, 'project', f.project.id, 'fixture');
  const args = f.make([add('Use pnpm for tests')]);
  let review = f.review(args);
  const unrelated = f.store.add('Personal display preference', 'user', null, 'fixture').memory;
  assert.equal(f.review(args).token, review.token);
  const otherRoot = join(f.root, 'elsewhere');
  mkdirSync(otherRoot);
  const other = f.store.project(otherRoot, true);
  f.store.add('Foreign display preference', 'project', other.id, 'fixture');
  assert.equal(f.review(args).token, review.token);
  const content =
    'Do not use pnpm for tests ' +
    Array.from({ length: 300 }, (_, i) => `contextword${i}`).join(' ');
  const hidden = f.store.add(content, 'project', f.project.id, 'fixture').memory;
  assert.equal(
    f.store
      .search(f.project.id, args.candidates[0].content, true, true, 'project')
      .some((m) => m.id === hidden.id),
    false,
  );
  const refreshed = f.review(args);
  assert.deepEqual(refreshed.items, review.items);
  assert.equal(
    f.run({ ...args, review: { token: review.token, reason: 'Previously reviewed' } }).status,
    'needs_review',
  );
  for (const mutate of [
    () => f.store.change(hidden.id, 1, content + ' Additional evidence', 'fixture'),
    () =>
      f.store.conflict(
        f.store.get(hidden.id),
        [],
        [{ id: randomUUID(), content: 'Use a different tool', metadata: unrelated.metadata }],
      ),
    () =>
      f.store.conflict(
        f.store.get(hidden.id),
        [],
        [{ id: randomUUID(), content: 'Keep existing tool', metadata: unrelated.metadata }],
      ),
    () => f.store.purge(hidden.id, 2),
  ]) {
    review = f.review(args);
    f.store.lock(() => f.store.transaction(mutate));
    assert.equal(
      f.run({ ...args, review: { token: review.token, reason: 'Previously reviewed' } }).status,
      'needs_review',
    );
  }
});

test('legacy conflicts gain a revision; appended evidence rejects stale choices but duplicate evidence does not', (t) => {
  const f = fixture(t);
  const old = f.store.add('Use npm', 'project', f.project.id, 'fixture').memory;
  const candidate = (content) => ({
    action: 'conflict',
    id: old.id,
    version: 1,
    content,
    kind: 'decision',
  });
  const first = f.run(f.make([candidate('Use pnpm')]));
  assert.equal(first.results[0].conflictRevision, 1);
  const legacy = f.store.conflicts()[0];
  delete legacy.revision;
  f.store.db
    .prepare('UPDATE conflicts SET payload=? WHERE id=?')
    .run(JSON.stringify(legacy), legacy.id);
  const seen = f.store.conflicts()[0];
  assert.equal(seen.revision, 1);
  const second = f.run(f.make([candidate('Use yarn')]));
  assert.equal(second.results[0].conflictRevision, 2);
  assert.equal(f.run(f.make([candidate('Use yarn')])).results[0].conflictRevision, 2);
  for (const [choice, content] of [
    ['current', undefined],
    [seen.candidates[0].id, undefined],
    ['custom', 'Merged decision'],
  ]) {
    assert.throws(
      () =>
        f.store.lock(() =>
          f.store.transaction(() => f.store.resolve(seen.id, seen.revision, choice, content)),
        ),
      /Conflict changed/,
    );
  }
  assert.equal(f.store.conflicts()[0].candidates.length, 2);
  assert.equal(f.store.get(old.id).version, 1);
  const resolved = f.store.lock(() =>
    f.store.transaction(() => f.store.resolve(seen.id, 2, seen.candidates[0].id)),
  );
  assert.equal(resolved.content, 'Use pnpm');
  assert.equal(f.store.conflicts().length, 0);
  assert.equal(f.store.history(old.id).length, 2);
});

test('an addition failure rolls back earlier batch corrections', (t) => {
  const f = fixture(t);
  const old = f.store.add('Legacy toolchain', 'project', f.project.id, 'fixture').memory;
  const args = f.make([
    { action: 'add', content: 'Pin this decision', kind: 'decision', pinned: true },
    {
      action: 'update',
      id: old.id,
      version: 1,
      basis: 'verified_change',
      content: 'New toolchain',
      kind: 'decision',
    },
  ]);
  assert.throws(() => f.run(args), /Only preferences/);
  assert.equal(f.store.get(old.id).version, 1);
  assert.equal(f.store.history(old.id).length, 1);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.equal(f.store.submission(f.project.id, args.requestId), null);
});

test('legacy edits normalize whitespace before hashing and later adds reuse the same note', async (t) => {
  const { change, remember } = await import('../dist/service.js');
  const f = fixture(t);
  const old = f.store.add('Original', 'project', f.project.id, 'fixture').memory;
  const edited = f.store.lock(() =>
    change(
      f.store,
      f.root,
      { id: old.id, version: 1, content: '\n\t  Use pnpm\u00a0 ', intent: 'explicit' },
      'fixture',
    ),
  );
  assert.equal(edited.memory.content, 'Use pnpm');
  const unchanged = f.store.lock(() =>
    change(
      f.store,
      f.root,
      { id: old.id, version: 2, content: '  Use pnpm  ', intent: 'explicit' },
      'fixture',
    ),
  );
  assert.equal(unchanged.memory.version, 2);
  const added = f.store.lock(() =>
    remember(f.store, f.root, { content: 'Use pnpm', intent: 'explicit' }, 'fixture'),
  );
  assert.equal(added.created, false);
  assert.equal(added.memory.id, old.id);
  assert.equal(added.verified, true);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.equal(f.store.history(old.id)[1].content, 'Use pnpm');
});

test('pre-existing untrimmed fingerprints are reused without rewriting history or reviving archives', async (t) => {
  const { hash } = await import('../dist/model.js');
  const f = fixture(t);
  const old = f.store.add('Legacy fact', 'project', f.project.id, 'fixture').memory;
  const untrimmed = { ...old, content: '\t Legacy fact\u00a0\n' };
  f.store.db
    .prepare('UPDATE notes SET content=?,fingerprint=?,payload=? WHERE id=?')
    .run(
      untrimmed.content,
      hash(JSON.stringify(['project', f.project.id, untrimmed.content])),
      JSON.stringify(untrimmed),
      old.id,
    );
  f.store.db
    .prepare('UPDATE histories SET payload=? WHERE id=?')
    .run(JSON.stringify(untrimmed), old.id);
  const args = f.make([add('Legacy fact')]);
  const result = f.run(args);
  assert.equal(result.results[0].status, 'existing');
  assert.equal(result.results[0].receipt.id, old.id);
  assert.equal(f.store.list(f.project.id).length, 1);
  assert.equal(
    JSON.parse(f.store.db.prepare('SELECT payload FROM histories WHERE id=?').get(old.id).payload)
      .content,
    untrimmed.content,
  );
  f.store.change(old.id, 1, null, 'fixture');
  assert.equal(f.run(f.make([add('Legacy fact')])).results[0].status, 'deleted_duplicate');
});

test('conflict receipt retries reflect appended evidence, resolution and permanent deletion', (t) => {
  const f = fixture(t);
  const old = f.store.add('Use npm', 'project', f.project.id, 'fixture').memory;
  const proposal = (content) => ({
    action: 'conflict',
    id: old.id,
    version: 1,
    content,
    kind: 'decision',
  });
  const args = f.make([proposal('Use pnpm')]);
  assert.equal(f.run(args).results[0].verification, 'current');
  f.run(f.make([proposal('Use yarn')]));
  const stale = f.run(args);
  assert.equal(stale.replayed, true);
  assert.equal(stale.results[0].verification, 'stale');
  assert.equal(stale.results[0].conflictRevision, 1);
  assert.equal(stale.results[0].currentConflictRevision, 2);
  const conflict = f.store.conflicts()[0];
  f.store.resolve(conflict.id, 2, 'current');
  const resolved = f.run(args);
  assert.equal(resolved.results[0].status, 'conflict_closed');
  assert.equal(resolved.results[0].verified, false);
  f.store.purge(old.id, 2);
  assert.equal(f.run(args).results[0].status, 'conflict_closed');
  assert.equal(f.store.conflicts().length, 0);
  assert.equal(f.store.list(f.project.id).length, 0);
});

test('redundant legacy whitespace records can be archived while keeping the canonical note and history', async (t) => {
  const { hash } = await import('../dist/model.js');
  const f = fixture(t);
  const canonical = f.store.add('Legacy fact', 'project', f.project.id, 'fixture').memory;
  const duplicate = f.store.add('Old placeholder', 'project', f.project.id, 'fixture').memory;
  const payload = { ...duplicate, content: '  Legacy fact  ' };
  f.store.db
    .prepare('UPDATE notes SET content=?,fingerprint=?,payload=? WHERE id=?')
    .run(
      payload.content,
      hash(JSON.stringify(['project', f.project.id, payload.content])),
      JSON.stringify(payload),
      duplicate.id,
    );
  const archived = f.store.transaction(() => f.store.change(duplicate.id, 1, null, 'fixture'));
  assert.equal(archived.deleted, true);
  assert.equal(f.store.history(duplicate.id).length, 2);
  assert.deepEqual(
    f.store.list(f.project.id).map((m) => m.id),
    [canonical.id],
  );
  assert.equal(f.run(f.make([add('Legacy fact')])).results[0].receipt.id, canonical.id);
});

test('a live legacy duplicate is reused even when the canonical fingerprint is archived', async (t) => {
  const { hash } = await import('../dist/model.js');
  const f = fixture(t);
  const archived = f.store.add('Legacy fact', 'project', f.project.id, 'fixture').memory;
  f.store.change(archived.id, 1, null, 'fixture');
  const live = f.store.add('Old placeholder', 'project', f.project.id, 'fixture').memory;
  const payload = { ...live, content: '\tLegacy fact  ' };
  f.store.db
    .prepare('UPDATE notes SET content=?,fingerprint=?,payload=? WHERE id=?')
    .run(
      payload.content,
      hash(JSON.stringify(['project', f.project.id, payload.content])),
      JSON.stringify(payload),
      live.id,
    );
  const args = f.make([add('Legacy fact')]);
  assert.equal(f.review(args).items[0].related[0].id, live.id);
  const result = f.run(args).results[0];
  assert.equal(result.status, 'existing');
  assert.equal(result.verified, true);
  assert.equal(result.receipt.id, live.id);
  assert.equal(f.store.get(archived.id).deleted, true);
  assert.equal(f.store.list(f.project.id, true).length, 2);
});
