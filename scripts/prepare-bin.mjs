import { chmodSync, cpSync } from 'node:fs';
chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);

cpSync(new URL('../src/ui', import.meta.url), new URL('../dist/ui', import.meta.url), {
  recursive: true,
});
