import { randomUUID } from 'node:crypto';
import { submitBatch } from './candidates.js';
import { Review } from './review.js';
import { semanticRanking, hybridSearch } from './semantic.js';
import { z } from 'zod';
import { Store } from './store.js';
import type { SyncReport } from './model.js';
import { Content, ensure, IntentSchema, Version } from './model.js';
import { SettingsPatch, allowWrite, settings } from './settings.js';
import type { Intent } from './settings.js';
import { context, sync, inspectSync } from './sync.js';

export { IntentSchema, Version };
export function projectId(store: Store, root: string): string | null {
  return store.autoProject(root)?.id ?? null;
}
export function requireProjectId(store: Store, root: string): string {
  const id = projectId(store, root);
  ensure(
    id,
    'No project context detected. Supply the agent workspace via --project or projectPath for project memory; use user scope only for cross-project personal information.',
  );
  return id;
}

export function scopedReport(store: Store, root: string, report: SyncReport): SyncReport {
  const id = projectId(store, root);
  const paused = settings(store, id).paused;
  return {
    ...report,
    conflicts: paused
      ? []
      : report.conflicts.filter((c) => {
          const m = store.get(c.memoryId);
          return m.scope === 'user' || m.projectId === id;
        }),
    errors: report.errors,
  };
}
export function configuration(store: Store, root: string) {
  const id = projectId(store, root);
  return {
    user: store.settings(null),
    project: id ? store.settings(id) : {},
    effective: settings(store, id),
  };
}
export function configure(
  store: Store,
  root: string,
  scope: 'user' | 'project',
  patch: SettingsPatch,
  reset = false,
) {
  const id = scope === 'project' ? requireProjectId(store, root) : null;
  store.transaction(() => store.configure(id, patch, reset));
  return configuration(store, root);
}
export function accessible(store: Store, root: string, id: string) {
  const memory = store.get(id);
  ensure(
    memory.scope === 'user' || memory.projectId === projectId(store, root),
    'Memory belongs to another project',
  );
  return memory;
}
function writable(store: Store, root: string, intent: Intent) {
  allowWrite(store, projectId(store, root), intent);
}
export function remember(
  store: Store,
  root: string,
  input: {
    content: string;
    scope?: 'user' | 'project';
    intent: Intent;
    review?: z.input<typeof Review>;
  },
  origin: string,
) {
  const result = submitBatch(
    store,
    root,
    {
      requestId: randomUUID(),
      intent: input.intent,
      candidates: [
        {
          action: 'add',
          content: input.content,
          kind: 'note',
          ...(input.scope ? { scope: input.scope } : {}),
        },
      ],
      ...(input.review ? { review: input.review } : {}),
    },
    [origin],
  );
  if ('status' in result) return result;
  const saved = result.results[0]!;
  const memory = accessible(store, root, saved.receipt!.id);
  return {
    ...result,
    memory,
    created: saved.status === 'created',
    verified: saved.verified,
    notice: memory.deleted ? 'This exact memory is archived; it has not been restored.' : undefined,
  };
}

export function change(
  store: Store,
  root: string,
  input: { id: string; version: number; content: string | null; intent: Intent },
  origin: string,
) {
  if (input.content !== null) Content.parse(input.content);
  writable(store, root, input.intent);
  sync(store);
  accessible(store, root, input.id);
  ensure(
    !store.conflicts().some((c) => c.memoryId === input.id),
    'Memory has a conflict; resolve it explicitly',
  );
  const memory = store.transaction(() =>
    store.change(input.id, input.version, input.content, origin, input.intent),
  );
  return {
    memory,
    verified: true,
    receipt: { id: memory.id, version: memory.version, deleted: memory.deleted },
    sync: scopedReport(store, root, sync(store)),
  };
}
/** Permanent deletion does not ingest unrelated pending edits first. */
export function remove(store: Store, root: string, input: { id: string; version: number }) {
  writable(store, root, 'explicit');
  accessible(store, root, input.id);
  store.transaction(() => store.purge(input.id, input.version));
  // Return derived-cache cleanup errors.
  const report = sync(store);
  return {
    id: input.id,
    permanent: true,
    sync: { ...scopedReport(store, root, report), errors: report.errors },
  };
}
export function restore(
  store: Store,
  root: string,
  input: { id: string; version: number },
  origin: string,
) {
  writable(store, root, 'explicit');
  accessible(store, root, input.id);
  ensure(
    !store.conflicts().some((c) => c.memoryId === input.id),
    'Memory has a conflict; resolve it explicitly',
  );
  const memory = store.transaction(() => store.restore(input.id, input.version, origin));
  return { memory, sync: scopedReport(store, root, sync(store)) };
}
/** Shared CLI/MCP resolution checks both workspace policy and conflict revision. */
export function resolveConflict(
  store: Store,
  root: string,
  input: { id: string; revision: number; take?: string; content?: string },
) {
  writable(store, root, 'explicit');
  const conflict = store.conflicts().find((c) => c.id === input.id);
  ensure(conflict, 'Conflict not found');
  accessible(store, root, conflict.memoryId);
  ensure(
    (input.take !== undefined) !== (input.content !== undefined),
    'Specify exactly one of take or content',
  );
  const memory = store.transaction(() =>
    store.resolve(input.id, input.revision, input.take ?? 'custom', input.content),
  );
  return { memory, sync: scopedReport(store, root, sync(store)) };
}

export function recall(store: Store, root: string, query?: string, deleted = false) {
  const id = projectId(store, root);
  ensure(
    !settings(store, id).paused,
    'Co-memo is paused; resume it in settings before recalling memories',
  );
  const report = inspectSync(store);
  const blocked = new Set(store.conflicts().map((c) => c.memoryId));
  return {
    memories: store
      .search(id, query, deleted)
      .map((m) => ({ ...m, conflicted: blocked.has(m.id) })),
    sync: scopedReport(store, root, report),
  };
}
export function sharedContext(store: Store, root: string, query?: string) {
  const report = inspectSync(store);
  return {
    context: context(store, projectId(store, root), 16_000, query),
    settings: configuration(store, root).effective,
    sync: scopedReport(store, root, report),
  };
}

export const CheckpointInput = z.object({
  reason: z.enum(['task_completed', 'user_correction', 'project_decision']),
  outcome: z.enum(['saved', 'nothing_to_save', 'skipped']),
  receipts: z
    .array(z.object({ id: z.uuid(), version: Version, deleted: z.boolean() }))
    .max(100)
    .default([]),
});
export function checkpoint(store: Store, root: string, input: z.input<typeof CheckpointInput>) {
  const args = CheckpointInput.parse(input);
  ensure(
    (args.outcome === 'saved') === args.receipts.length > 0,
    'Saved requires receipts; other outcomes must not include receipts',
  );
  if (configuration(store, root).effective.paused) return { status: 'paused', verified: false };
  const report = inspectSync(store);
  const conflicts = new Set(store.conflicts().map((c) => c.memoryId));
  for (const receipt of args.receipts) {
    const memory = accessible(store, root, receipt.id);
    ensure(!conflicts.has(memory.id), 'Receipt has an unresolved conflict');
    ensure(
      memory.version === receipt.version && memory.deleted === receipt.deleted,
      'Receipt does not match stored version/deletion state; reread the memory',
    );
  }
  return {
    status: args.outcome,
    reason: args.reason,
    verified: args.outcome === 'saved',
    receipts: args.receipts,
    notice:
      'Verification covers the central store at this instant, not whether another agent loaded the note. Non-save outcomes are agent declarations.',
    sync: scopedReport(store, root, report),
  };
}

/** Read snapshots surround provider I/O; never hold a transaction across an await. */
export async function retrieve(store: Store, root: string, query?: string, deleted = false) {
  const id = store.ensureProject(root)?.id ?? null;
  const ranking = await semanticRanking(store, id, query, deleted);
  return store.read(() => {
    const report = inspectSync(store);
    const effective = configuration(store, root).effective;
    const memories = hybridSearch(store, id, query, deleted, ranking);
    return {
      memories: memories.map((m) => ({ ...m, conflicted: false })),
      context: context(
        store,
        id,
        16000,
        query,
        memories.filter((m) => !m.deleted),
      ),
      settings: effective,
      retrieval: {
        mode: effective.paused ? 'lexical' : ranking.mode,
        reason: effective.paused ? 'paused' : ranking.reason,
      },
      sync: scopedReport(store, root, report),
    };
  });
}
