import { z } from 'zod';
import { Store } from './store.js';
import type { SyncReport } from './model.js';
import { Content, ensure } from './model.js';
import { SettingsPatch, allowWrite, settings } from './settings.js';
import type { Intent } from './settings.js';
import { context, sync } from './sync.js';

export const IntentSchema = z.enum(['explicit', 'automatic']);
export const Version = z.number().int().positive().safe();
export function projectId(store: Store, root: string): string | null {
  try {
    return store.project(root).id;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Project not connected;')) return null;
    throw e;
  }
}
export function scopedReport(store: Store, root: string, report: SyncReport): SyncReport {
  const id = projectId(store, root);
  const paused = settings(store, id).paused;
  const paths = new Set(
    store
      .replicas()
      .filter((r) => r.projectId === id)
      .map((r) => r.path),
  );
  return {
    ...report,
    conflicts: paused
      ? []
      : report.conflicts.filter((c) => {
          const m = store.get(c.memoryId);
          return m.scope === 'user' || m.projectId === id;
        }),
    errors: report.errors.filter((e) => paths.has(e.path)),
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
  const id = scope === 'project' ? store.project(root).id : null;
  store.transaction(() => store.configure(id, patch, reset));
  return configuration(store, root);
}
export function accessible(store: Store, root: string, id: string) {
  const memory = store.get(id);
  ensure(
    memory.scope === 'user' || memory.projectId === store.project(root).id,
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
  input: { content: string; scope?: 'user' | 'project'; intent: Intent },
  origin: string,
) {
  Content.parse(input.content);
  writable(store, root, input.intent);
  const scope = input.scope ?? configuration(store, root).effective.defaultScope;
  const id = scope === 'project' ? store.project(root).id : null;
  const before = sync(store);
  const result = store.transaction(() => store.add(input.content, scope, id, origin, input.intent));
  return {
    ...result,
    ...(result.memory.deleted
      ? { notice: 'This exact memory was deleted; it has not been resurrected.' }
      : {}),
    sync: scopedReport(store, root, sync(store)),
    priorErrors: scopedReport(store, root, before).errors,
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
  return { memory, sync: scopedReport(store, root, sync(store)) };
}
export function recall(store: Store, root: string, query?: string, deleted = false) {
  const id = store.project(root).id;
  ensure(
    !settings(store, id).paused,
    'Co-memo is paused; resume it in settings before recalling memories',
  );
  const report = sync(store);
  const blocked = new Set(store.conflicts().map((c) => c.memoryId));
  return {
    memories: store
      .list(id, deleted)
      .filter((m) => !query || m.content.toLowerCase().includes(query.toLowerCase()))
      .map((m) => ({ ...m, conflicted: blocked.has(m.id) })),
    sync: scopedReport(store, root, report),
  };
}
export function sharedContext(store: Store, root: string) {
  const report = sync(store);
  return {
    context: context(store, store.project(root).id),
    settings: configuration(store, root).effective,
    sync: scopedReport(store, root, report),
  };
}
