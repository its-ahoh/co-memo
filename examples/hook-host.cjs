#!/usr/bin/env node
// Runnable generic host lifecycle example; no model calls or client config changes.
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const config = process.argv[2];
if (!config) { process.stderr.write('Usage: node examples/hook-host.cjs /absolute/host.json [task]\n'); process.exit(1); }
function hook(command, payload) {
  const result = spawnSync(process.execPath, [resolve(__dirname, '../dist/cli.js'), command, '--config', resolve(config)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}
try {
  const task = process.argv[3] || 'Review the project';
  const { context, memories } = hook('hook-start', { query: task });
  // A real host passes this context as source-backed data to its engine here.
  process.stdout.write(JSON.stringify({ task, context, memories }, null, 2) + '\n');
  // Replace {} with a supported {content,evidence} proposal from the execution.
  // Never pass unfiltered transcripts or copy instructions from memory as system rules.
  const completion = hook('hook-end', {});
  process.stdout.write(JSON.stringify(completion) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
