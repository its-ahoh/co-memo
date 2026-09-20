#!/usr/bin/env node
/** Local trusted-host CLI. Hook payloads can never change identity or scope. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Inbox } from './inbox';
import { watchFiles } from './watch';
import { Catalog } from './catalog';
import { MemoryActor, MemoryEngine } from './engine';
import { callMemoryTool } from './engine/tools';

const HELP = `Co-memo
  co-memo watch --db FILE [--interval 30000] [--once]
  co-memo source-add --db FILE --agent ID --file /absolute/MEMORY.md [--project ID]
  co-memo sources --db FILE
  co-memo catalog --db /absolute/memory.sqlite
  co-memo recall --db FILE --agent ID [--project ID] [--query TEXT] [--json]
  co-memo get --db FILE --agent ID --id MEMORY_ID
  co-memo propose --db FILE --agent ID --content TEXT --evidence TEXT
  co-memo hook-start --config /absolute/host.json < request.json
  co-memo hook-end --config /absolute/host.json < proposal.json

Scope flags: --project ID --stage ID --purpose ID
Hook config: {"db":"/absolute/memory.sqlite","agentId":"ID","projectId":"ID"}
Hook start stdin: {"query":"task description"}
Hook end stdin: {"content":"durable lesson","evidence":"supporting quote"}
Empty hook-end input or {} is a no-op. Proposals are always private candidates.
These are generic host hooks, not native Claude Code / Codex hook configuration.
`;
type Flags = Record<string, string | true>;
function parse(args: string[]): { command: string; flags: Flags } {
  const command = args[0] ?? 'help'; const flags: Flags = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--') || key in flags) throw new Error('Invalid or duplicate option: ' + key);
    if (key === '--json' || key === '--once') { flags[key] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing value: ' + key);
    flags[key] = value;
  }
  return { command, flags };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected field; identity and scope must be configured by the host');
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be a nonempty string');
  return value;
}
async function stdin(): Promise<Record<string, unknown>> {
  let input = ''; let bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk); if (bytes > 65536) throw new Error('Input exceeds 64 KiB'); input += chunk;
  }
  return object(JSON.parse(input.trim() || '{}'));
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parse(args);
  if (command === 'help' || command === '--help') { process.stdout.write(HELP); return; }
  if (!['catalog','recall','get','propose','hook-start','hook-end','watch','sources','source-add'].includes(command)) throw new Error('Unknown command; run co-memo help');
  const hook = command.startsWith('hook-');
  const scope = ['--db','--agent','--project','--stage','--purpose'];
  only(flags, command === 'watch' ? ['--db','--interval','--once'] : command === 'sources' ? ['--db'] : command === 'source-add' ? [...scope,'--file'] : hook ? ['--config'] : command === 'catalog' ? ['--db'] : [...scope, ...(command === 'recall' ? ['--query','--json'] : command === 'get' ? ['--id'] : ['--content','--evidence'])]);
  let filename: string; let actor: MemoryActor;
  if (hook) {
    const path = optionalString(flags['--config'], '--config'); if (!path) throw new Error('--config required');
    if (readFileSync(path).length > 65536) throw new Error('Config exceeds 64 KiB');
    const config = object(JSON.parse(readFileSync(path, 'utf8')));
    only(config, ['db','agentId','projectId','stageId','purposeId']);
    const db = optionalString(config.db, 'db'); const agentId = optionalString(config.agentId, 'agentId');
    if (!db || !agentId) throw new Error('Config requires db and agentId');
    filename = isAbsolute(db) ? db : resolve(dirname(resolve(path)), db);
    actor = { agentId, projectId: optionalString(config.projectId,'projectId'), stageId: optionalString(config.stageId,'stageId'), purposeId: optionalString(config.purposeId,'purposeId') };
  } else {
    const db = optionalString(flags['--db'],'--db'); if (!db) throw new Error('--db required'); filename = resolve(db);
    const agentId = optionalString(flags['--agent'],'--agent');
    if (!['catalog','watch','sources'].includes(command) && !agentId) throw new Error('--agent required');
    actor = { agentId: agentId ?? '', projectId: optionalString(flags['--project'],'--project'), stageId: optionalString(flags['--stage'],'--stage'), purposeId: optionalString(flags['--purpose'],'--purpose') };
  }
  // A typo must not silently create a second empty memory store.
  if (!existsSync(filename)) throw new Error('Database not found; initialize it in the dashboard first');
  const payload = hook ? await stdin() : undefined;
  if (payload) only(payload, command === 'hook-start' ? ['query'] : ['content','evidence']);
  const catalog = new Catalog(filename);
  try {
    const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
    if (command === 'catalog') { emit(catalog.list()); return; }
    if (!['watch','sources'].includes(command)) catalog.validateActor(actor);
    const memory = new MemoryEngine(filename);
    try {
      if (['watch','sources','source-add'].includes(command)) {
        const inbox = new Inbox(filename,memory,catalog);
        try {
          if (command === 'watch') await watchFiles(inbox, Number(flags['--interval'] ?? (flags['--once'] ? 250 : 30000)), !!flags['--once']);
          else if (command === 'sources') emit(inbox.sources());
          else { const file=optionalString(flags['--file'],'--file'); if(!file)throw new Error('--file required'); emit(inbox.add(file,actor)); }
        } finally { inbox.close(); }
      } else if (command === 'recall' || command === 'hook-start') {
        const query = payload ? payload.query : flags['--query'];
        if (query !== undefined && typeof query !== 'string') throw new Error('query must be a string');
        const result = memory.contextWithEntries(actor, String(query ?? ''));
        if (hook) emit({ context: result.text, memories: result.entries.map(m => ({ id: m.id, version: m.version })) });
        else if (flags['--json']) emit(result);
        else process.stdout.write(result.text ? result.text + '\n' : '');
      } else if (command === 'get') {
        emit(callMemoryTool(memory, actor, 'memory_get', { id: flags['--id'] }));
      } else {
        if (payload && !Object.keys(payload).length) { emit({ status: 'skipped', reason: 'No proposal supplied' }); return; }
        const proposal = callMemoryTool(memory, actor, 'memory_record', payload ?? { content: flags['--content'], evidence: flags['--evidence'] });
        emit(proposal);
      }
    } finally { memory.close(); }
  } finally { catalog.close(); }
}
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed' }) + '\n');
  process.exitCode = 1;
});
