import { withoutPurged } from './document.js';
import { repository } from './worktrees.js';
import { searchTerms, recent } from './relevance.js';
import { SettingsPatch, allowWrite } from './settings.js';
import type { Intent } from './settings.js';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import {
  mkdirSync,
  existsSync,
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
import {
  Agent,
  Content,
  Memory,
  Metadata,
  Snapshot,
  Pending,
  Conflict,
  ensure,
  hash,
} from './model.js';
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
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;');
    this.mutex = new DatabaseSync(join(this.home, 'sync-lock.sqlite'));
    this.mutex.exec('PRAGMA busy_timeout=5000;');
    this.lock(() => {
      const version = this.db.prepare('PRAGMA user_version').get();
      ensure(Number(version?.user_version) <= 5, 'Database is from a newer Co-memo version');
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,content TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,deleted INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS replicas(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,agent TEXT NOT NULL,path TEXT NOT NULL UNIQUE,baseline TEXT,pending TEXT,UNIQUE(project_id,agent));
        CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(scope_key TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, terms, tokenize='unicode61 remove_diacritics 2');
        CREATE TABLE IF NOT EXISTS submissions(project_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,request_id));
      `);
        if (Number(version?.user_version) < 3) {
          this.db.exec('DELETE FROM notes_fts');
          for (const memory of this.rows(Memory, 'SELECT payload FROM notes')) this.index(memory);
        }
        if (Number(version?.user_version) < 4) {
          this.db.exec(`
            ALTER TABLE replicas RENAME TO replicas_v3;
            CREATE TABLE replicas(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,agent TEXT NOT NULL,path TEXT NOT NULL UNIQUE,baseline TEXT,pending TEXT);
            INSERT INTO replicas SELECT * FROM replicas_v3;
            DROP TABLE replicas_v3;
          `);
        }
        this.db.exec(
          'CREATE TABLE IF NOT EXISTS project_links(root TEXT PRIMARY KEY,project_id TEXT NOT NULL,git_common TEXT NOT NULL); CREATE TABLE IF NOT EXISTS purged(id TEXT PRIMARY KEY); PRAGMA user_version=5;',
        );
      });
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
    const linked = this.linkedProject(root);
    if (linked) return linked;
    if (!create) {
      while (true) {
        const linked = this.linkedProject(root);
        if (linked) return linked;
        const row = this.db.prepare('SELECT * FROM projects WHERE root=?').get(root);
        if (row) return { id: z.string().parse(row.id), root };
        // A nested repository/worktree must not inherit its enclosing project's identity.
        if (existsSync(join(root, '.git'))) break;
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
  /** Discover a workspace without installing adapters or asking the user to connect it. */
  autoProject(path: string, explicit = false): Project | null {
    const start = realpathSync(path);
    ensure(statSync(start).isDirectory(), 'Expected project directory');
    // Git boundaries take precedence over package manifests inside a monorepo.
    let root = start;
    let manifestRoot: string | null = null;
    while (true) {
      const linked = this.linkedProject(root);
      if (linked) return linked;
      if (existsSync(join(root, '.git'))) return this.project(root, true);
      const row = this.db.prepare('SELECT id FROM projects WHERE root=?').get(root);
      if (row) return { id: z.string().parse(row.id), root };
      const parent = dirname(root);
      if (parent === root || root === homedir()) break;
      if (
        !manifestRoot &&
        [
          'package.json',
          'pyproject.toml',
          'Cargo.toml',
          'go.mod',
          'pom.xml',
          'build.gradle',
          'build.gradle.kts',
        ].some((name) => existsSync(join(root, name)))
      )
        manifestRoot = root;
      root = parent;
    }
    const detected = manifestRoot ?? (explicit ? start : null);
    return detected ? this.project(detected, true) : null;
  }
  private linkedProject(root: string): Project | null {
    const link = this.db
      .prepare('SELECT project_id,git_common FROM project_links WHERE root=?')
      .get(root);
    if (!link) return null;
    const actual = repository(root);
    ensure(
      actual.root === root && actual.common === link.git_common,
      'Worktree identity changed; inspect its Co-memo link',
    );
    return { id: z.string().parse(link.project_id), root };
  }
  linkWorktree(path: string, target: string): Project {
    const source = repository(path),
      destination = repository(target);
    ensure(
      source.root !== destination.root && source.common === destination.common,
      'Both paths must be distinct worktrees of the same local Git repository',
    );
    ensure(
      !this.db.prepare('SELECT id FROM projects WHERE root=?').get(source.root),
      'Worktree already has an independent project; automatic merging is not supported',
    );
    const project = this.project(destination.root);
    ensure(
      project.root === destination.root,
      'Connect the repository root before linking a worktree',
    );
    const existing = this.db
      .prepare('SELECT project_id,git_common FROM project_links WHERE root=?')
      .get(source.root);
    ensure(
      !existing || (existing.project_id === project.id && existing.git_common === source.common),
      'Worktree is already linked elsewhere',
    );
    this.db
      .prepare('INSERT OR IGNORE INTO project_links VALUES (?,?,?)')
      .run(source.root, project.id, source.common);
    return { id: project.id, root: source.root };
  }
  worktrees(projectId: string) {
    return this.db
      .prepare('SELECT root FROM project_links WHERE project_id=? ORDER BY root')
      .all(projectId)
      .map((row) => z.string().parse(row.root));
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
    const path = join(project.root, '.co-memo', `${agent}.md`);
    const existing = this.replicas().find((r) => r.projectId === project.id && r.path === path);
    if (existing) return existing;
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
  /** Shared search path for context, MCP recall and CLI list. Filter before ranking. */
  search(
    projectId: string | null,
    query?: string,
    includeDeleted = false,
    includeConflicts = false,
  ): Memory[] {
    if (!query?.trim()) {
      const blocked = new Set(this.conflicts().map((c) => c.memoryId));
      return recent(this.list(projectId, includeDeleted)).filter(
        (m) => includeConflicts || !blocked.has(m.id),
      );
    }
    const terms = [...new Set(searchTerms(query.slice(0, 16000)))].slice(0, 64);
    if (!terms.length) return [];
    const match = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
    return this.rows(
      Memory,
      `SELECT n.payload FROM notes_fts JOIN notes n ON notes_fts.rowid=n.rowid
      WHERE notes_fts MATCH ? AND (n.scope='user' OR n.project_id=?)
      ${includeDeleted ? '' : 'AND n.deleted=0'}
      ${includeConflicts ? '' : 'AND NOT EXISTS (SELECT 1 FROM conflicts c WHERE c.memory_id=n.id)'}
      ORDER BY bm25(notes_fts), n.rowid DESC LIMIT 100`,
      match,
      projectId,
    );
  }
  private index(memory: Memory): void {
    const row = this.db.prepare('SELECT rowid FROM notes WHERE id=?').get(memory.id);
    ensure(row, 'Cannot index a missing note');
    const rowid = row.rowid!;
    this.db.prepare('DELETE FROM notes_fts WHERE rowid=?').run(rowid);
    this.db
      .prepare('INSERT INTO notes_fts(rowid,id,terms) VALUES (?,?,?)')
      .run(
        rowid,
        memory.id,
        searchTerms(memory.content + ' ' + (memory.metadata.module ?? '')).join(' '),
      );
  }
  submission(
    projectId: string,
    requestId: string,
  ): { fingerprint: string; result: unknown } | null {
    const row = this.db
      .prepare('SELECT fingerprint,payload FROM submissions WHERE project_id=? AND request_id=?')
      .get(projectId, requestId);
    return row
      ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.payload)) as unknown }
      : null;
  }
  saveSubmission(projectId: string, requestId: string, fingerprint: string, result: unknown): void {
    this.db
      .prepare('INSERT INTO submissions VALUES (?,?,?,?)')
      .run(projectId, requestId, fingerprint, JSON.stringify(result));
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
    this.index(memory);
    return memory;
  }
  add(
    content: string,
    scope: Scope,
    projectId: string | null,
    origin: string,
    intent: Intent = 'explicit',
    metadata: Metadata = Metadata.parse({}),
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
      metadata: Metadata.parse(metadata),
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
    metadata?: Metadata,
  ): Memory {
    const old = this.get(id);
    allowWrite(this, old.projectId, intent);
    ensure(old.version === version, 'Version changed; read the memory again');
    if (content !== null) Content.parse(content);
    ensure(!old.deleted || content === null, 'Deleted memory cannot be revived by a stale edit');
    if ((content === null && old.deleted) || (!metadata && !old.deleted && content === old.content))
      return old;
    return this.write({
      ...old,
      content: content ?? old.content,
      metadata: {
        ...(metadata ?? old.metadata),
        source: metadata?.source ?? null,
        basis: metadata?.basis ?? null,
        supersedes: { id: old.id, version: old.version },
      },
      deleted: content === null,
      version: old.version + 1,
      origin,
      updatedAt: Date.now(),
    });
  }
  purgedIds(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT id FROM purged')
        .all()
        .map((r) => String(r.id)),
    );
  }
  /** Caller holds lock and transaction. Retain only an ID to reject stale replicas. */
  purge(id: string, version: number): void {
    const old = this.get(id);
    allowWrite(this, old.projectId, 'explicit');
    ensure(old.version === version, 'Version changed; read the memory again');
    this.db.prepare('INSERT INTO purged VALUES (?)').run(id);
    this.db.prepare('DELETE FROM notes_fts WHERE id=?').run(id);
    this.db.prepare('DELETE FROM revisions WHERE id=?').run(id);
    this.db.prepare('DELETE FROM conflicts WHERE memory_id=?').run(id);
    this.db
      .prepare(
        'DELETE FROM resolutions WHERE EXISTS (SELECT 1 FROM json_tree(resolutions.payload) WHERE value=?)',
      )
      .run(id);
    // Keep idempotency keys so retrying an old submission cannot recreate a purged note.
    this.db
      .prepare(
        'UPDATE submissions SET payload=? WHERE EXISTS (SELECT 1 FROM json_tree(submissions.payload) WHERE value=?)',
      )
      .run(
        JSON.stringify([
          {
            action: 'skip',
            status: 'skipped',
            reason: 'A memory from this submission was permanently deleted.',
          },
        ]),
        id,
      );
    this.db.prepare('DELETE FROM notes WHERE id=?').run(id);
    const ids = new Set([id]);
    for (const replica of this.replicas()) {
      if (replica.baseline)
        replica.baseline.entries = replica.baseline.entries.filter((e) => e.id !== id);
      if (replica.pending) {
        replica.pending.text = withoutPurged(replica.pending.text, replica.id, ids);
        replica.pending.snapshot.entries = replica.pending.snapshot.entries.filter(
          (e) => e.id !== id,
        );
      }
      this.saveReplica(replica);
    }
  }
  restore(id: string, version: number, origin: string): Memory {
    const old = this.get(id);
    allowWrite(this, old.projectId, 'explicit');
    ensure(old.version === version, 'Version changed; read the memory again');
    ensure(old.deleted, 'Memory is not archived');
    return this.write({
      ...old,
      deleted: false,
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
  conflict(
    memory: Memory,
    proposals: Proposal[],
    candidates: Conflict['candidates'] = [],
  ): Conflict {
    const conflict: Conflict = {
      id: randomUUID(),
      memoryId: memory.id,
      currentVersion: memory.version,
      currentContent: memory.deleted ? null : memory.content,
      proposals,
      candidates,
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
    const candidate = conflict.candidates.find((p) => p.id === take);
    ensure(
      content !== undefined || take === 'current' || proposed || candidate,
      'Choose current, a replicaId or a candidate ID',
    );
    const selected =
      content ??
      (take === 'current'
        ? conflict.currentContent
        : candidate
          ? candidate.content
          : proposed!.content);
    // Explicit resolution may restore a deletion, unlike automatic synchronization.
    const memory = this.write({
      ...current,
      content: selected === null ? current.content : Content.parse(selected),
      deleted: selected === null,
      metadata: {
        ...(candidate && content === undefined ? candidate.metadata : current.metadata),
        source:
          content === undefined
            ? (candidate?.metadata.source ?? (take === 'current' ? current.metadata.source : null))
            : null,
        basis: 'user_resolution',
        supersedes: { id: current.id, version: current.version },
      },
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
