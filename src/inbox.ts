import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Catalog } from './catalog';
import { MemoryEngine, MemoryActor } from './engine';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export interface Source { version?: number; reviewedVersion?: number; missing?: boolean; change?: { kind: 'imported' | 'modified' | 'cleared' | 'deleted' | 'restored'; added: string[]; removed: string[] };  id: string; path: string; actor: MemoryActor; enabled: boolean; content: string; digest: string; previous: string; error?: string; checkedAt?: number; changedAt?: number }
/** Local admin service. Only explicitly registered files are read; never writes source files. */
export class Inbox {
  private db: DatabaseSync;
  private scannerId = randomUUID();
  private pending = new Map<string, string>();
  constructor(filename: string, private engine: MemoryEngine, private catalog: Catalog) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox_seen(memory_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_sources(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_scan_lease(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  close(): void { this.db.close(); }
  seen(): Record<string, number> { return Object.fromEntries(this.db.prepare('SELECT * FROM inbox_seen').all().map(r => [String(r.memory_id), Number(r.version)])); }
  mark(id: string, version: number): void {
    const m = this.engine.list({ includeForgotten: true }).find(m => m.id === id);
    if (!m || !Number.isInteger(version) || version < 1 || version > m.version) throw new Error('Invalid memory version');
    this.db.prepare('INSERT INTO inbox_seen VALUES (?,?) ON CONFLICT(memory_id) DO UPDATE SET version=MAX(version,excluded.version)').run(id,version);
  }
  sources(): Source[] { return this.db.prepare('SELECT payload FROM memory_sources ORDER BY rowid').all().map(r => JSON.parse(String(r.payload))); }
  add(path: string, actor: MemoryActor): Source {
    if (typeof path !== 'string' || !isAbsolute(path) || !/\.md$/i.test(path)) throw new Error('Use an absolute Markdown file path');
    this.catalog.validateActor(actor);
    if (this.sources().length >= 32) throw new Error('Maximum 32 watched files');
    path = resolve(path);
    if (this.sources().some(s => s.path === path)) throw new Error('File already registered');
    this.read(path); // Validate before registering; do not import until stable across two scans.
    const source: Source = { id: randomUUID(), path, actor, enabled: true, content: '', previous: '', digest: '' };
    this.save(source); return source;
  }
  enable(id: string, enabled: boolean): void {
    const source = this.sources().find(s => s.id === id); if (!source || typeof enabled !== 'boolean') throw new Error('Invalid source');
    source.enabled = enabled; this.pending.delete(id); this.save(source);
  }
  reviewSource(id: string, version: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const source = this.sources().find(s => s.id === id);
      if (!source || !Number.isInteger(version) || version < 1 || version > (source.version ?? 0)) throw new Error('Invalid source version');
      source.reviewedVersion = Math.max(source.reviewedVersion ?? 0, version); this.save(source); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private saveSnapshot(source: Source): void {
    // Preserve user controls changed by another dashboard connection during a scan.
    this.db.exec('BEGIN IMMEDIATE');
    try { const latest = this.sources().find(s => s.id === source.id);
      if (latest) { source.enabled = latest.enabled; source.reviewedVersion = latest.reviewedVersion; this.save(source); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private save(source: Source): void { this.db.prepare('INSERT OR REPLACE INTO memory_sources VALUES (?,?)').run(source.id,JSON.stringify(source)); }
  private read(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 65536) throw new Error('Expected a regular Markdown file up to 64 KiB');
      const bytes = readFileSync(fd); if (bytes.length > 65536) throw new Error('File exceeds 64 KiB');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    } finally { closeSync(fd); }
  }
  scan(): void {
    const now = Date.now();
    const lease = this.db.prepare('INSERT INTO memory_scan_lease VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE expires < ?').run(this.scannerId,now+30000,now);
    if (!lease.changes) return;
    try { this.scanSources(); } finally { this.db.prepare('DELETE FROM memory_scan_lease WHERE owner=?').run(this.scannerId); }
  }
  private scanSources(): void {
    for (const source of this.sources().filter(s => s.enabled)) {
      try {
        this.catalog.validateActor(source.actor);
        let content: string; let missing = false;
        try { content = this.read(source.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; content = ''; missing = true; }
        const digest = missing ? 'missing' : hash(content);
        if (digest !== source.digest) {
          if (this.pending.get(source.id) !== digest) { this.pending.set(source.id,digest); source.checkedAt = Date.now(); if (missing) source.error = 'File missing; waiting to confirm deletion'; this.saveSnapshot(source); continue; }
          const old = new Set(this.blocks(source.content)); const current = new Set(this.blocks(content));
          const added = [...current].filter(block => !old.has(block)); const removed = [...old].filter(block => !current.has(block));
          for (const block of added) {
            this.engine.recordPrivate(source.actor, { kind: 'lesson', content: block, state: 'candidate', evidence: {
              source: 'execution', eventId: `file:${source.id}:${digest}:${hash(block)}`, excerpt: block,
              filePath: source.path, fileHash: digest,
            } });
          }
          source.change = { kind: missing ? 'deleted' : source.missing ? 'restored' : !source.digest ? 'imported' : !content.trim() ? 'cleared' : 'modified', added, removed };
          source.version = (source.version ?? 0) + 1; source.missing = missing;
          source.previous = source.content; source.content = content; source.digest = digest; source.changedAt = Date.now(); this.pending.delete(source.id);
        }
        this.pending.delete(source.id);
        source.checkedAt = Date.now(); if (missing) source.error = 'File missing; existing memories are retained'; else delete source.error;
      } catch (e) { source.error = (e as Error).message; source.checkedAt = Date.now(); this.pending.delete(source.id); }
      this.saveSnapshot(source);
    }
  }
  private blocks(content: string): string[] {
    // Mechanical paragraph extraction, not semantic learning. Preserve all content in bounded chunks.
    return [...new Set(content.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).flatMap(s => {
      const chunks: string[] = []; for (let i = 0; i < s.length; i += 2400) chunks.push(s.slice(i,i+2400)); return chunks;
    }))];
  }
}
