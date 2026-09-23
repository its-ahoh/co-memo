import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { embeddingConfig, indexEmbeddings } from '../dist/semantic.js';
import { retrieve } from '../dist/service.js';
import { cases, evaluate } from './eval-quality.mjs';

// Explicit opt-in command. Only human-authored fixture texts go to the configured provider.
const config = embeddingConfig();
if (!config)
  throw new Error('Configure and enable semantic retrieval before running eval:semantic');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-semantic-eval-')));
const store = new Store(join(root, 'data'));
try {
  const main = store.project(root, true);
  const foreign = join(root, 'other');
  mkdirSync(foreign);
  const other = store.project(foreign, true);
  const keys = new Map();
  store.lock(() =>
    store.transaction(() => {
      for (const item of cases.memories) {
        const note = store.add(
          item.content,
          item.scope === 'other' ? 'project' : item.scope,
          item.scope === 'other' ? other.id : main.id,
          'evaluation',
          'explicit',
          Metadata.parse({ pinned: item.pinned ?? false, module: item.module ?? null }),
        ).memory;
        keys.set(note.id, item.key);
        if (item.deleted) store.change(note.id, 1, null, 'evaluation');
        if (item.conflicted) store.conflict(note, []);
      }
    }),
  );
  const indexed = await indexEmbeddings(store, main.id);
  if (indexed.failed || indexed.remaining)
    throw new Error('Embedding indexing incomplete; evaluation aborted');
  const details = [];
  for (const item of cases.retrieval) {
    const start = performance.now();
    const result = await retrieve(store, root, item.query);
    const returned = result.memories.slice(0, 5).map((m) => keys.get(m.id));
    const hits = returned.filter((key) => item.relevant.includes(key)).length;
    const rank = returned.findIndex((key) => item.relevant.includes(key));
    details.push({
      id: item.id,
      group: item.group,
      returned,
      retrieval: result.retrieval,
      recallAt5: item.relevant.length ? hits / item.relevant.length : null,
      precisionAt5: returned.length ? hits / returned.length : null,
      reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
      falsePositiveEmptyQuery: !item.relevant.length && returned.length > 0,
      leaked: cases.memories.some(
        (m) =>
          (m.scope === 'other' || m.deleted || m.conflicted) &&
          (returned.includes(m.key) || result.context.includes(m.content)),
      ),
      elapsedMs: performance.now() - start,
    });
  }
  const mean = (values) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const groups = Object.fromEntries(
    ['lexical', 'semantic'].map((group) => {
      const rows = details.filter((r) => r.group === group);
      return [
        group,
        {
          cases: rows.length,
          recallAt5: mean(rows.map((r) => r.recallAt5).filter((v) => v !== null)),
          precisionAt5: mean(rows.map((r) => r.precisionAt5).filter((v) => v !== null)),
          mrr: mean(rows.filter((r) => r.recallAt5 !== null).map((r) => r.reciprocalRank)),
          falsePositiveEmptyQueries: rows.filter((r) => r.falsePositiveEmptyQuery).length,
        },
      ];
    }),
  );
  const fallbackQueries = details.filter((r) => r.retrieval.mode !== 'hybrid').length;
  const leaks = details.filter((r) => r.leaked).length;
  console.log(
    JSON.stringify(
      {
        datasetVersion: cases.version,
        model: config.model,
        threshold: config.threshold,
        status: fallbackQueries ? 'incomplete' : 'scored',
        baseline: evaluate().retrieval.groups,
        hybrid: { groups, leaks, fallbackQueries, details },
      },
      null,
      2,
    ),
  );
  if (
    fallbackQueries ||
    leaks ||
    (process.argv.includes('--check') &&
      (groups.lexical.recallAt5 < 0.9 ||
        groups.lexical.falsePositiveEmptyQueries ||
        groups.semantic.recallAt5 < 0.9))
  )
    process.exitCode = 1;
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
