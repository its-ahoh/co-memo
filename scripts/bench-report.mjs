// Usage: node scripts/bench-report.mjs baseline.json [rerun.json ...] > report.md
// Later files replace earlier files' results for the same arm.
import { readFileSync } from 'node:fs';
import { render } from '../evals/bench/report.mjs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Pass one or more benchmark JSON files');
process.stdout.write(render(files.map((f) => JSON.parse(readFileSync(f, 'utf8')))));
