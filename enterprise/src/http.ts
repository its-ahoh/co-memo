import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Pool, transaction } from './db.js';
import { authorize } from './auth.js';
import { get, list, mutate } from './contexts.js';
import { createInput, patchInput, parse, uuid, Problem } from './model.js';
async function body(req: IncomingMessage) {
  const type = req.headers['content-type']?.toLowerCase();
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(type))
    throw new Problem(400, 'invalid_content_type');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new Problem(413, 'payload_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Problem(400, 'invalid_json');
  }
}
export function api(pool: Pool, cursorSecret: Buffer) {
  if (cursorSecret.length < 32)
    throw new Error('Cursor signing key must contain at least 32 bytes');
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-ID', requestId);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = /^\/v1\/workspaces\/([^/]+)\/contexts(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) throw new Problem(404, 'not_found');
      const workspace = parse(uuid, match[1]).toLowerCase();
      const id = match[2] ? parse(uuid, match[2]).toLowerCase() : undefined;
      const method = req.method;
      if (method !== 'GET' && !(method === 'POST' && !id) && !(method === 'PATCH' && id))
        throw new Problem(404, 'not_found');
      const write = method !== 'GET';
      // Bound and parse network input before taking any database locks.
      const input = write
        ? parse(method === 'POST' ? createInput : patchInput, await body(req))
        : undefined;
      const params = [...url.searchParams.keys()];
      if (
        params.some((k) => !(!id && method === 'GET' && ['limit', 'cursor'].includes(k))) ||
        new Set(params).size !== params.length
      )
        throw new Problem(400, 'invalid_query');
      const limit = parse(
        z.coerce.number().int().min(1).max(100),
        url.searchParams.get('limit') ?? 50,
      );
      const key = req.headers['idempotency-key'];
      const etag = req.headers['if-match'];
      if (write && (!key || (method === 'PATCH' && !etag)))
        throw new Problem(428, 'precondition_required');
      const validatedKey = write ? parse(uuid, key).toLowerCase() : undefined;
      let expected: string | undefined;
      if (method === 'PATCH') {
        if (
          typeof etag !== 'string' ||
          !/^"[1-9][0-9]*"$/.test(etag) ||
          etag.length > 21 ||
          BigInt(etag.slice(1, -1)) > 9223372036854775807n
        )
          throw new Problem(400, 'invalid_if_match');
        expected = etag.slice(1, -1);
      }
      const result = await transaction(pool, async (c) => {
        const a = await authorize(c, req.headers.authorization, workspace, write);
        if (method === 'GET')
          return {
            status: 200,
            data: id
              ? { resource: await get(c, a, id) }
              : await list(c, a, limit, url.searchParams.get('cursor') ?? undefined, cursorSecret),
            replayed: false,
          };
        const changed = await mutate(c, a, {
          method: method as 'POST' | 'PATCH',
          path: `/v1/workspaces/${workspace}/contexts${id ? '/' + id : ''}`,
          key: validatedKey!,
          body: input!,
          requestId,
          ...(id ? { id } : {}),
          ...(expected ? { expected } : {}),
        });
        return {
          status: changed.status,
          data: { resource: changed.resource },
          replayed: changed.replayed,
        };
      });
      res.statusCode = result.status;
      res.setHeader('Content-Type', 'application/json');
      if ('resource' in result.data) res.setHeader('ETag', `"${result.data.resource.revision}"`);
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
      res.end(JSON.stringify({ requestId, ...result.data }));
    } catch (e) {
      const problem = e instanceof Problem ? e : new Problem(503, 'temporarily_unavailable');
      res.statusCode = problem.status;
      res.setHeader('Content-Type', 'application/problem+json');
      res.end(
        JSON.stringify({
          type: 'about:blank',
          title: problem.code,
          status: problem.status,
          code: problem.code,
          requestId,
        }),
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
