import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Client } from './db.js';
import type { Identity } from './auth.js';
import { digest } from './auth.js';
import { canonical, Problem, type CreateInput, type PatchInput } from './model.js';

type Row = Record<string, any>;
const select = `SELECT o.*, d.kind AS context_kind,d.title,d.content,d.metadata,d.state,d.expires_at,
 to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_time
 FROM enterprise.objects o JOIN enterprise.context_data d USING(tenant_id,workspace_id,id)`;
const visible = (r: Row | undefined, a: Identity, now: Date): r is Row =>
  !!r &&
  r.state === 'active' &&
  (!r.expires_at || r.expires_at > now) &&
  (r.classification === 'internal' || a.clearance === 'restricted');
function resource(r: Row) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workspaceId: r.workspace_id,
    revision: r.revision,
    title: r.title,
    content: r.content,
    kind: r.context_kind,
    metadata: r.metadata,
    state: r.state,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
export async function get(c: Client, a: Identity, id: string, lock = false) {
  const row = (
    await c.query(`${select} WHERE o.id=$1 ${lock ? 'FOR UPDATE OF o,d' : 'FOR SHARE OF o,d'}`, [
      id,
    ])
  ).rows[0];
  const now = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
  if (!visible(row, a, now)) throw new Problem(404, 'not_found');
  return resource(row);
}
const cursorSchema = z.strictObject({
  tenant: z.uuid(),
  workspace: z.uuid(),
  principal: z.uuid(),
  clearance: z.string(),
  filter: z.literal('active-unexpired:created_at,id:asc'),
  time: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});
export async function list(
  c: Client,
  a: Identity,
  limit: number,
  cursor: string | undefined,
  secret: Buffer,
) {
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2 || cursor.length > 2048) throw new Error();
      const expected = createHmac('sha256', secret).update(parts[0]!).digest();
      const actual = Buffer.from(parts[1]!, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
        throw new Error();
      after = cursorSchema.parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
      if (
        after.tenant !== a.tenant_id ||
        after.workspace !== a.workspace_id ||
        after.principal !== a.principal_id ||
        after.clearance !== a.clearance
      )
        throw new Error();
    } catch {
      throw new Problem(400, 'invalid_cursor');
    }
  }
  const { rows } = await c.query(
    `${select} WHERE d.state='active' AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp())
    AND (o.classification='internal' OR $1='restricted')
    AND ($2::timestamptz IS NULL OR (o.created_at,o.id)>($2::timestamptz,$3::uuid))
    ORDER BY o.created_at,o.id LIMIT $4`,
    [a.clearance, after?.time ?? null, after?.id ?? null, limit + 1],
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  let nextCursor: string | null = null;
  if (more && last) {
    const value = Buffer.from(
      JSON.stringify({
        tenant: a.tenant_id,
        workspace: a.workspace_id,
        principal: a.principal_id,
        clearance: a.clearance,
        filter: 'active-unexpired:created_at,id:asc',
        time: last.page_time,
        id: last.id,
      }),
    ).toString('base64url');
    nextCursor = value + '.' + createHmac('sha256', secret).update(value).digest('base64url');
  }
  return { items: page.map(resource), nextCursor };
}
export async function mutate(
  c: Client,
  a: Identity,
  args: {
    method: 'POST' | 'PATCH';
    path: string;
    id?: string;
    key: string;
    expected?: string;
    body: CreateInput | PatchInput;
    requestId: string;
  },
) {
  const hash = digest(
    canonical({
      method: args.method,
      path: args.path,
      body: args.body,
      expected: args.expected ?? null,
      principal: a.principal_id,
    }),
  );
  const scope = [a.tenant_id, a.workspace_id, a.principal_id, args.key];
  const inserted = await c.query(
    `INSERT INTO enterprise.receipts(tenant_id,workspace_id,principal_id,key,request_hash)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING key`,
    [...scope, hash],
  );
  if (!inserted.rowCount) {
    const receipt = (
      await c.query(
        'SELECT * FROM enterprise.receipts WHERE tenant_id=$1 AND workspace_id=$2 AND principal_id=$3 AND key=$4',
        scope,
      )
    ).rows[0];
    if (!receipt || !receipt.request_hash.equals(hash))
      throw new Problem(409, 'idempotency_mismatch');
    await get(c, a, receipt.object_id); // Current access is mandatory before historical replay.
    const history = (
      await c.query(
        'SELECT snapshot FROM enterprise.object_revisions WHERE object_id=$1 AND revision=$2',
        [receipt.object_id, receipt.revision],
      )
    ).rows[0];
    if (!history?.snapshot || !receipt.status || receipt.purged)
      throw new Problem(404, 'not_found');
    return { status: receipt.status, resource: history.snapshot, replayed: true };
  }
  const id = args.id ?? randomUUID();
  if (args.method === 'POST') {
    const b = args.body as CreateInput;
    await c.query(
      `INSERT INTO enterprise.objects(tenant_id,workspace_id,id,kind,owner_id,created_by,updated_by)
      VALUES($1,$2,$3,'context',$4,$4,$4)`,
      [a.tenant_id, a.workspace_id, id, a.principal_id],
    );
    await c.query(
      `INSERT INTO enterprise.context_data(tenant_id,workspace_id,id,kind,title,content,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [a.tenant_id, a.workspace_id, id, b.kind, b.title ?? '', b.content, b.metadata ?? {}],
    );
  } else {
    await get(c, a, id, true);
    const update = await c.query(
      `UPDATE enterprise.objects SET revision=revision+1,updated_at=clock_timestamp(),updated_by=$2
      WHERE id=$1 AND revision=$3::bigint RETURNING revision`,
      [id, a.principal_id, args.expected],
    );
    if (!update.rowCount) throw new Problem(412, 'stale_revision');
    const b = args.body;
    await c.query(
      `UPDATE enterprise.context_data SET title=COALESCE($2,title),content=COALESCE($3,content),metadata=COALESCE($4::jsonb,metadata) WHERE id=$1`,
      [id, b.title ?? null, b.content ?? null, b.metadata ?? null],
    );
  }
  const result = await get(c, a, id);
  await c.query(
    `INSERT INTO enterprise.object_revisions(tenant_id,workspace_id,object_id,revision,snapshot,actor_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [a.tenant_id, a.workspace_id, id, result.revision, result, a.principal_id],
  );
  const eventType = args.method === 'POST' ? 'context.created' : 'context.updated';
  await c.query(
    `INSERT INTO enterprise.audit(tenant_id,workspace_id,id,actor_id,action,object_id,request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [a.tenant_id, a.workspace_id, randomUUID(), a.principal_id, eventType, id, args.requestId],
  );
  await c.query(
    `INSERT INTO enterprise.outbox(tenant_id,workspace_id,id,aggregate_id,aggregate_kind,aggregate_revision,event_type)
    VALUES($1,$2,$3,$4,'context',$5,$6)`,
    [a.tenant_id, a.workspace_id, randomUUID(), id, result.revision, eventType],
  );
  const status = args.method === 'POST' ? 201 : 200;
  await c.query(
    'UPDATE enterprise.receipts SET status=$5,object_id=$6,revision=$7 WHERE tenant_id=$1 AND workspace_id=$2 AND principal_id=$3 AND key=$4',
    [...scope, status, id, result.revision],
  );
  return { status, resource: result, replayed: false };
}
