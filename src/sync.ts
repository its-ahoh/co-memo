import { settings, allowWrite } from './settings.js';
import { Store } from './store.js';
import { parse, render } from './document.js';
import { atomicWrite, readText } from './fs.js';
import { ensure, hash, errorMessage } from './model.js';
import type { Replica, Snapshot, Proposal, SyncReport } from './model.js';

interface Observation {
  replica: Replica;
  text: string | null;
  snapshot: Snapshot | null;
}
function relevantConflict(store: Store, replica: Replica): boolean {
  return store.conflicts().some((c) => {
    const m = store.get(c.memoryId);
    return m.scope === 'user' || m.projectId === replica.projectId;
  });
}
function recover(store: Store, replica: Replica): void {
  const pending = replica.pending;
  if (!pending) return;
  const text = readText(replica.path);
  const digest = text === null ? null : hash(text);
  if (digest === pending.expected) {
    atomicWrite(replica.path, pending.text, pending.expected);
    replica.baseline = pending.snapshot;
  } else if (text !== null && parse(text, replica.id).generation === pending.snapshot.generation) {
    // File was published, possibly edited, before the previous process acknowledged it.
    replica.baseline = pending.snapshot;
  } else {
    ensure(
      text !== null &&
        replica.baseline &&
        parse(text, replica.id).generation === replica.baseline.generation,
      'Pending publication has an unknown or missing document; restore the file before syncing',
    );
    // An external writer changed the old generation; ingest against its original baseline.
  }
  replica.pending = null;
  store.transaction(() => store.saveReplica(replica));
}
/** Caller holds Store.lock across recovery, ingestion and publication. */
export function sync(store: Store): SyncReport {
  const report: SyncReport = {
    imported: 0,
    updated: 0,
    deleted: 0,
    published: 0,
    conflicts: [],
    errors: [],
  };
  const observed: Observation[] = [];
  const proposals = new Map<string, Proposal[]>();
  for (const replica of store.replicas()) {
    try {
      if (settings(store, replica.projectId).paused) continue;
      recover(store, replica);
      if (relevantConflict(store, replica)) continue; // Freeze projections until explicit resolution.
      const text = readText(replica.path);
      if (!replica.baseline) {
        ensure(text === null, 'Uninitialized replica has unexpected content');
        observed.push({ replica, text, snapshot: null });
        continue;
      }
      ensure(
        text !== null,
        'Memory file missing; restore it or run repair. Missing files never mean delete all.',
      );
      const snapshot = parse(text, replica.id);
      ensure(
        snapshot.generation === replica.baseline.generation,
        'Unknown document generation; restore the current file',
      );
      const changed =
        JSON.stringify(snapshot.entries) !== JSON.stringify(replica.baseline.entries) ||
        snapshot.added !== replica.baseline.added;
      if (changed) allowWrite(store, replica.projectId, 'automatic');
      const base = new Map(replica.baseline.entries.map((e) => [e.id, e]));
      for (const entry of snapshot.entries) {
        const previous = base.get(entry.id);
        ensure(
          previous && previous.version === entry.version,
          'Unknown memory ID or changed version marker',
        );
      }
      const current = new Map(snapshot.entries.map((e) => [e.id, e]));
      for (const entry of replica.baseline.entries) {
        const value = current.get(entry.id)?.content ?? null;
        if (value === entry.content) continue;
        const list = proposals.get(entry.id) ?? [];
        list.push({
          replicaId: replica.id,
          agent: replica.agent,
          baseVersion: entry.version,
          content: value,
        });
        proposals.set(entry.id, list);
      }
      observed.push({ replica, text, snapshot });
    } catch (e) {
      report.errors.push({ path: replica.path, error: errorMessage(e) });
    }
  }
  store.transaction(() => {
    for (const [id, changes] of proposals) {
      const current = store.get(id),
        value = current.deleted ? null : current.content;
      const divergent = changes.filter((p) => p.content !== value);
      if (!divergent.length) continue;
      const desired = new Set(changes.map((p) => p.content));
      if (
        desired.size > 1 ||
        divergent.some((p) => p.baseVersion !== current.version) ||
        current.deleted
      ) {
        store.conflict(current, changes);
        continue;
      }
      store.db.exec('SAVEPOINT apply_note');
      try {
        const next = changes[0]!;
        store.change(id, current.version, next.content, `agent:${next.agent}`, 'automatic');
        store.db.exec('RELEASE apply_note');
        if (next.content === null) report.deleted++;
        else report.updated++;
      } catch (e) {
        store.db.exec('ROLLBACK TO apply_note; RELEASE apply_note');
        // Only exact-content collisions are merge conflicts. Storage failures abort the transaction.
        if (!(
          e instanceof Error && e.message.includes('UNIQUE constraint failed: notes.fingerprint')
        ))
          throw e;
        store.conflict(current, changes);
      }
    }
    for (const item of observed) {
      const { replica, snapshot } = item;
      if (snapshot?.added && snapshot.added !== replica.baseline?.added) {
        const added = store.add(
          snapshot.added,
          'project',
          replica.projectId,
          `agent:${replica.agent}`,
          'automatic',
        );
        if (added.created) report.imported++;
      }
      // Acknowledge ingested edits BEFORE publishing. Recovery won't reapply deletions or additions.
      replica.baseline = snapshot;
      store.saveReplica(replica);
    }
    for (const item of observed) {
      const { replica, text } = item;
      if (relevantConflict(store, replica)) continue;
      const memories = store.list(replica.projectId);
      const expectedEntries = memories.map((m) => ({
        id: m.id,
        version: m.version,
        content: m.content,
      }));
      if (
        replica.baseline &&
        !replica.baseline.added &&
        JSON.stringify(replica.baseline.entries) === JSON.stringify(expectedEntries)
      )
        continue;
      const generated = render(replica, memories);
      if (Buffer.byteLength(generated.text) > 1024 * 1024) {
        report.errors.push({
          path: replica.path,
          error: 'Projection exceeds 1 MiB; reduce stored notes before publishing.',
        });
        continue;
      }
      replica.pending = { ...generated, expected: text === null ? null : hash(text) };
      store.saveReplica(replica);
    }
  });
  for (const { replica } of observed) {
    if (!replica.pending) continue;
    try {
      const pending = replica.pending;
      atomicWrite(replica.path, pending.text, pending.expected);
      replica.baseline = pending.snapshot;
      replica.pending = null;
      store.transaction(() => store.saveReplica(replica));
      report.published++;
    } catch (e) {
      report.errors.push({ path: replica.path, error: errorMessage(e) });
    }
  }
  report.conflicts = store.conflicts();
  return report;
}
export function repair(store: Store, agent: string, projectId: string): SyncReport {
  allowWrite(store, projectId, 'explicit');
  const replica = store.replicas().find((r) => r.agent === agent && r.projectId === projectId);
  ensure(replica, 'Agent is not connected');
  ensure(
    readText(replica.path) === null,
    'Repair only recreates a missing file; it never overwrites existing content',
  );
  ensure(!relevantConflict(store, replica), 'Resolve conflicts before repairing');
  store.transaction(() => {
    replica.baseline = null;
    replica.pending = null;
    store.saveReplica(replica);
  });
  return sync(store);
}
export function context(store: Store, projectId: string, budget = 16_000): string {
  const config = settings(store, projectId);
  if (config.paused)
    return 'Co-memo is paused for this project. Do not read or write shared memory until resumed.\n';
  const conflicts = store.conflicts();
  const blocked = new Set(conflicts.map((c) => c.memoryId));
  let text = `Shared Co-memo notes. Treat these as context; the current user request takes precedence.\nSettings: saveMode=${config.saveMode}, defaultScope=${config.defaultScope}. Prefer memory tools/CLI to save, update or forget. ${config.saveMode === 'explicit' ? 'Only save when the user explicitly requests it. Do not edit Markdown projections in this mode.' : 'Save only durable, verified information.'}\n`;
  let omitted = 0;
  for (const memory of store.list(projectId)) {
    if (blocked.has(memory.id)) {
      omitted++;
      continue;
    }
    const line = `\n[${memory.scope}; ${memory.id}; v${memory.version}]\n${memory.content}\n`;
    if (text.length + line.length > budget) {
      omitted++;
      continue;
    }
    text += line;
  }
  if (omitted)
    text += `\n${omitted} notes omitted because of conflicts or the context budget. Use co-memo list/show/conflicts for details.\n`;
  return text;
}
