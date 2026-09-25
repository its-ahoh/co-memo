import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { embeddingConfig, indexEmbeddings } from '../dist/semantic.js';
import { retrieve } from '../dist/service.js';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-semantic-')));
  const home = join(root, 'data');
  const store = new Store(home);
  const project = store.lock(() => store.project(root, true));
  const requests = [];
  let respond = (body) => ({
    data: [{ index: 0, embedding: body.input.includes('unrelated') ? [0, 1] : [1, 0] }],
  });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    const result = await respond(input);
    if (result === null) {
      res.writeHead(429);
      res.end('secret provider response');
    } else res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    CO_MEMO_SEMANTIC: '1',
    CO_MEMO_EMBEDDING_URL: `http://127.0.0.1:${server.address().port}/v1/embeddings`,
    CO_MEMO_EMBEDDING_MODEL: 'fixture',
    CO_MEMO_EMBEDDING_THRESHOLD: '0.65',
    CO_MEMO_EMBEDDING_API_KEY: '',
    CO_MEMO_EMBEDDING_REVISION: '',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const add = (content) =>
    store.lock(() => store.add(content, 'project', project.id, 'test').memory);
  return {
    root,
    home,
    store,
    project,
    requests,
    add,
    respond: (fn) => {
      respond = fn;
    },
    index: () => indexEmbeddings(store, project.id),
    query: (query = 'transport preferences') => retrieve(store, root, query),
  };
}

test('semantic opt-in, empty cache and invalid config never send memory implicitly', async (t) => {
  const f = await fixture(t);
  f.add('Use bicycles');
  assert.equal((await f.query()).retrieval.reason, 'no_cache');
  delete process.env.CO_MEMO_SEMANTIC;
  assert.equal((await f.query()).retrieval.reason, 'disabled');
  process.env.CO_MEMO_SEMANTIC = '1';
  process.env.CO_MEMO_EMBEDDING_URL = 'http://remote.example/embeddings?key=secret';
  assert.equal((await f.query()).retrieval.reason, 'invalid_configuration');
  assert.equal(f.requests.length, 0);
  assert.throws(() => embeddingConfig(), /Invalid semantic configuration/);
});

test('explicit index caches vectors; hybrid recall finds synonyms and excludes foreign/deleted/conflicted notes', async (t) => {
  const f = await fixture(t);
  const note = f.add('Use bicycles');
  f.add('unrelated cooking');
  const deleted = f.add('deleted private fact');
  const blocked = f.add('conflicted private fact');
  f.store.lock(() => {
    f.store.change(deleted.id, 1, null, 'test');
    f.store.conflict(blocked, []);
    const other = join(f.root, 'other');
    mkdirSync(other);
    f.store.add('foreign private fact', 'project', f.store.project(other, true).id, 'test');
  });
  assert.equal((await f.index()).indexed, 2);
  assert.equal((await f.index()).indexed, 0);
  const result = await f.query();
  assert.equal(result.retrieval.mode, 'hybrid');
  assert.deepEqual(
    result.memories.map((m) => m.id),
    [note.id],
  );
  assert.match(result.context, /Use bicycles/);
  assert.equal(f.requests.length, 3);
  assert.ok(!JSON.stringify(f.requests).includes('private fact'));
  const ns = join(f.home, 'embeddings-v1', readdirSync(join(f.home, 'embeddings-v1'))[0]);
  assert.ok(!readFileSync(join(ns, `${note.id}.json`), 'utf8').includes('bicycles'));
});

test('updated, deleted and newly conflicted cached notes cannot be recalled; model changes invalidate cache', async (t) => {
  const f = await fixture(t);
  const updated = f.add('Use bicycles'),
    deleted = f.add('Use trains'),
    conflict = f.add('Use buses');
  await f.index();
  f.store.lock(() => {
    f.store.change(updated.id, 1, 'unrelated cooking', 'test');
    f.store.change(deleted.id, 1, null, 'test');
    f.store.conflict(conflict, []);
  });
  assert.deepEqual((await f.query()).memories, []);
  assert.equal((await f.index()).indexed, 1);
  assert.deepEqual((await f.query()).memories, []);
  process.env.CO_MEMO_EMBEDDING_MODEL = 'different-model';
  assert.equal((await f.query()).retrieval.reason, 'no_cache');
});

test('HTTP failures, malformed vectors, dimension changes and corrupt cache fall back to lexical recall', async (t) => {
  const f = await fixture(t);
  const note = f.add('Use bicycles');
  await f.index();
  for (const output of [
    null,
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: [1] }] },
    { data: [] },
  ]) {
    f.respond(() => output);
    const result = await f.query('bicycles');
    assert.equal(result.retrieval.reason, 'provider_unavailable');
    assert.equal(result.memories[0].id, note.id);
    assert.ok(!JSON.stringify(result).includes('secret provider'));
  }
  const ns = join(f.home, 'embeddings-v1', readdirSync(join(f.home, 'embeddings-v1'))[0]);
  writeFileSync(join(ns, `${note.id}.json`), '{broken');
  assert.equal((await f.query('bicycles')).retrieval.reason, 'no_cache');
});

test('a second writer can acquire the lock during HTTP; concurrent edits are revalidated before returning', async (t) => {
  const f = await fixture(t);
  const note = f.add('Use bicycles');
  await f.index();
  f.respond(() => {
    const second = new Store(f.home);
    try {
      second.lock(() => second.change(note.id, 1, 'unrelated cooking', 'test'));
    } finally {
      second.close();
    }
    return { data: [{ index: 0, embedding: [1, 0] }] };
  });
  const result = await f.query();
  assert.deepEqual(result.memories, []);
  assert.ok(!result.context.includes('Use bicycles'));
});

test('pause while HTTP is pending suppresses output and cache publication', async (t) => {
  const f = await fixture(t);
  f.add('Use bicycles');
  f.respond(() => {
    f.store.lock(() => f.store.configure(f.project.id, { paused: true }));
    return { data: [{ index: 0, embedding: [1, 0] }] };
  });
  const indexed = await f.index();
  assert.equal(indexed.indexed, 0);
  assert.equal(indexed.paused, true);
  f.store.lock(() => f.store.configure(f.project.id, { paused: false }));
  f.respond(() => ({ data: [{ index: 0, embedding: [1, 0] }] }));
  await f.index();
  f.respond(() => {
    f.store.lock(() => f.store.configure(f.project.id, { paused: true }));
    return { data: [{ index: 0, embedding: [1, 0] }] };
  });
  const result = await f.query();
  assert.deepEqual(result.memories, []);
  assert.equal(result.retrieval.reason, 'paused');
  assert.ok(!result.context.includes('bicycles'));
});

test('queries with no semantic similarity remain empty; includeDeleted remains local', async (t) => {
  const f = await fixture(t);
  f.add('Use bicycles');
  await f.index();
  assert.deepEqual((await f.query('unrelated')).memories, []);
  const before = f.requests.length;
  assert.equal(
    (await retrieve(f.store, f.root, 'bicycles', true)).retrieval.reason,
    'include_deleted',
  );
  assert.equal(f.requests.length, before);
});

test('provider timeout returns lexical results within a bounded interval', async (t) => {
  const f = await fixture(t);
  const note = f.add('Use bicycles');
  await f.index();
  f.respond(() => new Promise(() => {}));
  const start = performance.now();
  const result = await f.query('bicycles');
  assert.equal(result.retrieval.reason, 'provider_unavailable');
  assert.equal(result.memories[0].id, note.id);
  assert.ok(performance.now() - start < 5000);
});

test('CLI index/list and MCP recall/context use the configured hybrid path', async (t) => {
  const f = await fixture(t);
  const note = f.add('Use bicycles');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const args = [resolve('dist/cli.js'), '--home', f.home, '--project', f.root];
  const cli = async (...command) =>
    JSON.parse(
      (await promisify(execFile)(process.execPath, [...args, ...command], { env: process.env }))
        .stdout,
    );
  assert.equal((await cli('index')).indexed, 1);
  const listed = await cli('list', '--query', 'transport preferences', '--explain');
  assert.equal(listed.retrieval.mode, 'hybrid');
  assert.equal(listed.memories[0].id, note.id);
  const c = new Client({ name: 'semantic-test', version: '1' });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [...args, 'serve'],
      env: process.env,
      stderr: 'pipe',
    }),
  );
  try {
    for (const name of ['memory_context', 'memory_recall']) {
      const raw = await c.callTool({ name, arguments: { query: 'transport preferences' } });
      assert.notEqual(raw.isError, true);
      const result = JSON.parse(raw.content[0].text);
      assert.equal(result.retrieval.mode, 'hybrid');
      assert.ok(JSON.stringify(result).includes('Use bicycles'));
    }
  } finally {
    await c.close();
  }
  // Exercise the real evaluation command against the synthetic provider; this is not a quality claim.
  const evaluation = JSON.parse(
    (
      await promisify(execFile)(process.execPath, [resolve('scripts/eval-semantic.mjs')], {
        env: process.env,
      })
    ).stdout,
  );
  assert.equal(evaluation.status, 'scored');
  const fixtureCases = JSON.parse(
    readFileSync(new URL('../evals/quality-cases.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    evaluation.hybrid.details.map((item) => item.id).sort(),
    fixtureCases.retrieval.map((item) => item.id).sort(),
  );
  assert.equal(evaluation.hybrid.leaks, 0);
  assert.equal(evaluation.hybrid.fallbackQueries, 0);
  f.store.lock(() => f.store.configure(f.project.id, { paused: true }));
  const requests = f.requests.length;
  const paused = await cli('list', '--query', 'bicycles', '--explain');
  assert.equal(paused.memories[0].id, note.id);
  assert.equal(paused.retrieval.reason, 'paused');
  assert.equal(f.requests.length, requests);
});
