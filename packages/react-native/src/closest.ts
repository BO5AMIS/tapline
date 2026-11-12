/**
 * Closest matches for a `not_found` (AGENT-TOOLS 1.12 §16.2). Pure functions: what counts as close, and
 * which elements are closest. Close means: the same words in another case or order; one contained in the
 * other; or a small edit distance (at most 2 up to 10 characters, at most 3 above). A match on only a
 * common word ("the", "a", "of", "to", "and", "in") doesn't count.
 */

/** Words too common to make two texts close. */
export const COMMON_WORDS: ReadonlySet<string> = new Set(['the', 'a', 'of', 'to', 'and', 'in']);

/** The most closest matches an answer lists. */
export const MAX_CLOSEST = 3;

/** Why two texts are close, best first; a lower rank is closer. */
export type Closeness = 'same-words' | 'contained' | 'edit-distance';

const RANK: Record<Closeness, number> = { 'same-words': 0, contained: 1, 'edit-distance': 2 };

/** Lower case words: runs of letters and digits. */
export function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** Whether the words include one that isn't a common word. */
function hasContent(words: string[]): boolean {
  return words.some((word) => !COMMON_WORDS.has(word));
}

/** The Levenshtein distance between two strings, in characters (code points). */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      row.push(Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = row;
  }
  return previous[y.length] ?? 0;
}

/** How close two texts are, or null when they aren't close. */
export function closeness(wanted: string, other: string): Closeness | null {
  const a = wordsOf(wanted);
  const b = wordsOf(other);
  if (a.length === 0 || b.length === 0) return null;
  if (!hasContent(a) || !hasContent(b)) return null;
  const sa = a.join(' ');
  const sb = b.join(' ');
  if ([...a].sort().join(' ') === [...b].sort().join(' ')) return 'same-words';
  // One inside the other. The shorter one must say something (not a lone common word) and be 2 characters or more.
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length >= 2 && long.includes(short)) return 'contained';
  const longest = Math.max(Array.from(sa).length, Array.from(sb).length);
  const shortest = Math.min(Array.from(sa).length, Array.from(sb).length);
  const distance = editDistance(sa, sb);
  // A distance as big as the shorter text would make any two short texts close.
  if (distance <= (longest <= 10 ? 2 : 3) && distance < shortest) return 'edit-distance';
  return null;
}

/** What the not-found target is compared with, and against which of an element's strings. */
export type ClosestKind = 'testID' | 'label' | 'text';

export interface ClosestCandidate {
  testID: string | null;
  label: string | null;
  text: string;
}

/** The strings of a candidate a target of this kind is compared with (id against ids, label against labels, text against texts and labels). */
function comparedWith(kind: ClosestKind, candidate: ClosestCandidate): string[] {
  const strings: Array<string | null> =
    kind === 'testID' ? [candidate.testID] : kind === 'label' ? [candidate.label ?? candidate.text] : [candidate.text, candidate.label];
  return strings.filter((value): value is string => value !== null && value !== '');
}

/**
 * Indexes of the closest candidates, closest first (ties keep the order given, which is reading order),
 * at most `limit`.
 */
export function closestMatches(kind: ClosestKind, wanted: string, candidates: ClosestCandidate[], limit: number = MAX_CLOSEST): number[] {
  const scored: Array<{ index: number; rank: number; gap: number }> = [];
  candidates.forEach((candidate, index) => {
    let best: { rank: number; gap: number } | null = null;
    for (const value of comparedWith(kind, candidate)) {
      const found = closeness(wanted, value);
      if (found === null) continue;
      const rank = RANK[found];
      const gap = Math.abs(value.length - wanted.length);
      if (best === null || rank < best.rank || (rank === best.rank && gap < best.gap)) best = { rank, gap };
    }
    if (best !== null) scored.push({ index, ...best });
  });
  scored.sort((p, q) => p.rank - q.rank || p.gap - q.gap || p.index - q.index);
  return scored.slice(0, limit).map((s) => s.index);
}
