// Opt-in: runs a real Claude model using existing login/quota and synthetic data only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../dist/store.js';
import { prepareSetup } from '../dist/setup.js';
import { applyAdapter, shellQuote } from '../dist/adapters.js';
import { sync } from '../dist/sync.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-hooks-')));
const project = join(root, 'project'),
  home = join(root, 'data');
const log = join(root, 'events.jsonl');
const label = `hook-check-${randomUUID()}`,
  value = randomBytes(12).toString('hex');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
try {
  mkdirSync(project);
  const store = new Store(home);
  try {
    applyAdapter(prepareSetup(project, 'claude', home, {}));
    const p = store.project(project, true);
    store.connect(p, 'claude');
    store.add(`${label}: verification value is ${value}.`, 'project', p.id, 'hook-fixture');
    sync(store);
  } finally {
    store.close();
  }
  const settingsPath = join(project, '.claude/settings.local.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  // Instrument the generated commands; the host must actually launch each hook.
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const hook = settings.hooks[event][0].hooks[0];
    const original = hook.command;
    const wrapper = join(root, `${event}.mjs`);
    writeFileSync(
      wrapper,
      `import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
const result = spawnSync('/bin/sh', ['-c', ${JSON.stringify(original)}], { input: readFileSync(0), encoding: 'utf8', timeout: 12000, maxBuffer: 1048576 });
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: ${JSON.stringify(event)}, status: result.status, delivered: (result.stdout ?? '').includes(${JSON.stringify(value)}) }) + '\\n');
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
`,
      { mode: 0o600 },
    );
    hook.command = `${shellQuote(process.execPath)} ${shellQuote(wrapper)}`;
  }
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const result = spawnSync(
    'claude',
    [
      '-p',
      `What is the verification value for ${label} in the shared context? Reply with that value only; if unavailable say NOT_FOUND.`,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      'local',
      '--disable-slash-commands',
      '--permission-mode',
      'dontAsk',
      '--max-budget-usd',
      '1',
    ],
    {
      cwd: project,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, CO_MEMO_SEMANTIC: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const events = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  assert.equal(
    result.status,
    0,
    'Claude did not complete; check authentication, quota and project trust. Raw host logs are not printed.',
  );
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error('Claude returned an unexpected output format');
  }
  assert.equal(output.is_error, false, 'Claude reported a model/provider error');
  assert.ok(
    String(output.result).includes(value),
    'Model did not recall the random value from hook context',
  );
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'])
    assert.ok(
      events.some((e) => e.event === event && e.status === 0),
      `${event} did not complete successfully`,
    );
  for (const event of ['SessionStart', 'UserPromptSubmit'])
    assert.ok(
      events.some((e) => e.event === event && e.delivered),
      `${event} did not deliver the memory`,
    );
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        host: 'claude',
        events,
        modelRecalledHookMemory: true,
        mcpEnabled: false,
        builtinToolsEnabled: false,
        automaticExtractionVerified: false,
        cli,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
