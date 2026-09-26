import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Agent, ensure } from './model.js';
import { safeParents } from './fs.js';
import { dataHome } from './store.js';
import { doctor } from './doctor.js';

/** Inventory must work outside a project and must not create, migrate or sync a store. */
export async function projects(home = dataHome(), check = false, probe = false) {
  const directory = resolve(home),
    path = join(directory, 'shared-memory-v1.sqlite');
  safeParents(path);
  if (!existsSync(path)) return { home: directory, projects: [], hostVerified: false };
  const stat = lstatSync(path);
  ensure(stat.isFile() && !stat.isSymbolicLink(), 'Unsafe database path');
  const db = new DatabaseSync(path, { readOnly: true });
  const entries: {
    id: string;
    root: string;
    sharedWith: string | null;
    exists: boolean;
    agents: string[];
    memories: number;
    diagnostics?: unknown;
  }[] = [];
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN;');
    ensure(
      [4, 5].includes(Number(db.prepare('PRAGMA user_version').get()?.user_version)),
      'Unsupported schema; upgrade before listing projects',
    );
    const replicas = db.prepare('SELECT agent,path,project_id FROM replicas').all();
    const roots = db
      .prepare(
        `SELECT id,root,NULL AS shared FROM projects UNION ALL SELECT l.project_id AS id,l.root,p.root AS shared FROM project_links l JOIN projects p ON p.id=l.project_id ORDER BY root`,
      )
      .all();
    for (const row of roots)
      entries.push({
        id: String(row.id),
        root: String(row.root),
        sharedWith: row.shared === null ? null : String(row.shared),
        exists: existsSync(String(row.root)),
        agents: replicas
          .filter((r) => r.project_id === row.id && dirname(dirname(String(r.path))) === row.root)
          .map((r) => Agent.parse(r.agent)),
        memories: Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM notes WHERE deleted=0 AND scope='project' AND project_id=?",
            )
            .get(String(row.id))?.n,
        ),
      });
  } finally {
    db.close();
  }
  if (check || probe)
    for (const entry of entries)
      entry.diagnostics = await doctor({ home: directory, root: entry.root, probe });
  return { home: directory, projects: entries, hostVerified: false };
}
