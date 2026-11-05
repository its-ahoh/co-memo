import type { Memory } from './model.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(
  'the a an is to of and or for in on with please this that 我 的 了 是 请 帮 我们 一下'.split(' '),
);
/** Raw word tokens after stop-word removal; diagnostics show these, matching uses stems. */
export function words(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_/\\.:-]+/g, ' ')
    .toLowerCase();
  return Array.from(segmenter.segment(normalized))
    .filter((part) => part.isWordLike && !stop.has(part.segment))
    .map((part) => part.segment);
}

const consonant = (w: string, i: number): boolean =>
  'aeiou'.includes(w[i]!) ? false : w[i] === 'y' ? i === 0 || !consonant(w, i - 1) : true;
/** Porter's m: the number of vowel-consonant sequences. */
function measure(w: string): number {
  let m = 0;
  for (let i = 1; i < w.length; i++) if (consonant(w, i) && !consonant(w, i - 1)) m++;
  return m;
}
const hasVowel = (w: string) => [...w].some((_, i) => !consonant(w, i));
const cvc = (w: string) => {
  const n = w.length;
  return (
    n >= 3 &&
    consonant(w, n - 3) &&
    !consonant(w, n - 2) &&
    consonant(w, n - 1) &&
    !'wxy'.includes(w[n - 1]!)
  );
};

/**
 * Light English stemmer so "build", "builds" and "building" match. Only inflections are
 * removed (Porter steps 1 and 5, with Porter2's plural rule so "bus" and "gas" survive);
 * derivational suffixes are kept to avoid merging unrelated words. Words with digits,
 * non-ASCII letters or fewer than three letters are returned unchanged.
 */
export function stem(word: string): string {
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies') || w.endsWith('ied')) w = w.slice(0, -3) + (w.length > 4 ? 'i' : 'ie');
  else if (w.endsWith('us') || w.endsWith('ss')) {
    // Keep as is.
  } else if (w.endsWith('s') && hasVowel(w.slice(0, -2))) w = w.slice(0, -1);
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else {
    const suffix = w.endsWith('ed') ? 2 : w.endsWith('ing') ? 3 : 0;
    if (suffix && hasVowel(w.slice(0, -suffix))) {
      w = w.slice(0, -suffix);
      const last = w[w.length - 1]!;
      if (/(at|bl|iz)$/.test(w)) w += 'e';
      else if (
        w.length >= 2 &&
        last === w[w.length - 2] &&
        consonant(w, w.length - 1) &&
        !'lsz'.includes(last)
      )
        w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w += 'e';
    }
  }
  // Porter2: y becomes i after a consonant that is not the first letter, so "try" and
  // "tries" meet at "tri" while "say" and "boy" keep their y.
  if (w.length > 2 && w.endsWith('y') && !'aeiouy'.includes(w[w.length - 2]!))
    w = w.slice(0, -1) + 'i';
  if (w.endsWith('e')) {
    const base = w.slice(0, -1);
    const m = measure(base);
    if (m > 1 || (m === 1 && !cvc(base))) w = base;
  }
  if (w.endsWith('ll') && measure(w) > 1) w = w.slice(0, -1);
  return w;
}

/** Stemmed terms; both stored notes and queries go through this before matching. */
export function searchTerms(text: string): string[] {
  return words(text).map(stem);
}
/** Full-text index terms: original words plus their stems, so readers that predate
 * stemming still find exact words and current readers find any word form. */
export function indexTerms(text: string): string[] {
  return words(text).flatMap((word) => {
    const root = stem(word);
    return root === word ? [word] : [word, root];
  });
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
/** Query words as typed (deduplicated, filler removed); compare them through `stem`. */
export function contextTerms(query?: string): string[] {
  return [...new Set(words((query ?? '').slice(0, 16000)))]
    .slice(0, 64)
    .filter((term) => !filler.has(term));
}

/** Context is narrower than explicit recall: one incidental term should not fill the prompt. */
export function contextFilter(query?: string): (memory: Memory) => boolean {
  if (!query?.trim()) return () => true;
  const terms = [...new Set(contextTerms(query).map(stem))];
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
