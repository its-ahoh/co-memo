// Readiness checks use disposable data/config; no model inference is launched.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-host-smoke-')));
const project = join(root, 'project');
mkdirSync(project);
const home = join(root, 'data');
const cli = resolve('dist/cli.js');
const results = [];
const run = (command, args, env = process.env) =>
  spawnSync(command, args, {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
try {
  for (const host of ['codex', 'opencode']) {
    const version = run(host, ['--version']);
    if (version.error || version.status !== 0) {
      results.push({ host, status: 'unavailable', modelToolUse: 'not_tested' });
      continue;
    }
    const setup = run(process.execPath, [
      cli,
      '--home',
      home,
      '--project',
      project,
      'setup',
      host,
      '--tools-only',
    ]);
    if (setup.status !== 0) throw new Error(`Disposable setup failed for ${host}`);
    const hostEnv = Object.fromEntries(
      ['PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'WINDIR'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    let args;
    if (host === 'codex') {
      const config = join(root, 'codex-home');
      mkdirSync(config);
      writeFileSync(
        join(config, 'config.toml'),
        `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
      );
      hostEnv.CODEX_HOME = config;
      args = ['mcp', 'get', 'co-memo', '--json'];
    } else {
      for (const [key, subdir] of [
        ['XDG_CONFIG_HOME', 'config'],
        ['XDG_DATA_HOME', 'oc-data'],
        ['XDG_CACHE_HOME', 'cache'],
        ['XDG_STATE_HOME', 'state'],
        ['OPENCODE_CONFIG_DIR', 'oc-config'],
      ]) {
        const path = join(root, subdir);
        mkdirSync(path);
        hostEnv[key] = path;
      }
      args = ['mcp', 'list'];
    }
    const result = run(host, args, hostEnv);
    let passed = false;
    if (host === 'codex') {
      try {
        const data = JSON.parse(result.stdout);
        passed =
          data.name === 'co-memo' && data.enabled === true && data.transport?.type === 'stdio';
      } catch {}
    } else passed = /co-memo\s+(?:\u001b\[[0-9;]*m)*connected/u.test(result.stdout ?? '');
    const probe = run(process.execPath, [
      cli,
      '--home',
      home,
      '--project',
      project,
      'doctor',
      host,
      '--probe',
    ]);
    let transport = 'failed';
    try {
      transport = JSON.parse(probe.stdout).transport;
    } catch {}
    results.push({
      host,
      version: version.stdout.trim(),
      status: result.status === 0 && passed ? 'passed' : 'failed',
      verifiedLayer: host === 'codex' ? 'project_config_discovery' : 'host_mcp_connection',
      localProtocolProbe: transport,
      modelToolUse: 'not_tested',
      hooks: 'not_tested_tools_only',
      exitCode: result.status,
    });
  }
  console.log(
    JSON.stringify(
      {
        results,
        note: 'No model, credentials or production memory used. Config/transport checks do not establish automatic capture, host trust in other projects or model tool use.',
      },
      null,
      2,
    ),
  );
  if (results.some((r) => r.status !== 'passed' || r.localProtocolProbe !== 'passed'))
    process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
