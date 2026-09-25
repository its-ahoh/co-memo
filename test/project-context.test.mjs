import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../dist/store.js';
import { configuration, remember, retrieve } from '../dist/service.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-context-')));
  const store = new Store(join(root, 'data'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const directory = (name) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { root, store, directory };
}
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });

test('Automatic Git context groups subdirectories, shares personal preferences and isolates projects', async (t) => {
  const f = fixture(t);
  const a = f.directory('a');
  const b = f.directory('b');
  git(a, 'init');
  git(b, 'init');
  const nested = f.directory('a/packages/client');
  writeFileSync(join(nested, 'package.json'), '{}');
  const local = remember(
    f.store,
    nested,
    { content: 'This project uses pnpm', scope: 'project', intent: 'explicit' },
    'test',
  ).memory;
  const personal = remember(
    f.store,
    nested,
    { content: 'Always answer in Chinese', scope: 'user', intent: 'explicit' },
    'test',
  ).memory;
  assert.equal(f.store.project(a).id, local.projectId);
  assert.equal(f.store.project(a).root, a);
  assert.equal(personal.projectId, null);
  assert.deepEqual(
    new Set((await retrieve(f.store, a)).memories.map((m) => m.id)),
    new Set([local.id, personal.id]),
  );
  assert.deepEqual(
    (await retrieve(f.store, b)).memories.map((m) => m.id),
    [personal.id],
  );
  assert.equal(f.store.replicas().length, 0);
  assert.equal(existsSync(join(a, '.co-memo')), false);
});

test('Missing workspace never changes defaultScope or silently saves project facts as personal', async (t) => {
  const f = fixture(t);
  const chat = f.directory('chat');
  assert.equal(configuration(f.store, chat).effective.defaultScope, 'project');
  for (const scope of [undefined, 'project']) {
    assert.throws(
      () =>
        remember(
          f.store,
          chat,
          { content: 'A project decision', scope, intent: 'explicit' },
          'test',
        ),
      /No project context detected/,
    );
  }
  assert.deepEqual((await retrieve(f.store, chat)).memories, []);
  const note = remember(
    f.store,
    chat,
    { content: 'Cross-project personal habit', scope: 'user', intent: 'explicit' },
    'test',
  ).memory;
  assert.equal(note.projectId, null);
  assert.equal(f.store.autoProject(chat), null);
});

test('Non-Git manifests and explicit agent workspaces are automatically registered', (t) => {
  const f = fixture(t);
  const project = f.directory('python/src');
  const root = join(f.root, 'python');
  writeFileSync(join(root, 'pyproject.toml'), '');
  assert.equal(f.store.autoProject(project).root, root);
  const design = f.directory('design');
  assert.equal(f.store.autoProject(design), null);
  assert.equal(f.store.autoProject(design, true).root, design);
});

test('Nested Git repositories and unlinked worktrees keep separate identities', (t) => {
  const f = fixture(t);
  const root = f.directory('repo');
  git(root, 'init');
  git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  );
  const parent = f.store.autoProject(root);
  const nested = f.directory('repo/nested');
  git(nested, 'init');
  assert.notEqual(f.store.autoProject(nested).id, parent.id);
  const worktree = join(f.root, 'worktree');
  git(root, 'worktree', 'add', '-b', 'test-worktree', worktree);
  assert.notEqual(f.store.autoProject(worktree).id, parent.id);
});

test('CLI detects cwd without --project, while an ordinary directory keeps personal reads available', (t) => {
  const f = fixture(t);
  const project = f.directory('repo');
  git(project, 'init');
  const cli = resolve('dist/cli.js');
  const run = (cwd, ...args) =>
    spawnSync(process.execPath, [cli, '--home', f.store.home, ...args], { cwd, encoding: 'utf8' });
  const added = run(project, 'add', '--scope', 'project', '--content', 'Repository decision');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).memory.scope, 'project');
  const chat = f.directory('chat');
  const failed = run(chat, 'add', '--content', 'Unclassified fact');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /No project context/);
  const read = run(chat, 'list');
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), []);
  const explicit = run(
    chat,
    '--project',
    chat,
    'add',
    '--scope',
    'project',
    '--content',
    'Non-Git workspace decision',
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).memory.scope, 'project');
});
