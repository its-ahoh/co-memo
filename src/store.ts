import { SettingsPatch, allowWrite } from './settings.js';
import type { Intent } from './settings.js';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import {
  mkdirSync,
  realpathSync,
  statSync,
  chmodSync,
  lstatSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Agent, Content, Memory, Snapshot, Pending, Conflict, ensure, hash } from './model.js';
import type { Scope, Replica, Project, Proposal } from './model.js';
import { safeParents, readText, absent } from './fs.js';

export function dataHome(): string {
  return resolve(
    process.env.CO_MEMO_HOME ||
      join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'co-memo'),
  );
}
export class Store {
  readonly db: DatabaseSync;
  readonly home: string;
  private readonly mutex: DatabaseSync;
  constructor(home = dataHome()) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(home);
    const path = join(this.home, 'shared-memory-v1.sqlite');
    safeParents(path);
    // Never follow a database or mutex symlink.
    for (const filename of ['shared-memory-v1.sqlite', 'sync-lock.sqlite']) {
      checkDatabase(join(this.home, filename));
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.mutex = new DatabaseSync(join(this.home, 'sync-lock.sqlite'));
    this.mutex.exec('PRAGMA busy_timeout=5000;');
    this.lock(() => {
      const version = this.db.prepare('PRAGMA user_version').get();
      ensure(Number(version?.user_version) <= 2, 'Database is from a newer Co-memo version');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,content TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,deleted INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS replicas(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,agent TEXT NOT NULL,path TEXT NOT NULL UNIQUE,baseline TEXT,pending TEXT,UNIQUE(project_id,agent));
        CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(scope_key TEXT PRIMARY KEY,payload TEXT NOT NULL);
        PRAGMA user_version=2;
      `);
    });
    chmodSync(path, 0o600);
    chmodSync(join(this.home, 'sync-lock.sqlite'), 0o600);
  }
  close(): void {
    this.db.close();
    this.mutex.close();
  }
  /** Separate SQLite lock serializes the full filesystem + DB workflow; OS releases it on crash. */
  lock<T>(fn: () => T): T {
    this.mutex.exec('BEGIN IMMEDIATE');
    try {
      return fn();
    } finally {
      this.mutex.exec('ROLLBACK');
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private rows<T>(schema: z.ZodType<T>, query: string, ...values: SQLInputValue[]): T[] {
    return this.db
      .prepare(query)
      .all(...values)
      .map((row) => schema.parse(JSON.parse(z.string().parse(row.payload))));
  }
  project(path: string, create = false): Project {
    let root = realpathSync(path);
    ensure(statSync(root).isDirectory(), 'Expected project directory');
    if (!create) {
      while (true) {
        const row = this.db.prepare('SELECT * FROM projects WHERE root=?').get(root);
        if (row) return { id: z.string().parse(row.id), root };
        const parent = dirname(root);
        if (parent === root) break;
        root = parent;
      }
      throw new Error('Project not connected; run co-memo connect <pi|claude|codex|opencode>');
    }
    const existing = this.db.prepare('SELECT * FROM projects WHERE root=?').get(root);
    if (existing) return { id: z.string().parse(existing.id), root };
    const project = { id: randomUUID(), root };
    this.db.prepare('INSERT INTO projects VALUES (?,?)').run(project.id, root);
    return project;
  }
  projectById(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    ensure(row, 'Unknown project');
    return { id, root: z.string().parse(row.root) };
  }
  replicas(): Replica[] {
    return this.db
      .prepare('SELECT * FROM replicas ORDER BY rowid')
      .all()
      .map((row) => ({
        id: z.string().parse(row.id),
        projectId: z.string().parse(row.project_id),
        agent: Agent.parse(row.agent),
        path: z.string().parse(row.path),
        baseline:
          row.baseline === null ? null : Snapshot.parse(JSON.parse(z.string().parse(row.baseline))),
        pending:
          row.pending === null ? null : Pending.parse(JSON.parse(z.string().parse(row.pending))),
      }));
  }
  connect(project: Project, agent: Agent): Replica {
    const existing = this.replicas().find((r) => r.projectId === project.id && r.agent === agent);
    if (existing) return existing;
    const path = join(project.root, '.co-memo', `${agent}.md`);
    ensure(
      readText(path) === null,
      `Unregistered memory file already exists: ${path}; import or move it first`,
    );
    const replica: Replica = {
      id: randomUUID(),
      projectId: project.id,
      agent,
      path,
      baseline: null,
      pending: null,
    };
    this.db
      .prepare('INSERT INTO replicas VALUES (?,?,?,?,NULL,NULL)')
      .run(replica.id, project.id, agent, path);
    return replica;
  }
  saveReplica(r: Replica): void {
    this.db
      .prepare('UPDATE replicas SET baseline=?,pending=? WHERE id=?')
      .run(
        r.baseline ? JSON.stringify(r.baseline) : null,
        r.pending ? JSON.stringify(r.pending) : null,
        r.id,
      );
  }
  settings(projectId: string | null): SettingsPatch {
    const row = this.db
      .prepare('SELECT payload FROM settings WHERE scope_key=?')
      .get(projectId ?? 'user');
    return row ? SettingsPatch.parse(JSON.parse(z.string().parse(row.payload))) : {};
  }
  configure(projectId: string | null, patch: SettingsPatch, reset = false): SettingsPatch {
    const value = SettingsPatch.parse(
      reset ? {} : { ...this.settings(projectId), ...SettingsPatch.parse(patch) },
    );
    if (projectId) this.projectById(projectId);
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET payload=excluded.payload',
      )
      .run(projectId ?? 'user', JSON.stringify(value));
    return value;
  }
  list(projectId: string | null, includeDeleted = false): Memory[] {
    return this.rows(
      Memory,
      `SELECT payload FROM notes WHERE (scope='user' OR project_id=?) ${includeDeleted ? '' : 'AND deleted=0'} ORDER BY rowid`,
      projectId,
    );
  }
  get(id: string): Memory {
    const memory = this.rows(Memory, 'SELECT payload FROM notes WHERE id=?', id)[0];
    ensure(memory, 'Memory not found');
    return memory;
  }
  private write(memory: Memory): Memory {
    Memory.parse(memory);
    const fingerprint = hash(JSON.stringify([memory.scope, memory.projectId, memory.content]));
    this.db
      .prepare(
        `INSERT INTO notes VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      content=excluded.content,fingerprint=excluded.fingerprint,version=excluded.version,deleted=excluded.deleted,payload=excluded.payload`,
      )
      .run(
        memory.id,
        memory.projectId,
        memory.scope,
        memory.content,
        fingerprint,
        memory.version,
        Number(memory.deleted),
        JSON.stringify(memory),
      );
    this.db
      .prepare('INSERT INTO revisions VALUES (?,?,?)')
      .run(memory.id, memory.version, JSON.stringify(memory));
    return memory;
  }
  add(
    content: string,
    scope: Scope,
    projectId: string | null,
    origin: string,
    intent: Intent = 'explicit',
  ): { memory: Memory; created: boolean } {
    allowWrite(this, projectId, intent);
    content = Content.parse(content);
    ensure(scope === 'user' || projectId, 'Project scope requires a project');
    if (scope === 'user') projectId = null;
    const fingerprint = hash(JSON.stringify([scope, projectId, content]));
    const existing = this.rows(
      Memory,
      'SELECT payload FROM notes WHERE fingerprint=?',
      fingerprint,
    )[0];
    if (existing) return { memory: existing, created: false }; // Includes tombstones: never resurrect by rediscovery.
    const memory: Memory = {
      id: randomUUID(),
      scope,
      projectId,
      content,
      version: 1,
      deleted: false,
      origin,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return { memory: this.write(memory), created: true };
  }
  change(
    id: string,
    version: number,
    content: string | null,
    origin: string,
    intent: Intent = 'explicit',
  ): Memory {
    const old = this.get(id);
    allowWrite(this, old.projectId, intent);
    ensure(old.version === version, 'Version changed; read the memory again');
    if (content !== null) Content.parse(content);
    ensure(!old.deleted || content === null, 'Deleted memory cannot be revived by a stale edit');
    if ((content === null && old.deleted) || (!old.deleted && content === old.content)) return old;
    return this.write({
      ...old,
      content: content ?? old.content,
      deleted: content === null,
      version: old.version + 1,
      origin,
      updatedAt: Date.now(),
    });
  }
  history(id: string): Memory[] {
    return this.rows(Memory, 'SELECT payload FROM revisions WHERE id=? ORDER BY version', id);
  }
  conflicts(): Conflict[] {
    return this.rows(Conflict, 'SELECT payload FROM conflicts ORDER BY rowid');
  }
  conflict(memory: Memory, proposals: Proposal[]): Conflict {
    const conflict: Conflict = {
      id: randomUUID(),
      memoryId: memory.id,
      currentVersion: memory.version,
      currentContent: memory.deleted ? null : memory.content,
      proposals,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO conflicts VALUES (?,?,?)')
      .run(conflict.id, memory.id, JSON.stringify(conflict));
    return conflict;
  }
  resolve(id: string, take: string, content?: string): Memory {
    const conflict = this.conflicts().find((c) => c.id === id);
    ensure(conflict, 'Conflict not found');
    const current = this.get(conflict.memoryId);
    allowWrite(this, current.projectId, 'explicit');
    ensure(
      current.version === conflict.currentVersion,
      'Memory changed since conflict; inspect it again',
    );
    const proposed = conflict.proposals.find((p) => p.replicaId === take);
    ensure(
      content !== undefined || take === 'current' || proposed,
      'Choose current or a proposal replicaId',
    );
    const selected = content ?? (take === 'current' ? conflict.currentContent : proposed!.content);
    // Explicit resolution may restore a deletion, unlike automatic synchronization.
    const memory = this.write({
      ...current,
      content: selected === null ? current.content : Content.parse(selected),
      deleted: selected === null,
      version: current.version + 1,
      origin: `resolve:${id}`,
      updatedAt: Date.now(),
    });
    this.db.prepare('INSERT INTO resolutions VALUES (?,?)').run(
      id,
      JSON.stringify({
        ...conflict,
        resolvedVersion: memory.version,
        selected,
        resolvedAt: Date.now(),
      }),
    );
    this.db.prepare('DELETE FROM conflicts WHERE id=?').run(id);
    return memory;
  }
}
function checkDatabase(path: string): void {
  try {
    const st = lstatSync(path);
    ensure(st.isFile() && !st.isSymbolicLink(), `Database is not a regular file: ${path}`);
  } catch (e) {
    if (!absent(e)) throw e;
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (created) {
      if (!(created instanceof Error && 'code' in created && created.code === 'EEXIST'))
        throw created;
      const st = lstatSync(path);
      ensure(st.isFile() && !st.isSymbolicLink(), 'Database is not a regular file');
    }
  }
}
