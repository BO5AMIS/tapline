import {
  FRONTIER_MAX,
  FRONTIER_MORE,
  SKIP_WHYS,
  capFrontier,
  exploredActionSchema,
  exploredSchema,
  mergeExplored,
  realFrontier,
  recomputeFrontier,
  type ActionResult,
  type ExploredAction,
  type ExploredRecord,
  type SkipWhy,
  type TriedKind,
  type TriedResult,
} from "./mapfile.js";

export { FRONTIER_MAX, FRONTIER_MORE, SKIP_WHYS, capFrontier, exploredActionSchema, exploredSchema, mergeExplored, recomputeFrontier };
export type { ActionResult, ExploredAction, ExploredRecord, SkipWhy, TriedKind, TriedResult };

// The map's explored record (AGENT-TOOLS 1.15 §28): for each place, what the explorer tried there. Pure functions over
// the record; mapfile.ts holds it in the file and merges it, places.ts has the helpers the explorer calls.

/** An action counts as tried for the explorer only on the app's current build; a skip holds for every build (§28.1). */
export function countsAsTried(action: ExploredAction, build: string): boolean {
  return action.result === "skipped" || action.build === build;
}

/**
 * What the explorer still has to try at a place: the stored frontier (cut mark left out), then the actions whose
 * build is not the current one (a new build tries everything again), except skips. Never repeats a signature.
 */
export function frontierOf(record: ExploredRecord | undefined, build: string): string[] {
  if (record === undefined) return [];
  const sigs = realFrontier(record.frontier);
  for (const action of record.actions) if (!countsAsTried(action, build)) sigs.push(action.sig);
  return [...new Set(sigs)];
}

/** Whether the frontier was cut at 50 (the explorer has more to find on a later read of the place). */
export function frontierCut(record: ExploredRecord | undefined): boolean {
  return record !== undefined && record.frontier.includes(FRONTIER_MORE);
}

/** Puts the result of one action into a record (a new entry, or the old one replaced), stamped `now`. */
export function withTried(record: ExploredRecord | undefined, sig: string, result: TriedResult, build: string, now: string): ExploredRecord {
  const entry: ExploredAction = { sig, result: result.result, ...("to" in result ? { to: result.to } : {}), ...("code" in result ? { code: result.code } : {}), ...("role" in result && result.role !== undefined && result.role !== "" ? { role: result.role } : {}), build, last: now };
  return replaceAction(record, entry, now);
}

/** A skip: kept for every build, with `word` when a policy word matched. It carries no build (§28.1). */
export function withSkipped(record: ExploredRecord | undefined, sig: string, why: SkipWhy, word: string | undefined, now: string): ExploredRecord {
  const entry: ExploredAction = { sig, result: "skipped", why, ...(word !== undefined ? { word } : {}), last: now };
  return replaceAction(record, entry, now);
}

/** Adds signatures seen on the place that nothing has tried or skipped yet. */
export function withSeen(record: ExploredRecord | undefined, sigs: readonly string[], now: string): ExploredRecord {
  const base: ExploredRecord = record ?? { last: now, actions: [], frontier: [] };
  const done = new Set(base.actions.map((action) => action.sig));
  const more = base.frontier.includes(FRONTIER_MORE);
  const next = [...realFrontier(base.frontier), ...sigs.filter((sig) => !done.has(sig))];
  return { ...base, last: now, frontier: capFrontier(next, more) };
}

function replaceAction(record: ExploredRecord | undefined, entry: ExploredAction, now: string): ExploredRecord {
  const base: ExploredRecord = record ?? { last: now, actions: [], frontier: [] };
  const index = base.actions.findIndex((action) => action.sig === entry.sig);
  const actions = base.actions.slice();
  if (index >= 0) actions[index] = entry;
  else actions.push(entry);
  return recomputeFrontier({ ...base, last: now, actions });
}

export interface CoverageCounts {
  places: number;
  explored: number;
  frontier: number;
}

/**
 * §28.3: a place is **explored** when it has a record for the current build and its frontier is empty; it is a
 * **frontier** place when its record has untried actions or when it has no record.
 */
export function coverageCounts(records: ReadonlyArray<ExploredRecord | undefined>, build: string): CoverageCounts {
  let explored = 0;
  for (const record of records) if (record !== undefined && frontierOf(record, build).length === 0 && !frontierCut(record)) explored += 1;
  return { places: records.length, explored, frontier: records.length - explored };
}

/** The `Coverage:` line of `map` (§28.3), or null when no place has an explored record. `notReached` is null for a tool with no places known up front. */
export function coverageLine(records: ReadonlyArray<ExploredRecord | undefined>, build: string, notReached: number | null): string | null {
  if (!records.some((record) => record !== undefined)) return null;
  const { places, explored, frontier } = coverageCounts(records, build);
  const up = notReached === null ? "" : `; known up front, not reached: ${notReached}`;
  return `Coverage: ${places} places (${explored} explored, ${frontier} frontier)${up}.`;
}
