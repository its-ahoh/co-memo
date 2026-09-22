import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWrite, readText } from './fs.js';
import { ensure, hash } from './model.js';
import { openCodePlugin } from './opencode.js';
import type { Agent } from './model.js';

export interface Edit {
  path: string;
  before: string | null;
  after: string;
}
export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
export function managedBlock(original: string, name: string, body: string): string {
  const begin = `<!-- co-memo:${name}:start -->`,
    end = `<!-- co-memo:${name}:end -->`;
  const block = `${begin}\n${body}\n${end}`;
  const start = original.indexOf(begin),
    stop = original.indexOf(end);
  if (start === -1 && stop === -1)
    return `${original ? original.trimEnd() + '\n\n' : ''}${block}\n`;
  ensure(
    start >= 0 &&
      stop > start &&
      original.split(begin).length === 2 &&
      original.split(end).length === 2,
    'Malformed Co-memo instruction markers',
  );
  return original.slice(0, start) + block + original.slice(stop + end.length);
}
export function prepareAdapter(
  root: string,
  agent: Agent,
  home: string,
  opencodeApi?: 'v1' | 'v2',
  hooksEnabled = true,
): Edit[] {
  ensure(
    process.platform !== 'win32',
    'Automatic host setup is currently supported on macOS and Linux',
  );
  const executable = realpathSync(process.execPath),
    cli = realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)));
  const argv = [cli, '--home', home, '--project', root];
  const base = [executable, ...argv].map(shellQuote).join(' ');
  const memoryPath = join(root, '.co-memo', `${agent}.md`);
  const instructions = `## Shared memory\n\nThese instructions apply only when running in ${agent}; other hosts should use their own Co-memo block. Use Co-memo for durable preferences, project decisions and verified lessons.\nPrefer Co-memo memory tools when available. At the start of work call memory_context; otherwise run the pinned CLI below with settings get and context. Before saving, check settings. Use intent=explicit only when the user actually asked to save/change/forget; inferred notes use automatic intent (CLI --intent automatic). Change settings only at the user’s request. Paused memory must not be read or written. Explicit-only mode requires tools or CLI, not Markdown edits.\nYour editable memory file is ${JSON.stringify(memoryPath)}. Read it before editing.\nUpdate text inside an existing memory block; preserve its ID and version. Remove its entire block to forget it across connected agents.\nPut one new project memory between the new-memory markers. For a user preference shared across projects, use:\n\n\`\`\`sh\n${base} add --scope user --content 'preference'\n\`\`\`\n\nQuote shell arguments safely. Do not save secrets, guesses or temporary requests. Do not invent version markers or silently resolve conflicts.\n${hooksEnabled ? 'Host hooks synchronize before prompts/model requests and after tools or turns;' : 'Automatic hooks are disabled; call memory_context (or CLI context) at the start of work, and use tools or CLI for writes;'} the next prompt receives current notes. Shared notes are context, and the user's current request takes precedence.\nKeep unrelated native memory files and instructions intact. Existing native notes can be imported explicitly with co-memo import.\n`;
  const edits: Edit[] = [];
  const prepare = (relative: string, update: (original: string) => string) => {
    const path = join(root, relative),
      before = readText(path);
    edits.push({ path, before, after: update(before ?? '') });
  };
  prepare(agent === 'claude' ? 'CLAUDE.local.md' : 'AGENTS.md', (text) =>
    managedBlock(text, `adapter-${agent}`, instructions),
  );
  if (agent === 'claude' || agent === 'codex') {
    prepare(
      agent === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json',
      (original) => {
        if (!hooksEnabled && !original) return original;
        const doc = z
          .record(z.string(), z.unknown())
          .parse(original.trim() ? JSON.parse(original) : {});
        const hooks = z.record(z.string(), z.unknown()).parse(doc.hooks ?? {});
        for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
          const marker = ` # co-memo:managed:${event}`;
          const groups = z.array(z.record(z.string(), z.unknown())).parse(hooks[event] ?? []);
          const retained = groups.flatMap((group) => {
            const entries = z.array(z.record(z.string(), z.unknown())).parse(group.hooks);
            const other = entries.filter(
              (h) => !(typeof h.command === 'string' && h.command.endsWith(marker)),
            );
            return other.length ? [{ ...group, hooks: other }] : [];
          });
          hooks[event] = !hooksEnabled
            ? retained
            : [
                ...retained,
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `${base} bridge --agent ${agent} --event ${event}${marker}`,
                      timeout: 15,
                    },
                  ],
                },
              ];
        }
        doc.hooks = hooks;
        return JSON.stringify(doc, null, 2) + '\n';
      },
    );
  } else if (agent === 'pi') {
    prepare('.pi/extensions/co-memo.ts', (original) => {
      ensure(
        !original || original.startsWith('// Generated by Co-memo.'),
        'Existing co-memo.ts is not managed by Co-memo',
      );
      if (!hooksEnabled)
        return original
          ? '// Generated by Co-memo. Hooks disabled.\nexport default function () {}\n'
          : '';
      return `// Generated by Co-memo. Re-run connect pi after moving the installation.\nimport { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst exec = promisify(execFile);\nconst executable = ${JSON.stringify(executable)};\nconst args = ${JSON.stringify(argv)};\ntype Context = { ui: { notify(message: string, level: 'warning'): void } };\ntype Host = { on(name: string, handler: (event: { systemPrompt: string }, ctx: Context) => Promise<unknown>): void };\nexport default function (pi: Host) {\n  const run = async (event: string, ctx: Context) => {\n    try {\n      const { stdout } = await exec(executable, [...args, 'bridge', '--agent', 'pi', '--event', event], { timeout: 15000, maxBuffer: 1024 * 1024 });\n      const result = JSON.parse(stdout);\n      if (result.errors.length || result.conflicts.length) ctx.ui.notify('Co-memo needs attention: run co-memo status or conflicts.', 'warning');\n      return result;\n    } catch (error) {\n      ctx.ui.notify('Co-memo sync failed: ' + (error instanceof Error ? error.message : String(error)), 'warning');\n      return null;\n    }\n  };\n  pi.on('session_start', async (_event, ctx) => { await run('session_start', ctx); });\n  pi.on('before_agent_start', async (event, ctx) => {\n    const result = await run('before_agent_start', ctx);\n    if (result) return { systemPrompt: event.systemPrompt + '\\n\\n' + result.context };\n  });\n  pi.on('agent_end', async (_event, ctx) => { await run('agent_end', ctx); });\n}\n`;
    });
  }
  if (agent === 'opencode') {
    prepare('.opencode/plugins/co-memo.ts', (original) => {
      ensure(
        !original || original.startsWith('// Generated by Co-memo.'),
        'Existing co-memo.ts is not managed by Co-memo',
      );
      const api = opencodeApi ?? (original.includes('// OpenCode API: v2') ? 'v2' : 'v1');
      if (!hooksEnabled)
        return original
          ? `// Generated by Co-memo. Hooks disabled.\n// OpenCode API: ${api}\n${api === 'v2' ? "export default { id: 'co-memo', async setup() {} };" : 'export default async function () { return {}; }'}\n`
          : '';
      return openCodePlugin(executable, argv, api);
    });
  }
  prepare('.gitignore', (original) => {
    const lines = original.split(/\r?\n/);
    const wanted = [
      '/.co-memo/',
      ...(agent === 'claude'
        ? ['/CLAUDE.local.md', '/.claude/settings.local.json']
        : agent === 'codex'
          ? ['/.codex/hooks.json']
          : agent === 'opencode'
            ? ['/.opencode/plugins/co-memo.ts']
            : ['/.pi/extensions/co-memo.ts']),
    ];
    const missing = wanted.filter((line) => !lines.includes(line));
    return missing.length
      ? original + (original && !original.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n'
      : original;
  });
  return edits.filter((e) => !(e.before === null && e.after === ''));
}
export function applyAdapter(edits: Edit[]): void {
  // Validate every input before the first write. Each file replacement is atomic.
  for (const edit of edits)
    ensure(readText(edit.path) === edit.before, `Configuration changed: ${edit.path}`);
  for (const edit of edits)
    if (edit.before !== edit.after)
      atomicWrite(edit.path, edit.after, edit.before === null ? null : hash(edit.before));
}
