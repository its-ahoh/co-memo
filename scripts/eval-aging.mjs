// Aging probe: does an old, still-valid note stay findable as newer look-alike notes pile up?
// Report only, no pass/fail gate. Run it before adding any time decay to ranking.
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store } from '../dist/store.js';
import { Metadata } from '../dist/model.js';
import { context } from '../dist/sync.js';

export const agingCases = JSON.parse(
  readFileSync(new URL('../evals/aging-cases.json', import.meta.url), 'utf8'),
);
const DAY = 86_400_000;

/** Run one case with `count` newer notes in a fresh store; the clock is faked so ages are realistic. */
function probe(item, count, now) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'co-memo-aging-')));
  const store = new Store(join(root, 'data'));
  const realNow = Date.now;
  try {
    const project = store.project(root, true);
    let oldId;
    store.transaction(() => {
      try {
        Date.now = () => now - agingCases.oldNoteAgeDays * DAY;
        oldId = store.add(
          item.old.content,
          'project',
          project.id,
          'evaluation',
          'explicit',
          Metadata.parse({ kind: item.old.kind }),
        ).memory.id;
        for (let i = 0; i < count; i++) {
          // Spread newer notes evenly over the recent window, oldest first.
          Date.now = () => now - ((count - i) / count) * agingCases.newerNotesWithinDays * DAY;
          store.add(
            item.newer.replaceAll('{i}', String(i + 1)),
            'project',
            project.id,
            'evaluation',
          );
        }
      } finally {
        Date.now = realNow;
      }
    });
    const results = store.search(project.id, item.query);
    const index = results.findIndex((m) => m.id === oldId);
    const injected = context(store, project.id, 16_000, item.query);
    return {
      newer: count,
      // Read back from the store so the report proves the faked clock took effect.
      oldAgeDays: Math.round((now - store.get(oldId).createdAt) / DAY),
      rank: index < 0 ? null : index + 1,
      inTop5: index >= 0 && index < 5,
      inContext: injected.includes(`; ${oldId};`),
      contextNotes: (injected.match(/\n\[project; /g) ?? []).length,
    };
  } finally {
    Date.now = realNow;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export function evaluateAging({ now = Date.UTC(2026, 0, 1) } = {}) {
  const cases = agingCases.cases.map((item) => ({
    id: item.id,
    query: item.query,
    runs: agingCases.newerCounts.map((count) => probe(item, count, now)),
  }));
  const at = (count) => cases.map((c) => c.runs.find((r) => r.newer === count));
  return {
    datasetVersion: agingCases.version,
    note: 'Ranking today ignores note age; ties are broken by insertion order (newer first). This probe only shows whether old notes get buried, not whether decay would help.',
    summary: agingCases.newerCounts.map((count) => ({
      newer: count,
      oldInTop5: at(count).filter((r) => r.inTop5).length,
      oldInContext: at(count).filter((r) => r.inContext).length,
      cases: cases.length,
    })),
    cases,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(evaluateAging(), null, 2));
}
