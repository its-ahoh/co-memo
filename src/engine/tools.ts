import { randomUUID } from 'node:crypto';
import { MemoryActor, MemoryEngine } from './index';

export const MEMORY_TOOLS = [
  { name: 'memory_search', description: 'Search relevant, active memories within this agent and project. Returns a compact index; fetch details with memory_get.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'memory_get', description: 'Read one active memory and its evidence. Access is restricted by the server-bound agent and project.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'memory_record', description: 'Propose a private lesson from this execution. It remains a candidate until reviewed. Cannot write shared memory.',
    inputSchema: { type: 'object', properties: { content: { type: 'string' }, evidence: { type: 'string' } }, required: ['content', 'evidence'], additionalProperties: false } },
];

/** Identity comes from the host, never from model-supplied tool arguments. */
export function callMemoryTool(engine: MemoryEngine, actor: MemoryActor, name: string, args: Record<string, unknown>): unknown {
  const allowed = name === 'memory_search' ? ['query'] : name === 'memory_get' ? ['id'] : name === 'memory_record' ? ['content', 'evidence'] : [];
  if (!allowed.length) throw new Error('Unknown memory tool');
  if (Object.keys(args).some(k => !allowed.includes(k))) throw new Error('Unexpected argument; memory identity and scope are fixed by the host');
  for (const key of allowed) if (typeof args[key] !== 'string' || !(args[key] as string).trim()) throw new Error(`${key} is required`);
  if (name === 'memory_search') return engine.recall(actor, String(args.query)).map(m => ({ id: m.id, kind: m.kind, summary: m.content.slice(0, 180), version: m.version }));
  if (name === 'memory_get') {
    const memory = engine.get(actor, String(args.id));
    if (!memory) throw new Error('Memory not found');
    return memory;
  }
  return engine.recordPrivate(actor, { kind: 'lesson', content: String(args.content), state: 'candidate',
    evidence: { eventId: `agent:${randomUUID()}`, source: 'assistant', excerpt: String(args.evidence).slice(0, 1800) } });
}
