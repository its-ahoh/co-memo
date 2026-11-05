import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { context, contextSelection } from '../dist/sync.js';
import { stem, searchTerms } from '../dist/relevance.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'co-memo-word-forms-'));
  const home = join(root, 'data');
  let store = new Store(home);
  const project = store.project(root, true);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get store() {
      return store;
    },
    project,
    reopen() {
      store.close();
      store = new Store(home);
    },
    add: (content, metadata = {}) =>
      store.add(content, 'project', project.id, 'fixture', 'explicit', Metadata.parse(metadata))
        .memory,
  };
}

test('stem maps common English word forms to one term', () => {
  for (const forms of [
    ['build', 'builds', 'building'],
    ['upload', 'uploads', 'uploaded', 'uploading'],
    ['store', 'stores', 'stored', 'storing'],
    ['use', 'uses', 'used', 'using'],
    ['story', 'stories'],
    ['plan', 'plans', 'planned', 'planning'],
    ['class', 'classes'],
  ])
    assert.equal(new Set(forms.map(stem)).size, 1, forms.join('/'));
  // Short words, identifiers with digits and non-Latin text are left alone.
  for (const word of ['bus', 'gas', 'utf8', 'v2', '数据库', 'café']) assert.equal(stem(word), word);
  assert.deepEqual(searchTerms('Builds Uploaded'), [stem('build'), stem('upload')]);
});

test('recall matches notes written in a different word form', (t) => {
  const f = fixture(t);
  const nightly = f.add('The nightly job builds the docs site.');
  const invoices = f.add('Invoices are stored offline until sync.');
  const other = f.add('Lint rules live in the shared config.');
  for (const [query, expected] of [
    ['build', nightly],
    ['building docs', nightly],
    ['store invoice', invoices],
    ['storing invoices', invoices],
  ]) {
    const found = f.store.search(f.project.id, query).map((m) => m.id);
    assert.ok(found.includes(expected.id), query);
    assert.ok(!found.includes(other.id), query);
  }
});

test('auto-injected context matches notes written in a different word form', (t) => {
  const f = fixture(t);
  const note = f.add('Uploads retried three times before failing.');
  const selection = contextSelection(
    f.store,
    f.project.id,
    16_000,
    'upload retry',
    undefined,
    new Map(),
    true,
  );
  assert.ok(selection.context.includes(note.content));
  const row = selection.explanation.notes.find((n) => n.id === note.id);
  assert.equal(row.reason, 'lexical');
  // Diagnostics report the words the user typed, not internal stems.
  assert.deepEqual(row.matchedTerms, ['upload', 'retry']);
  assert.deepEqual(selection.explanation.queryTerms, ['upload', 'retry']);
});

test('the index keeps original words so older readers still match exact terms', (t) => {
  const f = fixture(t);
  const note = f.add('The nightly job builds the docs site.');
  const rows = f.store.db
    .prepare('SELECT id FROM notes_fts WHERE notes_fts MATCH ?')
    .all('"builds"')
    .map((r) => r.id);
  assert.deepEqual(rows, [note.id]);
});

test('an index written without stems is rebuilt once on open', (t) => {
  const f = fixture(t);
  const note = f.add('The nightly job builds the docs site.');
  // Recreate what an earlier co-memo release left behind: raw terms and no index marker.
  f.store.db.exec('DROP TABLE IF EXISTS search_index');
  const rowid = f.store.db.prepare('SELECT rowid FROM notes WHERE id=?').get(note.id).rowid;
  f.store.db.prepare('DELETE FROM notes_fts WHERE rowid=?').run(rowid);
  f.store.db
    .prepare('INSERT INTO notes_fts(rowid,id,terms) VALUES (?,?,?)')
    .run(rowid, note.id, 'nightly job builds docs site');
  assert.equal(f.store.search(f.project.id, 'build').length, 0);
  f.reopen();
  assert.deepEqual(
    f.store.search(f.project.id, 'build').map((m) => m.id),
    [note.id],
  );
  assert.ok(context(f.store, f.project.id, 16_000, 'building docs').includes(note.content));
});
