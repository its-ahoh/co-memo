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

/** Context is narrower than explicit recall: one incidental term should not fill the prompt. */
export function contextFilter(query?: string): (memory: Memory) => boolean {
  if (!query?.trim()) return () => true;
  const terms = [...new Set(searchTerms(query.slice(0, 16000)))].slice(0, 64);
  return (memory) => {
    if (!terms.length) return false;
    const indexed = new Set(searchTerms(memory.content + ' ' + (memory.metadata.module ?? '')));
    let shared = 0;
    for (const term of terms) if (indexed.has(term)) shared++;
    return shared >= Math.min(2, terms.length) && shared / terms.length >= 0.75;
  };
}
export const checkpointReminder =
  'Before the final reply, and after a durable user correction or project decision, check whether memory needs updating. Honor saveMode and paused settings; inferred notes use automatic intent. Submit durable candidates directly with memory_submit (CLI submit --file); saving checks for duplicates and verifies writes. Inspect needs_review before claiming success. Sources may be omitted/null; never invent unknown source IDs. Prepare and checkpoint are optional. If nothing durable needs saving, do not invent a note. A reminder is not proof of a save.';
