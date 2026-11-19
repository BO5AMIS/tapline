import { planWay, type DrivePlan } from "./drive.js";
import { declaredLink, type AppMap, type KnownPlaces, type Place } from "./places.js";
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
    // The one check `drive` makes of a plan before it moves: every leg, every route, nested drives, links with no values.
    if (!runnable(plan)) continue;
    const at = Date.parse(saved.last);
    reached.push({ name, at: Number.isNaN(at) ? 0 : at });
  }
  reached.sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return reached.map((entry) => entry.name);
}

/** The line, or null when nothing is reachable. */
export function knownLine(names: string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, KNOWN_MAX);
  const more = names.length - shown.length;
  return `Known: ${[...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ")} ${WORDS}`;
}
