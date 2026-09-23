import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { prepareSetup } from './setup.js';
import { applyAdapter } from './adapters.js';
import { sync } from './sync.js';
import { ensure } from './model.js';
import { executable } from './onboarding.js';

export type VerificationHost = 'codex' | 'claude';
type Call = { name: string; input: Record<string, unknown>; result: unknown; failed: boolean };
function payload(content: unknown): unknown {
  try {
    if (typeof content === 'string') return JSON.parse(content);
    if (Array.isArray(content))
      return JSON.parse(
        content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text)
          .join(''),
      );
  } catch {
    /* Missing/malformed tool outputs cannot establish success. */
  }
  return null;
}
/** Parse only observed tool calls and final replies, never model claims of tool execution. */
export function evidence(host: VerificationHost, stdout: string) {
  const calls: Call[] = [],
    pending = new Map<string, Call>();
  let final = '',
    unexpected = false,
    completed = false;
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (host === 'codex') {
      if (event.type === 'turn.completed') completed = true;
      if (event.type !== 'item.completed') continue;
      const item = event.item;
      if (item?.type === 'mcp_tool_call') {
        if (item.server !== 'co-memo') unexpected = true;
        calls.push({
          name: item.tool,
          input: item.arguments ?? {},
          result: payload(item.result?.content),
          failed: item.status !== 'completed' || !!item.error || !!item.result?.isError,
        });
      } else if (item?.type === 'agent_message') final = item.text ?? '';
      else if (!['reasoning', 'plan'].includes(item?.type)) unexpected = true;
    } else {
      if (event.type === 'result') {
        final = event.result ?? '';
        completed = event.is_error === false;
      }
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') {
          if (!block.name.startsWith('mcp__co-memo__')) unexpected = true;
          const call = {
            name: block.name.replace('mcp__co-memo__', ''),
            input: block.input ?? {},
            result: null,
            failed: true,
          };
          pending.set(block.id, call);
          calls.push(call);
        } else if (block.type === 'tool_result') {
          const call = pending.get(block.tool_use_id);
          if (call) {
            call.result = payload(block.content);
            call.failed = !!block.is_error || call.result === null;
          }
        }
      }
    }
  }
  return { calls, final, unexpected, completed };
}
function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; code: number | null; failure: string | null }> {
  return new Promise((resolve) => {
    const env = { ...process.env, CO_MEMO_SEMANTIC: '0' };
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '',
      bytes = 0,
      failure: string | null = null;
    const stop = (reason: string) => {
      failure ??= reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(() => stop('host_timeout'), 120_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) stop('output_limit');
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) stop('output_limit');
    });
    child.on('error', () => {
      failure = 'host_launch_failed';
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code, failure });
    });
  });
}
function argumentsFor(
  host: VerificationHost,
  cli: string,
  home: string,
  project: string,
  prompt: string,
  write: boolean,
) {
  const tools = [
    'memory_context',
    'memory_recall',
    'memory_settings_get',
    ...(write ? ['memory_remember', 'memory_checkpoint'] : []),
  ];
  if (host === 'claude')
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config',
      join(project, '.mcp.json'),
      '--tools',
      '',
      '--allowedTools',
      tools.map((t) => `mcp__co-memo__${t}`).join(','),
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
      '--settings',
      '{"disableAllHooks":true}',
      '--max-budget-usd',
      '1',
      prompt,
    ];
  const overrides: Record<string, unknown> = {
    'mcp_servers.co-memo.command': realpathSync(process.execPath),
    'mcp_servers.co-memo.args': [
      cli,
      '--home',
      home,
      '--project',
      project,
      'serve',
      '--co-memo-managed',
    ],
    'mcp_servers.co-memo.required': true,
    'mcp_servers.co-memo.enabled_tools': tools,
    'mcp_servers.co-memo.env.CO_MEMO_SEMANTIC': '0',
  };
  for (const tool of tools)
    overrides[`mcp_servers.co-memo.tools.${tool}.approval_mode`] = 'approve';
  return [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    project,
    ...Object.entries(overrides).flatMap(([key, value]) => [
      '-c',
      `${key}=${JSON.stringify(value)}`,
    ]),
    prompt,
  ];
}
export async function verifyRoundTrip(
  input: { from: VerificationHost; to: VerificationHost; roundTrip?: boolean; keep?: boolean },
  progress: (message: string) => void = () => {},
) {
  ensure(input.from !== input.to, 'Select two different agents');
  const commands = { codex: executable('codex'), claude: executable('claude') };
  ensure(
    commands[input.from] && commands[input.to],
    'Both selected agent CLIs must be installed and on PATH',
  );
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-verify-'))),
    project = join(root, 'project'),
    home = join(root, 'data');
  mkdirSync(project);
  const cli = realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)));
  const store = new Store(home);
  const steps: {
    direction: string;
    status: string;
    reason: string;
    calls: string[];
    elapsedMs: number;
  }[] = [];
  try {
    const projectId = store.lock(() => {
      const p = store.project(project, true);
      for (const agent of [input.from, input.to]) {
        applyAdapter(prepareSetup(project, agent, home, { toolsOnly: true }));
        store.connect(p, agent);
      }
      sync(store);
      return p.id;
    });
    const directions = [
      [input.from, input.to],
      ...(input.roundTrip ? [[input.to, input.from]] : []),
    ] as [VerificationHost, VerificationHost][];
    for (const [writer, reader] of directions) {
      const label = `Shared integration fixture ${randomUUID()}`,
        token = randomBytes(12).toString('hex');
      const content = `${label}: ${token}`;
      const writePrompt = `Disposable Co-memo integration test. Use only Co-memo MCP tools; no shell or file operations. Explicitly save this project fact verbatim with memory_remember: ${content}\nUse intent=explicit, scope=project. Source identifiers are unknown; never invent them. Verify its returned id/version/deleted receipt using memory_checkpoint. Report any failure honestly.`;
      progress(`${writer}: saving and verifying a synthetic memory`);
      const start = performance.now();
      const saved = await run(
        commands[writer]!,
        argumentsFor(writer, cli, home, project, writePrompt, true),
        project,
      );
      const written = evidence(writer, saved.stdout);
      const note = store.lock(() => store.list(projectId).find((m) => m.content === content));
      const remember = written.calls.find(
        (c) =>
          c.name === 'memory_remember' &&
          !c.failed &&
          c.input.content === content &&
          c.input.intent === 'explicit',
      );
      const checkpoint = written.calls.find(
        (c) =>
          c.name === 'memory_checkpoint' &&
          !c.failed &&
          (c.result as { verified?: boolean })?.verified === true &&
          Array.isArray(c.input.receipts) &&
          c.input.receipts.some(
            (r) => r.id === note?.id && r.version === note?.version && r.deleted === false,
          ),
      );
      if (
        saved.code !== 0 ||
        saved.failure ||
        !written.completed ||
        written.unexpected ||
        !note ||
        note.scope !== 'project' ||
        note.projectId !== projectId ||
        !remember ||
        !checkpoint
      ) {
        steps.push({
          direction: `${writer}→${reader}`,
          status: 'failed',
          reason: saved.failure ?? 'writer_did_not_complete_verified_save',
          calls: written.calls.map((c) => c.name),
          elapsedMs: performance.now() - start,
        });
        break;
      }
      progress(
        `${reader}: starting a fresh session and reading the marker without its value in the prompt`,
      );
      const before = store.lock(() => JSON.stringify(store.list(projectId, true)));
      const prompt = `Fresh-session Co-memo integration test. Use only memory_context or memory_recall to retrieve the value for "${label}" saved by another agent. The value is deliberately omitted from this prompt. Return that exact value, do not guess. Do not save, change or delete anything. Do not use shell or file tools.`;
      const fetched = await run(
        commands[reader]!,
        argumentsFor(reader, cli, home, project, prompt, false),
        project,
      );
      const read = evidence(reader, fetched.stdout);
      const observed = read.calls.some(
        (c) =>
          ['memory_context', 'memory_recall'].includes(c.name) &&
          !c.failed &&
          JSON.stringify(c.result).includes(note.id) &&
          JSON.stringify(c.result).includes(token),
      );
      const unchanged = store.lock(() => before === JSON.stringify(store.list(projectId, true)));
      const passed =
        fetched.code === 0 &&
        !fetched.failure &&
        read.completed &&
        !read.unexpected &&
        read.calls.every((c) =>
          ['memory_context', 'memory_recall', 'memory_settings_get'].includes(c.name),
        ) &&
        observed &&
        read.final.includes(token) &&
        unchanged;
      steps.push({
        direction: `${writer}→${reader}`,
        status: passed ? 'passed' : 'failed',
        reason: passed
          ? 'verified_save_and_fresh_host_recall'
          : (fetched.failure ?? 'reader_did_not_prove_recall_or_changed_store'),
        calls: read.calls.map((c) => c.name),
        elapsedMs: performance.now() - start,
      });
      if (!passed) break;
    }
    const report = {
      status:
        steps.length === directions.length && steps.every((s) => s.status === 'passed')
          ? 'passed'
          : 'failed',
      steps,
      embeddings: 'disabled',
      hooks: 'not_tested',
      automaticExtraction: 'not_tested',
      artifacts: input.keep ? root : null,
      note: 'Explicitly prompted synthetic save/recall using real host models and existing login. Does not establish autonomous capture or general extraction quality.',
    };
    if (input.keep)
      writeFileSync(join(root, 'verification.json'), JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
    return report;
  } finally {
    store.close();
    if (!input.keep) rmSync(root, { recursive: true, force: true });
  }
}
