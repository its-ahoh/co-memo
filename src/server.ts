import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MemoryEngine, MemoryDraft, DurableMemory, MemoryActor, memoryReviewDue, memoryNeedsReview } from './engine';
import { startFileWatcher } from './watch';
import { Inbox } from './inbox';
import { callMemoryTool } from './engine/tools';
import { Catalog, CatalogKind, catalogKinds } from './catalog';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Request too large'); raw += chunk; }
  const result = JSON.parse(raw || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an object');
  return result;
}
function fields(data: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Unexpected field');
}
const editable = ['content', 'state', 'audience', 'projectId', 'stageId', 'purposeIds', 'sharedWith', 'reviewAfter'];
function memoryFields(data: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };
  for (const key of ['projectId', 'stageId', 'reviewAfter']) if (result[key] === null || result[key] === '') result[key] = undefined;
  for (const key of ['purposeIds','sharedWith']) if (result[key] === null) result[key] = [];
  return result;
}
export function createMemoryServer(filename: string, webRoot = join(__dirname, '../public')) {
  const engine = new MemoryEngine(filename); const catalog = new Catalog(filename);
  const inbox = new Inbox(filename, engine, catalog);
  const scanner = process.env.CO_MEMO_WATCH === '0' ? undefined : startFileWatcher(inbox, 30000, undefined, error => process.stderr.write(`File watcher: ${error.message}\n`));
  const token = randomBytes(32).toString('hex');
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map(host => `http://${host}`);
    if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !origins.includes(req.headers.origin))) { json(res, 403, { error: 'Local requests only' }); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = url.pathname;
    if (req.method !== 'GET') {
      const supplied = Buffer.from(String(req.headers['x-memory-token'] ?? ''));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !origins.includes(req.headers.origin ?? '')) { json(res, 403, { error: 'Invalid local session' }); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { json(res, 415, { error: 'JSON required' }); return; }
    }
    try {
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/demo', '/demo.js', '/demo.css'].includes(route)) {
        const file = route === '/' ? 'index.html' : route === '/demo' ? 'demo.html' : route.slice(1);
        let content = readFileSync(join(webRoot, file), 'utf8');
        if (file.endsWith('.html')) content = content.replace('__SESSION_TOKEN__', token);
        res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'); res.end(content); return;
      }
      if (req.method === 'GET' && route === '/api/state') {
        json(res, 200, { seen: inbox.seen(), sources: inbox.sources(), demo: process.env.CO_MEMO_DEMO === '1', workspaceLabel: process.env.CO_MEMO_DEMO === '1' ? 'Demo workspace · synthetic data' : 'Personal workspace', connection: { command: process.execPath, args: [join(__dirname, 'engine/mcp.js'), '--db', resolve(filename)] }, catalog: catalog.list(), memories: engine.list({ includeForgotten: true }).map(m => ({ ...m, reviewAfter: memoryReviewDue(m), needsReview: memoryNeedsReview(m) })) }); return;
      }
      if (req.method === 'GET' && route === '/api/export') {
        const memories = engine.list({ includeForgotten: true });
        res.setHeader('Content-Disposition', 'attachment; filename="co-memo-export.json"');
        json(res, 200, { format: 'co-memo-v1', exportedAt: new Date().toISOString(), catalog: catalog.list(), memories, histories: Object.fromEntries(memories.map(m => [m.id, engine.history(m.id)])) }); return;
      }
      if (req.method === 'POST' && route === '/api/inbox/seen') {
        const data = await body(req); fields(data, ['id','version']);
        inbox.mark(String(data.id), Number(data.version)); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && route === '/api/sources') {
        const data = await body(req); fields(data, ['path','agentId','projectId']);
        if (typeof data.agentId !== 'string' || (data.projectId !== undefined && typeof data.projectId !== 'string')) throw new Error('Invalid source scope');
        const registered = inbox.add(data.path as string, {agentId: data.agentId, projectId: data.projectId as string | undefined}); scanner?.refresh(); json(res, 201, registered); return;
      }
      const source = route.match(/^\/api\/sources\/([^/]+)$/);
      if (req.method === 'PATCH' && source) {
        const data = await body(req); fields(data, ['enabled','reviewedVersion']); if (data.enabled !== undefined) inbox.enable(source[1], data.enabled as boolean); if (data.reviewedVersion !== undefined) inbox.reviewSource(source[1], Number(data.reviewedVersion)); scanner?.refresh(); json(res,200,{ok:true}); return;
      }
      const history = route.match(/^\/api\/memories\/([^/]+)\/history$/);
      if (req.method === 'GET' && history) { json(res, 200, engine.history(history[1])); return; }
      if (req.method === 'POST' && route === '/api/demo/record') {
        if (process.env.CO_MEMO_DEMO !== '1') { json(res, 403, { error: 'Start npm run demo to use the guided sandbox' }); return; }
        const data = await body(req); fields(data, ['agentId', 'projectId', 'content']);
        const actor = { agentId: data.agentId, projectId: data.projectId } as MemoryActor;
        catalog.validateActor(actor);
        json(res, 201, callMemoryTool(engine, actor, 'memory_record', { content: data.content, evidence: 'Synthetic guided demo: proposed by the visitor; no live model extraction.' })); return;
      }
      if (req.method === 'POST' && route === '/api/memories') {
        const data = await body(req); fields(data, [...editable, 'ownerId', 'kind']);
        const draft = { ...memoryFields(data), evidence: { source: 'user', eventId: `manual:${randomUUID()}`, excerpt: String(data.content ?? '') } } as MemoryDraft;
        catalog.validateMemory(draft); json(res, 201, engine.add(draft)); return;
      }
      const memory = route.match(/^\/api\/memories\/([^/]+)$/);
      if (req.method === 'PATCH' && memory) {
        const data = await body(req); fields(data, ['version', 'patch']);
        const patch = data.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Patch required');
        fields(patch as Record<string, unknown>, editable);
        const current = engine.list().find(m => m.id === memory[1]); if (!current) throw new Error('Memory not found');
        const change = memoryFields(patch as Record<string, unknown>);
        catalog.validateMemory({ ...current, ...change } as MemoryDraft);
        json(res, 200, engine.revise(memory[1], Number(data.version), change as Partial<DurableMemory>, 'user:edit')); return;
      }
      if (req.method === 'POST' && route === '/api/recall') {
        const data = await body(req); fields(data, ['agentId', 'projectId', 'stageId', 'purposeId', 'query']);
        const actor = { agentId: data.agentId, projectId: data.projectId || undefined, stageId: data.stageId || undefined, purposeId: data.purposeId || undefined } as MemoryActor;
        catalog.validateActor(actor);
        if (data.query !== undefined && typeof data.query !== 'string') throw new Error('Invalid query');
        json(res, 200, engine.contextWithEntries(actor, String(data.query ?? ''))); return;
      }
      const entity = route.match(/^\/api\/catalog\/(agents|projects|stages|purposes)(?:\/([^/]+))?$/);
      if (entity && req.method === 'POST' && !entity[2]) {
        const data = await body(req); fields(data, ['name','description']);
        json(res, 201, catalog.add(entity[1] as CatalogKind, data.name as string, data.description as string | undefined)); return;
      }
      if (entity && req.method === 'PATCH' && entity[2]) {
        const data = await body(req); fields(data, ['name','description','archived','version']);
        const { version, ...patch } = data;
        json(res, 200, catalog.edit(entity[1] as CatalogKind, entity[2], Number(version), patch)); return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      json(res, /changed|stale|UNIQUE/.test(message) ? 409 : 400, { error: message });
    }
  });
  server.on('close', () => { scanner?.close(); inbox.close(); engine.close(); catalog.close(); });
  return server;
}
if (require.main === module) {
  const filename = resolve(process.env.CO_MEMO_DB ?? '.data/memory.sqlite');
  const port = Number(process.env.PORT ?? 4317);
  const server = createMemoryServer(filename);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') process.stdout.write(`Co-memo: http://127.0.0.1:${address.port}\nDatabase: ${filename}\n`);
  });
  server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  process.on('SIGINT', () => server.close()); process.on('SIGTERM', () => server.close());
}
