import { readFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { context } from '../dist/sync.js';

export const cases = JSON.parse(
  readFileSync(new URL('../evals/quality-cases.json', import.meta.url), 'utf8'),
);
const normalize = (s) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s。.!！]+/gu, ' ')
    .trim();
const Prediction = z.strictObject({
  run: z.strictObject({
    agent: z.string().min(1),
    model: z.string().min(1),
    timestamp: z.iso.datetime(),
  }),
  cases: z.array(
    z.strictObject({
      caseId: z.string(),
      memories: z.array(
        z.strictObject({
          content: z.string(),
          kind: z.enum(['note', 'preference', 'decision', 'constraint', 'lesson']),
          scope: z.enum(['user', 'project']),
          sourceMessageId: z.string(),
          replaces: z.string().optional(),
        }),
      ),
    }),
  ),
});
export function extractionMetrics(input) {
  const predictions = Prediction.parse(input);
  const seen = new Set();
  for (const result of predictions.cases) {
    if (seen.has(result.caseId) || !cases.extraction.some((c) => c.id === result.caseId))
      throw new Error('Duplicate or unknown extraction case');
    seen.add(result.caseId);
  }
  let tp = 0,
    fp = 0,
    fn = 0;
  const details = cases.extraction.map((item) => {
    const predicted = predictions.cases.find((p) => p.caseId === item.id)?.memories ?? [];
    const unmatched = new Set(item.expected.map((_, i) => i));
    let hits = 0;
    for (const note of predicted) {
      const match = [...unmatched].find((i) => {
        const expected = item.expected[i];
        return (
          expected.kind === note.kind &&
          expected.scope === note.scope &&
          expected.sourceMessageId === note.sourceMessageId &&
          expected.replaces === note.replaces &&
          expected.aliases.some((alias) => normalize(alias) === normalize(note.content))
        );
      });
      if (match !== undefined) {
        unmatched.delete(match);
        hits++;
      }
    }
    tp += hits;
    fp += predicted.length - hits;
    fn += unmatched.size;
    return {
      id: item.id,
      supplied: seen.has(item.id),
      correct: hits,
      falsePositives: predicted.length - hits,
      missed: unmatched.size,
    };
  });
  const complete = seen.size === cases.extraction.length;
  return {
    status: complete ? 'scored' : 'incomplete',
    run: predictions.run,
    grading:
      'Strict human-authored aliases, scope, kind, evidence-message ID and replacement target; not semantic grading. Inspect false negatives manually.',
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    falsePositives: fp,
    missed: fn,
    details,
  };
}
export function evaluate(predictions, { distractors = 0 } = {}) {
  z.number().int().min(0).max(100000).parse(distractors);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-quality-')));
  const store = new Store(join(root, 'data'));
  try {
    const main = store.project(root, true);
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    const other = store.project(foreign, true);
    const keys = new Map();
    store.transaction(() => {
      for (const item of cases.memories) {
        const note = store.add(
          item.content,
          item.scope === 'other' ? 'project' : item.scope,
          item.scope === 'other' ? other.id : main.id,
          'evaluation',
          'explicit',
          Metadata.parse({
            kind: item.pinned ? 'preference' : 'note',
            pinned: item.pinned ?? false,
            module: item.module ?? null,
          }),
        ).memory;
        keys.set(note.id, item.key);
        if (item.deleted) store.change(note.id, 1, null, 'evaluation');
        if (item.conflicted) store.conflict(note, []);
      }
    });
    store.transaction(() => {
      for (let i = 0; i < distractors; i++) {
        const foreign = i % 5 === 0;
        const content = `Historical task ${i}: ${i % 2 ? 'pnpm formatting configuration' : 'parser module documentation'} archive.`;
        const memory = store.add(
          content,
          'project',
          foreign ? other.id : main.id,
          'synthetic-distractor',
        ).memory;
        keys.set(memory.id, foreign ? `forbidden-noise-${i}` : `noise-${i}`);
      }
    });
    const details = cases.retrieval.map((item) => {
      const start = performance.now();
      const found = store
        .search(main.id, item.query)
        .slice(0, 5)
        .map((m) => keys.get(m.id));
      const elapsedMs = performance.now() - start;
      const hit = found.filter((key) => item.relevant.includes(key)).length;
      const rank = found.findIndex((key) => item.relevant.includes(key));
      const injected = context(store, main.id, 16000, item.query);
      const forbidden = cases.memories.filter(
        (m) => m.scope === 'other' || m.deleted || m.conflicted,
      );
      return {
        id: item.id,
        group: item.group,
        returned: found,
        relevant: item.relevant,
        recallAt5: item.relevant.length ? hit / item.relevant.length : null,
        precisionAt5: found.length ? hit / found.length : null,
        reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
        falsePositiveEmptyQuery: item.relevant.length === 0 && found.length > 0,
        leaked:
          found.some((key) => key?.startsWith('forbidden-noise-')) ||
          forbidden.some((m) => found.includes(m.key) || injected.includes(m.content)),
        contextWithinBudget: injected.length <= 16000,
        elapsedMs,
      };
    });
    const mean = (items) => (items.length ? items.reduce((a, b) => a + b, 0) / items.length : null);
    const groups = Object.fromEntries(
      ['lexical', 'semantic'].map((group) => {
        const rows = details.filter((r) => r.group === group);
        return [
          group,
          {
            cases: rows.length,
            recallAt5: mean(rows.map((r) => r.recallAt5).filter((v) => v !== null)),
            precisionAt5: mean(rows.map((r) => r.precisionAt5).filter((v) => v !== null)),
            mrr: mean(rows.filter((r) => r.relevant.length).map((r) => r.reciprocalRank)),
            falsePositiveEmptyQueries: rows.filter((r) => r.falsePositiveEmptyQuery).length,
          },
        ];
      }),
    );
    return {
      datasetVersion: cases.version,
      distractors,
      corpusSize: cases.memories.length + distractors,
      runtime: process.version,
      retrieval: {
        groups,
        leaks: details.filter((r) => r.leaked).length,
        contextBudgetViolations: details.filter((r) => !r.contextWithinBudget).length,
        p95Ms: details.map((r) => r.elapsedMs).sort((a, b) => a - b)[
          Math.ceil(details.length * 0.95) - 1
        ],
        details,
      },
      extraction: predictions
        ? extractionMetrics(predictions)
        : {
            status: 'not_run',
            reason:
              'No actual agent extraction output supplied. Storage tests are not extraction accuracy.',
          },
    };
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--extraction-inputs')) {
    console.log(
      JSON.stringify(
        {
          instruction:
            'Extract only durable, supported memories; honor pause and explicit-only settings. Return caseId and memories (content/kind/scope/sourceMessageId and replaces for corrections); return an empty array when nothing should be saved. Do not write memories to any real store.',
          cases: cases.extraction.map(({ expected: _expected, ...input }) => input),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const fileIndex = args.indexOf('--extractions');
  if (fileIndex >= 0 && !args[fileIndex + 1]) throw new Error('--extractions requires a JSON file');
  const scaleIndex = args.indexOf('--distractors');
  const distractors = scaleIndex < 0 ? 0 : Number(args[scaleIndex + 1]);
  const report = evaluate(
    fileIndex < 0 ? undefined : JSON.parse(readFileSync(args[fileIndex + 1], 'utf8')),
    { distractors },
  );
  console.log(JSON.stringify(report, null, 2));
  if (
    args.includes('--check') &&
    (report.retrieval.leaks ||
      report.retrieval.contextBudgetViolations ||
      report.retrieval.groups.lexical.recallAt5 < 0.9 ||
      report.retrieval.groups.lexical.falsePositiveEmptyQueries ||
      (fileIndex >= 0 &&
        (report.extraction.status !== 'scored' ||
          report.extraction.missed ||
          report.extraction.falsePositives)))
  )
    process.exitCode = 1;
}
