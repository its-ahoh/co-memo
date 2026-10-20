import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Pool, migrate, transaction } from './db.js';
import { digest } from './auth.js';

const provisionInput = z.strictObject({
  tenantId: z.uuid(),
  workspaceId: z.uuid(),
  principalId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  scopes: z.array(z.enum(['context:read', 'context:write'])).min(1),
});
export async function provision(pool: Pool, input: unknown) {
  const data = provisionInput.parse(input);
  const id = randomUUID(),
    secret = randomBytes(32).toString('base64url');
  await transaction(pool, async (c) => {
    const now = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
    if (new Date(data.expiresAt) <= now) throw new Error('Expiration must be in the future');
    await c.query(
      `INSERT INTO enterprise.credentials(tenant_id,workspace_id,id,principal_id,secret_hash,scopes,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        data.tenantId,
        data.workspaceId,
        id,
        data.principalId,
        digest(secret),
        data.scopes,
        data.expiresAt,
      ],
    );
  });
  return `${id}.${secret}`;
}
export async function bootstrap(pool: Pool) {
  // Explicit development command only: synthetic labels, no local memory access.
  const tenantId = randomUUID(),
    workspaceId = randomUUID(),
    principalId = randomUUID();
  await transaction(pool, async (c) => {
    await c.query('INSERT INTO enterprise.tenants VALUES($1,$2)', [tenantId, 'Synthetic tenant']);
    await c.query('INSERT INTO enterprise.principals VALUES($1,$2,$3)', [
      tenantId,
      principalId,
      'agent',
    ]);
    await c.query(
      'INSERT INTO enterprise.tenant_memberships(tenant_id,principal_id) VALUES($1,$2)',
      [tenantId, principalId],
    );
    await c.query('INSERT INTO enterprise.workspaces(tenant_id,id,name) VALUES($1,$2,$3)', [
      tenantId,
      workspaceId,
      'Synthetic workspace',
    ]);
    await c.query(
      "INSERT INTO enterprise.workspace_memberships(tenant_id,workspace_id,principal_id,role) VALUES($1,$2,$3,'contributor')",
      [tenantId, workspaceId, principalId],
    );
  });
  return { tenantId, workspaceId, principalId };
}
async function main() {
  if (!process.env.ADMIN_DATABASE_URL) throw new Error('ADMIN_DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'migrate') await migrate(pool);
    else if (command === 'bootstrap-demo') console.log(JSON.stringify(await bootstrap(pool)));
    else if (command === 'provision') console.log(await provision(pool, JSON.parse(value ?? '')));
    else if (command === 'revoke') {
      const id = z.uuid().parse(value);
      await transaction(pool, async (c) => {
        await c.query(
          'UPDATE enterprise.credentials SET revoked_at=clock_timestamp() WHERE id=$1',
          [id],
        );
      });
    } else
      throw new Error(
        'Use migrate | bootstrap-demo | provision <JSON binding> | revoke <credential UUID>',
      );
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Admin command failed; verify arguments, privileges and database configuration.');
    process.exitCode = 1;
  });
