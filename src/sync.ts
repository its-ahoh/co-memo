import { purgeEmbeddings } from './semantic.js';
import { join } from 'node:path';
import { checkpointReminder, contextFilter, contextTerms, searchTerms } from './relevance.js';
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
const pinnedLimit = 2000;
const pinnedOverhead = 100;
export function contextSelection(
  store: Store,
  projectId: string | null,
  budget = 16_000,
  query?: string,
  ranking?: Memory[],
  semanticMatches: ReadonlyMap<string, number> = new Map(),
  explain = false,
  // Prompt-time hooks repeat on every turn; full guidance is delivered once at session start.
  brief = false,
) {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 16_000;
  const config = settings(store, projectId);
  const included = new Map<string, string>();
  const budgetSkipped = new Set<string>();
  const pinnedSkipped = new Set<string>();
  const personalSkipped = new Set<string>();
  const candidates = new Set<string>();
  const conflicts = new Set<string>();
  const terms = contextTerms(query);
  const unfiltered = !query?.trim();
  const finish = (text: string) => ({
    context: text,
    ...(explain
      ? {
          explanation: {
            paused: config.paused,
            queryTerms: config.paused ? [] : terms,
            budget: { unit: 'utf16_code_units', limit, used: text.length, pinnedLimit },
            // Pause must not inspect or disclose stored notes. Only current scope is enumerated.
            notes: config.paused
              ? []
              : store.list(projectId, true).map((memory) => {
                  const indexed = new Set(
                    searchTerms(memory.content + ' ' + (memory.metadata.module ?? '')),
                  );
                  const conflicted = conflicts.has(memory.id);
                  const reason = memory.deleted
                    ? 'deleted'
                    : conflicted
                      ? 'conflict'
                      : (included.get(memory.id) ??
                        (budgetSkipped.has(memory.id)
                          ? 'context_budget'
                          : pinnedSkipped.has(memory.id)
                            ? 'pinned_budget'
                            : personalSkipped.has(memory.id)
                              ? 'personal_without_query'
                              : !candidates.has(memory.id)
                                ? 'not_retrieved'
                                : 'task_mismatch'));
                  return {
                    id: memory.id,
                    version: memory.version,
                    scope: memory.scope,
                    included: included.has(memory.id),
                    reason,
                    matchedTerms: terms.filter((term) => indexed.has(term)),
                    characters: memory.content.length,
                  };
                }),
          },
        }
      : {}),
  });
  if (config.paused)
    return finish(
      'Co-memo is paused for this project. Do not read or write shared memory until resumed.\n'.slice(
        0,
        limit,
      ),
    );
  if (explain) for (const conflict of store.conflicts()) conflicts.add(conflict.memoryId);
  const saving =
    config.saveMode === 'explicit'
      ? 'Only save when the user explicitly requests it.'
      : 'Save only durable, verified information.';
  let text = brief
    ? `Shared Co-memo notes (saveMode=${config.saveMode}, defaultScope=${config.defaultScope}; the current user request takes precedence). ${saving} Before the final reply, check whether memory needs updating.\n`
    : `Shared Co-memo notes. Treat these as context; the current user request takes precedence.\nSettings: saveMode=${config.saveMode}, defaultScope=${config.defaultScope}. Choose scope by content: user for cross-project personal preferences; project for workspace-specific facts and decisions. Missing project context never implies user scope. Prefer memory tools/CLI to save, update or forget. ${saving}\n` +
      checkpointReminder +
      '\n';
  const matches = contextFilter(query);
  const retrieved = ranking ?? store.search(projectId, query);
  for (const memory of retrieved) candidates.add(memory.id);
  const ranked = retrieved.filter((m) => {
    if (!(semanticMatches.get(m.id) === m.version || matches(m))) return false;
    // In a project without a task, personal facts from other work are noise; preferences
    // still apply. Projectless sessions have only personal notes, so they keep them all.
    if (
      unfiltered &&
      projectId !== null &&
      m.scope === 'user' &&
      m.metadata.kind !== 'preference'
    ) {
      personalSkipped.add(m.id);
      return false;
    }
    return true;
  });
  // Only deliberately pinned preferences bypass task relevance.
  const preferences: typeof ranked = [];
  let preferenceSize = 0;
  for (const memory of store.search(projectId).filter((m) => m.metadata.pinned)) {
    if (preferenceSize + memory.content.length + pinnedOverhead > pinnedLimit) {
      pinnedSkipped.add(memory.id);
      continue;
    }
    preferences.push(memory);
    preferenceSize += memory.content.length + pinnedOverhead;
  }
  const pinned = new Set(preferences.map((p) => p.id));
  const selected = [...preferences, ...ranked.filter((m) => !pinned.has(m.id))];
  const footer =
    '\nConflicted, unrelated or over-budget notes are omitted. Use memory_recall / memory_get or CLI list/show/conflicts for more notes.\n';
  if (text.length + footer.length > limit) {
    for (const memory of selected) budgetSkipped.add(memory.id);
    return finish((text + footer).slice(0, limit));
  }
  for (const memory of selected) {
    const line = `\n[${memory.scope}; ${memory.id}; v${memory.version}]\n${memory.content}\n`;
    if (text.length + line.length + footer.length > limit) {
      budgetSkipped.add(memory.id);
      continue;
    }
    included.set(
      memory.id,
      pinned.has(memory.id)
        ? 'pinned'
        : semanticMatches.get(memory.id) === memory.version
          ? 'semantic'
          : unfiltered
            ? 'unfiltered'
            : 'lexical',
    );
    text += line;
  }
  return finish(text + footer);
}

/** Plain context stays byte-for-byte compatible; diagnostics are opt-in. */
export function context(
  store: Store,
  projectId: string | null,
  budget = 16_000,
  query?: string,
  ranking?: Memory[],
  semanticMatches: ReadonlyMap<string, number> = new Map(),
  brief = false,
): string {
  return contextSelection(store, projectId, budget, query, ranking, semanticMatches, false, brief)
    .context;
}
