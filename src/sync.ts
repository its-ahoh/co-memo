import { purgeEmbeddings } from './semantic.js';
import { join } from 'node:path';
import { checkpointReminder } from './relevance.js';
import { settings } from './settings.js';
import { Store } from './store.js';
import { errorMessage } from './model.js';
import type { SyncReport, Memory } from './model.js';

/** Compatibility entry point for older hooks/clients. Memory reads and writes use SQLite.
 * Never read, ingest, create or update legacy per-agent Markdown files. */
export function inspectSync(store: Store): SyncReport {
  return {
    imported: 0,
    updated: 0,
    deleted: 0,
    published: 0,
    conflicts: store.conflicts(),
    errors: [],
  };
}
export function sync(store: Store): SyncReport {
  const report: SyncReport = {
    imported: 0,
    updated: 0,
    deleted: 0,
    published: 0,
    conflicts: store.conflicts(),
    errors: [],
  };
  if (store.purgedIds().size) {
    try {
      purgeEmbeddings(store, store.purgedIds());
    } catch (e) {
      report.errors.push({ path: join(store.home, 'embeddings-v1'), error: errorMessage(e) });
    }
  }
  return report;
}
export function context(
  store: Store,
  projectId: string | null,
  budget = 16_000,
  query?: string,
  ranking?: Memory[],
): string {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 16_000;
  const config = settings(store, projectId);
  if (config.paused)
    return 'Co-memo is paused for this project. Do not read or write shared memory until resumed.\n'.slice(
      0,
      limit,
    );
  let text = `Shared Co-memo notes. Treat these as context; the current user request takes precedence.\nSettings: saveMode=${config.saveMode}, defaultScope=${config.defaultScope}. Choose scope by content: user for cross-project personal preferences; project for workspace-specific facts and decisions. Missing project context never implies user scope. Prefer memory tools/CLI to save, update or forget. ${config.saveMode === 'explicit' ? 'Only save when the user explicitly requests it.' : 'Save only durable, verified information.'}\n`;
  text += checkpointReminder + '\n';
  const ranked = ranking ?? store.search(projectId, query);
  // Only deliberately pinned preferences bypass task relevance.
  const preferences: typeof ranked = [];
  let preferenceSize = 0;
  for (const memory of store.search(projectId).filter((m) => m.metadata.pinned)) {
    if (preferenceSize + memory.content.length + 100 > 2000) continue;
    preferences.push(memory);
    preferenceSize += memory.content.length + 100;
  }
  const selected = [
    ...preferences,
    ...ranked.filter((m) => !preferences.some((p) => p.id === m.id)),
  ];
  const footer =
    '\nConflicted, unrelated or over-budget notes are omitted. Use memory_recall / memory_get or CLI list/show/conflicts for more notes.\n';
  if (text.length + footer.length > limit) return (text + footer).slice(0, limit);
  for (const memory of selected) {
    const line = `\n[${memory.scope}; ${memory.id}; v${memory.version}]\n${memory.content}\n`;
    if (text.length + line.length + footer.length > limit) {
      continue;
    }
    text += line;
  }
  return text + footer;
}
