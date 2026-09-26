import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { safeParents, atomicWrite, readText } from './fs.js';
import { Memory, ensure } from './model.js';
import { dataHome } from './store.js';

const filename = 'shared-memory-v1.sqlite';
const tables = [
  'projects',
  'notes',
  'revisions',
  'replicas',
  'conflicts',
  'resolutions',
  'settings',
  'submissions',
  'project_links',
  'notes_fts',
  'purged',
] as const;
const Manifest = z.strictObject({
  format: z.literal(1),
  schema: z.union([z.literal(4), z.literal(5)]),
  createdAt: z.string().datetime(),
  database: z.literal(filename),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.record(z.string(), z.number().int().nonnegative()),
});
function open(path: string) {
  safeParents(path);
  const st = lstatSync(path);
  ensure(st.isFile() && !st.isSymbolicLink(), 'Expected a regular database file');
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  return db;
}
function inspect(db: DatabaseSync) {
  ensure(
    [4, 5].includes(Number(db.prepare('PRAGMA user_version').get()?.user_version)),
    'Backup requires schema 4 or 5; unsupported database',
  );
  ensure(
    db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok',
    'Database integrity check failed',
  );
  ensure(
    !db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view') LIMIT 1").get(),
    'Unexpected triggers or views in backup',
  );
  const counts: Record<string, number> = {};
  for (const table of tables.filter(
    (t) => t !== 'purged' || Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 5,
  ))
    counts[table] = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  for (const row of db.prepare('SELECT payload FROM notes').iterate())
    Memory.parse(JSON.parse(String(row.payload)));
  ensure(
    !db
      .prepare(
        'SELECT n.id FROM notes n LEFT JOIN notes_fts f ON f.rowid=n.rowid WHERE f.id IS NULL OR f.id<>n.id LIMIT 1',
      )
      .get(),
    'Incomplete full-text index',
  );
  return counts;
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function reserve(directory: string) {
  safeParents(join(directory, filename));
  // Exclusive creation: never adopt or overwrite an existing destination, even an empty one.
  mkdirSync(directory, { mode: 0o700 });
}
function finalize(path: string, detach = false) {
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE;');
    if (detach) db.exec('BEGIN IMMEDIATE; DELETE FROM replicas; COMMIT;');
    return inspect(db);
  } finally {
    db.close();
  }
}
export async function createBackup(destination: string, home = dataHome()) {
  const source = open(join(resolve(home), filename));
  const directory = resolve(destination),
    path = join(directory, filename);
  let reserved = false;
  try {
    inspect(source);
    reserve(directory);
    reserved = true;
    await sqliteBackup(source, path);
    const counts = finalize(path);
    const manifest = {
      format: 1,
      schema: Number(source.prepare('PRAGMA user_version').get()?.user_version),
      createdAt: new Date().toISOString(),
      database: filename,
      sha256: await digest(path),
      counts,
    };
    atomicWrite(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', null);
    return {
      status: 'backed_up',
      directory,
      ...manifest,
      excluded: [
        'Unsynchronized Markdown edits',
        'Host configuration',
        'Embedding cache',
        'Disconnected-file archives',
      ],
    };
  } catch (error) {
    if (reserved) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    source.close();
  }
}
export async function verifyBackup(directory: string) {
  const root = resolve(directory);
  const text = readText(join(root, 'manifest.json'));
  ensure(text !== null, 'Missing backup manifest');
  const manifest = Manifest.parse(JSON.parse(text));
  const path = join(root, filename);
  // Check before opening: a finished archive never depends on journal recovery.
  for (const suffix of ['-wal', '-shm', '-journal'])
    ensure(!existsSync(path + suffix), 'Backup has unexpected database sidecars');
  const db = open(path);
  try {
    ensure((await digest(path)) === manifest.sha256, 'Backup checksum mismatch');
    const counts = inspect(db);
    ensure(
      tables.every((table) => counts[table] === manifest.counts[table]),
      'Backup row counts differ from manifest',
    );
    return { status: 'verified', directory: root, ...manifest };
  } finally {
    db.close();
  }
}
export async function restoreBackup(directory: string, destination: string, apply = false) {
  const verified = await verifyBackup(directory);
  const target = resolve(destination);
  safeParents(join(target, filename));
  ensure(!existsSync(target), 'Restore destination must not exist; choose a new --to directory');
  if (!apply)
    return {
      status: 'preview',
      applied: false,
      destination: target,
      counts: verified.counts,
      next: 'Add --apply to restore. Existing agent bindings are not changed; restored replicas are detached.',
    };
  const source = open(join(verified.directory, filename));
  let reserved = false;
  try {
    reserve(target);
    reserved = true;
    const path = join(target, filename);
    await sqliteBackup(source, path);
    // Verify the copied logical snapshot before modifying it. SQLite backup may change header bytes.
    const copied = finalize(path);
    ensure(
      tables.every((table) => copied[table] === verified.counts[table]),
      'Backup changed during restore',
    );
    ensure(
      (await digest(join(verified.directory, filename))) === verified.sha256,
      'Backup changed during restore',
    );
    const counts = finalize(path, true);
    return {
      status: 'restored',
      applied: true,
      destination: target,
      counts,
      detachedReplicas: verified.counts.replicas,
      next: 'Inspect using --home DESTINATION. Stop old hosts and archive existing project projections before reconnecting to this home. Existing host configuration still points to the old store.',
    };
  } catch (error) {
    if (reserved) rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    source.close();
  }
}
