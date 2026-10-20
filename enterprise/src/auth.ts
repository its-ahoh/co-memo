import { createHash } from 'node:crypto';
import type { Client } from './db.js';
import { scope } from './db.js';
import { Problem, uuid } from './model.js';
export type Identity = {
  tenant_id: string;
  workspace_id: string;
  principal_id: string;
  clearance: string;
  role: string;
};
export const digest = (s: string) => createHash('sha256').update(s).digest();
export async function authorize(
  c: Client,
  authorization: string | undefined,
  workspace: string,
  write: boolean,
): Promise<Identity> {
  const token = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(authorization ?? '');
  if (!token || !uuid.safeParse(token[1]).success) throw new Problem(401, 'unauthenticated');
  const hash = digest(token[2]!);
  const lookup = await c.query('SELECT * FROM enterprise.authenticate($1,$2)', [token[1], hash]);
  const identity = lookup.rows[0];
  if (!identity) throw new Problem(401, 'unauthenticated');
  if (identity.workspace_id !== workspace) throw new Problem(404, 'not_found');
  await scope(c, identity.tenant_id, identity.workspace_id);
  // Lock first, then evaluate DB time after acquiring the lock. Revocation uses UPDATE.
  const cr = (
    await c.query('SELECT * FROM enterprise.credentials WHERE id=$1 FOR SHARE', [token[1]])
  ).rows[0];
  const now = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
  if (
    !cr ||
    cr.principal_id !== identity.principal_id ||
    cr.tenant_id !== identity.tenant_id ||
    cr.workspace_id !== identity.workspace_id ||
    !cr.secret_hash.equals(hash) ||
    cr.revoked_at ||
    cr.expires_at <= now
  )
    throw new Problem(401, 'unauthenticated');
  const tm = (
    await c.query('SELECT * FROM enterprise.tenant_memberships WHERE principal_id=$1 FOR SHARE', [
      identity.principal_id,
    ])
  ).rows[0];
  const wm = (
    await c.query(
      'SELECT * FROM enterprise.workspace_memberships WHERE principal_id=$1 FOR SHARE',
      [identity.principal_id],
    )
  ).rows[0];
  const ws = (await c.query('SELECT * FROM enterprise.workspaces FOR SHARE')).rows[0];
  if (
    !tm?.active ||
    !wm?.active ||
    !ws ||
    ws.paused ||
    !cr.scopes.includes('context:read') ||
    (write &&
      (!cr.scopes.includes('context:write') || wm.role === 'viewer' || ws.save_mode === 'explicit'))
  )
    throw new Problem(403, 'forbidden');
  return { ...identity, clearance: wm.clearance, role: wm.role };
}
