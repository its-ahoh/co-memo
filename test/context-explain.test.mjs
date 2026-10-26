import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { context, contextSelection } from '../dist/sync.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-explain-'));
  const root = join(dir, 'project'),
    home = join(dir, 'home');
  mkdirSync(root);
  const store = new Store(home),
    project = store.project(root, true);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const add = (text, metadata = {}) =>
    store.add(text, 'project', project.id, 'test', 'explicit', Metadata.parse(metadata)).memory;
  return { store, project, root, home, add };
}

test('explain agrees with rendered context and diagnoses scope, conflict, deletion and relevance', (t) => {
  const f = fixture(t);
  const relevant = f.add('Orchard irrigation schedule');
  const weak = f.add('Orchard visitors');
  const unrelated = f.add('Mountain telescope');
  const pinned = f.add('Use compact summaries', { kind: 'preference', pinned: true });
  const rule = f.add('Never edit generated files', { kind: 'constraint' });
  const deleted = f.add('Irrigation deleted');
  f.store.change(deleted.id, 1, null, 'test');
  const blocked = f.add('Irrigation conflict');
  f.store.conflict(
    blocked,
    [],
    [{ id: randomUUID(), content: 'Irrigation alternate', metadata: Metadata.parse({}) }],
  );
  const otherRoot = join(f.root, 'sibling');
  mkdirSync(otherRoot);
  const other = f.store.project(otherRoot, true);
  const foreign = f.store.add('Orchard irrigation foreign', 'project', other.id, 'test').memory;
  const query = 'Orchard irrigation schedule';
  const result = contextSelection(f.store, f.project.id, 16000, query, undefined, undefined, true);
  assert.equal(result.context, context(f.store, f.project.id, 16000, query));
  const notes = new Map(result.explanation.notes.map((n) => [n.id, n]));
  assert.equal(notes.get(relevant.id).reason, 'lexical');
  assert.equal(notes.get(pinned.id).reason, 'pinned');
  assert.equal(notes.get(rule.id).reason, 'constraint');
  assert.equal(notes.get(weak.id).reason, 'task_mismatch');
  assert.equal(notes.get(unrelated.id).reason, 'not_retrieved');
  assert.equal(notes.get(deleted.id).reason, 'deleted');
  assert.equal(notes.get(blocked.id).reason, 'conflict');
  assert.equal(notes.has(foreign.id), false);
  for (const note of notes.values()) assert.equal(result.context.includes(note.id), note.included);
  assert.deepEqual(notes.get(relevant.id).matchedTerms, ['orchard', 'irrigation', 'schedule']);
  assert.equal(result.explanation.budget.used, result.context.length);
  assert.ok(!JSON.stringify(result.explanation).includes('Mountain telescope'));
});

test('explain covers pinned allocation, total budget and valid semantic matches', (t) => {
  const f = fixture(t);
  const largePin = f.add('z'.repeat(2001), { kind: 'preference', pinned: true });
  const largeRule = f.add('y'.repeat(2001), { kind: 'constraint' });
  const long = f.add('Orchard irrigation '.repeat(1500));
  const semantic = f.add('Watering preferences');
  const query = 'orchard irrigation';
  const ranking = [long, semantic];
  const current = new Map([[semantic.id, semantic.version]]);
  const result = contextSelection(f.store, f.project.id, 16000, query, ranking, current, true);
  const reason = (id) => result.explanation.notes.find((n) => n.id === id).reason;
  assert.equal(reason(largePin.id), 'pinned_budget');
  assert.equal(reason(largeRule.id), 'constraint_budget');
  assert.equal(reason(long.id), 'context_budget');
  assert.equal(reason(semantic.id), 'semantic');
  const stale = contextSelection(
    f.store,
    f.project.id,
    16000,
    query,
    ranking,
    new Map([[semantic.id, 99]]),
    true,
  );
  assert.equal(stale.explanation.notes.find((n) => n.id === semantic.id).included, false);
  const tiny = contextSelection(f.store, f.project.id, 20, query, ranking, current, true);
  assert.equal(tiny.context.length, 20);
  assert.equal(tiny.explanation.notes.find((n) => n.id === semantic.id).reason, 'context_budget');
});

test('paused explanation does not inspect notes; CLI explain preserves plain context', (t) => {
  const f = fixture(t);
  f.add('Orchard irrigation schedule');
  const args = [
    resolve('dist/cli.js'),
    '--home',
    f.home,
    '--project',
    f.root,
    'context',
    '--query',
    'orchard irrigation',
  ];
  const plain = execFileSync(process.execPath, args, { encoding: 'utf8' });
  const explained = JSON.parse(
    execFileSync(process.execPath, [...args, '--explain'], { encoding: 'utf8' }),
  );
  assert.equal(explained.context, plain);
  assert.equal(explained.explanation.notes[0].included, true);
  assert.equal(explained.retrieval.mode, 'lexical');
  f.store.configure(f.project.id, { paused: true });
  for (const method of ['list', 'search', 'conflicts'])
    f.store[method] = () => {
      throw new Error('Paused read');
    };
  const paused = contextSelection(
    f.store,
    f.project.id,
    16000,
    'orchard',
    undefined,
    undefined,
    true,
  );
  assert.equal(paused.explanation.paused, true);
  assert.deepEqual(paused.explanation.notes, []);
  assert.deepEqual(paused.explanation.queryTerms, []);
});

test('without a query, selected notes are labelled unfiltered', (t) => {
  const f = fixture(t);
  const projectNote = f.add('Orchard irrigation schedule');
  const personal = f.store.add('Synthetic hobby fact', 'user', null, 'test').memory;
  const result = contextSelection(
    f.store,
    f.project.id,
    16000,
    undefined,
    undefined,
    undefined,
    true,
  );
  const reason = (id) => result.explanation.notes.find((n) => n.id === id).reason;
  assert.equal(reason(projectNote.id), 'unfiltered');
  assert.equal(reason(personal.id), 'unfiltered');
  assert.ok(result.context.includes('Synthetic hobby fact'));
});

test('brief context keeps notes and drops the repeated guidance', (t) => {
  const f = fixture(t);
  f.add('Orchard irrigation schedule');
  const full = contextSelection(f.store, f.project.id, 16000, 'orchard irrigation').context;
  const brief = contextSelection(
    f.store,
    f.project.id,
    16000,
    'orchard irrigation',
    undefined,
    undefined,
    false,
    true,
  ).context;
  assert.ok(brief.includes('Orchard irrigation schedule'));
  assert.ok(full.includes('Choose scope by content'));
  assert.ok(!brief.includes('Missing project context never implies user scope. Prefer'));
  assert.match(brief, /missing project context never implies user scope/);
  assert.match(brief, /saveMode=auto/);
  assert.match(brief, /check whether memory needs updating/);
  assert.ok(brief.length < full.length - 400);
});
