import { keyboardState } from './keyboard';
import { measureFiber, type Entry, type Snapshot } from './inspect';
import type { Frame } from './types';

/**
 * What is visibly on the glass (AGENT-TOOLS 1.12 §17.1, a journey in a user's eyes): an element's frame cut to the
 * screen, to every scroll view around it, and to the part of the screen above the keyboard. Null when none of it
 * shows. (What an open sheet hides isn't in the snapshot at all, so a sheet needs no rule here.)
 */

export function intersect(a: Frame, b: Frame): Frame | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The scroll views of a snapshot, by node index. */
export function scrollEntries(snapshot: Snapshot): Entry[] {
  return snapshot.entries.filter((entry) => !entry.tab && entry.info.actions.includes('scroll'));
}

/** The frames of the scroll views, by node index (null when one can't be measured). */
export async function measureScrollers(snapshot: Snapshot): Promise<Map<number, Frame | null>> {
  const scrollers = scrollEntries(snapshot);
  const frames = await Promise.all(scrollers.map((entry) => measureFiber(entry.node.fiber)));
  return new Map(scrollers.map((entry, i) => [entry.node.index, frames[i] ?? null]));
}

/** The node indexes of the scroll views around a node, innermost first. */
export function scrollAncestors(snapshot: Snapshot, entry: Entry, scrollers: ReadonlyMap<number, Frame | null>): number[] {
  const found: number[] = [];
  for (let p = entry.node.parent; p >= 0; ) {
    if (scrollers.has(p)) found.push(p);
    const node = snapshot.nodes[p];
    if (!node) break;
    p = node.parent;
  }
  return found;
}

/** The part of `frame` a person can see, or null. `frame` null (a native tab, an unmeasured element) is taken as visible. */
export function visiblePartOnGlass(
  snapshot: Snapshot,
  entry: Entry,
  frame: Frame | null,
  scrollers: ReadonlyMap<number, Frame | null>,
): Frame | null | 'unknown' {
  if (frame === null) return 'unknown';
  let area = intersect(frame, { x: 0, y: 0, width: snapshot.screen.width, height: snapshot.screen.height });
  for (const index of scrollAncestors(snapshot, entry, scrollers)) {
    if (area === null) return null;
    const around = scrollers.get(index);
    if (around) area = intersect(area, around);
  }
  if (area === null) return null;
  const top = keyboardState()?.top ?? null;
  if (top !== null) area = intersect(area, { x: 0, y: 0, width: snapshot.screen.width, height: top });
  return area;
}

/** Whether any of the element shows on the glass. An element that can't be measured counts as shown. */
export async function isOnGlass(snapshot: Snapshot, entry: Entry, frame: Frame | null): Promise<boolean> {
  return visiblePartOnGlass(snapshot, entry, frame, await measureScrollers(snapshot)) !== null;
}
