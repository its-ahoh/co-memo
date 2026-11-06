import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { contextSelection, lookAlikeLimit } from '../dist/sync.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'co-memo-look-alike-'));
  const store = new Store(join(root, 'data'));
  const project = store.project(root, true);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    project,
    add: (content, metadata = {}) =>
      store.add(content, 'project', project.id, 'fixture', 'explicit', Metadata.parse(metadata))
        .memory,
  };
}
const injectedIds = (text) => [...text.matchAll(/\n\[project; ([^;]+); v\d+\]/g)].map((m) => m[1]);

test('look-alike notes are capped in auto-injected context but stay in recall', (t) => {
  const f = fixture(t);
  const rule = f.add('Sign the release package with the team key before publishing.', {
    kind: 'decision',
  });
  const logs = [];
  for (let i = 1; i <= 60; i++)
    logs.push(f.add(`Release package ${i}: publishing to staging finished, checks passed.`));
  const query = 'how do I publish a release package';
  assert.equal(f.store.search(f.project.id, query).length, 61);
  const selection = contextSelection(
    f.store,
    f.project.id,
    16_000,
    query,
    undefined,
    new Map(),
    true,
  );
  const ids = injectedIds(selection.context);
  assert.ok(ids.includes(rule.id));
  assert.equal(ids.filter((id) => logs.some((m) => m.id === id)).length, lookAlikeLimit);
  assert.equal(ids.length, lookAlikeLimit + 1);
  const reasons = selection.explanation.notes.filter((n) => n.reason === 'look_alike');
  assert.equal(reasons.length, 60 - lookAlikeLimit);
});

test('distinct notes that share query words are not capped', (t) => {
  const f = fixture(t);
  const notes = [
    'Release package checksums are published next to each archive.',
    'Release package names include the platform and architecture.',
    'Release package uploads need a signed manifest file.',
    'Release package notes are drafted from merged pull requests.',
    'Release package builds run on a clean runner image.',
    'Release package mirrors refresh within one hour.',
  ].map((content) => f.add(content));
  const ids = injectedIds(
    contextSelection(f.store, f.project.id, 16_000, 'release package').context,
  );
  for (const note of notes) assert.ok(ids.includes(note.id), note.content);
});

test('pinned preferences and constraints are never dropped as look-alikes', (t) => {
  const f = fixture(t);
  const standing = [];
  for (let i = 1; i <= lookAlikeLimit + 2; i++)
    standing.push(
      f.add(`Prefer short answers about network calls, variant ${i}.`, {
        kind: 'preference',
        pinned: true,
      }),
    );
  for (let i = 1; i <= lookAlikeLimit + 2; i++)
    standing.push(f.add(`Keep module ${i} free of network calls.`, { kind: 'constraint' }));
  const ids = injectedIds(contextSelection(f.store, f.project.id, 16_000, 'network calls').context);
  for (const note of standing) assert.ok(ids.includes(note.id), note.content);
});
