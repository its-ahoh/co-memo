import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Content, Scope, Evidence, MemoryKind, Metadata, ensure, hash } from './model.js';
import type { Store } from './store.js';
import { allowWrite } from './settings.js';
import { sync } from './sync.js';
import { accessible, configuration, scopedReport, IntentSchema, Version } from './service.js';

const details = {
  content: Content,
  kind: MemoryKind,
  source: Evidence,
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
  requestId: z.uuid(),
  intent: IntentSchema,
  candidates: z.array(Candidate).min(1).max(20),
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
  ]),
  receipt: Receipt.optional(),
  conflictId: z.uuid().optional(),
  reason: z.string().optional(),
});
const Results = z.array(Result);

/** Call under Store.lock. Atomic candidate batch; model judgments remain caller declarations. */
export function submit(store: Store, root: string, input: z.input<typeof Submission>) {
  const args = Submission.parse(input);
  const projectId = store.project(root).id;
  allowWrite(store, projectId, args.intent);
  const fingerprint = hash(JSON.stringify(args));
  const before = sync(store);
  const previous = store.submission(projectId, args.requestId);
  let results: z.infer<typeof Results>;
  if (previous) {
    ensure(
      previous.fingerprint === fingerprint,
      'Request ID was already used with different candidates',
    );
    results = Results.parse(previous.result);
  } else {
    results = store.transaction(() => {
      const targets = new Set<string>();
      const output = args.candidates.map((candidate): z.infer<typeof Result> => {
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
            scope === 'project' ? projectId : null,
            'candidate:' + candidate.source.agent,
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
          !store.conflicts().some((c) => c.memoryId === old.id),
          'Memory has a conflict; resolve it explicitly',
        );
        if (candidate.action === 'conflict') {
          const conflict = store.conflict(
            old,
            [],
            [{ id: randomUUID(), content: candidate.content, metadata }],
          );
          return { action: 'conflict', status: 'needs_resolution', conflictId: conflict.id };
        }
        const memory = store.change(
          old.id,
          old.version,
          candidate.content,
          'candidate:' + candidate.source.agent,
          args.intent,
          metadata,
        );
        return {
          action: 'update',
          status: 'updated',
          receipt: { id: memory.id, version: memory.version, deleted: memory.deleted },
        };
      });
      store.saveSubmission(projectId, args.requestId, fingerprint, output);
      return output;
    });
  }
  const report = sync(store);
  const checked = results.map((result) => {
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
