import test from 'node:test';
import assert from 'node:assert/strict';
import { agingCases, evaluateAging } from '../scripts/eval-aging.mjs';

test('aging probe reports old-note rank and context inclusion for every newer-note count', () => {
  const report = evaluateAging();
  assert.equal(report.cases.length, agingCases.cases.length);
  for (const item of report.cases) {
    assert.deepEqual(
      item.runs.map((r) => r.newer),
      agingCases.newerCounts,
    );
    for (const run of item.runs) assert.equal(run.oldAgeDays, agingCases.oldNoteAgeDays, item.id);
    // With no newer notes the old note is the only match, so the fixture itself is sound.
    assert.equal(item.runs[0].rank, 1, item.id);
    assert.equal(item.runs[0].inContext, true, item.id);
  }
  assert.equal(report.summary.length, agingCases.newerCounts.length);
});
