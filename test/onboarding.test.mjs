import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { sync, repair } from '../dist/sync.js';
import { prepareSetup } from '../dist/setup.js';
import { applyAdapter } from '../dist/adapters.js';
import { planSetup, describePlan, applySetup, detectAgents } from '../dist/onboarding.js';
import { doctor } from '../dist/doctor.js';
const cli = resolve('dist/cli.js');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-onboarding-')));
  const project = join(root, 'project');
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, home: join(root, 'data') };
}
const setup = (store, root, agent) => {
  applyAdapter(prepareSetup(root, agent, store.home, { toolsOnly: true }));
  store.connect(store.project(root, true), agent);
  return sync(store);
};
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('init preview is read-only; apply configures multiple agents and probes; repeated apply is stable', async (t) => {
  const f = fixture(t);
  const input = { ...f, root: f.project, agents: ['codex', 'claude'], toolsOnly: true };
  const plan = planSetup(input);
  assert.equal(existsSync(f.home), false);
  assert.equal(existsSync(join(f.project, '.mcp.json')), false);
  assert.ok(describePlan(plan).agents.every((a) => a.changes.some((c) => c.action === 'create')));
  assert.ok(detectAgents(f.project, '').every((a) => a.executable === null));
  const result = await applySetup(input, plan);
  assert.equal(result.status, 'configured', JSON.stringify(result));
  assert.ok(result.checks.every((c) => c.transport === 'passed' && c.hostVerified === false));
  const before = readFileSync(join(f.project, '.gitignore'), 'utf8');
  assert.equal((await applySetup(input)).status, 'configured');
  assert.equal(readFileSync(join(f.project, '.gitignore'), 'utf8'), before);
});

test('init validates all selected agents before configuring any and rejects changed previews', async (t) => {
  const f = fixture(t),
    input = { ...f, root: f.project, agents: ['codex', 'claude'], toolsOnly: true };
  writeFileSync(join(f.project, '.mcp.json'), '{bad');
  assert.throws(() => planSetup(input));
  assert.equal(existsSync(join(f.project, '.codex')), false);
  unlinkSync(join(f.project, '.mcp.json'));
  const plan = planSetup(input);
  writeFileSync(join(f.project, '.gitignore'), 'user-change\n');
  await assert.rejects(applySetup(input, plan), /changed since preview/);
  assert.equal(existsSync(join(f.project, '.codex')), false);
});

test('noninteractive init previews by default and explicit apply returns a structured result', (t) => {
  const f = fixture(t);
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [cli, '--home', f.home, '--project', f.project, 'init', '--agents', 'claude', ...args],
      { encoding: 'utf8', timeout: 20000 },
    );
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  assert.equal(existsSync(f.home), false);
  const applied = run('--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, 'configured');
});

test('explicit worktree links share notes, settings and conflicts while maintaining separate same-agent replicas', async (t) => {
  const f = fixture(t);
  git(f.project, 'init');
  git(
    f.project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  const worktree = join(f.root, 'worktree');
  git(f.project, 'worktree', 'add', '-b', 'test-worktree', worktree);
  const store = new Store(f.home);
  t.after(() => store.close());
  let id, note;
  store.lock(() => {
    setup(store, f.project, 'codex');
    id = store.project(f.project).id;
    note = store.add('Repository uses pnpm', 'project', id, 'test').memory;
    const linked = store.transaction(() => store.linkWorktree(worktree, f.project));
    assert.equal(linked.id, id);
    assert.equal(linked.root, worktree);
    setup(store, worktree, 'codex');
    assert.equal(store.replicas().length, 2);
    assert.equal(store.project(worktree).id, id);
    mkdirSync(join(worktree, 'nested'));
    assert.equal(store.project(join(worktree, 'nested')).id, id);
    store.configure(id, { saveMode: 'explicit' });
    assert.equal(store.settings(store.project(worktree).id).saveMode, 'explicit');
  });
  assert.ok(readFileSync(join(worktree, '.co-memo/codex.md'), 'utf8').includes(note.content));
  const diagnosis = await doctor({ home: f.home, root: worktree, agent: 'codex', probe: true });
  assert.equal(diagnosis.transport, 'passed', JSON.stringify(diagnosis));
  assert.equal(diagnosis.root, worktree);
  store.lock(() => {
    store.change(note.id, 1, 'Repository uses npm', 'test');
    sync(store);
    assert.ok(readFileSync(join(f.project, '.co-memo/codex.md'), 'utf8').includes('uses npm'));
    assert.ok(readFileSync(join(worktree, '.co-memo/codex.md'), 'utf8').includes('uses npm'));
    unlinkSync(join(worktree, '.co-memo/codex.md'));
    assert.throws(() => repair(store, 'codex', id), /Multiple worktree/);
    repair(store, 'codex', id, worktree);
    store.change(note.id, 2, null, 'test');
    sync(store);
    assert.ok(!readFileSync(join(worktree, '.co-memo/codex.md'), 'utf8').includes('uses npm'));
  });
});

test('worktrees remain independent by default; links reject independent stores and different repositories', (t) => {
  const f = fixture(t);
  git(f.project, 'init');
  git(
    f.project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  const worktree = join(f.root, 'worktree');
  git(f.project, 'worktree', 'add', '-b', 'test', worktree);
  const store = new Store(f.home);
  t.after(() => store.close());
  const a = store.project(f.project, true),
    b = store.project(worktree, true);
  assert.notEqual(a.id, b.id);
  store.add('branch-only', 'project', b.id, 'test');
  assert.equal(store.list(a.id).length, 0);
  assert.throws(() => store.linkWorktree(worktree, f.project), /independent project/);
  const other = join(f.root, 'other');
  mkdirSync(other);
  git(other, 'init');
  assert.throws(() => store.linkWorktree(other, f.project), /same local Git/);
});

test('schema 3 replica migration preserves pending state and identities', (t) => {
  const f = fixture(t);
  let store = new Store(f.home);
  const project = store.project(f.project, true);
  const replica = store.connect(project, 'claude');
  const note = store.add('preserve history', 'project', project.id, 'test').memory;
  sync(store);
  const baseline = store.replicas()[0].baseline;
  const pending = { expected: null, text: readFileSync(replica.path, 'utf8'), snapshot: baseline };
  store.saveReplica({ ...store.replicas()[0], pending });
  store.db.exec(`ALTER TABLE replicas RENAME TO saved_replicas;
    CREATE TABLE replicas(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent TEXT NOT NULL,path TEXT NOT NULL UNIQUE,baseline TEXT,pending TEXT,UNIQUE(project_id,agent));
    INSERT INTO replicas SELECT * FROM saved_replicas; DROP TABLE saved_replicas; DROP TABLE project_links; PRAGMA user_version=3;`);
  store.close();
  store = new Store(f.home);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(store.replicas()[0].id, replica.id);
    assert.deepEqual(store.replicas()[0].baseline, baseline);
    assert.deepEqual(store.replicas()[0].pending, pending);
    assert.equal(store.get(note.id).version, 1);
  } finally {
    store.close();
  }
});

test('unlinked nested worktrees do not inherit enclosing repository memories', async (t) => {
  const f = fixture(t);
  git(f.project, 'init');
  git(
    f.project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  const nested = join(f.project, 'nested-worktree');
  git(f.project, 'worktree', 'add', '-b', 'nested', nested);
  const store = new Store(f.home);
  try {
    store.project(f.project, true);
    assert.throws(() => store.project(nested), /Project not connected/);
    const result = await doctor({ home: f.home, root: nested });
    assert.equal(result.status, 'needs_attention');
    store.transaction(() => store.linkWorktree(nested, f.project));
    assert.equal(store.project(nested).id, store.project(f.project).id);
  } finally {
    store.close();
  }
});
