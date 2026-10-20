import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { fixture } from './fixture.mjs';
import { Pool, transaction, scope, migrate, assertSchema } from '../dist/db.js';
import { provision } from '../dist/admin.js';
import { authorize } from '../dist/auth.js';
import { claim, finish, event } from '../dist/worker.js';
const spec = JSON.parse(
  await readFile(new URL('../../docs/enterprise/openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validate = (schema, value) => {
  const check = ajv.compile({ ...schema, components: spec.components });
  assert.ok(check(value), JSON.stringify(check.errors));
};

test(
  'M1 real PostgreSQL HTTP, authorization, atomicity and worker acceptance',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    console.log('PostgreSQL:', (await f.admin.query('SHOW server_version')).rows[0].server_version);
    const path = (id, ws = f.a.workspaceId) => `/v1/workspaces/${ws}/contexts${id ? '/' + id : ''}`;
    async function request(method, p, { token = f.tokenA, body, key, match, headers = {} } = {}) {
      const res = await fetch(f.base + p, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(match ? { 'If-Match': match } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json();
      const route =
        p.split('?')[0].split('/').length === 5
          ? '/v1/workspaces/{workspaceId}/contexts'
          : '/v1/workspaces/{workspaceId}/contexts/{id}';
      const response = spec.paths[route][method.toLowerCase()].responses[res.status];
      assert.ok(response, `Unspecified status ${res.status}: ${JSON.stringify(json)}`);
      const mime = res.headers.get('content-type');
      assert.ok(response.content[mime]);
      validate(response.content[mime].schema, json);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      if (json.resource) assert.equal(res.headers.get('etag'), `"${json.resource.revision}"`);
      return { status: res.status, json, headers: res.headers };
    }
    const input = {
      kind: 'note',
      content: 'Synthetic orchard context',
      metadata: { color: 'blue' },
    };
    const create = async (overrides = {}) =>
      request('POST', path(), { body: input, key: randomUUID(), ...overrides });
    let first;
    await t.test(
      'create/read/CAS; exact history replay; stale and simultaneous versions',
      async () => {
        const key = randomUUID();
        first = await create({ key });
        assert.equal(first.status, 201);
        const id = first.json.resource.id;
        assert.equal((await request('GET', path(id))).status, 200);
        const patchKey = randomUUID();
        const updated = await request('PATCH', path(id), {
          body: { title: 'Updated orchard' },
          key: patchKey,
          match: '"1"',
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.json.resource.revision, '2');
        const old = await request('PATCH', path(id), {
          body: { title: 'Old orchard' },
          key: randomUUID(),
          match: '"1"',
        });
        assert.equal(old.status, 412);
        const replay = await create({ key });
        assert.equal(replay.status, 201);
        assert.deepEqual(replay.json.resource, first.json.resource);
        assert.equal(replay.headers.get('idempotency-replayed'), 'true');
        const patchReplay = await request('PATCH', path(id), {
          body: { title: 'Updated orchard' },
          key: patchKey,
          match: '"1"',
        });
        assert.equal(patchReplay.status, 200);
        assert.equal(patchReplay.json.resource.revision, '2');
        const race = await Promise.all(
          ['Amber', 'Indigo'].map((title) =>
            request('PATCH', path(id), { body: { title }, key: randomUUID(), match: '"2"' }),
          ),
        );
        assert.deepEqual(race.map((r) => r.status).sort(), [200, 412]);
      },
    );
    await t.test(
      'concurrent same key commits one object/history/receipt/audit/event; mismatch hashes',
      async () => {
        const key = randomUUID();
        const results = await Promise.all(Array.from({ length: 8 }, () => create({ key })));
        assert.ok(results.every((r) => r.status === 201));
        assert.equal(new Set(results.map((r) => r.json.resource.id)).size, 1);
        assert.equal(
          results.filter((r) => r.headers.get('idempotency-replayed') !== 'true').length,
          1,
        );
        const id = results[0].json.resource.id;
        for (const [table, col] of [
          ['objects', 'id'],
          ['object_revisions', 'object_id'],
          ['audit', 'object_id'],
          ['outbox', 'aggregate_id'],
        ])
          assert.equal(
            (await f.admin.query(`SELECT count(*) FROM enterprise.${table} WHERE ${col}=$1`, [id]))
              .rows[0].count,
            '1',
          );
        assert.equal(
          (await f.admin.query('SELECT count(*) FROM enterprise.receipts WHERE key=$1', [key]))
            .rows[0].count,
          '1',
        );
        assert.equal(
          (await create({ key, body: { ...input, content: 'Other synthetic content' } })).status,
          409,
        );
        assert.equal(
          (
            await request('PATCH', path(id), {
              key,
              match: '"1"',
              body: { title: 'Changed method' },
            })
          ).status,
          409,
        );
        const patchKey = randomUUID();
        await request('PATCH', path(id), { key: patchKey, match: '"1"', body: { title: 'A' } });
        assert.equal(
          (await request('PATCH', path(id), { key: patchKey, match: '"2"', body: { title: 'A' } }))
            .status,
          409,
        );
        assert.equal(
          (
            await request('PATCH', path(first.json.resource.id), {
              key: patchKey,
              match: '"1"',
              body: { title: 'A' },
            })
          ).status,
          409,
        );
        const sortedKey = randomUUID();
        assert.equal(
          (
            await create({
              key: sortedKey,
              body: { kind: 'note', content: 'Ordering', metadata: { a: 1, b: 2 } },
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await create({
              key: sortedKey,
              body: { metadata: { b: 2, a: 1 }, content: 'Ordering', kind: 'note' },
            })
          ).headers.get('idempotency-replayed'),
          'true',
        );
      },
    );
    await t.test(
      'two tenants, same-tenant workspace isolation, credential-derived identity and pool reuse',
      async () => {
        const b = await request('POST', path(undefined, f.b.workspaceId), {
          token: f.tokenB,
          body: input,
          key: randomUUID(),
        });
        assert.equal(b.status, 201);
        assert.equal(
          (await request('GET', path(first.json.resource.id), { token: f.tokenB })).status,
          404,
        );
        assert.equal(
          (await request('GET', path(first.json.resource.id, f.b.workspaceId), { token: f.tokenB }))
            .status,
          404,
        );
        assert.equal(
          (
            await request('PATCH', path(first.json.resource.id, f.b.workspaceId), {
              token: f.tokenB,
              body: { title: 'No' },
              key: randomUUID(),
              match: '"1"',
            })
          ).status,
          404,
        );
        const sibling = randomUUID();
        await f.admin.query(
          'INSERT INTO enterprise.workspaces(tenant_id,id,name) VALUES($1,$2,$3)',
          [f.a.tenantId, sibling, 'Sibling'],
        );
        assert.equal((await request('GET', path(undefined, sibling))).status, 404);
        await f.admin.query(
          "INSERT INTO enterprise.workspace_memberships(tenant_id,workspace_id,principal_id,role) VALUES($1,$2,$3,'contributor')",
          [f.a.tenantId, sibling, f.a.principalId],
        );
        const siblingToken = await provision(f.admin, {
          ...f.a,
          workspaceId: sibling,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: ['context:read', 'context:write'],
        });
        assert.equal(
          (await request('GET', path(first.json.resource.id, sibling), { token: siblingToken }))
            .status,
          404,
        );
        assert.equal(
          (
            await request('PATCH', path(first.json.resource.id, sibling), {
              token: siblingToken,
              key: randomUUID(),
              match: '"1"',
              body: { title: 'Other workspace' },
            })
          ).status,
          404,
        );
        assert.deepEqual(
          (await request('GET', path(undefined, sibling), { token: siblingToken })).json.items,
          [],
        );
        await assert.rejects(
          transaction(f.runtime, async (c) => {
            await scope(c, f.a.tenantId, sibling);
            await c.query(
              "INSERT INTO enterprise.object_revisions(tenant_id,workspace_id,object_id,revision,snapshot,actor_id) VALUES($1,$2,$3,1,'{}',$4)",
              [f.a.tenantId, sibling, first.json.resource.id, f.a.principalId],
            );
          }),
          (e) => e.code === '23503',
        );

        for (let i = 0; i < 6; i++) {
          const a = await request('GET', path(), {
            headers: { 'X-Tenant-ID': f.b.tenantId, 'X-Workspace-ID': f.b.workspaceId },
          });
          assert.ok(a.json.items.every((r) => r.tenantId === f.a.tenantId));
          const other = await request('GET', path(undefined, f.b.workspaceId), { token: f.tokenB });
          assert.ok(other.json.items.every((r) => r.tenantId === f.b.tenantId));
        }
        const rejected = await create({
          body: { ...input, sourceAgent: 'manager', tenantId: f.b.tenantId },
        });
        assert.equal(rejected.status, 400);
      },
    );
    await t.test(
      'RLS deny without settings; FORCE RLS and role grants; composite FK rejects cross workspace',
      async () => {
        const tables = (
          await f.admin.query(
            "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='enterprise' AND c.relkind='r'",
          )
        ).rows;
        assert.ok(tables.length >= 12);
        for (const table of tables) {
          assert.equal(table.relrowsecurity, true);
          assert.equal(table.relforcerowsecurity, true);
          assert.equal(table.rolname, 'cm_owner');
        }
        for (const table of [
          'objects',
          'context_data',
          'object_revisions',
          'receipts',
          'credentials',
        ])
          assert.equal(
            (await f.runtime.query(`SELECT count(*) FROM enterprise.${table}`)).rows[0].count,
            '0',
          );
        await assert.rejects(f.runtime.query('SET ROLE cm_owner'), (e) => e.code === '42501');
        await assert.rejects(f.runtime.query('SET ROLE cm_auth'), (e) => e.code === '42501');
        await assert.rejects(
          f.runtime.query('TRUNCATE enterprise.objects CASCADE'),
          (e) => e.code === '42501',
        );
        await assert.rejects(
          f.runtime.query('UPDATE enterprise.credentials SET revoked_at=clock_timestamp()'),
          (e) => e.code === '42501',
        );
        await assert.rejects(
          f.worker.query('SELECT * FROM enterprise.context_data'),
          (e) => e.code === '42501',
        );
        await assert.rejects(
          transaction(f.runtime, async (c) => {
            await scope(c, f.a.tenantId, f.a.workspaceId);
            await c.query(
              `INSERT INTO enterprise.object_revisions(tenant_id,workspace_id,object_id,revision,snapshot,actor_id) VALUES($1,$2,$3,1,'{}',$4)`,
              [f.a.tenantId, f.a.workspaceId, randomUUID(), f.a.principalId],
            );
          }),
          (e) => e.code === '23503',
        );
        await transaction(f.runtime, async (c) => {
          await scope(c, f.a.tenantId, f.a.workspaceId);
          assert.equal(
            (
              await c.query('SELECT * FROM enterprise.context_data WHERE tenant_id=$1', [
                f.b.tenantId,
              ])
            ).rowCount,
            0,
          );
        });
        assert.equal(
          (await f.runtime.query('SELECT count(*) FROM enterprise.objects')).rows[0].count,
          '0',
        );
      },
    );
    await t.test(
      'expiry, revocation, scopes, role, membership and workspace policy checked before replay',
      async () => {
        const data = {
          ...f.a,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: ['context:read', 'context:write'],
        };
        const token = await provision(f.admin, data);
        const key = randomUUID();
        assert.equal((await create({ token, key })).status, 201);
        await f.admin.query(
          'UPDATE enterprise.credentials SET revoked_at=clock_timestamp() WHERE id=$1',
          [token.split('.')[0]],
        );
        assert.equal((await create({ token, key })).status, 401);
        const exp = await provision(f.admin, data);
        await f.admin.query(
          "UPDATE enterprise.credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [exp.split('.')[0]],
        );
        assert.equal((await request('GET', path(), { token: exp })).status, 401);
        assert.equal((await request('GET', path(), { token: null })).status, 401);
        assert.equal(
          (await request('GET', path(), { token: randomUUID() + '.' + 'a'.repeat(43) })).status,
          401,
        );
        const reader = await provision(f.admin, { ...data, scopes: ['context:read'] });
        assert.equal((await create({ token: reader })).status, 403);
        for (const [sql, restore] of [
          [
            "UPDATE enterprise.workspace_memberships SET role='viewer' WHERE principal_id=$1",
            "UPDATE enterprise.workspace_memberships SET role='contributor' WHERE principal_id=$1",
          ],
          [
            'UPDATE enterprise.tenant_memberships SET active=false WHERE principal_id=$1',
            'UPDATE enterprise.tenant_memberships SET active=true WHERE principal_id=$1',
          ],
          [
            'UPDATE enterprise.workspace_memberships SET active=false WHERE principal_id=$1',
            'UPDATE enterprise.workspace_memberships SET active=true WHERE principal_id=$1',
          ],
        ]) {
          await f.admin.query(sql, [f.a.principalId]);
          assert.equal((await create()).status, 403);
          await f.admin.query(restore, [f.a.principalId]);
        }
        await f.admin.query('UPDATE enterprise.workspaces SET paused=true WHERE id=$1', [
          f.a.workspaceId,
        ]);
        assert.equal((await request('GET', path())).status, 403);
        await f.admin.query(
          "UPDATE enterprise.workspaces SET paused=false,save_mode='explicit' WHERE id=$1",
          [f.a.workspaceId],
        );
        assert.equal((await create()).status, 403);
        await f.admin.query("UPDATE enterprise.workspaces SET save_mode='automatic' WHERE id=$1", [
          f.a.workspaceId,
        ]);
      },
    );
    await t.test(
      'authorization shared locks serialize revocation; no cached authorization',
      async () => {
        const token = await provision(f.admin, {
          ...f.a,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: ['context:read', 'context:write'],
        });
        const c = await f.runtime.connect(),
          admin = await f.admin.connect();
        try {
          await c.query('BEGIN');
          await authorize(c, `Bearer ${token}`, f.a.workspaceId, false);
          const pid = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const revoke = admin.query(
            'UPDATE enterprise.credentials SET revoked_at=clock_timestamp() WHERE id=$1',
            [token.split('.')[0]],
          );
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const r = await f.admin.query(
              'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
              [pid],
            );
            if (r.rows[0].wait_event_type === 'Lock') {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          assert.equal(waiting, true);
          await c.query('COMMIT');
          await revoke;
          assert.equal((await request('GET', path(), { token })).status, 401);
        } finally {
          await c.query('ROLLBACK');
          c.release();
          admin.release();
        }
      },
    );
    await t.test(
      'current classification/state/expiry protects reads and old receipt replay',
      async () => {
        const key = randomUUID(),
          created = await create({ key }),
          id = created.json.resource.id;
        await f.admin.query(
          "UPDATE enterprise.objects SET classification='restricted' WHERE id=$1",
          [id],
        );
        assert.equal((await request('GET', path(id))).status, 404);
        assert.equal((await create({ key })).status, 404);
        await f.admin.query(
          "UPDATE enterprise.workspace_memberships SET clearance='restricted' WHERE principal_id=$1",
          [f.a.principalId],
        );
        assert.equal((await create({ key })).status, 201);
        await f.admin.query(
          "UPDATE enterprise.workspace_memberships SET clearance='internal' WHERE principal_id=$1",
          [f.a.principalId],
        );
        await f.admin.query("UPDATE enterprise.objects SET classification='internal' WHERE id=$1", [
          id,
        ]);
        for (const state of ['archived', 'conflicted']) {
          await f.admin.query('UPDATE enterprise.context_data SET state=$2 WHERE id=$1', [
            id,
            state,
          ]);
          assert.equal((await request('GET', path(id))).status, 404);
          assert.equal((await create({ key })).status, 404);
        }
        await f.admin.query(
          "UPDATE enterprise.context_data SET state='active',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [id],
        );
        assert.equal((await create({ key })).status, 404);
      },
    );
    await t.test('strict input, body bounds, UTF-8, metadata and CAS headers', async () => {
      assert.equal((await request('POST', path(), { body: input })).status, 428);
      assert.equal(
        (
          await request('PATCH', path(first.json.resource.id), {
            body: { title: 'A' },
            key: randomUUID(),
          })
        ).status,
        428,
      );
      for (const match of ['W/"1"', '"0"', '"9223372036854775808"', '"1", "2"'])
        assert.equal(
          (
            await request('PATCH', path(first.json.resource.id), {
              body: { title: 'A' },
              key: randomUUID(),
              match,
            })
          ).status,
          400,
        );
      for (const body of [
        { ...input, extra: 1 },
        { ...input, content: '' },
        { ...input, content: 'x'.repeat(32001) },
        { ...input, metadata: { a: 'x'.repeat(16384) } },
        JSON.parse('{"kind":"note","content":"A","metadata":{"nested":{"__proto__":1}}}'),
      ])
        assert.equal((await create({ body })).status, 400);
      assert.equal((await create({ body: { ...input, content: 'a'.repeat(140000) } })).status, 413);
      assert.equal((await create({ body: { ...input, content: '🌳'.repeat(32000) } })).status, 201);
      assert.equal(
        (
          await request('PATCH', path(first.json.resource.id), {
            body: {},
            key: randomUUID(),
            match: '"3"',
          })
        ).status,
        400,
      );
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=1&limit=2',
        'unknown=1',
        'cursor=tampered',
      ])
        assert.equal((await request('GET', path() + '?' + query)).status, 400);
      const raw = await fetch(f.base + path(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${f.tokenA}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: Buffer.from([0xff]),
      });
      assert.equal(raw.status, 400);
    });
    await t.test(
      'signed pagination has no duplicates, binds principal/workspace and preserves microseconds',
      async () => {
        let cursor = null;
        const ids = [];
        do {
          const page = await request(
            'GET',
            path() + '?limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
          );
          assert.equal(page.status, 200);
          ids.push(...page.json.items.map((v) => v.id));
          cursor = page.json.nextCursor;
        } while (cursor);
        assert.equal(new Set(ids).size, ids.length);
        const all = await request('GET', path() + '?limit=100');
        assert.deepEqual(
          ids,
          all.json.items.map((v) => v.id),
        );
        const page = await request('GET', path() + '?limit=1');
        assert.ok(page.json.nextCursor);
        assert.equal(
          (
            await request(
              'GET',
              path(undefined, f.b.workspaceId) + '?cursor=' + page.json.nextCursor,
              { token: f.tokenB },
            )
          ).status,
          400,
        );
      },
    );
    await t.test(
      'failure after business writes rolls back object/history/receipt/audit/outbox; same key can retry',
      async () => {
        const key = randomUUID();
        const counts = async () =>
          Promise.all(
            ['objects', 'object_revisions', 'receipts', 'audit', 'outbox'].map(
              async (table) =>
                (await f.admin.query(`SELECT count(*) FROM enterprise.${table}`)).rows[0].count,
            ),
          );
        const before = await counts();
        await f.admin
          .query(`CREATE FUNCTION enterprise.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER test_fail BEFORE INSERT ON enterprise.outbox FOR EACH ROW EXECUTE FUNCTION enterprise.test_fail()`);
        try {
          assert.equal((await create({ key })).status, 503);
          assert.deepEqual(await counts(), before);
        } finally {
          await f.admin.query(
            'DROP TRIGGER test_fail ON enterprise.outbox; DROP FUNCTION enterprise.test_fail()',
          );
        }
        assert.equal((await create({ key })).status, 201);
      },
    );
    await t.test(
      'worker retry, inbox dedupe, stale ack, competing claims and dead-letter exhaustion',
      async () => {
        const a = await claim(f.worker, f.a);
        assert.ok(a);
        assert.equal(await finish(f.worker, f.b, a), false);
        assert.deepEqual(
          Object.keys(event(a)).sort(),
          [
            'eventId',
            'tenantId',
            'workspaceId',
            'aggregateKind',
            'aggregateId',
            'aggregateRevision',
            'eventType',
            'occurredAt',
          ].sort(),
        );
        assert.equal(await finish(f.worker, f.a, a, true), true);
        assert.equal(await finish(f.worker, f.a, a), false);
        await f.admin.query("UPDATE enterprise.outbox SET available_at='2000-01-01' WHERE id=$1", [
          a.id,
        ]);
        const retry = await claim(f.worker, f.a);
        assert.equal(retry.id, a.id);
        assert.equal(BigInt(retry.claim_token), BigInt(a.claim_token) + 1n);
        assert.equal(await finish(f.worker, f.a, a), false);
        assert.equal(await finish(f.worker, f.a, retry), true);
        assert.equal(await finish(f.worker, f.a, retry), false);
        // Simulate duplicate at-least-once delivery after a consumer already committed its marker.
        await f.admin.query(
          "UPDATE enterprise.outbox SET delivered_at=NULL,available_at='2000-01-01' WHERE id=$1",
          [a.id],
        );
        const duplicate = await claim(f.worker, f.a);
        assert.equal(duplicate.id, a.id);
        assert.equal(await finish(f.worker, f.a, duplicate), true);
        assert.equal(
          (await f.admin.query('SELECT count(*) FROM enterprise.inbox WHERE event_id=$1', [a.id]))
            .rows[0].count,
          '1',
        );
        const stale = await claim(f.worker, f.a);
        await f.admin.query(
          "UPDATE enterprise.outbox SET lease_until=clock_timestamp()-interval '1 second',available_at='2000-01-01' WHERE id=$1",
          [stale.id],
        );
        assert.equal(await finish(f.worker, f.a, stale), false);
        const takeover = await claim(f.worker, f.a);
        assert.equal(takeover.id, stale.id);
        assert.equal(await finish(f.worker, f.a, stale), false);
        assert.equal(await finish(f.worker, f.a, takeover), true);
        const parallel = await Promise.all([claim(f.worker, f.a), claim(f.worker, f.a)]);
        assert.ok(parallel.every(Boolean));
        assert.notEqual(parallel[0].id, parallel[1].id);
        for (const p of parallel) await finish(f.worker, f.a, p);
        const exhausted = await claim(f.worker, f.a);
        await f.admin.query(
          "UPDATE enterprise.outbox SET attempts=10,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [exhausted.id],
        );
        const next = await claim(f.worker, f.a);
        if (next) await finish(f.worker, f.a, next);
        assert.equal(
          (
            await f.admin.query('SELECT dead_letter FROM enterprise.outbox WHERE id=$1', [
              exhausted.id,
            ])
          ).rows[0].dead_letter,
          true,
        );
      },
    );
    await t.test(
      'single physical connection alternates tenants and clears settings on success and rollback',
      async () => {
        const one = new Pool({
          ...f.runtime.options,
          password: f.runtime.options.password,
          max: 1,
        });
        try {
          const pids = new Set();
          for (const binding of [f.a, f.b, f.a, f.b]) {
            await transaction(one, async (c) => {
              await scope(c, binding.tenantId, binding.workspaceId);
              pids.add((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
              const rows = await c.query('SELECT tenant_id FROM enterprise.objects');
              assert.ok(rows.rows.every((r) => r.tenant_id === binding.tenantId));
            });
            assert.equal(
              (await one.query('SELECT count(*) FROM enterprise.objects')).rows[0].count,
              '0',
            );
          }
          assert.equal(pids.size, 1);
          await assert.rejects(
            transaction(one, async (c) => {
              await scope(c, f.a.tenantId, f.a.workspaceId);
              throw new Error('synthetic rollback');
            }),
          );
          assert.equal(
            (await one.query('SELECT count(*) FROM enterprise.objects')).rows[0].count,
            '0',
          );
        } finally {
          await one.end();
        }
      },
    );
    await t.test('bigint revisions retain precision beyond JavaScript safe integers', async () => {
      const made = await create();
      const id = made.json.resource.id;
      await f.admin.query("UPDATE enterprise.objects SET revision='9007199254740993' WHERE id=$1", [
        id,
      ]);
      const read = await request('GET', path(id));
      assert.equal(read.json.resource.revision, '9007199254740993');
      const updated = await request('PATCH', path(id), {
        key: randomUUID(),
        match: '"9007199254740993"',
        body: { title: 'Large revision' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.json.resource.revision, '9007199254740994');
    });
    await t.test(
      'worker checks expiration after waiting for row lock; ack/inbox rollback together',
      async () => {
        const row = await claim(f.worker, f.a);
        assert.ok(row);
        const lock = await f.admin.connect();
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM enterprise.outbox WHERE id=$1 FOR UPDATE', [row.id]);
        const finishing = finish(f.worker, f.a, row);
        await lock.query(
          "UPDATE enterprise.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [row.id],
        );
        await lock.query('COMMIT');
        lock.release();
        assert.equal(await finishing, false);
        const next = await claim(f.worker, f.a);
        assert.ok(next);
        await f.admin
          .query(`CREATE FUNCTION enterprise.test_ack_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ack failure'; END $$;
     CREATE TRIGGER test_ack_fail BEFORE UPDATE ON enterprise.outbox FOR EACH ROW EXECUTE FUNCTION enterprise.test_ack_fail()`);
        try {
          await assert.rejects(finish(f.worker, f.a, next));
          assert.equal(
            (
              await f.admin.query('SELECT count(*) FROM enterprise.inbox WHERE event_id=$1', [
                next.id,
              ])
            ).rows[0].count,
            '0',
          );
        } finally {
          await f.admin.query(
            'DROP TRIGGER test_ack_fail ON enterprise.outbox; DROP FUNCTION enterprise.test_ack_fail()',
          );
        }
        assert.equal(await finish(f.worker, f.a, next), true);
      },
    );
    await t.test(
      'transient serialization failure retries the whole DB transaction with one committed effect',
      async () => {
        await f.admin.query(`CREATE SEQUENCE public.test_retry_seq;
     GRANT USAGE,SELECT ON public.test_retry_seq TO cm_runtime;
     CREATE FUNCTION enterprise.test_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
       IF nextval('public.test_retry_seq')=1 THEN RAISE EXCEPTION 'synthetic retry' USING ERRCODE='40001'; END IF;
       RETURN NEW; END $$;
     CREATE TRIGGER test_retry BEFORE INSERT ON enterprise.outbox FOR EACH ROW EXECUTE FUNCTION enterprise.test_retry()`);
        try {
          const key = randomUUID();
          const r = await create({ key });
          assert.equal(r.status, 201);
          assert.equal(
            (await f.admin.query('SELECT count(*) FROM enterprise.receipts WHERE key=$1', [key]))
              .rows[0].count,
            '1',
          );
        } finally {
          await f.admin.query(
            'DROP TRIGGER test_retry ON enterprise.outbox; DROP FUNCTION enterprise.test_retry(); DROP SEQUENCE public.test_retry_seq',
          );
        }
      },
    );
    await t.test('paused workspaces block worker claims and acknowledgements', async () => {
      await create();
      const row = await claim(f.worker, f.a);
      assert.ok(row);
      await f.admin.query('UPDATE enterprise.workspaces SET paused=true WHERE id=$1', [
        f.a.workspaceId,
      ]);
      assert.equal(await claim(f.worker, f.a), undefined);
      assert.equal(await finish(f.worker, f.a, row), false);
      await f.admin.query('UPDATE enterprise.workspaces SET paused=false WHERE id=$1', [
        f.a.workspaceId,
      ]);
      assert.equal(await finish(f.worker, f.a, row), true);
    });
    await t.test(
      'actual admin CLI provisions digest-only credentials and revokes them',
      async () => {
        const url = new URL('postgresql://127.0.0.1/postgres');
        url.port = String(f.admin.options.port);
        url.username = 'postgres';
        url.password = f.admin.options.password;
        const env = { ...process.env, ADMIN_DATABASE_URL: url.href };
        const binding = {
          ...f.a,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: ['context:read'],
        };
        const result = await promisify(execFile)(
          process.execPath,
          ['dist/admin.js', 'provision', JSON.stringify(binding)],
          { env },
        );
        const token = result.stdout.trim();
        assert.match(token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
        assert.equal((await request('GET', path(), { token })).status, 200);
        const stored = (
          await f.admin.query('SELECT secret_hash FROM enterprise.credentials WHERE id=$1', [
            token.split('.')[0],
          ])
        ).rows[0];
        assert.equal(stored.secret_hash.length, 32);
        await promisify(execFile)(
          process.execPath,
          ['dist/admin.js', 'revoke', token.split('.')[0]],
          { env },
        );
        assert.equal((await request('GET', path(), { token })).status, 401);
      },
    );
    await t.test(
      'migration rerun, checksum drift/newer version rejected; unsafe runtime role rejected',
      async () => {
        await migrate(f.admin);
        await assertSchema(f.runtime);
        await assert.rejects(assertSchema(f.admin), /Unsafe/);
        await f.admin.query("UPDATE public.cm_migrations SET checksum='altered'");
        await assert.rejects(migrate(f.admin), /Unsupported/);
        await assert.rejects(assertSchema(f.runtime), /Unsupported/);
        const { migrationSource } = await import('../dist/db.js');
        await f.admin.query('UPDATE public.cm_migrations SET checksum=$1', [
          (await migrationSource()).checksum,
        ]);
        await f.admin.query("INSERT INTO public.cm_migrations VALUES(2,'future')");
        await assert.rejects(migrate(f.admin), /Unsupported/);
        await assert.rejects(assertSchema(f.runtime), /Unsupported/);
        await f.admin.query('DELETE FROM public.cm_migrations WHERE version=2');
      },
    );
  },
);
