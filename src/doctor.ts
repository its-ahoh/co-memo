import { repository } from './worktrees.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse as toml } from 'smol-toml';
import { parse as jsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Agent, Memory, Snapshot, ensure } from './model.js';
import { readText, safeParents } from './fs.js';
import { parse } from './document.js';
import { prepareSetup } from './setup.js';
import { SettingsPatch } from './settings.js';
import { dataHome } from './store.js';

type Check = {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  message: string;
  remedy?: string;
};
const record = z.record(z.string(), z.unknown());
const cli = realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)));
function config(root: string, agent: Agent): Record<string, unknown> | null {
  if (agent === 'pi') return null;
  if (agent === 'codex') {
    const text = readText(join(root, '.codex/config.toml'));
    ensure(text !== null, 'Missing config');
    return record.parse(record.parse(toml(text).mcp_servers)['co-memo']);
  }
  if (agent === 'claude') {
    const text = readText(join(root, '.mcp.json'));
    ensure(text !== null, 'Missing config');
    return record.parse(record.parse(JSON.parse(text).mcpServers)['co-memo']);
  }
  const plain = readText(join(root, 'opencode.json'));
  const commented = readText(join(root, 'opencode.jsonc'));
  ensure((plain === null) !== (commented === null), 'Expected one OpenCode config');
  const errors: ParseError[] = [];
  const doc = jsonc(plain ?? commented!, errors, { allowTrailingComma: true });
  ensure(!errors.length, 'Malformed JSONC');
  const mcp = record.parse(record.parse(doc).mcp);
  return record.parse((mcp.servers ? record.parse(mcp.servers) : mcp)['co-memo']);
}

/** Static inspection never opens Store (which creates/migrates databases), syncs, or runs config commands. */
export async function doctor(input: {
  home?: string | undefined;
  root: string;
  agent?: Agent | undefined;
  probe?: boolean | undefined;
}) {
  const checks: Check[] = [];
  const add = (id: string, status: Check['status'], message: string, remedy?: string) =>
    checks.push({ id, status, message, ...(remedy ? { remedy } : {}) });
  let root = resolve(input.root);
  let home = resolve(input.home ?? dataHome());
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add(
    'runtime',
    major > 24 || (major === 24 && minor >= 12) ? 'pass' : 'fail',
    `Node ${process.versions.node}; requires 24.12+`,
    'Use a supported Node runtime and rerun setup.',
  );
  let db: DatabaseSync | undefined;
  let ready = false;
  let agents: Agent[] = input.agent ? [input.agent] : [];
  try {
    root = realpathSync(root);
    home = realpathSync(home);
    const database = join(home, 'shared-memory-v1.sqlite');
    safeParents(database);
    const st = lstatSync(database);
    ensure(st.isFile() && !st.isSymbolicLink(), 'Unsafe database path');
    db = new DatabaseSync(database, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    ensure(db.prepare('PRAGMA user_version').get()?.user_version === 4, 'Unsupported schema');
    ensure(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok', 'Integrity check failed');
    let project: Record<string, unknown> | undefined;
    for (let path = root; ; path = dirname(path)) {
      project = db.prepare('SELECT id,root FROM projects WHERE root=?').get(path);
      if (!project) {
        const link = db
          .prepare('SELECT project_id,git_common FROM project_links WHERE root=?')
          .get(path);
        if (link) {
          ensure(repository(path).common === link.git_common, 'Worktree identity changed');
          project = { id: link.project_id, root: path };
        }
      }
      if (project || path === dirname(path) || existsSync(join(path, '.git'))) break;
    }
    ensure(project, 'Project not registered');
    root = String(project.root);
    const id = String(project.id);
    add('database', 'pass', 'Schema 4, integrity check and project registration passed.');
    const effective = db
      .prepare("SELECT payload FROM settings WHERE scope_key IN ('user', ?)")
      .all(id)
      .map((row) => SettingsPatch.parse(JSON.parse(String(row.payload))));
    if (effective.some((s) => s.paused))
      add(
        'paused',
        'warn',
        'Memory is paused; delivery and writes are disabled.',
        'Resume only when intended: settings set --scope user|project --paused false.',
      );
    if (effective.some((s) => s.saveMode === 'explicit'))
      add('save-mode', 'pass', 'Explicit-only mode: inferred and Markdown writes are rejected.');
    const conflicts = Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM conflicts c JOIN notes n ON n.id=c.memory_id WHERE n.scope='user' OR n.project_id=?",
        )
        .get(id)?.n,
    );
    add(
      'conflicts',
      conflicts ? 'warn' : 'pass',
      `${conflicts} unresolved conflicts affect this project.`,
      'Inspect conflicts and resolve only with a user-selected version.',
    );
    const replicas = db
      .prepare('SELECT * FROM replicas WHERE project_id=?')
      .all(id)
      .filter((r) => dirname(dirname(String(r.path))) === root);
    if (!agents.length) agents = replicas.map((r) => Agent.parse(r.agent));
    if (!agents.length) add('agents', 'fail', 'No connected agent replicas.', 'Run setup AGENT.');
    const memories = db
      .prepare(
        "SELECT payload FROM notes WHERE deleted=0 AND (scope='user' OR project_id=?) ORDER BY rowid",
      )
      .all(id)
      .map((r) => Memory.parse(JSON.parse(String(r.payload))));
    for (const agent of agents) {
      const r = replicas.find((r) => r.agent === agent);
      if (!r) {
        add(`${agent}:replica`, 'fail', 'Agent is not connected.', `Run setup ${agent}.`);
        continue;
      }
      try {
        const text = readText(String(r.path));
        ensure(text !== null, 'Missing projection');
        const snapshot = parse(text, String(r.id));
        const baseline = r.baseline ? Snapshot.parse(JSON.parse(String(r.baseline))) : null;
        const expected = memories.map((m) => ({
          id: m.id,
          version: m.version,
          content: m.content,
        }));
        const changed = !baseline || JSON.stringify(snapshot) !== JSON.stringify(baseline);
        const stale = JSON.stringify(snapshot.entries) !== JSON.stringify(expected);
        add(
          `${agent}:replica`,
          r.pending || changed || stale ? 'warn' : 'pass',
          r.pending
            ? 'Publication is pending.'
            : changed
              ? 'Projection contains unsynchronized changes.'
              : stale
                ? 'Projection differs from current central notes.'
                : 'Projection matches central notes.',
          'Run sync and inspect errors; doctor never imports edits.',
        );
      } catch {
        add(
          `${agent}:replica`,
          'fail',
          'Projection is missing, unsafe or malformed.',
          'Inspect the file; use repair only for a missing projection.',
        );
      }
    }
    // Check index coverage without returning memory contents.
    const missing = Number(
      db
        .prepare(
          'SELECT count(*) AS n FROM notes n LEFT JOIN notes_fts f ON f.rowid=n.rowid WHERE f.rowid IS NULL OR f.id<>n.id',
        )
        .get()?.n,
    );
    add(
      'search-index',
      missing ? 'fail' : 'pass',
      missing
        ? 'Full-text index has missing/mismatched rows.'
        : 'Full-text index covers stored notes.',
      'Back up the store before investigating database damage.',
    );
    ready = true;
  } catch {
    add(
      'database',
      'fail',
      'Cannot inspect this registered project: store missing, unsafe, busy, corrupt or on an unsupported schema.',
      'Check --home/--project. For a new project run setup AGENT; for an older store upgrade using the current CLI. No database was created or migrated.',
    );
  } finally {
    db?.close();
  }
  let validBinding = false;
  if (ready)
    for (const agent of agents) {
      try {
        const entry = config(root, agent);
        const expected = [cli, '--home', home, '--project', root, 'serve', '--co-memo-managed'];
        if (entry) {
          const command =
            agent === 'opencode'
              ? z.array(z.string()).parse(entry.command)
              : [z.string().parse(entry.command), ...z.array(z.string()).parse(entry.args)];
          ensure(
            JSON.stringify(command) ===
              JSON.stringify([realpathSync(process.execPath), ...expected]),
            'Binding differs',
          );
          ensure(entry.enabled !== false, 'Disabled server');
          validBinding = true;
        }
        add(
          `${agent}:binding`,
          'pass',
          entry
            ? 'Project MCP entry points to this runtime, CLI, store and project.'
            : 'Pi uses the pinned CLI instead of MCP.',
        );
        const hooks =
          readText(
            join(
              root,
              agent === 'codex'
                ? '.codex/hooks.json'
                : agent === 'claude'
                  ? '.claude/settings.local.json'
                  : agent === 'pi'
                    ? '.pi/extensions/co-memo.ts'
                    : '.opencode/plugins/co-memo.ts',
            ),
          ) ?? '';
        const toolsOnly =
          agent === 'codex' || agent === 'claude'
            ? !hooks.includes('co-memo:managed:')
            : !hooks.includes('bridge');
        const edits = prepareSetup(root, agent, home, { toolsOnly });
        const drift = edits.filter((edit) => edit.before !== edit.after).map((edit) => edit.path);
        add(
          `${agent}:files`,
          drift.length ? 'warn' : 'pass',
          drift.length
            ? `Generated files need refresh: ${drift.join(', ')}`
            : `Generated configuration, skill and instructions match (${toolsOnly ? 'tools-only' : 'hybrid'}).`,
          `Rerun setup ${agent}${toolsOnly ? ' --tools-only' : ''}, then reload the host.`,
        );
        add(
          `${agent}:host`,
          'info',
          'Host loading, project trust, hook/tool approval and model tool use are not established by static checks. saveMode=auto does not bypass host approval.',
          agent === 'codex'
            ? 'Trust the project, reload Codex, inspect /mcp and /hooks, then run a disposable cross-agent round trip.'
            : 'Reload the host, inspect loaded tools, then run a disposable cross-agent round trip.',
        );
      } catch {
        add(
          `${agent}:binding`,
          'fail',
          'Missing, malformed, disabled or stale Co-memo configuration; no configured command was executed.',
          `Review the config and rerun setup ${agent} with the intended store and runtime.`,
        );
      }
    }
  let transport: 'not_requested' | 'blocked' | 'passed' | 'failed' = 'not_requested';
  if (input.probe) {
    transport = 'blocked';
    if (ready && validBinding) {
      const client = new Client({ name: 'co-memo-doctor', version: '1' });
      const connection = new StdioClientTransport({
        command: process.execPath,
        args: [cli, '--home', home, '--project', root, 'serve'],
        stderr: 'pipe',
      });
      connection.stderr?.on('data', () => {});
      try {
        await client.connect(connection, { timeout: 5000 });
        const listed = await client.listTools({}, { timeout: 5000 });
        ensure(
          ['memory_context', 'memory_submit', 'memory_settings_get'].every((name) =>
            listed.tools.some((t) => t.name === name),
          ),
          'Required tools missing',
        );
        const result = await client.callTool(
          { name: 'memory_settings_get', arguments: {} },
          undefined,
          { timeout: 5000 },
        );
        ensure(!result.isError, 'Settings tool failed');
        transport = 'passed';
        add(
          'mcp-probe',
          'pass',
          'This CLI completed MCP initialize, tool discovery and settings read. No memory writes or model calls were requested.',
        );
      } catch {
        transport = 'failed';
        add(
          'mcp-probe',
          'fail',
          'MCP initialization/discovery/settings read failed or timed out.',
          'Check Node compatibility, installation and store access.',
        );
      } finally {
        await client.close();
      }
    } else
      add(
        'mcp-probe',
        'fail',
        'Probe skipped: no valid registered MCP binding for this installation.',
        'Fix the binding first. Pi uses CLI; MCP probing is not applicable.',
      );
  }
  return {
    status: checks.some((c) => c.status === 'fail')
      ? 'needs_attention'
      : checks.some((c) => c.status === 'warn')
        ? 'warnings'
        : 'healthy',
    root,
    home,
    transport,
    hostVerified: false,
    checks,
  };
}
