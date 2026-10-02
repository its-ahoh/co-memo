import { join } from 'node:path';
import { Store } from './store.js';
import type { Memory } from './model.js';

/** Memory lives only in the central database. Connections do not imply host delivery. */
export function locationReader(store: Store) {
  const connections = store.connections();
  return (memory: Memory) => ({
    database: join(store.home, 'shared-memory-v1.sqlite'),
    table: 'notes',
    id: memory.id,
    connections: connections
      .filter((c) => memory.scope === 'user' || c.projectId === memory.projectId)
      .map((c) => ({ agent: c.agent, root: c.root })),
  });
}
