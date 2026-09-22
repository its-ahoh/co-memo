#!/usr/bin/env node
import { Submission, submit } from './candidates.js';
import { configuration, configure, remember, change, checkpoint } from './service.js';
import { allowWrite } from './settings.js';
import type { Intent } from './settings.js';
import { prepareSetup } from './setup.js';
import { serve } from './mcp.js';
import { Command, Option } from 'commander';
import { realpathSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { sync, context, repair } from './sync.js';
import { prepareAdapter, applyAdapter } from './adapters.js';
import { readText } from './fs.js';
import { Agent, Scope, Content, ensure, errorMessage } from './model.js';
import type { SyncReport, Memory } from './model.js';

const app = new Command()
  .name('co-memo')
  .version('0.5.0')
  .enablePositionalOptions()
  .description('One local memory store for your coding agents')
  .option('--home <directory>', 'Local data directory (or CO_MEMO_HOME)')
  .option('--project <directory>', 'Project directory', process.cwd());
const print = (value: unknown) => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};
const positive = (s: string) => z.number().int().positive().safe().parse(Number(s));
function options(): { home?: string | undefined; project: string } {
  return z.object({ home: z.string().optional(), project: z.string() }).parse(app.opts());
}
function using<T>(fn: (store: Store, root: string) => T): T {
  const opts = options(),
    store = new Store(opts.home);
  try {
    return store.lock(() => fn(store, opts.project));
  } finally {
    store.close();
  }
}
function reportExit(report: SyncReport): void {
  if (report.errors.length || report.conflicts.length) process.exitCode = 2;
}
function checkScope(store: Store, id: string, root: string): Memory {
  const memory = store.get(id);
  ensure(
    memory.scope === 'user' || store.project(root).id === memory.projectId,
    'Memory belongs to another project',
  );
  return memory;
}
const scoped = (command: Command) =>
  command.addOption(new Option('--scope <scope>', 'Memory scope').choices(['project', 'user']));
app
  .command('connect <agent>')
  .description('Connect pi, claude, codex or opencode in this project')
  .addOption(
    new Option(
      '--opencode-api <version>',
      'OpenCode plugin API (new connections default to v1)',
    ).choices(['v1', 'v2']),
  )
  .action((name: string, opts: { opencodeApi?: 'v1' | 'v2' }) => {
    const agent = Agent.parse(name);
    ensure(!opts.opencodeApi || agent === 'opencode', '--opencode-api requires connect opencode');
    print(
      using((store, path) => {
        const root = realpathSync(path);
        const edits = prepareAdapter(root, agent, store.home, opts.opencodeApi);
        const replica = store.transaction(() => store.connect(store.project(root, true), agent));
        applyAdapter(edits);
        const report = sync(store);
        reportExit(report);
        return {
          agent,
          memoryFile: replica.path,
          files: edits.map((e) => e.path),
          ...report,
          next:
            agent === 'pi'
              ? 'Trust the project and run /reload in Pi.'
              : agent === 'claude'
                ? 'Restart Claude Code and approve its project hooks.'
                : agent === 'codex'
                  ? 'Restart Codex, trust the project and review/enable hooks with /hooks.'
                  : 'Restart OpenCode to load the project plugin. Use --opencode-api v2 for OpenCode V2.',
        };
      }),
    );
  });
scoped(
  app
    .command('add')
    .description('Remember a note; omitted scope uses settings')
    .requiredOption('--content <text>', 'Memory text')
    .addOption(
      new Option('--intent <intent>', 'explicit user request or automatic capture')
        .choices(['explicit', 'automatic'])
        .default('explicit'),
    ),
).action((opts: { content: string; scope?: 'project' | 'user'; intent: Intent }) =>
  print(
    using((store, root) => {
      const result = remember(store, root, opts, 'user');
      reportExit(result.sync);
      return result;
    }),
  ),
);
app
  .command('list')
  .description('List user notes and this project’s notes')
  .option('--deleted', 'Include tombstones')
  .option('--query <text>', 'Local full-text search (BM25, up to 100 matches)')
  .action((opts: { deleted?: boolean; query?: string }) =>
    print(
      using((store, root) => {
        const project = store.project(root);
        const report = sync(store);
        reportExit(report);
        return store.search(project.id, opts.query, opts.deleted);
      }),
    ),
  );
app
  .command('show <id>')
  .description('Read a full memory')
  .action((id: string) => print(using((store, root) => checkScope(store, id, root))));
app
  .command('history <id>')
  .description('Read every version, including deletion')
  .action((id: string) =>
    print(
      using((store, root) => {
        checkScope(store, id, root);
        return store.history(id);
      }),
    ),
  );
app
  .command('edit <id>')
  .description('Update a memory using its current version')
  .requiredOption('--version <number>', 'Expected version', positive)
  .requiredOption('--content <text>', 'New content')
  .addOption(
    new Option('--intent <intent>', 'Write intent')
      .choices(['explicit', 'automatic'])
      .default('explicit'),
  )
  .action((id: string, opts: { version: number; content: string; intent: Intent }) =>
    print(
      using((store, root) => {
        const result = change(store, root, { id, ...opts }, 'user');
        reportExit(result.sync);
        return result;
      }),
    ),
  );
app
  .command('forget <id>')
  .description('Delete a memory everywhere, retaining a tombstone')
  .requiredOption('--version <number>', 'Expected version', positive)
  .addOption(
    new Option('--intent <intent>', 'Write intent')
      .choices(['explicit', 'automatic'])
      .default('explicit'),
  )
  .action((id: string, opts: { version: number; intent: Intent }) =>
    print(
      using((store, root) => {
        const result = change(store, root, { id, ...opts, content: null }, 'user');
        reportExit(result.sync);
        return result;
      }),
    ),
  );
scoped(
  app
    .command('import <path>')
    .description(
      'Import a Markdown file, or a directory of Markdown files, without changing originals',
    ),
).action((path: string, opts: { scope?: string }) =>
  print(
    using((store, root) => {
      const config = configuration(store, root);
      const scope = Scope.parse(opts.scope ?? config.effective.defaultScope);
      ensure(!config.effective.paused, 'Co-memo is paused');
      allowWrite(store, scope === 'project' ? store.project(root).id : null, 'explicit');
      ensure(!lstatSync(path).isSymbolicLink(), 'Linked import paths are not supported');
      const absolute = realpathSync(path);
      const paths = statSync(absolute).isDirectory()
        ? readdirSync(absolute)
            .filter((p) => extname(p).toLowerCase() === '.md')
            .sort()
            .map((p) => join(absolute, p))
        : [absolute];
      ensure(paths.length && paths.length <= 100, 'Import requires 1–100 Markdown files');
      const notes = paths.map((file) => {
        ensure(extname(file).toLowerCase() === '.md', 'Only Markdown imports are supported');
        const text = readText(file);
        ensure(text !== null, 'Import file missing');
        return { file, content: Content.parse(text) };
      });
      sync(store);
      const projectId = scope === 'project' ? store.project(root).id : null;
      const result = store.transaction(() =>
        notes.map((n) => store.add(n.content, scope, projectId, `import:${n.file}`)),
      );
      const report = sync(store);
      reportExit(report);
      return { notes: result, sync: report };
    }),
  ),
);
app
  .command('sync')
  .description('Reconcile all connected agents and projects')
  .action(() => {
    const report = using((store) => sync(store));
    print(report);
    reportExit(report);
  });
app
  .command('repair <agent>')
  .description('Recreate a missing replica from central memory; never overwrite a file')
  .action((name: string) => {
    const agent = Agent.parse(name),
      report = using((store, root) => repair(store, agent, store.project(root).id));
    print(report);
    reportExit(report);
  });
app
  .command('conflicts')
  .description('Inspect competing versions; nothing is discarded')
  .action(() => print(using((store) => store.conflicts())));
app
  .command('resolve <id>')
  .description('Resolve a conflict explicitly; proposed replica IDs appear in conflicts')
  .option('--take <choice>', 'current or a proposal replicaId')
  .option('--content <text>', 'Custom merged text')
  .action((id: string, opts: { take?: string; content?: string }) => {
    ensure(
      (opts.take !== undefined) !== (opts.content !== undefined),
      'Specify exactly one of --take or --content',
    );
    print(
      using((store) => {
        const memory = store.transaction(() =>
          store.resolve(id, opts.take ?? 'custom', opts.content),
        );
        const report = sync(store);
        reportExit(report);
        return { memory, sync: report };
      }),
    );
  });
app
  .command('status')
  .description('Check storage, connected agents, pending writes and conflicts')
  .action(() =>
    print(
      using((store, root) => {
        const project = store.project(root);
        return {
          home: store.home,
          project,
          agents: store
            .replicas()
            .filter((r) => r.projectId === project.id)
            .map((r) => ({
              agent: r.agent,
              path: r.path,
              pending: r.pending !== null,
              exists: readText(r.path) !== null,
            })),
          memories: store.list(project.id).length,
          conflicts: store.conflicts(),
          runtime: process.version,
          settings: configuration(store, root),
        };
      }),
    ),
  );
app
  .command('context')
  .description('Print bounded context for this project')
  .option('--query <text>', 'Current task for local lexical ranking')
  .action((opts: { query?: string }) => {
    process.stdout.write(
      using((store, root) => {
        const report = sync(store);
        reportExit(report);
        return context(store, store.project(root).id, 16_000, opts.query);
      }),
    );
  });
app
  .command('submit')
  .requiredOption('--file <path>', 'UTF-8 JSON candidate submission file (max 1 MiB)')
  .action((opts: { file: string }) => {
    const input = readText(opts.file);
    ensure(input !== null, 'Submission file is missing');
    const args = Submission.parse(JSON.parse(input));
    print(
      using((store, root) => {
        const result = submit(store, root, args);
        reportExit(result.sync);
        if (result.results.some((r) => !r.verified && r.status !== 'skipped')) process.exitCode = 2;
        return result;
      }),
    );
  });
app
  .command('checkpoint')
  .requiredOption('--reason <reason>', 'task_completed, user_correction or project_decision')
  .requiredOption('--outcome <outcome>', 'saved, nothing_to_save or skipped')
  .option('--receipts <json>', 'JSON array of id/version/deleted save receipts', '[]')
  .action((opts) =>
    print(
      using((store, root) =>
        checkpoint(store, root, {
          reason: opts.reason,
          outcome: opts.outcome,
          receipts: JSON.parse(opts.receipts),
        }),
      ),
    ),
  );
app
  .command('bridge')
  .description('Host lifecycle entry point (generated by connect)')
  .requiredOption('--agent <agent>', 'pi, claude, codex or opencode')
  .requiredOption('--event <event>', 'Host event')
  .option('--stdin', 'Read bounded host JSON with optional prompt from stdin')
  .action(async (opts: { agent: string; event: string; stdin?: boolean }) => {
    let query: string | undefined;
    if (opts.stdin) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const data = Buffer.from(chunk);
        size += data.length;
        ensure(size <= 1024 * 1024, 'Host input exceeds 1 MiB');
        chunks.push(data);
      }
      const input = z
        .object({ prompt: z.string().optional() })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      query = input.prompt?.slice(0, 16000);
    }
    const agent = Agent.parse(opts.agent);
    const allowed =
      agent === 'claude' || agent === 'codex'
        ? ['SessionStart', 'UserPromptSubmit', 'Stop']
        : agent === 'pi'
          ? ['session_start', 'before_agent_start', 'agent_end']
          : ['context', 'tool_after', 'idle'];
    ensure(allowed.includes(opts.event), 'Unsupported host event');
    const result = using((store, root) => {
      const project = store.project(root);
      ensure(
        store.replicas().some((r) => r.projectId === project.id && r.agent === agent),
        'Agent is not connected',
      );
      const report = sync(store);
      const warning =
        report.errors.length || report.conflicts.length
          ? '\nCo-memo needs attention. Run co-memo sync/conflicts; do not silently resolve conflicts.\n'
          : '';
      return { ...report, context: context(store, project.id, 16_000, query) + warning };
    });
    if (agent === 'pi' || agent === 'opencode') print(result);
    else if (opts.event !== 'Stop')
      print({
        hookSpecificOutput: { hookEventName: opts.event, additionalContext: result.context },
      });
    else if (result.errors.length || result.conflicts.length)
      process.stderr.write('Co-memo needs attention; run co-memo sync/conflicts.\n');
  });
app
  .command('watch')
  .description('Reconcile every two seconds until interrupted')
  .action(async () => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    print({ status: 'watching', intervalMs: 2000 });
    let lastProblems = '';
    try {
      while (!controller.signal.aborted) {
        const report = using((store) => sync(store));
        const problems = JSON.stringify([report.errors, report.conflicts]);
        if (
          report.imported ||
          report.updated ||
          report.deleted ||
          report.published ||
          problems !== lastProblems
        )
          print(report);
        lastProblems = problems;
        try {
          await delay(2000, undefined, { signal: controller.signal });
        } catch (e) {
          if (!controller.signal.aborted) throw e;
        }
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    print({ status: 'stopped' });
  });
app
  .command('setup <agent>')
  .description('Install memory tools, dialogue skill and optional lifecycle hooks')
  .option('--tools-only', 'Disable Co-memo lifecycle hooks; use tools/CLI for memory')
  .addOption(new Option('--opencode-api <version>', 'OpenCode plugin API').choices(['v1', 'v2']))
  .action((name: string, opts: { toolsOnly?: boolean; opencodeApi?: 'v1' | 'v2' }) => {
    const agent = Agent.parse(name);
    ensure(!opts.opencodeApi || agent === 'opencode', '--opencode-api requires setup opencode');
    print(
      using((store, path) => {
        const root = realpathSync(path);
        const edits = prepareSetup(root, agent, store.home, opts);
        const replica = store.transaction(() => store.connect(store.project(root, true), agent));
        applyAdapter(edits);
        const report = sync(store);
        reportExit(report);
        return {
          agent,
          mode: opts.toolsOnly ? 'tools-only' : 'hybrid',
          memoryFile: replica.path,
          files: edits.map((e) => e.path),
          transport: agent === 'pi' ? 'cli' : 'mcp-stdio',
          ...report,
          next: 'Restart/reload the host and review project/tool trust prompts. Verify memory_context and settings get.',
        };
      }),
    );
  });
app
  .command('serve')
  .option('--co-memo-managed', 'Marks generated MCP launch configurations')
  .description('Run a project-bound MCP server over stdio')
  .action(async () => {
    const opts = options();
    await serve(opts.home, opts.project);
  });
const settingsCommand = app.command('settings').description('Inspect or configure memory behavior');
settingsCommand
  .command('get')
  .action(() => print(using((store, root) => configuration(store, root))));
settingsCommand
  .command('set')
  .addOption(
    new Option('--scope <scope>', 'Where to save settings')
      .choices(['user', 'project'])
      .default('project'),
  )
  .addOption(
    new Option('--save-mode <mode>', 'auto or explicit-only capture').choices(['auto', 'explicit']),
  )
  .addOption(
    new Option('--default-scope <scope>', 'Default scope for new notes').choices([
      'user',
      'project',
    ]),
  )
  .addOption(new Option('--paused <boolean>', 'Pause shared memory').choices(['true', 'false']))
  .option('--reset', 'Clear overrides at this scope')
  .action(
    (opts: {
      scope: 'user' | 'project';
      saveMode?: 'auto' | 'explicit';
      defaultScope?: 'user' | 'project';
      paused?: string;
      reset?: boolean;
    }) => {
      const patch = {
        ...(opts.saveMode ? { saveMode: opts.saveMode } : {}),
        ...(opts.defaultScope ? { defaultScope: opts.defaultScope } : {}),
        ...(opts.paused ? { paused: opts.paused === 'true' } : {}),
      };
      ensure(
        opts.reset ? Object.keys(patch).length === 0 : Object.keys(patch).length > 0,
        'Provide settings to change, or --reset alone',
      );
      print(using((store, root) => configure(store, root, opts.scope, patch, opts.reset)));
    },
  );
try {
  await app.parseAsync();
} catch (e) {
  process.stderr.write(JSON.stringify({ error: errorMessage(e) }) + '\n');
  process.exitCode = 1;
}
