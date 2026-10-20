import { z } from 'zod';

export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const uuid = z.uuid();
const validString = (s: string) => !/[\u0000\uD800-\uDFFF]/u.test(s);
const text = (min: number, max: number) =>
  z
    .string()
    .refine((s) => [...s].length >= min && [...s].length <= max && validString(s), 'Invalid text');
function safeJson(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof v === 'string') return validString(v);
  if (!v || typeof v !== 'object') return true;
  return Object.entries(v).every(
    ([k, value]) =>
      validString(k) &&
      !['__proto__', 'prototype', 'constructor'].includes(k) &&
      safeJson(value, depth + 1),
  );
}
// Inspect raw keys before Zod reconstructs records (which can discard __proto__).
const metadata = z
  .unknown()
  .refine((v) => safeJson(v), 'Invalid metadata')
  .pipe(z.record(z.string(), z.json()))
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 16384, 'Invalid metadata size');
const fields = {
  title: text(0, 200).optional(),
  content: text(1, 32000),
  metadata: metadata.optional(),
};
export const createInput = z.strictObject({
  ...fields,
  kind: z.enum(['note', 'preference', 'decision', 'constraint', 'lesson']),
});
export const patchInput = z
  .strictObject({ ...fields, content: fields.content.optional() })
  .refine((v) => Object.keys(v).length > 0);
export type CreateInput = z.infer<typeof createInput>;
export type PatchInput = z.infer<typeof patchInput>;
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Problem(400, 'invalid_input');
  return result.data;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
