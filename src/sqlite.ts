import type { DatabaseSync } from 'node:sqlite';

/** Retry acquisition only. Never replay a transaction body, stale version or failed commit. */
export function beginImmediate(db: DatabaseSync, budgetMs = 5000): void {
  const deadline = performance.now() + budgetMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let attempt = 0;
  try {
    for (;;) {
      db.exec(
        `PRAGMA busy_timeout=${Math.max(0, Math.min(250, Math.floor(deadline - performance.now())))};`,
      );
      try {
        db.exec('BEGIN IMMEDIATE');
        return;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (typeof code !== 'number' || (code & 255) !== 5 || performance.now() >= deadline)
          throw error;
        const delay = Math.min(
          10 * 2 ** Math.min(attempt++, 4) + Math.random() * 10,
          deadline - performance.now(),
        );
        if (delay > 0) Atomics.wait(sleeper, 0, 0, delay);
      }
    }
  } finally {
    db.exec('PRAGMA busy_timeout=5000');
  }
}
