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

// Question and pronoun words in natural prompts; they never signal that a note is relevant.
const filler = new Set(
  'how what why when where which who can could should would will do does did we you i me my our your it its be are was were am been have has had there they them about from into by at as if so just any some per 怎么 如何 什么 为什么 这个 那个 应该 可以 需要 吗 呢 吧 你 在 和 有 要 会 能'.split(
    ' ',
  ),
);
export function contextTerms(query?: string): string[] {
  return [...new Set(searchTerms((query ?? '').slice(0, 16000)))]
    .slice(0, 64)
    .filter((term) => !filler.has(term));
}

/** Context is narrower than explicit recall: one incidental term should not fill the prompt. */
export function contextFilter(query?: string): (memory: Memory) => boolean {
  if (!query?.trim()) return () => true;
  const terms = contextTerms(query);
  return (memory) => {
    if (!terms.length) return false;
    const indexed = new Set(searchTerms(memory.content + ' ' + (memory.metadata.module ?? '')));
    let shared = 0;
    for (const term of terms) if (indexed.has(term)) shared++;
    if (shared >= Math.min(2, terms.length) && shared / terms.length >= 0.75) return true;
    // Whole prompts dilute the ratio above, so long queries may instead match on overlap
    // with the smaller side. Three terms minimum: one CJK word can segment into two terms.
    const smaller = Math.min(terms.length, indexed.size);
    return terms.length >= 4 && shared >= Math.max(3, Math.min(6, Math.ceil(smaller * 0.4)));
  };
}
export const checkpointReminder =
  'Before the final reply, and after a durable user correction or project decision, check whether memory needs updating. Honor saveMode and paused settings; inferred notes use automatic intent. Submit durable candidates directly with memory_submit (CLI submit --file); saving checks for duplicates and verifies writes. Inspect needs_review before claiming success. Sources may be omitted/null; never invent unknown source IDs. Prepare and checkpoint are optional. If nothing durable needs saving, do not invent a note. A reminder is not proof of a save.';
