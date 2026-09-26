import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { locationReader } from './locations.js';
import { Store } from './store.js';
import { Content, Scope, errorMessage } from './model.js';
import { remember, change, remove, restore, Version } from './service.js';

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw new Error('Request too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Loopback-only UI; reads inspect the central store without synchronizing replicas. */
export async function startUI(home?: string, root = process.cwd(), port = 4318) {
  const store = new Store(home);
  const token = randomBytes(32).toString('hex');
  const assets = new Map<string, [string, string | Buffer]>([
    ['/logo.png', ['image/png', readFileSync(new URL('./ui/logo.png', import.meta.url))]],
    [
      '/theme.js',
      [
        'text/javascript; charset=utf-8',
        readFileSync(new URL('./ui/theme.js', import.meta.url), 'utf8'),
      ],
    ],
    [
      '/',
      [
        'text/html; charset=utf-8',
        readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8').replace(
          '__TOKEN__',
          token,
        ),
      ],
    ],
    [
      '/app.js',
      [
        'text/javascript; charset=utf-8',
        readFileSync(new URL('./ui/app.js', import.meta.url), 'utf8'),
      ],
    ],
    [
      '/style.css',
      ['text/css; charset=utf-8', readFileSync(new URL('./ui/style.css', import.meta.url), 'utf8')],
    ],
  ]);
  let authority = '';
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      req.headers.host !== authority ||
      (req.headers.origin && req.headers.origin !== `http://${authority}`)
    ) {
      send(403, { error: 'Untrusted origin' });
      return;
    }
    const path = new URL(req.url ?? '/', `http://${authority}`).pathname;
    const asset = assets.get(path);
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'Content-Type': asset[0]! });
      res.end(asset[1]);
      return;
    }
    if (req.headers['x-co-memo-token'] !== token) {
      send(403, { error: 'Reload the page to reconnect' });
      return;
    }
    try {
      if (path === '/api/memories' && req.method === 'GET') {
        const result = store.lock(() => {
          const projects = store.db
            .prepare('SELECT id,root FROM projects ORDER BY root')
            .all()
            .map((p) => ({ id: String(p.id), root: String(p.root) }));
          const memories = [
            ...store.list(null, true),
            ...projects.flatMap((p) => store.list(p.id, true).filter((m) => m.scope === 'project')),
          ];
          const conflicts = new Set(store.conflicts().map((c) => c.memoryId));
          const locations = locationReader(store);
          return {
            home: store.home,
            projects,
            memories: memories.map((m) => ({
              ...m,
              conflicted: conflicts.has(m.id),
              locations: locations(m),
            })),
          };
        });
        send(200, result);
        return;
      }
      if (req.headers['content-type'] !== 'application/json') {
        send(415, { error: 'Expected application/json' });
        return;
      }
      if (path === '/api/memories' && req.method === 'POST') {
        const input = z
          .strictObject({ content: Content, scope: Scope, projectId: z.uuid().nullable() })
          .parse(await body(req));
        const result = store.lock(() => {
          const target =
            input.scope === 'project'
              ? store.projectById(z.uuid().parse(input.projectId)).root
              : root;
          return remember(
            store,
            target,
            { content: input.content, scope: input.scope, intent: 'explicit' },
            'user:ui',
          );
        });
        send(200, result);
        return;
      }
      const action = path.match(/^\/api\/memories\/([a-f0-9-]+)\/(archive|restore)$/);
      if (action && req.method === 'POST') {
        const input = z.strictObject({ version: Version }).parse(await body(req));
        const result = store.lock(() => {
          const id = z.uuid().parse(action[1]);
          const old = store.get(id);
          const target = old.projectId ? store.projectById(old.projectId).root : root;
          return action[2] === 'restore'
            ? restore(store, target, { id, ...input }, 'user:ui')
            : change(store, target, { id, ...input, content: null, intent: 'explicit' }, 'user:ui');
        });
        send(200, result);
        return;
      }
      const id = path.match(/^\/api\/memories\/([a-f0-9-]+)$/)?.[1];
      if (id && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const input = z
          .strictObject({ version: Version, content: Content.optional() })
          .parse(await body(req));
        const result = store.lock(() => {
          const old = store.get(z.uuid().parse(id));
          const target = old.projectId ? store.projectById(old.projectId).root : root;
          if (req.method === 'DELETE') return remove(store, target, { id, version: input.version });
          return change(
            store,
            target,
            {
              id,
              version: input.version,
              content: Content.parse(input.content),
              intent: 'explicit',
            },
            'user:ui',
          );
        });
        send(200, result);
        return;
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      const error = errorMessage(e);
      send(/Version changed|conflict|UNIQUE constraint/.test(error) ? 409 : 400, { error });
    }
  });
  server.requestTimeout = 15_000;
  server.on('close', () => store.close());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (e) {
    store.close();
    throw e;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  authority = `127.0.0.1:${address.port}`;
  return { server, url: `http://${authority}` };
}
