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
export const Memory = z.object({
  id: z.uuid(),
  scope: Scope,
  projectId: z.uuid().nullable(),
  content: Content,
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
