import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export { Pool };
export type Client = PoolClient;
async function attempt<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let broken = false;
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='10s'");
    await c.query("SET LOCAL lock_timeout='3s'");
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw e;
  } finally {
    c.release(broken);
  }
}
// Closures must contain only transactional database work, never external effects.
export async function transaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt(pool, fn);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (retry >= 2 || !['40001', '40P01'].includes(code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
    }
  }
}
export async function scope(c: Client, tenant: string, workspace: string) {
  await c.query(
    "SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)",
    [tenant, workspace],
  );
}
export async function migrationSource() {
  const sql = await readFile(new URL('../migrations/001-context.sql', import.meta.url), 'utf8');
  return { sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
export async function migrate(pool: Pool) {
  const { sql, checksum } = await migrationSource();
  await transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(873601,1)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS public.cm_migrations(version integer PRIMARY KEY, checksum text NOT NULL)',
    );
    await c.query('REVOKE ALL ON public.cm_migrations FROM PUBLIC');
    const { rows } = await c.query('SELECT * FROM public.cm_migrations ORDER BY version');
    if (rows.length) {
      if (rows.length !== 1 || rows[0].version !== 1 || rows[0].checksum !== checksum)
        throw new Error('Unsupported or altered migration');
      return;
    }
    await c.query(sql);
    await c.query('INSERT INTO public.cm_migrations VALUES(1,$1)', [checksum]);
    await c.query('GRANT SELECT ON public.cm_migrations TO cm_runtime,cm_worker');
  });
}
export async function assertSchema(pool: Pool) {
  const { checksum } = await migrationSource();
  const { rows } = await pool.query('SELECT * FROM public.cm_migrations ORDER BY version');
  if (rows.length !== 1 || rows[0].version !== 1 || rows[0].checksum !== checksum)
    throw new Error('Unsupported or altered migration');
  const r = await pool.query(`SELECT r.rolsuper,r.rolbypassrls,
    pg_has_role(current_user,'cm_owner','MEMBER') AS owner_member,
    pg_has_role(current_user,'cm_auth','MEMBER') AS auth_member FROM pg_roles r WHERE rolname=current_user`);
  if (
    r.rows[0].rolsuper ||
    r.rows[0].rolbypassrls ||
    r.rows[0].owner_member ||
    r.rows[0].auth_member
  )
    throw new Error('Unsafe runtime database role');
}
