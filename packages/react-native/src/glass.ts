import { measureScrollState } from './actions';
import { intersect, measureScrollers, scrollEntries, visiblePartOnGlass } from './glassclip';
import { findProp, tree, type GlassPass, type Listed } from './inspect';
import type { Frame, TreeResult } from './types';

/**
 * `tree` with `glass: true` (AGENT-TOOLS 1.12 §17.1, a journey in a user's eyes): only what a person sees. An
 * element cut off by its scroll view, or under the keyboard, is left out (what an open sheet hides never is in
 * the list), and instead of counts the result says whether a scroll view can really go further: `glass`.
 */

/** A scroll view this small (in points, tall) isn't what a person means by "more below". */
const MIN_SCROLLER_HEIGHT = 40;
/** Rest positions within this many points of an end count as being at it. */
const END_SLACK = 1;

const glassPass: GlassPass = async (snapshot, listed) => {
  const scrollers = await measureScrollers(snapshot);
  const kept: Listed[] = [];
  /** Elements the pass dropped, with the scroll view that cut them off: the fallback when a scroll view can't be measured. */
  const droppedBy = new Map<number, { above: boolean; below: boolean }>();
  for (const item of listed) {
    const shown = visiblePartOnGlass(snapshot, item.entry, item.frame, scrollers);
    if (shown !== null) {
      kept.push(item);
      continue;
    }
    // Which side of its scroll view it lies on, for a scroll view that can't be measured.
    if (item.frame === null) continue;
    for (const [index, around] of scrollers) {
      if (!around || !isInside(snapshot, item.entry.node.index, index)) continue;
      const side = droppedBy.get(index) ?? { above: false, below: false };
      if (item.frame.y >= around.y + around.height) side.below = true;
      else if (item.frame.y + item.frame.height <= around.y) side.above = true;
      droppedBy.set(index, side);
    }
  }
  let moreAbove = false;
  let moreBelow = false;
  const screen = { x: 0, y: 0, width: snapshot.screen.width, height: snapshot.screen.height };
  for (const entry of scrollEntries(snapshot)) {
    const around: Frame | null | undefined = scrollers.get(entry.node.index);
    if (!around) continue;
    const shownPart = intersect(around, screen);
    if (shownPart === null || shownPart.height < MIN_SCROLLER_HEIGHT) continue;
    if (findProp(entry.node, 'horizontal') === true) continue;
    const state = await measureScrollState(entry).catch(() => null);
    if (state !== null) {
      if (state.offset.y > END_SLACK) moreAbove = true;
      if (state.offset.y < state.max.y - END_SLACK) moreBelow = true;
      continue;
    }
    const side = droppedBy.get(entry.node.index);
    if (side?.above === true) moreAbove = true;
    if (side?.below === true) moreBelow = true;
  }
  return { kept, moreAbove, moreBelow };
};

/** Whether the node `inner` lies inside the node `outer` (by node index). */
function isInside(snapshot: { nodes: ReadonlyArray<{ parent: number }> }, inner: number, outer: number): boolean {
  for (let p = snapshot.nodes[inner]?.parent ?? -1; p >= 0; p = snapshot.nodes[p]?.parent ?? -1) {
    if (p === outer) return true;
  }
  return false;
}

/** The `tree` method for a request with `glass: true`. */
export function glassTree(params: unknown): Promise<TreeResult> {
  return tree(params, glassPass);
}
