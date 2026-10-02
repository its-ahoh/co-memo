import { Review, reviewCandidates } from './review.js';
import { projectId as resolveProjectId, requireProjectId } from './service.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Content,
  Scope,
  Evidence,
  MemoryKind,
  Metadata,
  ensure,
  hash,
  IntentSchema,
  Version,
} from './model.js';
import type { Store } from './store.js';
import { allowWrite } from './settings.js';
import { sync } from './sync.js';
import { accessible, configuration, scopedReport } from './service.js';

const details = {
  content: Content,
  kind: MemoryKind,
  source: Evidence.nullable().default(null),
  module: z.string().trim().min(1).max(300).nullable().default(null),
  pinned: z.boolean().default(false),
};
export const Candidate = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), scope: Scope.optional(), ...details }),
  z.strictObject({
    action: z.literal('update'),
    id: z.uuid(),
    version: Version,
    basis: z.enum(['user_correction', 'verified_change']),
    ...details,
  }),
  z.strictObject({ action: z.literal('conflict'), id: z.uuid(), version: Version, ...details }),
  z.strictObject({ action: z.literal('skip'), reason: z.string().trim().min(1).max(1000) }),
]);
export const Submission = z.strictObject({
  requestId: z
    .uuid()
    .describe(
      'A UUID, for example a newly generated random UUID. Reuse only for identical retries; descriptive labels are invalid.',
    ),
  intent: IntentSchema,
  candidates: z.array(Candidate).min(1).max(20),
  review: Review.optional(),
});
const Receipt = z.object({ id: z.uuid(), version: Version, deleted: z.boolean() });
const Result = z.object({
  action: z.enum(['add', 'update', 'conflict', 'skip']),
  status: z.enum([
    'created',
    'updated',
    'existing',
    'deleted_duplicate',
    'needs_resolution',
    'skipped',
    'needs_review',
    'conflict_closed',
  ]),
  receipt: Receipt.optional(),
  conflictId: z.uuid().optional(),
  conflictRevision: Version.optional(),
  reason: z.string().optional(),
});
const Results = z.array(Result);

/** Call under Store.lock. Atomic candidate batch; model judgments remain caller declarations. */
export const Preparation = Submission.omit({ requestId: true, review: true });
export function prepare(store: Store, root: string, input: z.input<typeof Preparation>) {
  const args = Preparation.parse(input);
  return reviewCandidates(store, resolveProjectId(store, root), args.candidates, args.intent);
}
export function submit(store: Store, root: string, input: z.input<typeof Submission>) {
  return submitBatch(store, root, Submission.parse(input));
}

/** Shared write pipeline. Imports accept up to 100 notes; public agent batches are capped at 20. */
export function submitBatch(
  store: Store,
  root: string,
  input: z.input<typeof Submission>,
  origins: string[] = [],
) {
  const args = Submission.extend({ candidates: z.array(Candidate).min(1).max(100) }).parse(input);
  const projectId = resolveProjectId(store, root);
  allowWrite(store, projectId, args.intent);
  // Reusing another configured agent's receipt must not masquerade as this agent's write.
  // Preserve the old hash for unbound clients and their existing retries.
  const fingerprint = hash(
    JSON.stringify(store.sourceAgent === null ? args : { ...args, sourceAgent: store.sourceAgent }),
  );
  const before = sync(store);
  // Empty namespace is reserved for personal submissions; project IDs are UUIDs.
  const submissionScope = projectId ?? '';
  const previous = store.submission(submissionScope, args.requestId);
  let results: z.infer<typeof Results>;
  if (previous) {
    // Schema 7 receipts used the old identity key in their fingerprint; retain valid retries.
    ensure(
      previous.fingerprint === fingerprint ||
        (store.sourceAgent !== null &&
          previous.fingerprint ===
            hash(JSON.stringify({ ...args, writerAgent: store.sourceAgent }))),
      'Request ID was already used with different candidates',
    );
    results = Results.parse(previous.result);
  } else {
    const review = reviewCandidates(store, projectId, args.candidates, args.intent);
    if ((review.required && !args.review) || (args.review && args.review.token !== review.token)) {
      return {
        requestId: args.requestId,
        replayed: false,
        status: 'needs_review',
        review,
        results: args.candidates.map((candidate) => ({
          action: candidate.action,
          status: 'needs_review',
          verified: false,
        })),
        sync: scopedReport(store, root, before),
        priorErrors: scopedReport(store, root, before).errors,
        notice:
          'Nothing was saved. Review related memories and choose add, update, conflict or skip. Submit revised actions without the old review, or confirm unchanged distinct additions with this token and a reason.',
      };
    }
    results = store.transaction(() => {
      const targets = new Set<string>();
      const apply = (
        candidate: z.infer<typeof Candidate>,
        index: number,
      ): z.infer<typeof Result> => {
        if (candidate.action === 'skip')
          return { action: 'skip', status: 'skipped', reason: candidate.reason };
        ensure(
          !candidate.pinned || candidate.kind === 'preference',
          'Only preferences can be pinned',
        );
        const metadata = Metadata.parse({
          kind: candidate.kind,
          source: candidate.source,
          module: candidate.module,
          pinned: candidate.pinned,
          basis: candidate.action === 'update' ? candidate.basis : null,
        });
        if (candidate.action === 'add') {
          const scope = candidate.scope ?? configuration(store, root).effective.defaultScope;
          const { memory, created } = store.add(
            candidate.content,
            scope,
            scope === 'project' ? requireProjectId(store, root) : null,
            origins[index] ?? 'candidate:' + (candidate.source?.agent ?? 'unknown'),
            args.intent,
            metadata,
          );
          ensure(
            !store.conflicts().some((c) => c.memoryId === memory.id),
            'Existing duplicate has a conflict; resolve it explicitly',
          );
          return {
            action: 'add',
            status: memory.deleted ? 'deleted_duplicate' : created ? 'created' : 'existing',
            receipt: { id: memory.id, version: memory.version, deleted: memory.deleted },
          };
        }
        ensure(!targets.has(candidate.id), 'A memory can be targeted only once per submission');
        targets.add(candidate.id);
        const old = accessible(store, root, candidate.id);
        allowWrite(store, old.projectId, args.intent);
        ensure(old.version === candidate.version, 'Version changed; read the memory again');
        ensure(!old.deleted, 'Deleted memory cannot be revived by a candidate');
        ensure(
          candidate.action === 'conflict' || !store.conflicts().some((c) => c.memoryId === old.id),
          'Memory has a conflict; resolve it explicitly',
        );
        if (candidate.action === 'conflict') {
          const conflict = store.conflict(
            old,
            [],
            [{ id: randomUUID(), content: candidate.content, metadata }],
          );
          return {
            action: 'conflict',
            status: 'needs_resolution',
            conflictId: conflict.id,
            conflictRevision: conflict.revision,
          };
        }
        const memory = store.change(
          old.id,
          old.version,
          candidate.content,
          origins[index] ?? 'candidate:' + (candidate.source?.agent ?? 'unknown'),
          args.intent,
          metadata,
        );
        return {
          action: 'update',
          status: 'updated',
          receipt: { id: memory.id, version: memory.version, deleted: memory.deleted },
        };
      };
      // Updates/conflicts establish the final existing-note state before deduplicating adds.
      // Keep response order identical to the caller's candidate order.
      const output = new Array<z.infer<typeof Result>>(args.candidates.length);
      const order = args.candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort(
          (a, b) => Number(a.candidate.action === 'add') - Number(b.candidate.action === 'add'),
        );
      for (const { candidate, index } of order) output[index] = apply(candidate, index);
      store.saveSubmission(submissionScope, args.requestId, fingerprint, output);
      return output;
    });
  }
  const report = sync(store);
  const checked = results.map((result) => {
    if (result.conflictId) {
      const current = report.conflicts.find((c) => c.id === result.conflictId);
      return {
        ...result,
        status: current ? result.status : ('conflict_closed' as const),
        verified: false,
        verification: !current
          ? 'closed'
          : current.revision === result.conflictRevision
            ? 'current'
            : 'stale',
        ...(current ? { currentConflictRevision: current.revision } : {}),
      };
    }
    if (!result.receipt) return { ...result, verified: false };
    const current = accessible(store, root, result.receipt.id);
    const matches =
      current.version === result.receipt.version && current.deleted === result.receipt.deleted;
    return {
      ...result,
      verified:
        result.status !== 'deleted_duplicate' &&
        matches &&
        !store.conflicts().some((c) => c.memoryId === current.id),
      verification: matches ? 'current' : 'stale',
    };
  });
  return {
    requestId: args.requestId,
    replayed: previous !== null,
    results: checked,
    sync: scopedReport(store, root, report),
    priorErrors: scopedReport(store, root, before).errors,
    notice:
      'Verified means the central store matches the receipt now, not that another agent loaded it. Source evidence and update basis are agent declarations. Exact duplicates retain their existing metadata; review them before updating. No semantic deduplication is performed.',
  };
}
