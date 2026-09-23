import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { Agent, ensure, errorMessage } from './model.js';
import { prepareSetup } from './setup.js';
import { applyAdapter } from './adapters.js';
import { Store, dataHome } from './store.js';
import { sync } from './sync.js';
import { doctor } from './doctor.js';
import { readText } from './fs.js';
import { repository } from './worktrees.js';

export function executable(name: string, searchPath = process.env.PATH ?? ''): string | null {
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const path = resolve(directory, name + suffix);
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return realpathSync(path);
      } catch {
        /* Missing or inaccessible executable. */
      }
    }
  }
  return null;
}
export function detectAgents(root: string, searchPath = process.env.PATH ?? '') {
  return Agent.options.map((agent) => ({
    agent,
    executable: executable(agent, searchPath),
    projectConfigured: existsSync(
      join(root, { pi: '.pi', claude: '.claude', codex: '.codex', opencode: '.opencode' }[agent]),
    ),
  }));
}
function canonicalDestination(path: string): string {
  let parent = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(parent)) {
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  return join(realpathSync(parent), ...suffix);
}
export interface InitOptions {
  home?: string | undefined;
  root: string;
  agents: Agent[];
  toolsOnly: boolean;
  opencodeApi?: 'v1' | 'v2' | undefined;
}
export function planSetup(input: InitOptions) {
  ensure(input.agents.length > 0, 'Choose at least one agent with --agents');
  ensure(new Set(input.agents).size === input.agents.length, 'Duplicate agent selection');
  const root = realpathSync(input.root),
    home = canonicalDestination(input.home ?? dataHome());
  let git = null;
  try {
    git = repository(root);
  } catch {
    /* Non-Git projects remain supported. */
  }
  const options = {
    toolsOnly: input.toolsOnly,
    ...(input.opencodeApi ? { opencodeApi: input.opencodeApi } : {}),
  };
  return {
    root,
    home,
    mode: input.toolsOnly ? 'tools-only' : 'hybrid',
    repository: git,
    detected: detectAgents(root),
    agents: input.agents.map((agent) => ({
      agent,
      edits: prepareSetup(root, agent, home, options),
    })),
  };
}
export function describePlan(plan: ReturnType<typeof planSetup>) {
  return {
    root: plan.root,
    home: plan.home,
    mode: plan.mode,
    detected: plan.detected,
    repository: plan.repository,
    sharing: 'Worktrees remain isolated unless explicitly linked with worktree link.',
    agents: plan.agents.map(({ agent, edits }) => ({
      agent,
      changes: edits.map((e) => ({
        path: e.path,
        action: e.before === e.after ? 'unchanged' : e.before === null ? 'create' : 'update',
      })),
    })),
  };
}
/** All agents are preflighted before mutations; failures are reported, never called a complete setup. */
export async function applySetup(input: InitOptions, plan = planSetup(input)) {
  const store = new Store(plan.home);
  const results: { agent: Agent; status: string; error?: string; files?: string[] }[] = [];
  try {
    store.lock(() => {
      for (const { edits } of plan.agents)
        for (const edit of edits)
          ensure(
            readText(edit.path) === edit.before,
            'Configuration changed since preview; run init again',
          );
      for (const { agent } of plan.agents) {
        try {
          const edits = prepareSetup(plan.root, agent, store.home, {
            toolsOnly: input.toolsOnly,
            ...(input.opencodeApi ? { opencodeApi: input.opencodeApi } : {}),
          });
          store.transaction(() => store.connect(store.project(plan.root, true), agent));
          applyAdapter(edits);
          results.push({ agent, status: 'configured', files: edits.map((e) => e.path) });
        } catch (e) {
          results.push({ agent, status: 'failed', error: errorMessage(e) });
          break;
        }
      }
    });
    const report = store.lock(() => sync(store));
    const checks = [];
    for (const result of results)
      if (result.status === 'configured')
        checks.push({
          agent: result.agent,
          ...(await doctor({
            home: store.home,
            root: plan.root,
            agent: result.agent,
            probe: result.agent !== 'pi',
          })),
        });
    return {
      status:
        results.length === input.agents.length &&
        results.every((r) => r.status === 'configured') &&
        !report.errors.length &&
        !report.conflicts.length &&
        checks.every((c) => c.status !== 'needs_attention')
          ? 'configured'
          : 'needs_attention',
      results,
      sync: report,
      checks,
      hostVerified: false,
      next: 'Restart the selected agents and review host trust/tool approvals. Protocol probes do not establish model behavior.',
    };
  } finally {
    store.close();
  }
}
