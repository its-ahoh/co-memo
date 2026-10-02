import { z } from 'zod';
import { hash, ensure } from './model.js';
import type { Memory, Scope } from './model.js';
import type { Store } from './store.js';
import { searchTerms } from './relevance.js';
import { settings, allowWrite } from './settings.js';

export const Review = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(1000),
});
export type ReviewCandidate =
  | { action: 'skip'; reason: string }
  | { action: 'add'; content: string; scope?: 'user' | 'project' | undefined }
  | { action: 'update' | 'conflict'; content: string; id: string; version: number };

/** Call with the process lock held, including the subsequent commit. Similarity is not truth. */
export function reviewCandidates(
  store: Store,
  projectId: string | null,
  candidates: ReviewCandidate[],
  intent: 'automatic' | 'explicit',
) {
  allowWrite(store, projectId, intent);
  const config = settings(store, projectId);
  const conflicts = new Map(store.conflicts().map((c) => [c.memoryId, c]));
  // Validate all targets before examining peers, including cross-project candidates.
  const targets = new Map<string, Memory>();
  const scopes = candidates.map((candidate) => {
    if (candidate.action === 'skip') return null;
    if (candidate.action !== 'add') {
      ensure(!targets.has(candidate.id), 'A memory can be targeted only once per submission');
      const target = store.get(candidate.id);
      ensure(
        target.scope === 'user' || target.projectId === projectId,
        'Memory belongs to another project',
      );
      allowWrite(store, target.projectId, intent);
      ensure(target.version === candidate.version, 'Version changed; read the memory again');
      targets.set(candidate.id, target);
      return target.scope;
    }
    const scope = candidate.scope ?? config.defaultScope;
    ensure(
      scope !== 'project' || projectId,
      'No project context detected; supply projectPath or --project',
    );
    return scope;
  });
  // Bound the display, not freshness. Scope snapshots also cover low-ranked matches,
  // deletions, and newly appended conflict evidence. Load each scope only once.
  const snapshots = new Map<Scope, Memory[]>();
  for (const scope of scopes) {
    if (scope && !snapshots.has(scope))
      snapshots.set(
        scope,
        store.list(scope === 'user' ? null : projectId, true).filter((m) => m.scope === scope),
      );
  }
  const state = [...snapshots].map(([scope, memories]) => [
    scope,
    memories.map((m) => [m.id, m.version, m.deleted, conflicts.get(m.id)?.revision ?? null]),
  ]);
  const items = candidates.map((candidate, index) => {
    if (candidate.action === 'skip')
      return { index, action: candidate.action, related: [], peers: [] };
    const target = candidate.action === 'add' ? null : targets.get(candidate.id)!;
    const scope = scopes[index]!;
    const withinScope = snapshots.get(scope)!;
    const exact =
      withinScope.find((m) => !m.deleted && m.content === candidate.content) ??
      withinScope.find((m) => m.content === candidate.content);
    const found = store
      .search(scope === 'user' ? null : projectId, candidate.content, true, true, scope)
      .filter((m) => m.scope === scope)
      .slice(0, 10);
    const related = [
      ...new Map(
        [...(exact ? [exact] : []), ...(target ? [target] : []), ...found].map((m) => [m.id, m]),
      ).values(),
    ].map((m) => ({
      id: m.id,
      version: m.version,
      content: m.content,
      scope: m.scope,
      projectId: m.projectId,
      deleted: m.deleted,
      metadata: m.metadata,
      match: m.content === candidate.content ? 'exact' : 'related',
      conflict: conflicts.get(m.id) ?? null,
    }));
    const terms = new Set(searchTerms(candidate.content));
    const peers = candidates.flatMap((other, otherIndex) => {
      if (
        otherIndex === index ||
        other.action === 'skip' ||
        candidate.action !== 'add' ||
        scopes[otherIndex] !== scope ||
        (other.action === 'add' && other.content === candidate.content)
      )
        return [];
      return other.content === candidate.content ||
        (other.action !== 'add' && targets.get(other.id)?.content === candidate.content) ||
        searchTerms(other.content).some((term) => terms.has(term))
        ? [otherIndex]
        : [];
    });
    return {
      index,
      action: candidate.action,
      related,
      peers,
      needsReview:
        candidate.action === 'add' &&
        !(exact && !targets.has(exact.id)) &&
        (related.length > 0 || peers.length > 0),
    };
  });
  return {
    required: items.some((item) => item.needsReview),
    token: hash(JSON.stringify({ projectId, intent, candidates, items, state })),
    items,
    guidance:
      'Lexical matches are review candidates, not proof of duplication or contradiction. Compare scope, conditions and evidence. Skip equivalent facts; update the existing ID for an explicit correction or verified change; submit conflict for uncertain contradictions. Add distinct facts only after review. Never merge based solely on similarity. Return this token and a reason with an unchanged submission to confirm distinct additions. If candidates change, submit them without the old review. Any change in a reviewed scope invalidates the token, including records outside the displayed matches. Batch peers include planned updates/conflicts; those run before additions. Prepare is an optional preview. All creation entry points enforce this review.',
  };
}
