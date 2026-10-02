import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store } from '../dist/store.js';

const cli = resolve('dist/cli.js');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-cli-')));
  const project = join(root, "project with 'quote' and $sign");
  mkdirSync(project);
  const home = join(root, 'data');
  const argv = ['--home', home, '--project', project];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...argv, ...args], {
      encoding: 'utf8',
      cwd: root,
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, home, argv, run };
}
const read = (path) => readFileSync(path, 'utf8');

test('CLI add/edit/forget/history works and stale writes are rejected', (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  f.run('connect', 'claude');
  const note = f.run('add', '--content', 'Use pnpm').memory;
  assert.equal(f.run('list')[0].content, 'Use pnpm');
  assert.equal(
    f.run('edit', note.id, '--version', '1', '--content', 'Use frozen lockfiles').memory.version,
    2,
  );
  const stale = spawnSync(process.execPath, [cli, ...f.argv, 'forget', note.id, '--version', '1'], {
    encoding: 'utf8',
  });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /Version changed/);
  f.run('forget', note.id, '--version', '2');
  assert.deepEqual(f.run('list'), []);
  assert.equal(f.run('history', note.id).length, 3);
});

test('Connect preserves user settings, hooks and instructions; reruns are byte-stable', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.claude'));
  writeFileSync(join(f.project, 'AGENTS.md'), '# Existing Pi rules\n');
  writeFileSync(join(f.project, 'CLAUDE.local.md'), '# Existing Claude rules\n');
  const configPath = join(f.project, '.claude/settings.local.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      permissions: { allow: ['Bash(git status)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] },
    }),
  );
  f.run('connect', 'pi');
  f.run('connect', 'claude');
  const paths = [
    'AGENTS.md',
    'CLAUDE.local.md',
    '.gitignore',
    '.claude/settings.local.json',
    '.pi/extensions/co-memo.ts',
  ];
  const first = paths.map((p) => read(join(f.project, p)));
  f.run('connect', 'pi');
  f.run('connect', 'claude');
  assert.deepEqual(
    paths.map((p) => read(join(f.project, p))),
    first,
  );
  assert.match(read(join(f.project, 'AGENTS.md')), /Existing Pi rules/);
  assert.match(read(join(f.project, 'CLAUDE.local.md')), /Existing Claude rules/);
  const config = JSON.parse(read(configPath));
  assert.equal(config.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  assert.deepEqual(config.permissions.allow, ['Bash(git status)']);
});

test('Generated Claude hooks execute with a different cwd/home and return scoped context', (t) => {
  const f = fixture(t);
  f.run('connect', 'claude');
  f.run('add', '--content', 'Project uses pnpm');
  const config = JSON.parse(read(join(f.project, '.claude/settings.local.json')));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const command = config.hooks[event][0].hooks[0].command;
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: f.root,
      encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: event }),
      env: { ...process.env, CO_MEMO_HOME: join(f.root, 'wrong') },
    });
    assert.equal(result.status, 0, result.stderr);
    if (event === 'Stop') assert.equal(result.stdout, '');
    else {
      const response = JSON.parse(result.stdout);
      assert.equal(response.hookSpecificOutput.hookEventName, event);
      assert.match(response.hookSpecificOutput.additionalContext, /Project uses pnpm/);
    }
  }
});

test('Generated Pi extension executes lifecycle callbacks and sees Claude edits', async (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  f.run('connect', 'claude');
  const handlers = new Map(),
    notices = [];
  const extension = await import(pathToFileURL(join(f.project, '.pi/extensions/co-memo.ts')).href);
  extension.default({ on: (name, fn) => handlers.set(name, fn) });
  const ctx = { ui: { notify: (...args) => notices.push(args) } };
  await handlers.get('session_start')({}, ctx);
  const note = f.run('add', '--content', 'Speak Chinese').memory;
  f.run('edit', note.id, '--version', '1', '--content', 'Speak English');
  const response = await handlers.get('before_agent_start')(
    { systemPrompt: 'Host instructions' },
    ctx,
  );
  assert.match(response.systemPrompt, /^Host instructions/);
  assert.match(response.systemPrompt, /Speak English/);
  f.run('edit', note.id, '--version', '2', '--content', 'Speak French');
  await handlers.get('agent_end')({}, ctx);
  assert.equal(f.run('show', note.id).content, 'Speak French');
  assert.deepEqual(notices, []);
});

test('Import keeps originals intact and is idempotent', (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  const source = join(f.root, 'MEMORY.md'),
    text = '# Preferences\n\n中文回答。\n\nKeep explanations concise.\n';
  writeFileSync(source, text);
  const first = f.run('import', source, '--scope', 'user');
  const second = f.run('import', source, '--scope', 'user');
  assert.equal(first.notes[0].created, true);
  assert.equal(second.notes[0].created, false);
  assert.equal(read(source), text);
  assert.equal(f.run('list')[0].scope, 'user');
});

test('Malformed settings fail before writing agent files or registering a connection', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.claude'));
  writeFileSync(join(f.project, '.claude/settings.local.json'), '{bad');
  const result = spawnSync(process.execPath, [cli, ...f.argv, 'connect', 'claude'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(f.project, 'CLAUDE.local.md')), false);
  const store = new Store(f.home);
  assert.deepEqual(store.connections(), []);
  store.close();
});

test('Symlinked adapter paths never modify outside files', (t) => {
  const f = fixture(t),
    outside = join(f.root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.project, '.pi'));
  const result = spawnSync(process.execPath, [cli, ...f.argv, 'connect', 'pi'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(outside, 'extensions')), false);
  assert.equal(existsSync(join(f.project, 'AGENTS.md')), false);
});

test('Parallel CLI writers use one central store without losing notes', async (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  f.run('connect', 'claude');
  const attempt = (i, review) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [
        cli,
        ...f.argv,
        'add',
        '--content',
        `parallel note ${i}`,
        ...(review
          ? [
              '--review-token',
              review.token,
              '--review-reason',
              'Synthetic independently numbered notes',
            ]
          : []),
      ]);
      let out = '',
        err = '';
      child.stdout.on('data', (b) => {
        out += b;
      });
      child.stderr.on('data', (b) => {
        err += b;
      });
      child.on('error', fail);
      child.on('close', (code) => {
        if (code !== 0 && code !== 2) {
          fail(new Error(err || out));
          return;
        }
        try {
          done({ code, value: JSON.parse(out) });
        } catch (error) {
          fail(error);
        }
      });
    });
  await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      let review;
      for (let retry = 0; retry < 10; retry++) {
        const result = await attempt(i, review);
        if (result.code === 0) {
          assert.equal(result.value.verified, true);
          return;
        }
        assert.equal(result.value.status, 'needs_review');
        review = result.value.review;
      }
      assert.fail('Review did not stabilize after writers finished');
    }),
  );
  assert.equal(f.run('list').length, 6);
  assert.equal(existsSync(join(f.project, '.co-memo')), false);
});

test('Watch checks database maintenance and shuts down on SIGTERM', async (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  f.run('connect', 'claude');
  const child = spawn(process.execPath, [cli, ...f.argv, 'watch']);
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.resume();
  await new Promise((resolve) => setTimeout(resolve, 300));
  f.run('add', '--content', 'From database');
  assert.equal(f.run('list')[0].content, 'From database');
  assert.equal(existsSync(join(f.project, '.co-memo')), false);
  const stopped = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await stopped, 0);
  assert.match(output, /stopped/);
});

test('Direct symlink imports are refused without creating a memory', (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  const source = join(f.root, 'original.md'),
    link = join(f.root, 'linked.md');
  writeFileSync(source, 'Do not import through a link');
  symlinkSync(source, link);
  const result = spawnSync(process.execPath, [cli, ...f.argv, 'import', link], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Linked import/);
  assert.deepEqual(f.run('list'), []);
});

for (const agent of ['codex', 'opencode']) {
  test(`${agent} setup preserves existing files and reconnect is idempotent`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.project, 'AGENTS.md'), '# My project rules\n');
    const configPath = join(f.project, '.codex/hooks.json');
    if (agent === 'codex') {
      mkdirSync(join(f.project, '.codex'));
      writeFileSync(
        configPath,
        JSON.stringify({
          description: 'Mine',
          hooks: {
            SessionStart: [
              { matcher: 'startup', hooks: [{ type: 'command', command: 'echo custom' }] },
            ],
          },
        }),
      );
    }
    const first = f.run('connect', agent);
    const before = first.files.map(read);
    f.run('connect', agent);
    assert.deepEqual(first.files.map(read), before);
    assert.match(read(join(f.project, 'AGENTS.md')), /^# My project rules/);
    if (agent === 'codex') {
      const config = JSON.parse(read(configPath));
      assert.equal(config.description, 'Mine');
      assert.equal(config.hooks.SessionStart[0].hooks[0].command, 'echo custom');
    }
  });
}

test('Codex hooks return context and all four agents see database updates', (t) => {
  const f = fixture(t);
  for (const agent of ['pi', 'claude', 'codex', 'opencode']) f.run('connect', agent);
  const note = f.run('add', '--content', 'Use pnpm').memory;
  const config = JSON.parse(read(join(f.project, '.codex/hooks.json')));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    if (event === 'Stop')
      f.run('edit', note.id, '--version', '1', '--content', 'Use frozen lockfiles');
    const result = spawnSync('/bin/sh', ['-c', config.hooks[event][0].hooks[0].command], {
      cwd: f.root,
      encoding: 'utf8',
      input: '{}',
      env: { ...process.env, CO_MEMO_HOME: join(f.root, 'wrong') },
    });
    assert.equal(result.status, 0, result.stderr);
    if (event === 'Stop') assert.equal(result.stdout, '');
    else {
      const response = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(response.hookEventName, event);
      assert.match(response.additionalContext, /Use pnpm/);
    }
  }
  for (const agent of ['pi', 'claude', 'codex', 'opencode']) {
    assert.equal(existsSync(join(f.project, `.co-memo/${agent}.md`)), false);
    const event =
      agent === 'pi' ? 'before_agent_start' : agent === 'opencode' ? 'context' : 'SessionStart';
    assert.match(
      JSON.stringify(f.run('bridge', '--agent', agent, '--event', event)),
      /Use frozen lockfiles/,
    );
  }
});

for (const api of ['v1', 'v2']) {
  test(`OpenCode ${api} callbacks read, edit and delete across all four agents`, async (t) => {
    const f = fixture(t);
    for (const agent of ['pi', 'claude', 'codex']) f.run('connect', agent);
    f.run('connect', 'opencode', '--opencode-api', api);
    const pluginPath = join(f.project, '.opencode/plugins/co-memo.ts');
    const before = read(pluginPath);
    f.run('connect', 'opencode');
    assert.equal(read(pluginPath), before);
    const plugin = (await import(pathToFileURL(pluginPath).href)).default;
    let context, after;
    if (api === 'v1') {
      const hooks = await plugin();
      context = async () => {
        const out = { system: ['Original instructions'] };
        await hooks['experimental.chat.system.transform']({}, out);
        assert.equal(out.system[0], 'Original instructions');
        return out.system.at(-1);
      };
      after = () => hooks['tool.execute.after']();
      await hooks.event({ event: { type: 'session.idle' } });
    } else {
      assert.equal(plugin.id, 'co-memo');
      const handlers = new Map();
      await plugin.setup({
        session: { hook: async (name, fn) => handlers.set(name, fn) },
        tool: { hook: async (name, fn) => handlers.set(name, fn) },
      });
      context = async () => {
        const event = { system: [{ type: 'text', text: 'Original instructions' }] };
        await handlers.get('context')(event);
        assert.equal(event.system[0].text, 'Original instructions');
        assert.equal(event.system.at(-1).type, 'text');
        return event.system.at(-1).text;
      };
      after = () => handlers.get('execute.after')();
    }
    const note = f.run('add', '--content', 'Use pnpm').memory;
    f.run('edit', note.id, '--version', '1', '--content', 'Use npm');
    assert.match(await context(), /Use npm/);
    f.run('edit', note.id, '--version', '2', '--content', 'Use pnpm again');
    await after();
    assert.match(await context(), /Use pnpm again/);
    f.run('forget', note.id, '--version', '3');
    await after();
    assert.deepEqual(f.run('list'), []);
    assert.doesNotMatch(await context(), /Use pnpm again/);
    assert.equal(existsSync(join(f.project, '.co-memo')), false);
  });
}

test('New adapters refuse malformed hooks and unmanaged plugins before any setup writes', (t) => {
  for (const agent of ['codex', 'opencode']) {
    const f = fixture(t);
    const relative = agent === 'codex' ? '.codex' : '.opencode/plugins';
    mkdirSync(join(f.project, relative), { recursive: true });
    const path = join(f.project, relative, agent === 'codex' ? 'hooks.json' : 'co-memo.ts');
    const text = agent === 'codex' ? '{bad json' : 'export default function mine() {}';
    writeFileSync(path, text);
    const result = spawnSync(process.execPath, [cli, ...f.argv, 'connect', agent], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(read(path), text);
    assert.equal(existsSync(join(f.project, 'AGENTS.md')), false);
    const store = new Store(f.home);
    try {
      assert.deepEqual(store.connections(), []);
    } finally {
      store.close();
    }
  }
});

test('CLI personal memory works without connecting a project, including paused inspection', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run('list'), []);
  const note = f.run(
    'add',
    '--scope',
    'user',
    '--content',
    'Personal preference for Chinese',
  ).memory;
  assert.equal(note.scope, 'user');
  assert.equal(note.projectId, null);
  const store = new Store(f.home);
  try {
    const other = store.project(f.root, true);
    store.add('Private project preference', 'project', other.id, 'test');
  } finally {
    store.close();
  }
  // A nested repository must not inherit the registered parent project.
  mkdirSync(join(f.project, '.git'));
  assert.deepEqual(
    f.run('list').map((m) => m.id),
    [note.id],
  );
  assert.equal(f.run('list', '--query', 'Chinese')[0].id, note.id);
  assert.equal(f.run('show', note.id).id, note.id);
  f.run('settings', 'set', '--scope', 'user', '--paused', 'true');
  const paused = f.run('list', '--explain');
  assert.equal(paused.retrieval.reason, 'paused');
  assert.deepEqual(
    paused.memories.map((m) => m.id),
    [note.id],
  );
  f.run('settings', 'set', '--scope', 'user', '--paused', 'false');
  f.run('forget', note.id, '--version', '1');
  assert.deepEqual(f.run('list'), []);
  assert.equal(f.run('list', '--deleted')[0].id, note.id);
});

test('CLI add and atomic imports enforce shared review and accept a reviewed retry', (t) => {
  const f = fixture(t);
  f.run('add', '--content', 'Use pnpm for builds');
  const raw = (...args) =>
    spawnSync(process.execPath, [cli, ...f.argv, ...args], { encoding: 'utf8', cwd: f.root });
  const addition = raw('add', '--content', 'Use pnpm for tests');
  assert.equal(addition.status, 2);
  assert.equal(JSON.parse(addition.stdout).status, 'needs_review');
  assert.equal(f.run('list').length, 1);
  const confirmed = f.run(
    'add',
    '--content',
    'Use pnpm for tests',
    '--review-token',
    JSON.parse(addition.stdout).review.token,
    '--review-reason',
    'Separate test configuration',
  );
  assert.equal(confirmed.verified, true);
  const dir = join(f.root, 'imports');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.md'), 'Use pnpm for packaging');
  writeFileSync(join(dir, 'b.md'), 'SQLite durability');
  const pending = raw('import', dir);
  assert.equal(pending.status, 2);
  assert.equal(f.run('list').length, 2);
  const accepted = f.run(
    'import',
    dir,
    '--review-token',
    JSON.parse(pending.stdout).review.token,
    '--review-reason',
    'Packaging is separate from build and test policies',
  );
  assert.equal(accepted.notes.length, 2);
  assert.ok(accepted.notes.every((n) => n.verified));
  assert.match(accepted.notes[0].memory.origin, /^import:/);
  assert.equal(f.run('list').length, 4);
});

test('CLI and bridges scope conflict reports and reject foreign or paused resolutions', (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  const other = join(f.root, 'other');
  mkdirSync(other);
  const store = new Store(f.home);
  try {
    const p = store.project(other, true);
    const foreign = store.add('Foreign hidden conflict', 'project', p.id, 'fixture').memory;
    const hidden = store.conflict(foreign, []);
    const personal = store.add('Personal shared conflict', 'user', null, 'fixture').memory;
    const visible = store.conflict(personal, []);
    assert.deepEqual(
      f.run('conflicts').map((c) => c.id),
      [visible.id],
    );
    for (const result of [
      f.run('status'),
      JSON.parse(
        spawnSync(process.execPath, [cli, ...f.argv, 'sync'], { encoding: 'utf8', cwd: f.root })
          .stdout,
      ),
      f.run('bridge', '--agent', 'pi', '--event', 'before_agent_start'),
    ]) {
      assert.doesNotMatch(JSON.stringify(result), /Foreign hidden conflict/);
      assert.match(JSON.stringify(result), /Personal shared conflict/);
    }
    const raw = (...args) =>
      spawnSync(process.execPath, [cli, ...f.argv, ...args], { encoding: 'utf8', cwd: f.root });
    const denied = raw('resolve', hidden.id, '--revision', '1', '--take', 'current');
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /another project/);
    assert.equal(store.conflicts().length, 2);
    f.run('settings', 'set', '--scope', 'project', '--paused', 'true');
    const paused = raw('resolve', visible.id, '--revision', '1', '--take', 'current');
    assert.equal(paused.status, 1);
    assert.match(paused.stderr, /paused/);
    assert.equal(store.conflicts().length, 2);
    assert.doesNotMatch(
      JSON.stringify(f.run('bridge', '--agent', 'pi', '--event', 'before_agent_start')),
      /Personal shared conflict|Foreign hidden conflict/,
    );
  } finally {
    store.close();
  }
});

test('CLI add/import return unsuccessful-save exit status for archived duplicates', (t) => {
  const f = fixture(t);
  const note = f.run('add', '--content', 'Archived policy').memory;
  f.run('archive', note.id, '--version', '1');
  const file = join(f.root, 'archive.md');
  writeFileSync(file, 'Archived policy');
  for (const args of [
    ['add', '--content', 'Archived policy'],
    ['import', file],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...f.argv, ...args], {
      encoding: 'utf8',
      cwd: f.root,
    });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).results[0].status, 'deleted_duplicate');
    assert.equal(JSON.parse(result.stdout).results[0].verified, false);
  }
  assert.equal(f.run('list').length, 0);
});
