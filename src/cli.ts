#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { Review } from './review.js';
import { createInterface } from 'node:readline/promises';
import { detectAgents, planSetup, describePlan, applySetup } from './onboarding.js';
import { repository } from './worktrees.js';
import { verifyRoundTrip } from './verification.js';
import { indexEmbeddings } from './semantic.js';
import { retrieve, projectId, requireProjectId } from './service.js';
import { doctor } from './doctor.js';
import { projects } from './projects.js';
import { createBackup, verifyBackup, restoreBackup } from './backup.js';
import { planDisconnect, describeDisconnect, applyDisconnect } from './disconnect.js';
import { Submission, submit, submitBatch, Preparation, prepare } from './candidates.js';
import {
  configuration,
  configure,
  remember,
  change,
  remove,
  restore,
  resolveConflict,
  scopedReport,
  checkpoint,
} from './service.js';
import { allowWrite } from './settings.js';
import type { Intent } from './settings.js';
import { prepareSetup } from './setup.js';
import { serve } from './mcp.js';
import { locationReader } from './locations.js';
import { startUI } from './ui.js';
import { openBrowser } from './open-browser.js';
import { Command, Option } from 'commander';
import { realpathSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { sync, context, inspectSync } from './sync.js';
import { prepareAdapter, applyAdapter } from './adapters.js';
import { readText } from './fs.js';
import { Agent, WriterAgent, Scope, Content, ensure, errorMessage } from './model.js';
import type { SyncReport, Memory } from './model.js';

type ReviewOptions = { reviewToken?: string; reviewReason?: string };
function reviewOptions(command: Command) {
  return command
    .option('--review-token <token>', 'Latest returned review token')
    .option('--review-reason <text>', 'Why these are distinct memories');
}
function reviewInput(opts: ReviewOptions) {
  if (opts.reviewToken === undefined && opts.reviewReason === undefined) return {};
  return { review: Review.parse({ token: opts.reviewToken, reason: opts.reviewReason }) };
}

const app = new Command()
  .name('co-memo')
  .version('0.7.0')
  .enablePositionalOptions()
  .description('One local memory store for your coding agents')
  .option('--home <directory>', 'Local data directory (or CO_MEMO_HOME)')
  .option(
    '--agent-id <id>',
    'Configured writing agent (for example codex or cursor); not an authentication credential',
  )
  .option(
    '--project <directory>',
    'Agent workspace (otherwise detected from the working directory)',
    process.cwd(),
  );
const print = (value: unknown) => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
};
const positive = (s: string) => z.number().int().positive().safe().parse(Number(s));
function options(): { home?: string | undefined; project: string; agentId?: string | undefined } {
  return z
    .object({ home: z.string().optional(), project: z.string(), agentId: WriterAgent.optional() })
    .parse(app.opts());
}
function prepareMemoryProject(store: Store, root: string, locked = false): void {
  const command = app.args[0];
  if (
    app.getOptionValueSource('project') === 'cli' &&
    [
      'add',
      'list',
      'show',
      'history',
      'edit',
      'forget',
      'archive',
      'delete',
      'unarchive',
      'import',
      'index',
      'context',
      'submit',
      'prepare',
      'checkpoint',
      'settings',
      'status',
      'conflicts',
      'resolve',
      'sync',
      'watch',
      'locations',
    ].includes(command ?? '')
  )
    if (locked) store.autoProject(root, true);
    else store.ensureProject(root, true);
}
function using<T>(fn: (store: Store, root: string) => T): T {
  const opts = options(),
    store = new Store(opts.home, opts.agentId);
  try {
    const reading =
      [
        'show',
        'history',
        'locations',
        'status',
        'conflicts',
        'prepare',
        'checkpoint',
        'bridge',
      ].includes(app.args[0] ?? '') ||
      (app.args[0] === 'settings' && app.args[1] === 'get');
    if (reading) {
      prepareMemoryProject(store, opts.project);
      store.ensureProject(opts.project);
      return store.read(() => fn(store, opts.project));
    }
    return store.lock(() => {
      // Already serialized; use the registration path without reacquiring the lock.
      prepareMemoryProject(store, opts.project, true);
      return fn(store, opts.project);
    });
  } finally {
    store.close();
  }
}
async function usingAsync<T>(fn: (store: Store, root: string) => Promise<T>): Promise<T> {
  const opts = options(),
    store = new Store(opts.home, opts.agentId);
  try {
    prepareMemoryProject(store, opts.project);
    return await fn(store, opts.project);
  } finally {
    store.close();
  }
}
app
  .command('projects')
  .description('List registered projects/worktrees without synchronizing or creating a store')
  .option('--check', 'Run read-only diagnostics for each registered root')
  .option('--probe', 'Also probe configured MCP servers; never runs host models')
  .action(async (opts: { check?: boolean; probe?: boolean }) => {
    const report = await projects(options().home, opts.check, opts.probe);
    print(report);
    if (
      report.projects.some(
        (p) => (p.diagnostics as { status?: string } | undefined)?.status === 'needs_attention',
      )
    )
      process.exitCode = 2;
  });
app
  .command('backup <directory>')
  .description('Create a verified snapshot of the entire central store in a new directory')
  .action(async (directory: string) => print(await createBackup(directory, options().home)));
app
  .command('backup-check <directory>')
  .description('Verify backup checksum, schema, integrity and row counts without restoring')
  .action(async (directory: string) => print(await verifyBackup(directory)));
app
  .command('restore <directory>')
  .description('Preview or restore a backup into a new data home; detach agent connections')
  .requiredOption('--to <directory>', 'New, non-existing memory home')
  .option('--apply', 'Perform the restore; otherwise validate and preview only')
  .action(async (directory: string, opts: { to: string; apply?: boolean }) =>
    print(await restoreBackup(directory, opts.to, opts.apply)),
  );
app
  .command('disconnect <agent>')
  .description(
    'Preview removal of managed integration; keep central memories and archive local files',
  )
  .option('--apply', 'Apply the previewed removal for this project and agent')
  .action((name: string, opts: { apply?: boolean }) => {
    const plan = planDisconnect(options().project, Agent.parse(name));
    if (!opts.apply) print(describeDisconnect(plan));
    else print(using((store) => applyDisconnect(store, plan)));
  });
app
  .command('index')
  .description(
    'Explicitly send eligible user/project memories to the configured embedding provider',
  )
  .option('--limit <count>', 'Maximum notes to index (1..1000)', positive, 100)
  .action(async (opts: { limit: number }) => {
    const result = await usingAsync(async (store, root) => {
      const id = store.lock(() => {
        sync(store);
        return projectId(store, root);
      });
      return indexEmbeddings(store, id, opts.limit);
    });
    print(result);
    if (result.failed) process.exitCode = 2;
  });
function reportExit(report: SyncReport): void {
  if (report.errors.length || report.conflicts.length) process.exitCode = 2;
}
function checkScope(store: Store, id: string, root: string): Memory {
  const memory = store.get(id);
  ensure(
    memory.scope === 'user' || projectId(store, root) === memory.projectId,
    'Memory belongs to another project',
  );
  return memory;
}
const scoped = (command: Command) =>
  command.addOption(new Option('--scope <scope>', 'Memory scope').choices(['project', 'user']));
app
  .command('init')
  .description('Discover agents, preview setup, then optionally configure and probe them')
  .option('--agents <names>', 'Comma-separated agents: codex,claude,opencode,pi')
  .option('--apply', 'Apply the displayed setup plan; otherwise noninteractive runs only preview')
  .option('--hooks', 'Include lifecycle hooks (default: tools-only)')
  .addOption(new Option('--opencode-api <version>', 'OpenCode plugin API').choices(['v1', 'v2']))
  .action(
    async (opts: {
      agents?: string;
      apply?: boolean;
      hooks?: boolean;
      opencodeApi?: 'v1' | 'v2';
    }) => {
      const global = options(),
        detected = detectAgents(global.project);
      let selected = opts.agents;
      const interactive = process.stdin.isTTY && process.stdout.isTTY;
      const terminal = interactive
        ? createInterface({ input: process.stdin, output: process.stdout })
        : null;
      try {
        if (!selected && terminal) {
          print({ detected });
          selected = await terminal.question('Agents to connect (comma-separated): ');
        }
        const agents = selected
          ? selected.split(',').map((a) => Agent.parse(a.trim()))
          : detected.filter((a) => a.executable).map((a) => a.agent);
        if (!agents.length) {
          print({ detected, next: 'No agents found. Pass --agents to select explicitly.' });
          return;
        }
        const input = {
          ...global,
          root: global.project,
          agents,
          toolsOnly: !opts.hooks,
          opencodeApi: opts.opencodeApi,
        };
        const plan = planSetup(input);
        if (terminal) print(describePlan(plan));
        const apply =
          opts.apply ||
          (terminal &&
            (await terminal.question('Apply this plan? [y/N] ')).trim().toLowerCase() === 'y');
        if (!apply) {
          if (!terminal)
            print({
              applied: false,
              plan: describePlan(plan),
              next: 'Rerun with --apply to configure these agents.',
            });
          return;
        }
        const result = await applySetup(input, plan);
        print({ plan: describePlan(plan), ...result });
        if (result.status !== 'configured') process.exitCode = 2;
      } finally {
        terminal?.close();
      }
    },
  );
app
  .command('verify')
  .description('Run real host models against temporary synthetic memory; uses existing login/quota')
  .addOption(
    new Option('--from <agent>', 'Writer host').choices(['codex', 'claude']).default('codex'),
  )
  .addOption(
    new Option('--to <agent>', 'Reader host').choices(['codex', 'claude']).default('claude'),
  )
  .option('--round-trip', 'Also verify the reverse direction')
  .option('--keep', 'Retain synthetic store, generated configs and verification report')
  .action(
    async (opts: {
      from: 'codex' | 'claude';
      to: 'codex' | 'claude';
      roundTrip?: boolean;
      keep?: boolean;
    }) => {
      const result = await verifyRoundTrip(opts, (message) => process.stderr.write(message + '\n'));
      print(result);
      if (result.status !== 'passed') process.exitCode = 2;
    },
  );
const worktreeCommand = app
  .command('worktree')
  .description('Explicitly share repository memories across Git worktrees');
worktreeCommand.command('inspect').action(() =>
  print({
    ...repository(options().project),
    policy:
      'Independent until explicitly linked. Linking shares all project memories and settings.',
  }),
);
worktreeCommand
  .command('link')
  .requiredOption('--to <directory>', 'An already connected worktree of the same repository')
  .action((opts: { to: string }) =>
    print(
      using((store, root) => {
        const project = store.transaction(() => store.linkWorktree(root, opts.to));
        return {
          project,
          repository: store.projectById(project.id).root,
          shared: 'All project memories, settings and conflicts',
          next: 'Run init or setup in this worktree to connect its agents.',
        };
      }),
    ),
  );
app
  .command('doctor [agent]')
  .description('Inspect store/configuration without syncing; optionally probe the local MCP server')
  .option(
    '--probe',
    'Initialize this installation’s MCP and read settings; no model or memory writes',
  )
  .action(async (name: string | undefined, opts: { probe?: boolean }) => {
    const config = options();
    const result = await doctor({
      home: config.home,
      root: config.project,
      agent: name ? Agent.parse(name) : undefined,
      probe: opts.probe,
    });
    print(result);
    if (result.status === 'needs_attention') process.exitCode = 2;
  });
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
        const connection = store.transaction(() => store.connect(store.project(root, true), agent));
        applyAdapter(edits);
        const report = scopedReport(store, root, sync(store));
        reportExit(report);
        return {
          agent,
          storage: 'database',
          connection,
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
reviewOptions(
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
  ),
).action((opts: { content: string; scope?: 'project' | 'user'; intent: Intent } & ReviewOptions) =>
  print(
    using((store, root) => {
      const result = remember(store, root, { ...opts, ...reviewInput(opts) }, 'user');
      if (result.results.some((r) => !r.verified && r.status !== 'skipped')) process.exitCode = 2;
      reportExit(result.sync);
      return result;
    }),
  ),
);
app
  .command('list')
  .description('List personal notes and the automatically detected project’s notes')
  .option('--deleted', 'Include archived memories (legacy option name)')
  .option('--query <text>', 'Full-text search with optional cached semantic ranking')
  .option('--explain', 'Include retrieval mode and fallback reason')
  .action(async (opts: { deleted?: boolean; query?: string; explain?: boolean }) => {
    const result = await usingAsync(async (store, root) => {
      // Human CLI inspection remains available while paused, without provider requests.
      const inspection = store.read(() => {
        if (!configuration(store, root).effective.paused) return null;
        return {
          memories: store.search(projectId(store, root), opts.query, opts.deleted),
          retrieval: { mode: 'lexical', reason: 'paused' },
          sync: inspectSync(store),
        };
      });
      return inspection ?? (await retrieve(store, root, opts.query, opts.deleted));
    });
    reportExit(result.sync);
    print(
      opts.explain ? { memories: result.memories, retrieval: result.retrieval } : result.memories,
    );
  });
app
  .command('show <id>')
  .description('Read a full memory')
  .action((id: string) => print(using((store, root) => checkScope(store, id, root))));
app
  .command('locations <id>')
  .description('Inspect the database location and connected agents')
  .action((id: string) =>
    print(using((store, root) => locationReader(store)(checkScope(store, id, root)))),
  );
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
  .command('archive <id>')
  .alias('forget')
  .description('Archive a memory, retaining content and history (forget is a compatibility alias)')
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
for (const action of ['delete', 'unarchive'] as const)
  app
    .command(`${action} <id>`)
    .description(
      action === 'delete'
        ? 'Permanently delete a memory and its revision history'
        : 'Restore an archived memory',
    )
    .requiredOption('--version <number>', 'Expected version', positive)
    .action((id: string, opts: { version: number }) =>
      print(
        using((store, root) => {
          const result =
            action === 'delete'
              ? remove(store, root, { id, ...opts })
              : restore(store, root, { id, ...opts }, 'user');
          reportExit(result.sync);
          return result;
        }),
      ),
    );
reviewOptions(
  scoped(
    app
      .command('import <path>')
      .description(
        'Import a Markdown file, or a directory of Markdown files, without changing originals',
      ),
  ),
).action((path: string, opts: { scope?: string } & ReviewOptions) =>
  print(
    using((store, root) => {
      const config = configuration(store, root);
      const scope = Scope.parse(opts.scope ?? config.effective.defaultScope);
      ensure(!config.effective.paused, 'Co-memo is paused');
      allowWrite(store, scope === 'project' ? requireProjectId(store, root) : null, 'explicit');
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
      const result = submitBatch(
        store,
        root,
        {
          requestId: randomUUID(),
          intent: 'explicit',
          candidates: notes.map((n) => ({
            action: 'add',
            content: n.content,
            scope,
            kind: 'note',
          })),
          ...reviewInput(opts),
        },
        notes.map((n) => `import:${n.file}`),
      );
      reportExit(result.sync);
      if (result.results.some((r) => !r.verified && r.status !== 'skipped')) process.exitCode = 2;
      if ('status' in result) {
        process.exitCode = 2;
        return result;
      }
      return {
        ...result,
        notes: result.results.map((r) => ({
          memory: store.get(r.receipt!.id),
          created: r.status === 'created',
          verified: r.verified,
        })),
      };
    }),
  ),
);
app
  .command('sync')
  .description('Check database maintenance and conflicts')
  .action(() => {
    const report = using((store, root) => scopedReport(store, root, sync(store)));
    print(report);
    reportExit(report);
  });
app
  .command('conflicts')
  .description('Inspect competing versions; nothing is discarded')
  .action(() =>
    print(using((store, root) => scopedReport(store, root, inspectSync(store)).conflicts)),
  );
app
  .command('resolve <id>')
  .requiredOption('--revision <number>', 'Expected conflict revision from conflicts', positive)
  .description('Resolve a conflict explicitly; proposal IDs appear in conflicts')
  .option('--take <choice>', 'current or a proposal/candidate ID')
  .option('--content <text>', 'Custom merged text')
  .action((id: string, opts: { revision: number; take?: string; content?: string }) => {
    ensure(
      (opts.take !== undefined) !== (opts.content !== undefined),
      'Specify exactly one of --take or --content',
    );
    print(
      using((store, root) => {
        const result = resolveConflict(store, root, { id, ...opts });
        reportExit(result.sync);
        return result;
      }),
    );
  });
app
  .command('status')
  .description('Check storage, connected agents and conflicts')
  .action(() =>
    print(
      using((store, root) => {
        const project = store.autoProject(root);
        return {
          home: store.home,
          project,
          agents: store
            .connections()
            .filter((r) => r.projectId === project?.id)
            .map((r) => ({
              agent: r.agent,
              root: r.root,
            })),
          memories: store.list(project?.id ?? null).length,
          conflicts: scopedReport(store, root, inspectSync(store)).conflicts,
          runtime: process.version,
          sharedRepository: project ? store.projectById(project.id).root : null,
          linkedWorktrees: project ? store.worktrees(project.id) : [],
          settings: configuration(store, root),
        };
      }),
    ),
  );
app
  .command('context')
  .description('Print bounded context for this project')
  .option('--query <text>', 'Current task for optional hybrid ranking')
  .action(async (opts: { query?: string }) => {
    const result = await usingAsync((store, root) => retrieve(store, root, opts.query));
    reportExit(result.sync);
    process.stdout.write(result.context);
  });
app
  .command('prepare')
  .description('Review related memories before submitting candidates; no notes are saved')
  .requiredOption('--file <path>', 'UTF-8 JSON with intent and candidates')
  .action((opts: { file: string }) => {
    const input = readText(opts.file);
    ensure(input !== null, 'Preparation file is missing');
    const args = Preparation.parse(JSON.parse(input));
    print(using((store, root) => prepare(store, root, args)));
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
        store
          .connections()
          .some((r) => r.projectId === project.id && r.agent === agent && r.root === project.root),
        'Agent is not connected',
      );
      const report = scopedReport(store, root, inspectSync(store));
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
        const report = using((store, root) => scopedReport(store, root, sync(store)));
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
        const connection = store.transaction(() => store.connect(store.project(root, true), agent));
        applyAdapter(edits);
        const report = scopedReport(store, root, sync(store));
        reportExit(report);
        return {
          agent,
          mode: opts.toolsOnly ? 'tools-only' : 'hybrid',
          storage: 'database',
          connection,
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
  .description('Run an MCP server over stdio with automatic workspace detection')
  .action(async () => {
    const opts = options();
    await serve(
      opts.home,
      opts.project,
      app.getOptionValueSource('project') === 'cli',
      opts.agentId,
    );
  });
app
  .command('ui')
  .description('Open a local memory manager for browsing, adding, editing and deleting notes')
  .option('--port <number>', 'Loopback HTTP port (0 chooses an available port)', '4318')
  .option('--no-open', 'Start the server without opening a browser')
  .action(async (opts: { port: string; open: boolean }) => {
    const port = z.number().int().min(0).max(65535).parse(Number(opts.port));
    const { server, url } = await startUI(options().home, options().project, port);
    process.stdout.write(`Co-memo memory manager: ${url}\nPress Ctrl+C to stop.\n`);
    const stop = () => server.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (opts.open) {
      try {
        await openBrowser(url);
      } catch {
        process.stderr.write(`Could not open a browser automatically. Open ${url} manually.\n`);
      }
    }
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
