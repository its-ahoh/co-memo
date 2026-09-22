import { createHash } from 'node:crypto';
import { z } from 'zod';

export const Agent = z.enum(['pi', 'claude', 'codex', 'opencode']);
export type Agent = z.infer<typeof Agent>;
export const Content = z
  .string()
  .trim()
  .min(1)
  .max(32_000)
  .refine((s) => !s.includes('<!-- co-memo:'), 'Reserved Co-memo marker in content');
export const Scope = z.enum(['user', 'project']);
export type Scope = z.infer<typeof Scope>;
export const MemoryKind = z.enum(['note', 'preference', 'decision', 'constraint', 'lesson']);
export const Evidence = z.strictObject({
  agent: z.string().trim().min(1).max(100),
  sessionId: z.string().trim().min(1).max(200),
  messageId: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().min(1).max(2000),
});
export const Metadata = z.strictObject({
  kind: MemoryKind.default('note'),
  source: Evidence.nullable().default(null),
  module: z.string().trim().min(1).max(300).nullable().default(null),
  pinned: z.boolean().default(false),
  basis: z.enum(['user_correction', 'verified_change', 'user_resolution']).nullable().default(null),
  supersedes: z
    .object({ id: z.uuid(), version: z.number().int().positive() })
    .nullable()
    .default(null),
});
export type Metadata = z.infer<typeof Metadata>;
export const Memory = z.object({
  id: z.uuid(),
  scope: Scope,
  projectId: z.uuid().nullable(),
  content: Content,
  metadata: Metadata.default({
    kind: 'note',
    source: null,
    module: null,
    pinned: false,
    basis: null,
    supersedes: null,
  }),
  version: z.number().int().positive(),
  deleted: z.boolean(),
  origin: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Memory = z.infer<typeof Memory>;
export const Entry = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  content: Content,
});
export type Entry = z.infer<typeof Entry>;
export const Snapshot = z.object({
  generation: z.uuid(),
  entries: z.array(Entry),
  added: z.string(),
});
export type Snapshot = z.infer<typeof Snapshot>;
export const Pending = z.object({
  text: z.string(),
  snapshot: Snapshot,
  expected: z.string().nullable(),
});
export type Pending = z.infer<typeof Pending>;
export interface Replica {
  id: string;
  projectId: string;
  agent: Agent;
  path: string;
  baseline: Snapshot | null;
  pending: Pending | null;
}
export interface Project {
  id: string;
  root: string;
}
export const Proposal = z.object({
  replicaId: z.uuid(),
  agent: Agent,
  baseVersion: z.number().int().positive(),
  content: Content.nullable(),
});
export type Proposal = z.infer<typeof Proposal>;
export const Conflict = z.object({
  id: z.uuid(),
  memoryId: z.uuid(),
  currentVersion: z.number().int().positive(),
  currentContent: Content.nullable(),
  proposals: z.array(Proposal),
  candidates: z.array(z.object({ id: z.uuid(), content: Content, metadata: Metadata })).default([]),
  createdAt: z.number(),
});
export type Conflict = z.infer<typeof Conflict>;
export interface SyncReport {
  imported: number;
  updated: number;
  deleted: number;
  published: number;
  conflicts: Conflict[];
  errors: { path: string; error: string }[];
}
export function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
