import test from 'node:test';
import { get } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUI } from '../dist/ui.js';
import { Store } from '../dist/store.js';
import { sync } from '../dist/sync.js';

test('UI resolves current, alternative, merged and archive choices with revision and policy checks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-ui-conflict-'));
  const home = join(dir, 'data');
  const store = new Store(home, 'fixture-agent');
  const other = new Store(home, 'other-agent');
  const project = store.project(dir, true);
  const { server, url } = await startUI(home, dir, 0);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const token = (await (await fetch(url)).text()).match(
    /name="co-memo-token" content="([a-f0-9]+)"/,
  )[1];
  const request = async (path, body) => {
    const response = await fetch(url + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Co-memo-token': token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  for (const choice of ['current', 'alternative', 'custom', 'archive']) {
    const old = store.add(`Color ${choice}: blue`, 'project', project.id, 'fixture').memory;
    const candidate = {
      id: randomUUID(),
      content: `Color ${choice}: red`,
      metadata: old.metadata,
      sourceAgent: 'other-agent',
    };
    const replicaId = randomUUID();
    const conflict = other.conflict(
      old,
      [{ replicaId, agent: 'codex', baseVersion: 1, content: null }],
      [candidate],
    );
    const endpoint = `/api/conflicts/${conflict.id}/resolve`;
    const listed = (await request('/api/memories')).value.memories.find((m) => m.id === old.id);
    assert.equal(listed.conflict.candidates[0].sourceAgent, 'other-agent');
    assert.equal(listed.sourceAgent, 'fixture-agent');
    assert.equal((await fetch(url + endpoint, { method: 'POST' })).status, 403);
    assert.equal(
      (await request(endpoint, { revision: 1, take: 'current', content: 'both' })).status,
      400,
    );
    assert.equal((await request(endpoint, { revision: 1, take: randomUUID() })).status, 400);
    store.configure(project.id, { paused: true });
    assert.equal((await request(endpoint, { revision: 1, take: 'current' })).status, 400);
    store.configure(project.id, { paused: false });
    store.conflict(
      old,
      [],
      [{ ...candidate, id: randomUUID(), content: `Color ${choice}: green` }],
    );
    assert.equal((await request(endpoint, { revision: 1, take: 'current' })).status, 409);
    assert.equal(store.get(old.id).version, 1);
    const body =
      choice === 'custom'
        ? { content: `Color ${choice}: violet` }
        : {
            take:
              choice === 'alternative'
                ? candidate.id
                : choice === 'archive'
                  ? replicaId
                  : 'current',
          };
    const result = await request(endpoint, { revision: 2, ...body });
    assert.equal(result.status, 200);
    assert.equal(result.value.memory.version, 2);
    assert.equal(result.value.memory.deleted, choice === 'archive');
    assert.equal(
      result.value.memory.content,
      choice === 'custom'
        ? body.content
        : choice === 'alternative'
          ? candidate.content
          : old.content,
    );
    assert.equal(store.history(old.id).length, 2);
    assert.equal((await request(endpoint, { revision: 2, ...body })).status, 409);
    assert.equal(
      (await request('/api/memories')).value.memories.find((m) => m.id === old.id).conflict,
      null,
    );
  }
  const drifted = store.add('Shade: blue', 'project', project.id, 'fixture').memory;
  const open = other.conflict(
    drifted,
    [],
    [{ id: randomUUID(), content: 'Shade: red', metadata: drifted.metadata }],
  );
  store.change(drifted.id, 1, 'Shade: teal', 'fixture');
  const stuck = await request(`/api/conflicts/${open.id}/resolve`, {
    revision: 1,
    take: 'current',
  });
  assert.equal(stuck.status, 400);
  assert.match(stuck.value.error, /Memory changed since conflict/);
});

test('UI persists CRUD, uses database storage, protects versions and serves packaged assets', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'co-memo-ui-'));
  const root = join(dir, 'project'),
    home = join(dir, 'data');
  mkdirSync(root);
  const store = new Store(home);
  const project = store.project(root, true);
  store.connect(project, 'codex');
  store.lock(() => sync(store));
  const { server, url } = await startUI(home, root, 0);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const html = await (await fetch(url)).text();
  const token = html.match(/name="co-memo-token" content="([a-f0-9]+)"/)[1];
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { 'X-Co-memo-token': token, 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await fetch(url + '/app.js')).status, 200);
  assert.equal((await fetch(url + '/style.css')).status, 200);
  assert.equal((await fetch(url + '/api/memories')).status, 403);
  assert.equal(
    (await request('/api/memories', 'GET', null, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      get(url, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    }),
    403,
  );
  const created = await request('/api/memories', 'POST', {
    content: 'Use pnpm',
    scope: 'project',
    projectId: project.id,
  });
  assert.equal(created.status, 200);
  const id = created.value.memory.id;
  assert.equal(store.get(id).content, 'Use pnpm');
  const list = await request('/api/memories');
  assert.equal(list.value.memories.length, 1);
  assert.equal(list.value.projects[0].id, project.id);
  assert.equal(
    (
      await request(`/api/memories/${id}`, 'PATCH', {
        content: 'Use pnpm --frozen-lockfile',
        version: 1,
      })
    ).status,
    200,
  );
  assert.equal((await request(`/api/memories/${id}`, 'DELETE', { version: 1 })).status, 409);
  assert.equal(store.get(id).deleted, false);
  assert.equal((await request(`/api/memories/${id}/archive`, 'POST', { version: 2 })).status, 200);
  assert.equal(store.get(id).deleted, true);
  assert.equal(store.history(id).length, 3);
  assert.equal(existsSync(join(root, '.co-memo')), false);
  assert.equal((await request('/api/memories')).value.memories[0].deleted, true);
  assert.equal((await request(`/api/memories/${id}/restore`, 'POST', { version: 3 })).status, 200);
  assert.equal(store.get(id).deleted, false);
  assert.equal((await request(`/api/memories/${id}`, 'DELETE', { version: 4 })).status, 200);
  assert.throws(() => store.get(id), /not found/);
  assert.deepEqual(store.history(id), []);
  assert.equal((await request('/api/memories')).value.memories.length, 0);
  assert.equal(existsSync(join(root, '.co-memo')), false);

  assert.equal(
    (await request('/api/memories', 'POST', { content: ' ', scope: 'user', projectId: null }))
      .status,
    400,
  );
  const personal = await request('/api/memories', 'POST', {
    content: '<script>alert(1)</script>',
    scope: 'user',
    projectId: null,
  });
  assert.equal(personal.status, 200);
  assert.equal(
    (
      await request('/api/memories', 'POST', {
        content: '<script>alert(1)</script>',
        scope: 'user',
        projectId: null,
      })
    ).value.created,
    false,
  );
  const relatedInput = { content: '<script>alert(2)</script>', scope: 'user', projectId: null };
  const pending = await request('/api/memories', 'POST', relatedInput);
  assert.equal(pending.value.status, 'needs_review');
  assert.equal((await request('/api/memories')).value.memories.length, 1);
  const reviewed = await request('/api/memories', 'POST', {
    ...relatedInput,
    review: { token: pending.value.review.token, reason: 'Different alert example' },
  });
  assert.equal(reviewed.value.verified, true);
  store.transaction(() => store.conflict(personal.value.memory, []));
  assert.equal(
    (
      await request(`/api/memories/${personal.value.memory.id}`, 'PATCH', {
        content: 'changed',
        version: 1,
      })
    ).status,
    409,
  );
});

test(
  'UI CLI opens the advertised URL by default and supports --no-open',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { spawn } = await import('node:child_process');
    const { writeFileSync, existsSync } = await import('node:fs');
    const { once } = await import('node:events');
    const { setTimeout: delay } = await import('node:timers/promises');
    const dir = mkdtempSync(join(tmpdir(), 'co-memo-ui-launch-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const receipt = join(dir, 'opened-url');
    const opener = join(dir, process.platform === 'darwin' ? 'open' : 'xdg-open');
    writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$UI_OPEN_RECEIPT"\n', { mode: 0o755 });
    for (const noOpen of [true, false]) {
      const child = spawn(
        process.execPath,
        [
          'dist/cli.js',
          '--home',
          join(dir, 'data'),
          'ui',
          '--port',
          '0',
          ...(noOpen ? ['--no-open'] : []),
        ],
        {
          env: { ...process.env, PATH: dir + ':' + process.env.PATH, UI_OPEN_RECEIPT: receipt },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const exited = once(child, 'exit');
      let output = '',
        errors = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (errors += chunk));
      try {
        for (let i = 0; i < 100 && !output.includes('http://'); i++) {
          if (child.exitCode !== null) throw new Error(errors || 'UI exited before listening');
          await delay(50);
        }
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        assert.ok(url, errors || output);
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /Memory console/);
        if (noOpen) {
          await delay(150);
          assert.equal(existsSync(receipt), false);
        } else {
          for (let i = 0; i < 100 && !existsSync(receipt); i++) await delay(50);
          assert.equal(readFileSync(receipt, 'utf8'), url);
        }
      } finally {
        child.kill('SIGTERM');
        await exited;
      }
    }
  },
);
