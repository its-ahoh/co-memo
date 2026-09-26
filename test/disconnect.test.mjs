import { shortcutPaths } from '../dist/shortcuts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { prepareSetup } from '../dist/setup.js';
import { applyAdapter } from '../dist/adapters.js';
import { planDisconnect, applyDisconnect } from '../dist/disconnect.js';
import { sync } from '../dist/sync.js';
import { doctor } from '../dist/doctor.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-disconnect-')));
  const project = join(root, 'project');
  mkdirSync(project);
  const store = new Store(join(root, 'data'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const setup = (agent, api = 'v1') => {
    applyAdapter(prepareSetup(project, agent, store.home, { opencodeApi: api }));
    store.connect(store.project(project, true), agent);
    sync(store);
  };
  return { root, project, store, setup };
}
for (const agent of ['claude', 'codex', 'opencode', 'pi'])
  test(`disconnect ${agent} archives pending edits, retains central memory and permits reconnect`, async (t) => {
    const { project, store, setup } = fixture(t);
    setup(agent);
    const projectId = store.project(project).id;
    const memory = store.add('Keep this central decision', 'project', projectId, 'test').memory;
    sync(store);
    const path = join(project, '.co-memo', `${agent}.md`);
    const before = readFileSync(path, 'utf8').replace(
      'Keep this central decision',
      'Pending unsaved edit',
    );
    writeFileSync(path, before);
    const plan = planDisconnect(project, agent);
    assert.equal(readFileSync(path, 'utf8'), before);
    const result = store.lock(() => applyDisconnect(store, plan));
    assert.equal(result.hostUnloaded, false);
    assert.equal(store.replicas().length, 0);
    assert.equal(store.get(memory.id).content, memory.content);
    assert.equal(existsSync(path), false);
    const hostRoot = { codex: '.agents', claude: '.claude', pi: '.pi', opencode: '.opencode' }[
      agent
    ];
    for (const shortcut of shortcutPaths(agent))
      assert.equal(existsSync(join(project, hostRoot, shortcut.path)), false);
    if (agent === 'opencode')
      assert.equal(existsSync(join(project, '.opencode/commands/co-memo.md')), false);
    const manifest = JSON.parse(readFileSync(join(result.archive, 'manifest.json'), 'utf8'));
    const backup = manifest.find((e) => e.original === path);
    assert.equal(readFileSync(join(result.archive, backup.backup), 'utf8'), before);
    assert.equal(applyDisconnect(store, planDisconnect(project, agent)).archive, null);
    setup(agent);
    assert.equal(store.get(memory.id).content, memory.content);
    assert.ok(!readFileSync(path, 'utf8').includes('Pending unsaved edit'));
    const report = await doctor({ root: project, home: store.home, agent, probe: agent !== 'pi' });
    assert.equal(report.readiness.hostMemoryLoaded, 'unverified');
    if (agent !== 'pi') assert.equal(report.transport, 'passed');
  });

test('disconnect preserves other agent blocks, hooks, MCP servers and gitignore', (t) => {
  const { project, store, setup } = fixture(t);
  mkdirSync(join(project, '.claude'));
  writeFileSync(
    join(project, '.claude/settings.local.json'),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] },
      permissions: { allow: ['Read'] },
    }),
  );
  writeFileSync(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
  );
  writeFileSync(join(project, 'AGENTS.md'), 'User instructions\n');
  setup('claude');
  setup('codex');
  setup('pi');
  const ignore = readFileSync(join(project, '.gitignore'), 'utf8');
  applyDisconnect(store, planDisconnect(project, 'claude'));
  assert.deepEqual(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')).mcpServers, {
    other: { command: 'other' },
  });
  const settings = JSON.parse(readFileSync(join(project, '.claude/settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo user');
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  applyDisconnect(store, planDisconnect(project, 'codex'));
  const instructions = readFileSync(join(project, 'AGENTS.md'), 'utf8');
  assert.ok(instructions.includes('User instructions'));
  assert.ok(instructions.includes('co-memo:adapter-pi:start'));
  assert.ok(!instructions.includes('co-memo:adapter-codex:start'));
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), ignore);
  assert.deepEqual(
    store.replicas().map((r) => r.agent),
    ['pi'],
  );
});

test('disconnect rejects malformed, unmanaged, changed and symlinked files before mutations', (t) => {
  const { project, root, store, setup } = fixture(t);
  setup('claude');
  const config = join(project, '.mcp.json');
  const original = readFileSync(config, 'utf8');
  const instructions = readFileSync(join(project, 'CLAUDE.local.md'), 'utf8');
  for (const content of ['{bad', '{"mcpServers":{"co-memo":{"command":"other"}}}']) {
    writeFileSync(config, content);
    assert.throws(() => planDisconnect(project, 'claude'));
    assert.equal(readFileSync(join(project, 'CLAUDE.local.md'), 'utf8'), instructions);
  }
  writeFileSync(config, original);
  const plan = planDisconnect(project, 'claude');
  writeFileSync(config, original + '\n');
  assert.throws(() => applyDisconnect(store, plan), /changed since preview/);
  assert.equal(store.replicas().length, 1);
  rmSync(config);
  const outside = join(root, 'outside.json');
  writeFileSync(outside, original);
  symlinkSync(outside, config);
  assert.throws(() => planDisconnect(project, 'claude'), /regular file/);
  assert.equal(readFileSync(outside, 'utf8'), original);
});

test('OpenCode V2 disconnect retains other servers and JSONC comments', (t) => {
  const { project, store, setup } = fixture(t);
  writeFileSync(
    join(project, 'opencode.jsonc'),
    '{\n// keep comment\n"mcp":{"servers":{"other":{"type":"local","command":["other"]}}}}',
  );
  setup('opencode', 'v2');
  applyDisconnect(store, planDisconnect(project, 'opencode'));
  const text = readFileSync(join(project, 'opencode.jsonc'), 'utf8');
  assert.ok(text.includes('// keep comment'));
  assert.ok(text.includes('"other"'));
  assert.ok(!text.includes('--co-memo-managed'));
});
