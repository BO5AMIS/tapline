import { planWay, type DrivePlan } from "./drive.js";
import { declaredLink, type AppMap, type KnownPlaces, type Place } from "./places.js";
import { asWords, linkReadable, linkWords, matchWord } from "./policy.js";
import { routeEdges } from "./routes.js";

// The `Known:` line (AGENT-TOOLS 1.17 §30.2): the places `drive {"to": name}` reaches from where the app is, by the map.

/** At most this many names; the rest read as `+N more`. */
export const KNOWN_MAX = 8;

const WORDS = "(one call each: drive {\"to\": ...})";

/**
 * The names of the map's places that `drive` reaches in one call from `here` (null when the screen is new to the map, so
 * only a link can start). It asks the same planner `drive` uses, and a link only counts when it needs no value. Names are
 * the map's own (a route name or one given with `map`), never screen text. Most recently reached first, then by name:
 * the map keeps no use counts for places.
 */
export function reachableNames(map: AppMap, here: Place | null, current: Place, known: KnownPlaces, tapsOnly: boolean, runnable: (plan: DrivePlan) => boolean): string[] {
  const places = map.data().places;
  const routes = tapsOnly ? undefined : routeEdges(map);
  const reached: Array<{ name: string; at: number }> = [];
  for (const [name, saved] of Object.entries(places)) {
    if (name === current.name) continue;
    const link = saved.link ?? declaredLink(saved.key, known, {});
    const plan = planWay(map, here, { name, link }, { by: "any", tapsOnly, ...(routes !== undefined ? { routes } : {}) });
    if ("error" in plan) continue;
    // A saved route on the way is never listed: its steps carry arguments, policy words and nested drives no static check can promise.
    if (plan.moves.some((move) => move.route !== undefined)) continue;
    // A link with a placeholder of any form needs a value, whether or not the app declared its params.
    if (plan.by !== "taps" && link !== null && PLACEHOLDER.test(link)) continue;
    // The one check `drive` makes of a plan before it moves: every leg, every route, nested drives, links with no values.
    if (!runnable(plan)) continue;
    const at = Date.parse(saved.last);
    reached.push({ name, at: Number.isNaN(at) ? 0 : at });
  }
  reached.sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return reached.map((entry) => entry.name);
}

/** A link's placeholders in every form a router uses: `[id]`, `[...rest]`, `:id`, `{id}`. */
const PLACEHOLDER = /\[[^\]]+\]|\{[^}]+\}|\/:\w+/;

/**
 * Whether any leg of the plan would be blocked by the policy words, or would need a person's OK (so it isn't one call): the words
 * are matched, as a touch matches them, on each link's path and on each road's saved id, label and text. `words` is the block and the
 * confirm list together.
 */
export function legsNeedPerson(plan: DrivePlan, words: string[]): boolean {
  if (words.length === 0) return false;
  for (const { road } of plan.moves) {
    const { move, names } = road;
    if (move.tool === "open_url") {
      const url = move.url ?? "";
      if (!linkReadable(url) || matchWord(words, { label: linkWords(url) }) !== null) return true;
    }
    const said: Array<string | undefined> = [names?.label, names?.text, move.target?.label, move.target?.text];
    if (said.some((text) => text !== undefined && matchWord(words, { label: text }) !== null)) return true;
    for (const id of [names?.id, move.target?.id]) if (id !== undefined && matchWord(words, { label: asWords(id) }) !== null) return true;
  }
  return false;
}

/** The line, or null when nothing is reachable. */
export function knownLine(names: string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, KNOWN_MAX);
  const more = names.length - shown.length;
  return `Known: ${[...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ")} ${WORDS}`;
}
