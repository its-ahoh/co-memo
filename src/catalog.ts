import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryDraft, MemoryActor } from './engine';
export const catalogKinds = ['agents', 'projects', 'stages', 'purposes'] as const;
export type CatalogKind = typeof catalogKinds[number];
export interface CatalogEntry { id: string; kind: CatalogKind; name: string; description: string; archived: boolean; version: number }
export class Catalog {
  private db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS catalog(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);`);
    // Stable starter taxonomy; no agents or personal memories are seeded.
    for (const [id, kind, name, description] of [
      ['stage-explore','stages','Explore','Research, discovery and planning'], ['stage-build','stages','Build','Implementation and delivery'], ['stage-maintain','stages','Maintain','Operations and continued improvement'],
      ['purpose-preferences','purposes','Preferences','How you prefer to work'], ['purpose-decisions','purposes','Decisions','Agreed choices and their rationale'], ['purpose-knowledge','purposes','Knowledge','Facts, conventions and domain context'],
    ] as const) this.db.prepare('INSERT OR IGNORE INTO catalog VALUES (?,?,?)').run(id, kind, JSON.stringify({ id, kind, name, description, archived: false, version: 1 }));
  }
  close(): void { this.db.close(); }
  list(kind?: CatalogKind): CatalogEntry[] {
    return this.db.prepare('SELECT payload FROM catalog ORDER BY rowid').all().map(row => JSON.parse(String(row.payload)) as CatalogEntry).filter(e => !kind || e.kind === kind);
  }
  get(kind: CatalogKind, id: string): CatalogEntry {
    const row = this.db.prepare('SELECT payload FROM catalog WHERE id=? AND kind=?').get(id, kind);
    if (!row) throw new Error(`${kind}: item not found`);
    return JSON.parse(String(row.payload));
  }
  add(kind: CatalogKind, name: string, description = ''): CatalogEntry {
    const entry = { id: randomUUID(), kind, name: this.name(name), description: this.description(description), archived: false, version: 1 };
    if (!catalogKinds.includes(kind)) throw new Error('Unknown catalog');
    this.db.prepare('INSERT INTO catalog VALUES (?,?,?)').run(entry.id, kind, JSON.stringify(entry));
    return entry;
  }
  edit(kind: CatalogKind, id: string, version: number, patch: { name?: string; description?: string; archived?: boolean }): CatalogEntry {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.get(kind, id);
      if (old.version !== version) throw new Error('Item changed; reload before editing');
      if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw new Error('Invalid archive state');
      const next = { ...old, name: patch.name === undefined ? old.name : this.name(patch.name), description: patch.description === undefined ? old.description : this.description(patch.description), archived: patch.archived ?? old.archived, version: version + 1 };
      this.db.prepare('UPDATE catalog SET payload=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  validateMemory(m: MemoryDraft): void {
    this.get('agents', m.ownerId);
    if (m.projectId) this.get('projects', m.projectId);
    if (m.stageId) this.get('stages', m.stageId);
    for (const id of m.purposeIds ?? []) this.get('purposes', id);
    for (const id of m.sharedWith ?? []) this.get('agents', id);
  }
  validateActor(actor: MemoryActor): void {
    if (this.get('agents', actor.agentId).archived) throw new Error('Agent is archived');
    if (actor.projectId) this.get('projects', actor.projectId);
    if (actor.stageId) this.get('stages', actor.stageId);
    if (actor.purposeId) this.get('purposes', actor.purposeId);
  }
  private name(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('Name must contain 1–80 characters');
    return value.trim();
  }
  private description(value: string): string {
    if (typeof value !== 'string' || value.length > 600) throw new Error('Description must be at most 600 characters');
    return value;
  }
}
