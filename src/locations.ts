import { join } from 'node:path';
import { Store } from './store.js';
import { readText } from './fs.js';
import { parse } from './document.js';
import type { Memory } from './model.js';

/** Inspect registered files once per request; never synchronize or modify them. */
export function locationReader(store: Store) {
  const replicas = store.replicas().map((replica) => {
    try {
      const text = readText(replica.path);
      if (text === null) return { replica, state: 'missing' as const, entries: [] };
      const entries = parse(text, replica.id).entries.map((entry) => ({
        ...entry,
        line:
          text
            .split('\n')
            .findIndex(
              (line) => line.trim() === `<!-- co-memo:memory ${entry.id} ${entry.version} -->`,
            ) + 2,
      }));
      return { replica, state: 'readable' as const, entries };
    } catch {
      return { replica, state: 'unreadable' as const, entries: [] };
    }
  });
  return (memory: Memory) => ({
    database: join(store.home, 'shared-memory-v1.sqlite'),
    table: 'notes',
    id: memory.id,
    replicas: replicas
      .filter(({ replica }) => memory.scope === 'user' || replica.projectId === memory.projectId)
      .map(({ replica, state, entries }) => {
        const entry = entries.find((entry) => entry.id === memory.id);
        return {
          agent: replica.agent,
          path: replica.path,
          line: entry?.line ?? null,
          status:
            state !== 'readable'
              ? state
              : !entry
                ? 'not_present'
                : !memory.deleted &&
                    entry.version === memory.version &&
                    entry.content === memory.content
                  ? 'current'
                  : 'different',
          pending: replica.pending !== null,
        };
      }),
  });
}
