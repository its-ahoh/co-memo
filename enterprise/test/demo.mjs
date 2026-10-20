import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { claim, finish, event } from '../dist/worker.js';
const f = await fixture();
try {
  const path = `/v1/workspaces/${f.a.workspaceId}/contexts`;
  async function call(method, p, body, key, match, token = f.tokenA) {
    const r = await fetch(f.base + p, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(match ? { 'If-Match': match } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      etag: r.headers.get('etag'),
      replayed: r.headers.get('idempotency-replayed'),
      body: await r.json(),
    };
  }
  const key = randomUUID(),
    input = { kind: 'decision', content: 'Synthetic packing guideline', title: 'Orchard demo' };
  const created = await call('POST', path, input, key);
  assert.equal(created.status, 201);
  console.log('create:', created.status, 'revision:', created.body.resource.revision);
  const id = created.body.resource.id;
  assert.equal((await call('GET', path + '/' + id)).status, 200);
  console.log('read: 200');
  const updated = await call(
    'PATCH',
    path + '/' + id,
    { title: 'Updated guideline' },
    randomUUID(),
    created.etag,
  );
  assert.equal(updated.status, 200);
  console.log('update:', updated.status, 'revision:', updated.body.resource.revision);
  const stale = await call(
    'PATCH',
    path + '/' + id,
    { title: 'Stale guideline' },
    randomUUID(),
    created.etag,
  );
  assert.equal(stale.status, 412);
  console.log('stale version: 412');
  const replay = await call('POST', path, input, key);
  assert.equal(replay.replayed, 'true');
  assert.equal(replay.body.resource.id, id);
  console.log('same-key replay: same object, original revision');
  assert.equal(
    (await call('GET', path + '/' + id, undefined, undefined, undefined, f.tokenB)).status,
    404,
  );
  console.log('other workspace: 404');
  let row;
  while ((row = await claim(f.worker, f.a))) {
    assert.equal(await finish(f.worker, f.a, row), true);
    console.log('content-free internal delivery:', JSON.stringify(event(row)));
  }
  console.log('Demo passed; temporary database and credentials removed.');
} finally {
  await f.close();
}
