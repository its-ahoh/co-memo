import { randomUUID } from 'node:crypto';
import { Pool, transaction, scope } from './db.js';
export type Binding = { tenantId: string; workspaceId: string };
export type Claim = { id: string; claim_owner: string; claim_token: string; [key: string]: any };
export async function claim(pool: Pool, b: Binding, leaseMs = 30000): Promise<Claim | undefined> {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000)
    throw new Error('Invalid lease');
  return transaction(pool, async (c) => {
    await scope(c, b.tenantId, b.workspaceId);
    const workspace = (await c.query('SELECT paused FROM enterprise.workspaces FOR SHARE')).rows[0];
    if (!workspace || workspace.paused) return;
    // Crashed final attempts become dead letters rather than permanently stuck rows.
    await c.query(`UPDATE enterprise.outbox SET dead_letter=true,claim_owner=NULL,lease_until=NULL,last_error_code='attempts_exhausted'
      WHERE delivered_at IS NULL AND NOT dead_letter AND attempts>=10 AND (lease_until IS NULL OR lease_until<=clock_timestamp())`);
    const row = (
      await c.query(`SELECT id FROM enterprise.outbox WHERE delivered_at IS NULL AND NOT dead_letter AND attempts<10
      AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)
    ).rows[0];
    if (!row) return;
    return (
      await c.query(
        `UPDATE enterprise.outbox SET claim_owner=$2,claim_token=claim_token+1,attempts=attempts+1,
      lease_until=clock_timestamp()+$3::integer*interval '1 millisecond' WHERE id=$1 RETURNING *`,
        [row.id, randomUUID(), leaseMs],
      )
    ).rows[0];
  });
}
export function event(row: Claim) {
  return {
    eventId: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.aggregate_id,
    aggregateRevision: row.aggregate_revision,
    eventType: row.event_type,
    occurredAt: row.created_at.toISOString(),
  };
}
export async function finish(
  pool: Pool,
  b: Binding,
  token: Claim,
  failed = false,
): Promise<boolean> {
  return transaction(pool, async (c) => {
    await scope(c, b.tenantId, b.workspaceId);
    const workspace = (await c.query('SELECT paused FROM enterprise.workspaces FOR SHARE')).rows[0];
    if (!workspace || workspace.paused) return false;
    // Check wall clock AFTER obtaining the row lock: stale acknowledgements fail closed.
    const row = (
      await c.query('SELECT * FROM enterprise.outbox WHERE id=$1 FOR UPDATE', [token.id])
    ).rows[0];
    const now = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
    if (
      !row ||
      row.delivered_at ||
      row.dead_letter ||
      row.claim_owner !== token.claim_owner ||
      row.claim_token !== token.claim_token ||
      !row.lease_until ||
      row.lease_until <= now
    )
      return false;
    if (failed) {
      const delay =
        Math.min(60000, 100 * 2 ** Math.min(row.attempts, 10)) + Math.floor(Math.random() * 100);
      await c.query(
        `UPDATE enterprise.outbox SET claim_owner=NULL,lease_until=NULL,last_error_code='internal_retry',dead_letter=(attempts>=10),
        available_at=clock_timestamp()+$2::integer*interval '1 millisecond' WHERE id=$1`,
        [token.id, delay],
      );
    } else {
      await c.query(
        `INSERT INTO enterprise.inbox(tenant_id,workspace_id,consumer,event_id) VALUES($1,$2,'m1-marker',$3) ON CONFLICT DO NOTHING`,
        [b.tenantId, b.workspaceId, token.id],
      );
      await c.query(
        `UPDATE enterprise.outbox SET delivered_at=clock_timestamp(),claim_owner=NULL,lease_until=NULL,last_error_code=NULL WHERE id=$1`,
        [token.id],
      );
    }
    return true;
  });
}
