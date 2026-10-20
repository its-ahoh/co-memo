import { Pool, assertSchema } from './db.js';
import { claim, finish, event } from './worker.js';
import { parse, uuid } from './model.js';
if (!process.env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required');
const binding = {
  tenantId: parse(uuid, process.env.TENANT_ID),
  workspaceId: parse(uuid, process.env.WORKSPACE_ID),
};
const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });
try {
  await assertSchema(pool);
  let row;
  while ((row = await claim(pool, binding))) {
    if (await finish(pool, binding, row)) console.log(JSON.stringify(event(row)));
  }
} finally {
  await pool.end();
}
