import { z } from "zod";
import { readRouteSync, type MapReflex, type MapRoad } from "./mapfile.js";
import { placeNameFromRoute, samePlace, type AppMap, type KnownPlaces, type Place } from "./places.js";
import { asWords, linkWords, matchWord } from "./policy.js";
import { looksLikeValue } from "./protocol.js";
import { routeEdges, type RouteEdge } from "./routes.js";
import { describeRunStep } from "./run.js";

// The `map` tool (AGENT-TOOLS 1.13 §18.8): a read, and the way to edit what a map holds. It never touches the app.
// Every edit goes through AppMap, which writes with saveMap; nothing here writes the file.

const NAME = /^[a-z0-9_]+$/;
const LIST_MAX = 60;

// -- the reflex a call may add (§18.7)

const whenSchema = z
  .object({ text: z.string().min(1).optional(), label: z.string().min(1).optional(), id: z.string().min(1).optional() })
  .strict()
  .refine((when) => [when.text, when.label, when.id].filter((value) => value !== undefined).length === 1, { message: "when needs exactly one of text, label or id" });

/**
 * What a reflex may do: one step that acts, written as `run` takes it and nothing more (no force, text, secure, index
 * or account). Typing, waiting and the tools that read are not reflexes. An element is named by id, label or text,
 * never by a ref or a point.
 */
const named = z.string().min(1).max(200);
const elementTarget = z.union([z.object({ id: named }).strict(), z.object({ label: named }).strict(), z.object({ text: named }).strict()]);
const elementStep = <T extends "tap" | "long_press" | "toggle">(tool: T) => z.object({ tool: z.literal(tool), target: elementTarget }).strict();
export const reflexDoSchema = z.discriminatedUnion("tool", [
  elementStep("tap"),
  elementStep("long_press"),
  elementStep("toggle"),
  z.object({ tool: z.literal("back") }).strict(),
  z
    .object({ tool: z.literal("swipe"), x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number(), seconds: z.number().min(0.05).max(5).optional() })
    .strict(),
  z
    .object({
      tool: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().min(0.1).max(1).optional(),
      to: z.enum(["start", "end"]).optional(),
      target: elementTarget.optional(),
    })
    .strict(),
  // The cut-down link, as a road keeps it (clarification 14): no query, fragment, credentials or value.
  z
    .object({ tool: z.literal("open_url"), url: named })
    .strict()
    .superRefine((step, ctx) => {
      const problem = linkProblem(step.url);
      if (problem !== null) ctx.addIssue({ code: "custom", path: ["url"], message: problem });
    }),
]);

export const reflexSchema = z
  .object({
    name: z.string().regex(NAME, "a reflex's name is [a-z0-9_]"),
    when: whenSchema,
    do: reflexDoSchema,
    max: z.number().int().min(1).max(3).optional(),
    at: z.string().regex(NAME).optional(),
  })
  .strict();
export type ReflexInput = z.infer<typeof reflexSchema>;
export type ReflexDo = z.infer<typeof reflexDoSchema>;

export interface MapArgs {
  to?: string | undefined;
  name?: string | undefined;
  link?: string | undefined;
  place?: string | undefined;
  reflex?: ReflexInput | undefined;
  forget_reflex?: string | undefined;
  forget?: string | undefined;
}

const ONE_OF = ["to", "name", "link", "reflex", "forget_reflex", "forget"] as const;

const bad = (message: string): MapAnswer => ({ text: `Error bad_params: ${message}`, error: true });
const notFoundPlace = (name: string): MapAnswer => ({ text: `Error not_found: no place named "${name}"; map lists the places.`, error: true });
const said = (text: string): MapAnswer => ({ text, error: false });

export interface MapAnswer {
  text: string;
  error: boolean;
}

/** One argument at a time; `place` only with `link`. A message, or null when the call is well formed. */
export function mapArgsError(args: MapArgs): string | null {
  const given = ONE_OF.filter((key) => args[key] !== undefined);
  if (given.length > 1) return `map takes one argument at a time; you gave ${given.join(", ")}.`;
  if (args.place !== undefined && args.link === undefined) return "place goes with link.";
  return null;
}

export interface MapContext {
  map: AppMap;
  app: { name: string; id: string };
  /** Where the app is now (a read of its place); null when that can't be read. */
  here: () => Promise<Place | null>;
  /** The places the app lists before any visit (§18.1). */
  known: () => Promise<KnownPlaces>;
  /** The policy's words for this app (§11). */
  lists: { confirm: string[]; block: string[] };
  /** Account names, never values (§18.6). */
  accounts: string[];
}

/** Runs one `map` call. The arguments were checked by `mapArgsError`. */
export async function runMap(args: MapArgs, ctx: MapContext): Promise<MapAnswer> {
  let answer: MapAnswer;
  let edited = false;
  if (args.to !== undefined) answer = await way(args.to, ctx);
  else if (args.name !== undefined) [answer, edited] = await nameHere(args.name, ctx);
  else if (args.link !== undefined) [answer, edited] = await addLink(args.link, args.place, ctx);
  else if (args.reflex !== undefined) [answer, edited] = addReflex(args.reflex, ctx);
  else if (args.forget_reflex !== undefined) [answer, edited] = forgetReflex(args.forget_reflex, ctx);
  else if (args.forget !== undefined) [answer, edited] = forgetPlace(args.forget, ctx);
  else answer = await listing(ctx);
  if (!edited) return answer;
  // An edit is written now, so a person or the other tool sees it; a failed write is kept and tried again.
  await ctx.map.flush();
  const failed = ctx.map.lastError();
  return failed === null ? answer : { ...answer, text: `${answer.text}\nNote: the map file wasn't written (${failed}); the change is kept and written when it can be.` };
}

// -- the listing

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** At most 60 entries, then `…`. */
function capped(items: string[]): string[] {
  return items.length > LIST_MAX ? [...items.slice(0, LIST_MAX), "…"] : items;
}

function withLink(name: string, link: string | null | undefined): string {
  return link !== null && link !== undefined && link !== "" ? `${name} (link ${link})` : name;
}

function routeLine(map: AppMap, name: string, relative: string): string {
  const file = readRouteSync(map.folder(), relative);
  if (file === null) return name;
  // A route file is a person's to edit: only a name-shaped start or end is printed, and cut short.
  const place = (value: unknown): string | undefined => (typeof value === "string" && NAME.test(value) ? value.slice(0, 40) : undefined);
  const start = place(file["start"]);
  const end = place(file["end"]);
  const variables = Array.isArray(file["variables"])
    ? file["variables"].filter((v): v is string => typeof v === "string" && /^\w+$/.test(v)).map((v) => v.slice(0, 40))
    : [];
  const way = start !== undefined && end !== undefined ? `${start} → ${end}` : "";
  const parts = [way, variables.join(", ")].filter((part) => part !== "");
  return parts.length === 0 ? name : `${name} (${parts.join("; ")})`;
}

/** Places the app lists that the map has no place for yet: with their links, and no roads. */
function notVisited(map: AppMap, known: KnownPlaces): string[] {
  const saved = Object.values(map.data().places);
  const lines: string[] = [];
  for (const place of known.places) {
    if (saved.some((own) => samePlace(own.key, { route: place.route }))) continue;
    const name = placeNameFromRoute(place.route);
    if (name === "") continue;
    const params = place.params ?? [];
    const notes = [
      place.link !== null && place.link !== undefined && place.link !== "" ? `link ${place.link}` : "",
      params.length > 0 ? `needs ${params.join(", ")}` : "",
    ].filter((note) => note !== "");
    lines.push(notes.length === 0 ? name : `${name} (${notes.join("; ")})`);
  }
  return lines;
}

async function listing(ctx: MapContext): Promise<MapAnswer> {
  const { map, app } = ctx;
  // Reading where the app is can save the screen it is on as a first place, so it comes before the counts.
  const here = await ctx.here();
  const data = map.data();
  const roads = data.roads.length;
  const proven = data.roads.filter((road) => map.isProven(road)).length;
  const routes = Object.entries(data.routes);
  const reflexes = data.reflexes;
  const places = Object.entries(data.places);
  const head =
    `Map of ${app.name} (${app.id}), build ${map.currentBuild()}: ${plural(places.length, "place", "places")}, ` +
    `${plural(roads, "road", "roads")}${roads > 0 ? ` (${proven} proven)` : ""}, ${plural(routes.length, "route", "routes")}, ` +
    `${plural(reflexes.length, "reflex", "reflexes")}. Now at: ${here?.name ?? "unknown"}.`;
  const lines = [head];
  if (places.length > 0) lines.push(`Places: ${capped(places.map(([name, place]) => withLink(name, place.link))).join(", ")}`);
  const up = notVisited(map, await ctx.known());
  if (up.length > 0) lines.push(`Known up front, not visited: ${capped(up).join(", ")}.`);
  if (routes.length > 0) lines.push(`Routes: ${capped(routes.map(([name, relative]) => routeLine(map, name, relative))).join(", ")}`);
  if (reflexes.length > 0) lines.push(`Reflexes: ${capped(reflexes.map((reflex) => reflex.name)).join(", ")}.`);
  if (ctx.accounts.length > 0) lines.push(`Accounts: ${ctx.accounts.join(", ")}.`);
  return said(lines.join("\n"));
}

// -- `to`: the way drive would take (§18.4)

/** Roads this tool replays: its own, and the ones both tools have driven (§18.2). */
const driveable = (road: MapRoad): boolean => road.by === "tapline" || road.by === "both";

/**
 * The cheapest chain of roads: a proven road costs 1, an unproven one 2. Equal cost goes to the chain with the road used most
 * recently. The graph is a few screens, and the search is capped so a tangled map can't stall a read.
 */
export function cheapestWay(roads: MapRoad[], from: string, to: string, isProven: (road: MapRoad) => boolean, routes: RouteEdge[] = []): Array<MapRoad | RouteEdge> | null {
  const recent = (leg: { last: string }): number => {
    const at = Date.parse(leg.last);
    return Number.isNaN(at) ? 0 : at;
  };
  // A route is one leg from its start to its end that costs a move for each of its steps (§18.5).
  const legs: Array<{ leg: MapRoad | RouteEdge; from: string; to: string; cost: number }> = [
    ...roads.filter(driveable).map((road) => ({ leg: road, from: road.from, to: road.to, cost: isProven(road) ? 1 : 2 })),
    ...routes.map((route) => ({ leg: route, from: route.from, to: route.to, cost: route.moves })),
  ];
  const found: { best: { cost: number; used: number; chain: Array<MapRoad | RouteEdge> } | null } = { best: null };
  let budget = 20_000;
  const walk = (at: string, seen: Set<string>, chain: Array<MapRoad | RouteEdge>, cost: number, used: number): void => {
    const { best } = found;
    if (budget-- <= 0 || (best !== null && cost > best.cost)) return;
    if (at === to) {
      if (best === null || cost < best.cost || (cost === best.cost && used > best.used)) found.best = { cost, used, chain: [...chain] };
      return;
    }
    for (const next of legs) {
      if (next.from !== at || seen.has(next.to)) continue;
      seen.add(next.to);
      chain.push(next.leg);
      walk(next.to, seen, chain, cost + next.cost, Math.max(used, recent(next.leg)));
      chain.pop();
      seen.delete(next.to);
    }
  };
  walk(from, new Set([from]), [], 0, 0);
  return found.best === null ? null : found.best.chain;
}

/** A leg that is a saved route rather than a road. */
export const isRouteLeg = (leg: MapRoad | RouteEdge): leg is RouteEdge => typeof leg.route === "string" && typeof leg.moves === "number";

async function way(to: string, ctx: MapContext): Promise<MapAnswer> {
  const { map } = ctx;
  const saved = map.data().places[to];
  const up = saved === undefined ? (await ctx.known()).places.find((place) => placeNameFromRoute(place.route) === to) : undefined;
  if (saved === undefined && up === undefined) return notFoundPlace(to);
  const here = await ctx.here();
  if (here?.name === to) return said(`Already at ${to}.`);
  // A jump goes to a place's link from wherever the app is (§18.4).
  const link = saved !== undefined ? saved.link : (up?.link ?? null);
  if (link !== null && link !== "") return said(`Would drive to ${to} by link (${link}).`);
  if (here === null) return { text: "Error not_found: the app's current place isn't known, so no way can be planned; look at the screen first.", error: true };
  const chain = cheapestWay(map.data().roads, here.name, to, (road) => map.isProven(road), routeEdges(map));
  if (chain === null) {
    return { text: `Error not_found: no known way from ${here.name} to ${to}; drive it once (the driver), and it is remembered.`, error: true };
  }
  const names = [here.name, ...chain.map((leg) => leg.to)].join(" > ");
  // A route counts one move for each of its steps (§18.5).
  const count = chain.reduce((sum, leg) => sum + (isRouteLeg(leg) ? leg.moves : 1), 0);
  const taps = chain.every((leg) => !isRouteLeg(leg) && leg.move.tool === "tap");
  const how = `${count} ${taps ? (count === 1 ? "tap" : "taps") : count === 1 ? "move" : "moves"}`;
  const roads = chain.filter((leg): leg is MapRoad => !isRouteLeg(leg));
  const unproven = roads.filter((road) => !map.isProven(road));
  const via = chain.filter(isRouteLeg).map((leg) => `via route ${leg.route}`);
  const state = [unproven.length === 0 ? "all proven" : `unproven for build ${map.currentBuild()}: ${unproven.map((road) => `${road.from} > ${road.to}`).join(", ")}`, ...via].join("; ");
  return said(`Would drive to ${to} by ${how}: ${names} (${state}).`);
}

// -- `name`

const NO_HERE: MapAnswer = { text: "Error not_found: the app's current place isn't known; look at the screen first.", error: true };

async function nameHere(name: string, ctx: MapContext): Promise<[MapAnswer, boolean]> {
  const here = await ctx.here();
  if (here === null) return [NO_HERE, false];
  if (ctx.map.data().places[here.name] === undefined) return [{ text: "Error not_found: the current place isn't in the map yet; look at the screen first.", error: true }, false];
  if (here.name === name) return [said(`The current place is already ${name}.`), false];
  if (ctx.map.data().places[name] !== undefined) return [bad(`a place named "${name}" already exists; pick another name.`), false];
  // The name is the agent's choice and may be any [a-z0-9_]; the tool never fills one in from screen text.
  if (!ctx.map.renamePlace(here.name, name)) return [bad(`"${name}" can't name a place; use [a-z0-9_].`), false];
  return [said(`Named the current place ${name} (was ${here.name}).`), true];
}

// -- `link`: kept as given, as a pattern, never a real id (§18.3)

const PARAM_PIECE = /^\[(?:\.\.\.)?[A-Za-z0-9_]+\]$/;

/** A segment that holds a value: a number, a uuid, long hex (§18.1), or a long mixed run that looks like a token. */
function holdsValue(segment: string): boolean {
  if (PARAM_PIECE.test(segment)) return false;
  // A JWT is three dotted parts: each part is looked at on its own.
  return segment.split(".").some(
    (part) =>
      looksLikeValue(part) ||
      (part.length >= 20 && /^[A-Za-z0-9_-]+$/.test(part) && /[A-Za-z]/.test(part) && /\d/.test(part)) ||
      // A long run with no separator is no word of a route.
      (part.length >= 24 && /^[A-Za-z0-9]+$/.test(part)),
  );
}

/** A message when the link can't be kept as given; null when it can. It never repeats what was refused. */
function linkProblem(link: string): string | null {
  const found = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(link.trim());
  if (found === null) return "a link is scheme://path, like wayfare://settings.";
  const [, scheme = "", rest = ""] = found;
  const authority = rest.split("/")[0] ?? "";
  if (/[?#]/.test(rest) || authority.includes("@")) {
    return "a link holds only a scheme and a path: no query, no fragment, no credentials. A value there may be a secret; drop it.";
  }
  const segments = rest.split("/").filter((segment) => segment !== "");
  if (!segments.some(holdsValue)) return null;
  const suggestion = `${scheme}://${segments.map((segment) => (holdsValue(segment) ? "[id]" : segment)).join("/")}`;
  return `a segment of the link looks like a value (an id, a uuid or a token), and a link holds a pattern; write it as ${suggestion}.`;
}

async function addLink(link: string, placeName: string | undefined, ctx: MapContext): Promise<[MapAnswer, boolean]> {
  const problem = linkProblem(link);
  if (problem !== null) return [bad(problem), false];
  let target = placeName;
  if (target === undefined) {
    const here = await ctx.here();
    if (here === null) return [NO_HERE, false];
    target = here.name;
  }
  const saved = ctx.map.data().places[target];
  if (saved === undefined) return [notFoundPlace(target), false];
  const was = saved.link;
  const given = link.trim();
  ctx.map.setLink(target, given);
  const replaced = was !== null && was !== "" && was !== given ? ` (was ${was})` : "";
  return [said(`Added link ${given} to ${target}${replaced}.`), true];
}

// -- reflexes (§18.7); the machinery that fires them is not here


/** The words a policy could match in a reflex's `do`: its text and label, an id's words, and a link's path words. */
export function reflexWords(step: ReflexInput["do"]): { label?: string; text?: string } {
  if (step.tool === "open_url") return { text: linkWords(step.url) };
  if (step.tool !== "tap" && step.tool !== "long_press" && step.tool !== "toggle") return {};
  const target = step.target;
  if ("id" in target) return { text: asWords(target.id) };
  if ("label" in target) return { label: target.label };
  return { text: target.text };
}

function addReflex(input: ReflexInput, ctx: MapContext): [MapAnswer, boolean] {
  if (input.at !== undefined && ctx.map.data().places[input.at] === undefined) return [notFoundPlace(input.at), false];
  const words = reflexWords(input.do);
  const blocked = matchWord(ctx.lists.block, words);
  const flagged = blocked === null ? matchWord(ctx.lists.confirm, words) : null;
  if (blocked !== null || flagged !== null) {
    const what = describeRunStep(input.do);
    const refusal =
      blocked !== null
        ? `which the policy blocks (${JSON.stringify(blocked)}); a reflex may not do it.`
        : `which the policy flags (${JSON.stringify(flagged)}); a reflex may not do what needs a person's OK.`;
    return [{ text: `Error not_allowed: blocked: reflex "${input.name}" would ${what}, ${refusal} Nothing was saved.`, error: true }, false];
  }
  const reflex: MapReflex = {
    name: input.name,
    when: input.when,
    do: input.do,
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
  };
  const result = ctx.map.addReflex(reflex);
  return [said(`${result === "added" ? "Added" : "Replaced"} reflex ${input.name}.`), true];
}

function forgetReflex(name: string, ctx: MapContext): [MapAnswer, boolean] {
  if (!ctx.map.removeReflex(name)) return [{ text: `Error not_found: no reflex named "${name}".`, error: true }, false];
  return [said(`Forgot reflex ${name}.`), true];
}

// -- `forget`

function forgetPlace(name: string, ctx: MapContext): [MapAnswer, boolean] {
  const { map } = ctx;
  if (map.data().places[name] === undefined) return [notFoundPlace(name), false];
  // Counted before it goes: the answer says what went with the place.
  const counts = [
    plural(map.data().roads.filter((road) => road.from === name || road.to === name).length, "road", "roads"),
    plural(map.routesAt(name).length, "route", "routes"),
    plural(map.data().reflexes.filter((reflex) => reflex.at === name).length, "reflex", "reflexes"),
  ].filter((count) => !count.startsWith("0 "));
  map.removePlace(name);
  const together = counts.length <= 1 ? counts.join("") : `${counts.slice(0, -1).join(", ")} and ${counts[counts.length - 1] as string}`;
  return [said(`Forgot place ${name}${together === "" ? "" : `, with ${together}`}.`), true];
}
