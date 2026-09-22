import type { Memory } from './model.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(
  'the a an is to of and or for in on with please this that 我 的 了 是 请 帮 我们 一下'.split(' '),
);
export function searchTerms(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_/\\.:-]+/g, ' ')
    .toLowerCase();
  return Array.from(segmenter.segment(normalized))
    .filter((part) => part.isWordLike && !stop.has(part.segment))
    .map((part) => part.segment);
}
export function recent(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
export const checkpointReminder =
  'Before the final reply, and after a durable user correction or project decision, check whether memory needs updating. Honor saveMode and paused settings; inferred notes use automatic intent. Find existing notes before saving. Prefer memory_submit (CLI submit --file) for evidence-backed candidates; it verifies writes in one call. For legacy writes verify returned id/version/deleted with memory_checkpoint (CLI checkpoint). If nothing durable needs saving, do not invent a note. A reminder is not proof of a save.';
