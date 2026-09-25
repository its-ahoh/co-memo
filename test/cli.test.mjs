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
import { parse } from '../dist/document.js';
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
    '.co-memo/pi.md',
    '.co-memo/claude.md',
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
  f.run('add', '--content', 'Speak Chinese');
  const claude = join(f.project, '.co-memo/claude.md');
  writeFileSync(claude, read(claude).replace('Speak Chinese', 'Speak English'));
  const response = await handlers.get('before_agent_start')(
    { systemPrompt: 'Host instructions' },
    ctx,
  );
  assert.match(response.systemPrompt, /^Host instructions/);
  assert.match(response.systemPrompt, /Speak English/);
  const pi = join(f.project, '.co-memo/pi.md');
  writeFileSync(pi, read(pi).replace('Speak English', 'Speak French'));
  await handlers.get('agent_end')({}, ctx);
  assert.match(read(claude), /Speak French/);
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

test('Malformed settings fail before writing agent files or registering a replica', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.project, '.claude'));
  writeFileSync(join(f.project, '.claude/settings.local.json'), '{bad');
  const result = spawnSync(process.execPath, [cli, ...f.argv, 'connect', 'claude'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(f.project, 'CLAUDE.local.md')), false);
  const store = new Store(f.home);
  assert.deepEqual(store.replicas(), []);
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
  await Promise.all(
    Array.from(
      { length: 6 },
      (_, i) =>
        new Promise((done, fail) => {
          const child = spawn(process.execPath, [
            cli,
            ...f.argv,
            'add',
            '--content',
            `parallel note ${i}`,
          ]);
          let err = '';
          child.stderr.on('data', (b) => {
            err += b;
          });
          child.stdout.resume();
          child.on('error', fail);
          child.on('exit', (code) => (code === 0 ? done() : fail(new Error(err))));
        }),
    ),
  );
  assert.equal(f.run('list').length, 6);
  assert.equal(
    (read(join(f.project, '.co-memo/pi.md')).match(/<!-- co-memo:memory /g) ?? []).length,
    6,
  );
});

test('Watch reconciles edits and shuts down on SIGTERM', async (t) => {
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
  const pi = join(f.project, '.co-memo/pi.md');
  writeFileSync(
    pi,
    read(pi).replace('<!-- co-memo:new -->\n\n', '<!-- co-memo:new -->\nFrom watcher\n'),
  );
  const deadline = Date.now() + 8000;
  while (
    Date.now() < deadline &&
    !read(join(f.project, '.co-memo/claude.md')).includes('From watcher')
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(read(join(f.project, '.co-memo/claude.md')), /From watcher/);
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

test('Codex hooks return context and Stop publishes memory to all four agents', (t) => {
  const f = fixture(t);
  for (const agent of ['pi', 'claude', 'codex', 'opencode']) f.run('connect', agent);
  f.run('add', '--content', 'Use pnpm');
  const path = join(f.project, '.co-memo/codex.md');
  const config = JSON.parse(read(join(f.project, '.codex/hooks.json')));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    if (event === 'Stop')
      writeFileSync(path, read(path).replace('Use pnpm', 'Use frozen lockfiles'));
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
    assert.match(read(join(f.project, `.co-memo/${agent}.md`)), /Use frozen lockfiles/);
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
    f.run('add', '--content', 'Use pnpm');
    const codex = join(f.project, '.co-memo/codex.md');
    writeFileSync(codex, read(codex).replace('Use pnpm', 'Use npm'));
    assert.match(await context(), /Use npm/);
    const projection = join(f.project, '.co-memo/opencode.md');
    writeFileSync(projection, read(projection).replace('Use npm', 'Use pnpm again'));
    await after();
    for (const agent of ['pi', 'claude', 'codex']) {
      assert.match(read(join(f.project, `.co-memo/${agent}.md`)), /Use pnpm again/);
    }
    writeFileSync(
      projection,
      read(projection).replace(/<!-- co-memo:memory [\s\S]*?<!-- co-memo:\/memory -->\n?/g, ''),
    );
    await after();
    assert.deepEqual(f.run('list'), []);
    for (const agent of ['pi', 'claude', 'codex']) {
      assert.doesNotMatch(read(join(f.project, `.co-memo/${agent}.md`)), /Use pnpm again/);
    }
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
      assert.deepEqual(store.replicas(), []);
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
