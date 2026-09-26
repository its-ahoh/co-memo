import { shortcutPaths } from '../dist/shortcuts.js';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { Store } from '../dist/store.js';

const cli = resolve('dist/cli.js');
const read = (path) => readFileSync(path, 'utf8');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-tools-')));
  const project = join(root, "project 'quoted' $literal");
  mkdirSync(project);
  const home = join(root, 'home');
  const argv = ['--home', home, '--project', project];
  const raw = (...args) =>
    spawnSync(process.execPath, [cli, ...argv, ...args], {
      encoding: 'utf8',
      cwd: root,
      timeout: 20000,
    });
  const run = (...args) => {
    const r = raw(...args);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, home, argv, raw, run };
}
async function client(t, f, command = process.execPath, args = [cli, ...f.argv, 'serve']) {
  const transport = new StdioClientTransport({ command, args, cwd: f.root, stderr: 'pipe' });
  const c = new Client({ name: 'co-memo-test', version: '1' });
  await c.connect(transport);
  t.after(() => c.close());
  const raw = (name, args = {}) => c.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  return { c, call, raw };
}

test('MCP stdio initializes, discovers tools, saves/updates/forgets, rejects stale and cross-project writes', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex', '--tools-only');
  const config = parseToml(read(join(f.project, '.codex/config.toml'))).mcp_servers['co-memo'];
  const { c, call, raw } = await client(t, f, config.command, config.args);
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('memory_settings_set'));
  const note = (await call('memory_remember', { content: '中文 preference', intent: 'explicit' }))
    .memory;
  assert.match((await call('memory_context')).context, /中文 preference/);
  assert.equal((await call('memory_recall', { query: '中文' })).memories[0].id, note.id);
  const updated = await call('memory_update', {
    id: note.id,
    version: 1,
    content: 'Changed',
    intent: 'explicit',
  });
  assert.equal(updated.memory.version, 2);
  assert.equal(
    (await raw('memory_forget', { id: note.id, version: 1, intent: 'explicit' })).isError,
    true,
  );
  assert.equal((await raw('memory_remember', { content: 'missing intent' })).isError, true);
  const other = join(f.root, 'other');
  mkdirSync(other);
  const store = new Store(f.home);
  let foreign;
  try {
    store.lock(() => {
      const project = store.project(other, true);
      foreign = store.add('other project', 'project', project.id, 'test').memory;
    });
  } finally {
    store.close();
  }
  assert.equal((await raw('memory_get', { id: foreign.id })).isError, true);
  assert.equal(
    (
      await raw('memory_update', {
        id: foreign.id,
        version: 1,
        content: 'attack',
        intent: 'explicit',
      })
    ).isError,
    true,
  );
  await call('memory_forget', { id: note.id, version: 2, intent: 'explicit' });
  assert.equal((await call('memory_recall')).memories.length, 0);
  const duplicate = await call('memory_remember', { content: 'Changed', intent: 'explicit' });
  assert.equal(duplicate.memory.deleted, true);
  assert.match(duplicate.notice, /deleted/);
  assert.equal((await call('memory_get', { id: note.id, history: true })).history.length, 3);
});

test('Settings enforce intent, defaults and user restrictions through tools and CLI', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex', '--tools-only');
  const { call, raw } = await client(t, f);
  const initial = await call('memory_settings_get');
  assert.equal(initial.effective.defaultScope, 'project');
  const configured = await call('memory_settings_set', {
    scope: 'user',
    patch: { saveMode: 'explicit', defaultScope: 'user' },
    userRequested: true,
  });
  assert.equal(configured.effective.saveMode, 'explicit');
  assert.equal(
    (await raw('memory_settings_set', { scope: 'user', patch: { saveMode: 'auto' } })).isError,
    true,
  );
  assert.equal(
    (
      await raw('memory_settings_set', {
        scope: 'user',
        patch: { unknown: 1 },
        userRequested: true,
      })
    ).isError,
    true,
  );
  await call('memory_settings_set', {
    scope: 'project',
    patch: { saveMode: 'auto' },
    userRequested: true,
  });
  assert.equal((await call('memory_settings_get')).effective.saveMode, 'explicit');
  assert.equal(
    (await raw('memory_remember', { content: 'inferred', intent: 'automatic' })).isError,
    true,
  );
  assert.equal(f.raw('add', '--content', 'inferred', '--intent', 'automatic').status, 1);
  const saved = await call('memory_remember', { content: 'requested', intent: 'explicit' });
  assert.equal(saved.memory.scope, 'user');
  assert.equal(f.run('add', '--content', 'CLI default').memory.scope, 'user');
  assert.equal(
    (
      await raw('memory_update', {
        id: saved.memory.id,
        version: 1,
        content: 'automatic edit',
        intent: 'automatic',
      })
    ).isError,
    true,
  );
  assert.equal(
    (await raw('memory_forget', { id: saved.memory.id, version: 1, intent: 'automatic' })).isError,
    true,
  );
  f.run('settings', 'set', '--scope', 'user', '--reset');
  assert.equal((await call('memory_settings_get')).effective.saveMode, 'auto');
});

test('Explicit-only mode preserves rejected Markdown edits without importing or overwriting them', (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  f.run('connect', 'codex');
  f.run('add', '--content', 'original');
  f.run('settings', 'set', '--save-mode', 'explicit');
  const path = join(f.project, '.co-memo/pi.md');
  const edited = read(path).replace('original', 'unapproved');
  writeFileSync(path, edited);
  const result = f.raw('sync');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Explicit-only/);
  assert.equal(read(path), edited);
  assert.match(read(join(f.project, '.co-memo/codex.md')), /original/);
  f.run('settings', 'set', '--save-mode', 'auto');
  f.run('sync');
  assert.equal(f.run('list')[0].content, 'unapproved');
});

test('Pause suppresses context, tools and syncing while keeping settings available and files intact', async (t) => {
  const f = fixture(t);
  f.run('connect', 'pi');
  const { call, raw } = await client(t, f);
  const note = (await call('memory_remember', { content: 'secret preference', intent: 'explicit' }))
    .memory;
  await call('memory_settings_set', {
    scope: 'project',
    patch: { paused: true },
    userRequested: true,
  });
  assert.doesNotMatch((await call('memory_context')).context, /secret preference/);
  assert.equal((await raw('memory_get', { id: note.id })).isError, true);
  assert.equal((await raw('memory_recall')).isError, true);
  assert.equal(
    (await raw('memory_remember', { content: 'new', scope: 'user', intent: 'explicit' })).isError,
    true,
  );
  assert.equal(f.raw('add', '--scope', 'user', '--content', 'new').status, 1);
  const path = join(f.project, '.co-memo/pi.md');
  const edited = read(path).replace('secret preference', 'pending edit');
  writeFileSync(path, edited);
  f.run('sync');
  assert.equal(read(path), edited);
  await call('memory_settings_set', {
    scope: 'project',
    patch: { paused: false },
    userRequested: true,
  });
  assert.match((await call('memory_context')).context, /pending edit/);
  f.run('settings', 'set', '--scope', 'user', '--paused', 'true');
  assert.equal((await call('memory_settings_get')).effective.paused, true);
});

for (const agent of ['codex', 'claude', 'opencode', 'pi']) {
  test(`Setup ${agent} preserves unrelated config, installs skill and is idempotent`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.project, 'AGENTS.md'), '# Existing rules\n');
    if (agent === 'codex') {
      mkdirSync(join(f.project, '.codex'));
      writeFileSync(
        join(f.project, '.codex/config.toml'),
        '# Keep comment\nmodel = "existing"\n[mcp_servers.other]\ncommand = "other"\n',
      );
    } else if (agent === 'opencode') {
      writeFileSync(
        join(f.project, 'opencode.jsonc'),
        '{\n// Keep comment\n"theme":"mine", "mcp": {"other":{"type":"local","command":["other"]}},\n}\n',
      );
    } else if (agent === 'claude') {
      writeFileSync(join(f.project, '.mcp.json'), '{"mcpServers":{"other":{"command":"other"}}}\n');
    }
    const first = f.run('setup', agent);
    const before = first.files.map(read);
    f.run('setup', agent);
    assert.deepEqual(first.files.map(read), before);
    assert.match(read(join(f.project, 'AGENTS.md')), /^# Existing rules/);
    const skillPath = first.files.find((path) => path.endsWith('/skills/co-memo/SKILL.md'));
    assert.ok(skillPath);
    assert.equal(read(skillPath), read('skills/co-memo/SKILL.md'));
    const hostRoot = { codex: '.agents', claude: '.claude', pi: '.pi', opencode: '.opencode' }[
      agent
    ];
    for (const shortcut of shortcutPaths(agent)) {
      const content = read(join(f.project, hostRoot, shortcut.path));
      assert.ok(content.includes(JSON.stringify(skillPath)));
      assert.ok(content.includes(`Action: ${shortcut.action}\n`));
      assert.ok(content.includes('User arguments: $ARGUMENTS'));
    }
    if (agent === 'opencode') {
      assert.equal(
        read(join(f.project, '.opencode/commands/co-memo.md')),
        read('skills/co-memo/opencode-command.md'),
      );
    }
    if (agent === 'codex') {
      const text = read(join(f.project, '.codex/config.toml'));
      assert.match(text, /Keep comment/);
      const conf = parseToml(text);
      assert.equal(conf.model, 'existing');
      assert.equal(conf.mcp_servers.other.command, 'other');
    } else if (agent === 'opencode') {
      const text = read(join(f.project, 'opencode.jsonc'));
      assert.match(text, /Keep comment/);
      assert.equal(parseJsonc(text).theme, 'mine');
      assert.deepEqual(parseJsonc(text).mcp.other.command, ['other']);
    }
    const toolsOnly = f.run('setup', agent, '--tools-only');
    assert.equal(toolsOnly.mode, 'tools-only');
    const instructions = read(
      join(f.project, agent === 'claude' ? 'CLAUDE.local.md' : 'AGENTS.md'),
    );
    assert.match(instructions, /Automatic hooks are disabled/);
    if (agent === 'codex' || agent === 'claude') {
      const config = JSON.parse(
        read(
          join(f.project, agent === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json'),
        ),
      );
      assert.deepEqual(config.hooks.SessionStart, []);
    } else {
      const plugin = read(
        join(
          f.project,
          agent === 'pi' ? '.pi/extensions/co-memo.ts' : '.opencode/plugins/co-memo.ts',
        ),
      );
      assert.doesNotMatch(plugin, /execFile/);
    }
  });
}

test('Setup refuses unmanaged MCP entries and malformed configs before any registration or file changes', (t) => {
  for (const [agent, filename, content] of [
    ['claude', '.mcp.json', '{bad'],
    ['claude', '.mcp.json', '{"mcpServers":{"co-memo":{"command":"mine"}}}'],
    ['codex', '.codex/config.toml', '[mcp_servers.co-memo]\ncommand = "mine"\n'],
    ['opencode', 'opencode.jsonc', '{bad'],
  ]) {
    const f = fixture(t);
    if (agent === 'codex') mkdirSync(join(f.project, '.codex'));
    const path = join(f.project, filename);
    writeFileSync(path, content);
    assert.equal(f.raw('setup', agent).status, 1);
    assert.equal(read(path), content);
    assert.equal(existsSync(join(f.project, 'AGENTS.md')), false);
    const store = new Store(f.home);
    try {
      assert.deepEqual(store.replicas(), []);
    } finally {
      store.close();
    }
  }
});

test('Tools-only fresh setup writes no lifecycle hooks and serves without projections when configured manually', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex', '--tools-only');
  assert.equal(existsSync(join(f.project, '.codex/hooks.json')), false);
  const other = fixture(t);
  const { call } = await client(t, other);
  await call('memory_remember', { content: 'tools without hooks', intent: 'explicit' });
  assert.match((await call('memory_context')).context, /tools without hooks/);
  assert.equal(existsSync(join(other.project, '.co-memo')), false);
});

test('MCP reports never expose another project conflict or paused memory content', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex', '--tools-only');
  const { call, raw } = await client(t, f);
  const store = new Store(f.home);
  let own;
  try {
    store.lock(() => {
      const other = join(f.root, 'private');
      mkdirSync(other);
      const p = store.project(other, true);
      const note = store.add('private conflict content', 'project', p.id, 'test').memory;
      store.conflict(note, []);
      own = store.add(
        'own conflict content',
        'project',
        store.project(f.project).id,
        'test',
      ).memory;
      store.conflict(own, []);
    });
  } finally {
    store.close();
  }
  const context = await call('memory_context');
  assert.doesNotMatch(JSON.stringify(context), /private conflict content/);
  assert.equal((await call('memory_conflicts')).length, 1);
  const note = await call('memory_remember', { content: 'new note', intent: 'explicit' });
  assert.doesNotMatch(JSON.stringify(note), /private conflict content/);
  await call('memory_settings_set', {
    scope: 'project',
    patch: { paused: true },
    userRequested: true,
  });
  assert.doesNotMatch(
    JSON.stringify(await call('memory_context')),
    /own conflict content|private conflict content/,
  );
  assert.equal((await raw('memory_conflicts')).isError, true);
});

test('OpenCode V2 setup uses mcp.servers, launches MCP and preserves API without a plugin', async (t) => {
  const f = fixture(t);
  f.run('setup', 'opencode', '--tools-only', '--opencode-api', 'v2');
  const path = join(f.project, 'opencode.json');
  const text = read(path);
  const config = parseJsonc(text);
  assert.equal(config.mcp['co-memo'], undefined);
  const server = config.mcp.servers['co-memo'];
  assert.equal(server.enabled, undefined);
  assert.equal(server.type, 'local');
  const { call } = await client(t, f, server.command[0], server.command.slice(1));
  assert.equal((await call('memory_settings_get')).effective.paused, false);
  f.run('setup', 'opencode', '--tools-only');
  assert.equal(read(path), text);
  f.run('setup', 'opencode', '--tools-only', '--opencode-api', 'v1');
  assert.ok(parseJsonc(read(path)).mcp['co-memo']);
  assert.equal(parseJsonc(read(path)).mcp.servers, undefined);
  f.run('setup', 'opencode', '--tools-only', '--opencode-api', 'v2');
  assert.ok(parseJsonc(read(path)).mcp.servers['co-memo']);
});

test('Schema upgrade preserves existing notes and revisions and rejects future databases', (t) => {
  const f = fixture(t);
  let store = new Store(f.home);
  let note;
  try {
    store.lock(() => {
      note = store.add('existing user note', 'user', null, 'test').memory;
      store.change(note.id, 1, 'updated user note', 'test');
      store.db.exec('DROP TABLE settings; PRAGMA user_version=1;');
    });
  } finally {
    store.close();
  }
  store = new Store(f.home);
  try {
    assert.equal(store.get(note.id).content, 'updated user note');
    assert.equal(store.history(note.id).length, 2);
    assert.deepEqual(store.settings(null), {});
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    store.db.exec('PRAGMA user_version=99;');
  } finally {
    store.close();
  }
  assert.throws(() => new Store(f.home), /newer Co-memo version/);
});

test('task context ranks Chinese and technical terms, excludes unrelated notes, and verifies receipts', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex', '--tools-only');
  const { call, raw } = await client(t, f);
  const save = (content, scope = 'project') =>
    call('memory_remember', { content, scope, intent: 'explicit' });
  const chinese = (await save('数据库迁移必须保留历史记录')).memory;
  const technical = (await save('SQLite migrations use transactions')).memory;
  await save('Use violet buttons on the landing page');
  await save('Prefer concise answers', 'user');
  const chineseContext = (await call('memory_context', { query: '数据库迁移' })).context;
  assert.ok(chineseContext.includes(chinese.content));
  assert.ok(!chineseContext.includes('violet'));
  const context = (await call('memory_context', { query: 'SQLite migrations' })).context;
  assert.ok(context.includes(technical.content));
  assert.ok(!context.includes('Prefer concise answers')); // Unpinned preferences must match the task.
  assert.ok(!context.includes('violet'));
  const receipt = { id: technical.id, version: technical.version, deleted: false };
  const verified = await call('memory_checkpoint', {
    reason: 'task_completed',
    outcome: 'saved',
    receipts: [receipt],
  });
  assert.equal(verified.verified, true);
  assert.equal(
    (await raw('memory_checkpoint', { reason: 'task_completed', outcome: 'saved', receipts: [] }))
      .isError,
    true,
  );
  await call('memory_update', {
    id: technical.id,
    version: technical.version,
    content: 'SQLite requires transactional migrations',
    intent: 'explicit',
  });
  assert.equal(
    (
      await raw('memory_checkpoint', {
        reason: 'task_completed',
        outcome: 'saved',
        receipts: [receipt],
      })
    ).isError,
    true,
  );
  assert.equal(
    (await call('memory_checkpoint', { reason: 'user_correction', outcome: 'nothing_to_save' }))
      .verified,
    false,
  );
  const forgotten = (
    await call('memory_forget', { id: chinese.id, version: chinese.version, intent: 'explicit' })
  ).memory;
  assert.equal(
    (
      await call('memory_checkpoint', {
        reason: 'user_correction',
        outcome: 'saved',
        receipts: [{ id: forgotten.id, version: forgotten.version, deleted: true }],
      })
    ).verified,
    true,
  );
  assert.equal(
    (
      await raw('memory_checkpoint', {
        reason: 'user_correction',
        outcome: 'saved',
        receipts: [{ id: forgotten.id, version: forgotten.version, deleted: false }],
      })
    ).isError,
    true,
  );
  assert.ok(
    !(await call('memory_context', { query: '数据库迁移' })).context.includes(chinese.content),
  );
  assert.equal(
    f.run('checkpoint', '--reason', 'task_completed', '--outcome', 'nothing_to_save').verified,
    false,
  );
  const foreignRoot = join(f.root, 'foreign');
  mkdirSync(foreignRoot);
  const store = new Store(f.home);
  let foreign;
  store.lock(() => {
    const project = store.project(foreignRoot, true);
    foreign = store.add('foreign secret', 'project', project.id, 'test');
  });
  store.close();
  assert.equal(
    (
      await raw('memory_checkpoint', {
        reason: 'task_completed',
        outcome: 'saved',
        receipts: [{ id: foreign.memory.id, version: 1, deleted: false }],
      })
    ).isError,
    true,
  );
  await call('memory_settings_set', {
    scope: 'project',
    patch: { paused: true },
    userRequested: true,
  });
  const paused = await call('memory_checkpoint', {
    reason: 'task_completed',
    outcome: 'saved',
    receipts: [receipt],
  });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.verified, false);
});

test('context budget includes guidance and bridge reads task query from host stdin', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex');
  f.run('add', '--content', 'SQLite migrations require transactions');
  f.run('add', '--content', 'Unrelated violet buttons');
  const { context } = await import('../dist/sync.js');
  const store = new Store(f.home);
  store.lock(() => {
    const project = store.project(f.project);
    for (const budget of [0, 25, 800, 16000])
      assert.ok(context(store, project.id, budget, 'SQLite').length <= budget);
  });
  store.close();
  const result = spawnSync(
    process.execPath,
    [cli, ...f.argv, 'bridge', '--agent', 'codex', '--event', 'UserPromptSubmit', '--stdin'],
    {
      encoding: 'utf8',
      input: JSON.stringify({ prompt: 'SQLite migrations', irrelevantHostField: true }),
      timeout: 20000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const injected = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.ok(injected.includes('SQLite migrations require transactions'));
  assert.ok(!injected.includes('Unrelated violet'));
  const malformed = spawnSync(
    process.execPath,
    [cli, ...f.argv, 'bridge', '--agent', 'codex', '--event', 'UserPromptSubmit', '--stdin'],
    { encoding: 'utf8', input: '{bad', timeout: 20000 },
  );
  assert.equal(malformed.status, 1);
});

test('MCP and CLI submit evidence-backed candidates and resolve them through the public interfaces', async (t) => {
  const f = fixture(t);
  f.run('setup', 'codex', '--tools-only');
  const { c, call, raw } = await client(t, f);
  assert.ok((await c.listTools()).tools.some((tool) => tool.name === 'memory_submit'));
  const source = {
    agent: 'codex',
    sessionId: 'session-1',
    messageId: 'message-1',
    excerpt: 'Remember: use pnpm.',
  };
  const input = {
    requestId: randomUUID(),
    intent: 'explicit',
    candidates: [{ action: 'add', kind: 'decision', content: 'Use pnpm dependencies', source }],
  };
  const saved = await call('memory_submit', input);
  assert.equal(saved.results[0].verified, true);
  const note = saved.results[0].receipt;
  const file = join(f.root, 'candidate.json');
  writeFileSync(file, JSON.stringify(input));
  const retry = f.run('submit', '--file', file);
  assert.equal(retry.replayed, true);
  assert.equal(retry.results[0].receipt.id, note.id);
  const retrieved = (await call('memory_recall', { query: 'pnpm dependencies' })).memories;
  assert.deepEqual(
    retrieved.map((m) => m.id),
    f.run('list', '--query', 'pnpm dependencies').map((m) => m.id),
  );
  assert.deepEqual(retrieved[0].metadata.source, source);
  const conflict = await call('memory_submit', {
    requestId: randomUUID(),
    intent: 'automatic',
    candidates: [
      {
        action: 'conflict',
        id: note.id,
        version: note.version,
        kind: 'decision',
        content: 'Use npm dependencies',
        source: { ...source, messageId: 'message-2', excerpt: 'Maybe use npm instead?' },
      },
    ],
  });
  assert.equal(conflict.results[0].verified, false);
  assert.equal((await call('memory_recall', { query: 'dependencies' })).memories.length, 0);
  const pending = (await call('memory_conflicts'))[0];
  await call('memory_resolve', {
    id: pending.id,
    take: pending.candidates[0].id,
    userRequested: true,
  });
  const resolved = await call('memory_get', { id: note.id, history: true });
  assert.equal(resolved.memory.content, 'Use npm dependencies');
  assert.equal(resolved.memory.metadata.basis, 'user_resolution');
  assert.equal(resolved.history.length, 2);
  assert.equal(
    (
      await raw('memory_submit', {
        requestId: randomUUID(),
        intent: 'explicit',
        candidates: [
          { action: 'add', content: 'bad', kind: 'decision', source: { agent: 'codex' } },
        ],
      })
    ).isError,
    true,
  );
  writeFileSync(file, JSON.stringify(input));
  const stale = f.raw('submit', '--file', file);
  assert.equal(stale.status, 2);
  assert.equal(JSON.parse(stale.stdout).results[0].verified, false);
});

test('Projectless MCP keeps personal memory independent without registering a project', async (t) => {
  const f = fixture(t);
  const { call, raw } = await client(t, f, process.execPath, [cli, '--home', f.home, 'serve']);
  assert.equal((await call('memory_settings_get')).effective.defaultScope, 'project');
  assert.equal(
    (await raw('memory_remember', { content: 'Unclassified note', intent: 'explicit' })).isError,
    true,
  );
  const note = (
    await call('memory_remember', {
      content: 'Personal language preference',
      scope: 'user',
      intent: 'explicit',
    })
  ).memory;
  assert.equal(note.scope, 'user');
  assert.equal(note.projectId, null);
  assert.equal((await call('memory_get', { id: note.id })).memory.id, note.id);
  assert.equal((await call('memory_recall')).memories[0].id, note.id);
  assert.match((await call('memory_context')).context, /Personal language preference/);
  assert.deepEqual(await call('memory_conflicts'), []);
  assert.equal(
    (
      await raw('memory_remember', {
        content: 'Project only',
        scope: 'project',
        intent: 'explicit',
      })
    ).isError,
    true,
  );
  await call('memory_update', {
    id: note.id,
    version: 1,
    content: 'Updated personal preference',
    intent: 'explicit',
  });
  await call('memory_forget', { id: note.id, version: 2, intent: 'explicit' });
  assert.deepEqual((await call('memory_recall')).memories, []);
  const submission = {
    requestId: randomUUID(),
    intent: 'explicit',
    candidates: [
      {
        action: 'add',
        scope: 'user',
        kind: 'preference',
        content: 'Personal submitted preference',
        source: {
          agent: 'codex',
          sessionId: 'test-session',
          messageId: 'test-message',
          excerpt: 'Personal submitted preference',
        },
      },
    ],
  };
  const saved = await call('memory_submit', submission);
  assert.equal(saved.results[0].verified, true);
  assert.equal((await call('memory_submit', submission)).replayed, true);
  assert.equal(
    (await call('memory_get', { id: saved.results[0].receipt.id })).memory.scope,
    'user',
  );
  const store = new Store(f.home);
  try {
    assert.throws(() => store.project(f.project), /Project not connected/);
  } finally {
    store.close();
  }
});

test('Shared MCP accepts the current agent workspace and scopes personal versus project content', async (t) => {
  const f = fixture(t);
  const { call, raw } = await client(t, f, process.execPath, [cli, '--home', f.home, 'serve']);
  const second = join(f.root, 'second-workspace');
  mkdirSync(second);
  const local = (
    await call('memory_remember', {
      projectPath: f.project,
      scope: 'project',
      content: 'Workspace-specific architecture',
      intent: 'explicit',
    })
  ).memory;
  const personal = (
    await call('memory_remember', {
      projectPath: f.project,
      scope: 'user',
      content: 'Always answer in Chinese',
      intent: 'explicit',
    })
  ).memory;
  assert.equal(local.scope, 'project');
  assert.equal(personal.projectId, null);
  assert.deepEqual(
    new Set((await call('memory_recall', { projectPath: f.project })).memories.map((m) => m.id)),
    new Set([local.id, personal.id]),
  );
  assert.deepEqual(
    (await call('memory_recall', { projectPath: second })).memories.map((m) => m.id),
    [personal.id],
  );
  assert.equal((await raw('memory_get', { projectPath: second, id: local.id })).isError, true);
  assert.deepEqual(
    (await call('memory_recall')).memories.map((m) => m.id),
    [personal.id],
  );
});

test('Setup preserves an unmanaged OpenCode slash command without partial configuration', (t) => {
  const f = fixture(t);
  const path = join(f.project, '.opencode/commands/co-memo.md');
  mkdirSync(join(f.project, '.opencode/commands'), { recursive: true });
  writeFileSync(path, 'My custom command');
  const result = f.raw('setup', 'opencode');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /command is not managed/);
  assert.equal(read(path), 'My custom command');
  assert.equal(existsSync(join(f.project, 'opencode.json')), false);
  assert.equal(existsSync(join(f.project, '.opencode/skills/co-memo/SKILL.md')), false);
});

for (const agent of ['claude', 'pi', 'opencode']) {
  test(`Setup ${agent} refuses unmanaged namespaced shortcuts without partial installation`, (t) => {
    const f = fixture(t);
    const hostRoot = { claude: '.claude', pi: '.pi', opencode: '.opencode' }[agent];
    const shortcut = shortcutPaths(agent).find((s) => s.action === 'ui');
    const path = join(f.project, hostRoot, shortcut.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'My existing shortcut');
    const result = f.raw('setup', agent);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shortcut is not managed/);
    assert.equal(read(path), 'My existing shortcut');
    assert.equal(existsSync(join(f.project, hostRoot, 'skills/co-memo/SKILL.md')), false);
  });
}
