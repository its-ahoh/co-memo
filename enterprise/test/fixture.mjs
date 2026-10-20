import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Pool, migrate, assertSchema } from '../dist/db.js';
import { bootstrap, provision } from '../dist/admin.js';
import { api } from '../dist/http.js';
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'co-memo-m1-'));
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const password = randomBytes(24).toString('hex');
  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, 'db'),
    user: 'postgres',
    password,
    port,
    persistent: false,
    authMethod: 'scram-sha-256',
    postgresFlags: ['-h', '127.0.0.1', '-k', dir],
    onLog: () => {},
    onError: () => {},
  });
  let admin, runtime, worker, server;
  try {
    await pg.initialise();
    await pg.start();
    const config = {
      host: '127.0.0.1',
      port,
      password,
      database: 'postgres',
      connectionTimeoutMillis: 3000,
    };
    admin = new Pool({ ...config, user: 'postgres' });
    await migrate(admin);
    for (const role of ['cm_runtime', 'cm_worker'])
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    runtime = new Pool({ ...config, user: 'cm_runtime', max: 2 });
    worker = new Pool({ ...config, user: 'cm_worker', max: 2 });
    await assertSchema(runtime);
    await assertSchema(worker);
    const a = await bootstrap(admin),
      b = await bootstrap(admin);
    const tokenA = await provision(admin, {
      ...a,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['context:read', 'context:write'],
    });
    const tokenB = await provision(admin, {
      ...b,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      scopes: ['context:read', 'context:write'],
    });
    server = api(runtime, randomBytes(32));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      admin,
      runtime,
      worker,
      a,
      b,
      tokenA,
      tokenB,
      base,
      pg,
      async close() {
        await new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        });
        await Promise.all([admin.end(), runtime.end(), worker.end()]);
        await pg.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await Promise.all([admin?.end(), runtime?.end(), worker?.end()]);
    await pg.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
