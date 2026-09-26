import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-package-')));
const project = join(root, 'project');
const home = join(root, 'memory');
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CO_MEMO_SEMANTIC: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
try {
  mkdirSync(project);
  // Build is the caller's responsibility. Pack exactly those artifacts without rebuilding.
  const [pack] = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], repo),
  );
  const paths = pack.files.map((file) => file.path);
  for (const path of [
    'dist/cli.js',
    'dist/locations.js',
    'dist/ui/index.html',
    'dist/ui/app.js',
    'dist/ui/style.css',
    'dist/ui/theme.js',
    'dist/ui/logo.png',
    'skills/co-memo/SKILL.md',
    'NOTICE.md',
    'LICENSE',
    'LICENSES/original-engine-MIT.txt',
  ])
    assert.ok(paths.includes(path), `Missing runtime asset: ${path}`);
  assert.ok(
    paths.every(
      (path) =>
        !/^(src|test|node_modules|\.git|\.co-memo)\//.test(path) &&
        !/(^|\/)\.env/.test(path) &&
        !/\.sqlite(?:$|[-.])/.test(path),
    ),
    'Package contains development or private data files',
  );
  const archive = join(root, pack.filename);
  const install = (name) => {
    const prefix = join(root, name);
    run('npm', [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      archive,
    ]);
    const cli = join(prefix, 'bin', 'co-memo');
    assert.equal(run(cli, ['--version']).trim(), pack.version);
    const json = (...args) => JSON.parse(run(cli, ['--home', home, '--project', project, ...args]));
    return { prefix, cli, json };
  };
  const first = install('first');
  assert.equal(
    first.json('init', '--agents', 'claude,codex,opencode,pi', '--hooks', '--apply').status,
    'configured',
  );
  const saved = first.json('add', '--content', 'Package validation uses synthetic memories.');
  assert.ok(saved.memory.id);
  for (const agent of ['claude', 'codex', 'opencode'])
    assert.equal(first.json('doctor', agent, '--probe').transport, 'passed');
  // Simulate an installation moving (e.g. a Node version manager upgrade).
  const next = install('next');
  rmSync(first.prefix, { recursive: true, force: true });
  const repaired = next.json('init', '--agents', 'claude,codex,opencode,pi', '--hooks', '--apply');
  assert.equal(repaired.status, 'configured');
  assert.equal(next.json('show', saved.memory.id).content, saved.memory.content);
  for (const agent of ['claude', 'codex', 'opencode'])
    assert.equal(next.json('doctor', agent, '--probe').transport, 'passed');
  const config = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
  assert.ok(config.mcpServers['co-memo'].args[0].startsWith(next.prefix));
  assert.ok(!config.mcpServers['co-memo'].args[0].includes(repo));
  assert.equal(next.json('disconnect', 'claude').applied, false);
  assert.equal(next.json('disconnect', 'claude', '--apply').status, 'disconnected');
  assert.equal(next.json('show', saved.memory.id).content, saved.memory.content);
  assert.equal(next.json('doctor', 'codex', '--probe').transport, 'passed');
  const inventory = next.json('projects', '--check');
  assert.equal(inventory.projects.length, 1);
  assert.equal(inventory.projects[0].root, project);
  assert.ok(!inventory.projects[0].agents.includes('claude'));
  const archiveDirectory = join(root, 'memory-backup');
  assert.equal(next.json('backup', archiveDirectory).status, 'backed_up');
  assert.equal(next.json('backup-check', archiveDirectory).status, 'verified');
  const recoveredHome = join(root, 'recovered-memory');
  assert.equal(
    next.json('restore', archiveDirectory, '--to', recoveredHome, '--apply').status,
    'restored',
  );
  const recovered = JSON.parse(
    run(next.cli, ['--home', recoveredHome, '--project', project, 'show', saved.memory.id]),
  );
  assert.equal(recovered.content, saved.memory.content);
  console.log(
    JSON.stringify(
      {
        package: pack.name,
        version: pack.version,
        bytes: pack.size,
        files: paths.length,
        install: 'passed',
        mcp: 'passed',
        relocation: 'passed',
        disconnect: 'passed',
        backupRestore: 'passed',
        projects: 'passed',
        hostVerified: false,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
