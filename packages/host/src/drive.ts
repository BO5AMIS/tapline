import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AccountStore } from "./accounts.js";
import { cheapestWay, describeWay, howText, isRouteLeg, type WayLeg } from "./mapcmd.js";
import type { MapRoad, Move } from "./mapfile.js";
import { declaredLink, keyFromState, placeNameFromRoute, placeNow, type AppMap, type KnownPlaces, type Observation, type Place, type PlaceSource } from "./places.js";
import { elementSchema, placeStateSchema, type PlaceState, type TreeElement, type TreeResult } from "./protocol.js";
import { isReflexFailure } from "./reflexes.js";
import { loadRoute, routeEdges, routeRunner, substituteSteps, type RouteEdge } from "./routes.js";
import type { SharedScriptV2 } from "./script.js";
import type { Step } from "./run.js";

// `drive` (AGENT-TOOLS 1.13 §18.4; F7): takes the app to a place along the roads the map knows, with no model in the loop.
// Every move goes through `services.touch`, which runs the same policy check and person's OK as a single call.

// -- the plan

export interface PlannedMove {
  road: MapRoad;
  viaLink: boolean;
  /** Set when this leg is a saved route (§18.5): `road` then only carries its two places. */
  route?: RouteEdge;
}

export interface DrivePlan {
  by: "link" | "taps" | "link then taps";
  moves: PlannedMove[];
  cost: number;
  proven: boolean;
}

export type PlanOptions = { by: "any" | "taps" | "link"; tapsOnly: boolean; routes?: RouteEdge[] };

/** A saved route as one leg: a road in shape, so one loop plans and counts both. */
function routeRoad(edge: RouteEdge): MapRoad {
  return { from: edge.from, to: edge.to, move: { tool: "route" }, names: { text: edge.route }, by: "tapline", seen: 0, failed: 0, ms: 0, last: edge.last, build: "" };
}

/** A jump is an `open_url` of the place's link, written as a road so one loop drives both. */
function jumpRoad(from: Place | null, to: { name: string }, link: string): MapRoad {
  return { from: from?.name ?? "", to: to.name, move: { tool: "open_url", url: link }, by: "tapline", seen: 0, failed: 0, ms: 0, last: "", build: "" };
}

/**
 * §18.4: a jump if the place has a link and `by` allows one (a user's-eyes journey never jumps); else the chain of proven
 * roads with the fewest moves (an unproven road counts double); a tie goes to the road used most recently. Only this
 * tool's roads, and the ones both tools have driven, are followed (§18.2).
 */
export function planWay(map: AppMap, from: Place | null, to: { name: string; link: string | null }, options: PlanOptions): DrivePlan | { error: "no_way" | "unknown_start" } {
  const link = to.link !== null && to.link !== "" ? to.link : null;
  if (options.by !== "taps" && !options.tapsOnly && link !== null) {
    return { by: "link", moves: [{ road: jumpRoad(from, to, link), viaLink: true }], cost: 1, proven: true };
  }
  if (options.by === "link") return { error: "no_way" };
  if (from === null) return { error: "unknown_start" };
  if (from.name === to.name) return { by: "taps", moves: [], cost: 0, proven: true };
  // A person has no link to follow, so a journey's roads leave the link roads, and its routes, out.
  const roads = options.tapsOnly ? map.data().roads.filter((road) => road.move.tool !== "open_url") : map.data().roads;
  const chain = cheapestWay(roads, from.name, to.name, (road) => map.isProven(road), options.tapsOnly ? [] : (options.routes ?? []));
  if (chain === null) return { error: "no_way" };
  const moves: PlannedMove[] = chain.map((leg) => (isRouteLeg(leg) ? { road: routeRoad(leg), viaLink: false, route: leg } : { road: leg, viaLink: false }));
  return {
    by: "taps",
    moves,
    cost: chain.reduce((sum, leg) => sum + (isRouteLeg(leg) ? leg.moves : map.isProven(leg) ? 1 : 2), 0),
    proven: chain.every((leg) => isRouteLeg(leg) || map.isProven(leg)),
  };
}

// -- what the host gives drive

export type TouchTool = "tap" | "long_press" | "toggle" | "swipe" | "back" | "open_url";
export type TouchMethod = "press" | "longPress" | "toggle" | "swipe" | "back" | "openURL";

/** What the policy checked, field by field: null means the field is absent, and the app holds it to absent. */
export interface Guard {
  id: string | null;
  label: string | null;
  text: string | null;
  role: string | null;
}

export interface TouchCall {
  tool: TouchTool;
  method: TouchMethod;
  /** Exactly what the plain method takes. */
  params: Record<string, unknown>;
  /** The element the policy is checked against, already read; without it the host resolves the target itself. */
  known?: TreeElement[];
  /** The app refuses (`stale`) when the target is another element than this one. */
  guard?: Guard;
  /** Wait for this target after the move (the app's `move` request). */
  next?: { target: Record<string, unknown>; capMs: number; kind: "press" | "longPress" | "toggle" };
  /** Which call made this touch: only a drive's own jump is noted as a journey shortcut (a plain open_url is noted by its own call). */
  of?: "drive";
  /** Send one `move` request (the app has the capability), else the plain method. */
  pipelined: boolean;
}

export interface NextWait {
  state: "ready" | "missing" | "covered" | "moving";
  element?: TreeElement;
  waitedMs: number;
}

export type TouchOutcome =
  | { kind: "stop"; answer: CallToolResult }
  | { kind: "error"; code: string; message: string }
  | { kind: "done"; place: PlaceState | null; next?: NextWait; via?: "chat" | "live view" };

export interface DriveServices {
  map: AppMap;
  source: PlaceSource;
  capabilities: readonly string[];
  /** The call was cancelled: stop between moves. */
  aborted(): boolean;
  /** A user's-eyes journey never jumps (§18.4), unless its `allow` names `drive`. */
  tapsOnly: boolean;
  /** In a user's eyes each move is aimed by the visible text it had, and no id or place name is said (§18.12). */
  eyes: boolean;
  /** Told of each move that went through, so a journey can count its taps. */
  moved?(tool: string, viaLink: boolean): void;
  clock(): number;
  sleep(ms: number): Promise<void>;
  describe(error: unknown): string;
  /** The places the app lists before any visit. */
  known(): Promise<KnownPlaces>;
  /** One element list read, with no answer built. */
  tree(): Promise<TreeResult>;
  /** The elements a wire target could mean in a list (the same matching a touch uses). */
  candidates(target: Record<string, unknown>, elements: TreeElement[]): TreeElement[];
  /** One move: the policy, a person's OK when needed, then the request. */
  touch(call: TouchCall): Promise<TouchOutcome>;
  /**
   * Gives declared reflexes their moment (§18.7): at a place change (`at` is the place arrived at) and before a failure is
   * answered (no `at`). Says how many fired.
   */
  reflexes?(at?: string): Promise<number>;
  /** The screen as an action's answer shows a new screen, under this first line. */
  screen(line: string, brief: boolean | undefined): Promise<CallToolResult>;
}

export interface DriveArgs {
  to?: string | undefined;
  route?: string | undefined;
  with?: Record<string, string> | undefined;
  account?: string | undefined;
  then?: unknown[] | undefined;
  by?: "any" | "taps" | "link" | undefined;
  brief?: boolean | undefined;
  dry_run?: boolean | undefined;
  /** Set by the host for a drive that is a `run` step or a route's way to its start: no screen is built on success. */
  quiet?: boolean | undefined;
}

/** A refusal of the arguments, before anything is read; null when they are fine. */
export function driveArgsError(args: DriveArgs): string | null {
  if ((args.to === undefined) === (args.route === undefined)) return "give exactly one of to (a place) or route (a saved route).";
  if (args.route !== undefined && args.by !== undefined && args.by !== "any") return "by goes with to; a route is driven from its start place by link or roads.";
  return null;
}

// -- the app's `move` answer

const moveResultSchema = z.object({
  place: placeStateSchema.nullish().catch(null),
  next: z
    .object({ state: z.enum(["ready", "missing", "covered", "moving"]), element: elementSchema.optional(), waitedMs: z.number().catch(0) })
    .optional()
    .catch(undefined),
});

/** What a `move` answer says beyond what the plain method returns: where the app is, and the next target's state. */
export function parseMoveResult(raw: unknown): { place: PlaceState | null; next?: NextWait } {
  const parsed = moveResultSchema.safeParse(raw);
  if (!parsed.success) return { place: null };
  const { place, next } = parsed.data;
  if (next === undefined) return { place: place ?? null };
  return { place: place ?? null, next: { state: next.state, waitedMs: next.waitedMs, ...(next.element !== undefined ? { element: next.element } : {}) } };
}

// -- words

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const seconds = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(1);

function targetWords(target: Move["target"], names?: MapRoad["names"], eyes = false): string {
  // In a user's eyes only the visible text is said, never an id or a label (AGENT-TOOLS 1.13 18.12).
  if (eyes) return names?.text !== undefined ? ` ${JSON.stringify(names.text)}` : "";
  // What a person would read comes first: the road's text or label, else its id (§18.4's example names "Language").
  const text = names?.text ?? names?.label ?? target?.text ?? target?.label;
  if (text !== undefined) return ` ${JSON.stringify(text)}`;
  const id = target?.id ?? names?.id;
  return id !== undefined ? ` id=${id}` : "";
}

/** `tap "Language"`, for the step an answer names. */
function stepWords(road: MapRoad, eyes = false): string {
  const { move } = road;
  switch (move.tool) {
    case "tap":
      return `tap${targetWords(move.target, road.names, eyes)}`;
    case "long_press":
      return `long press${targetWords(move.target, road.names, eyes)}`;
    case "toggle":
      return `toggle${targetWords(move.target, road.names, eyes)}`;
    case "back":
      return "back";
    case "swipe":
      return "swipe";
    case "route":
      return eyes ? "route" : `route ${road.names?.text ?? ""}`.trim();
    default:
      return "open the link";
  }
}

const said = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }] });
const failed = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function appendLines(answer: CallToolResult, lines: string[]): CallToolResult {
  if (lines.length === 0) return answer;
  const [top, ...rest] = answer.content;
  if (top === undefined || top.type !== "text") return answer;
  return { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), ...lines].join("\n") }, ...rest] };
}

// -- one road as a request

const NO_TEXT = "it has no text a person could read";

type Built ={ ok: true; tool: TouchTool; method: TouchMethod; params: Record<string, unknown>; wire?: Record<string, unknown> } | { ok: false; why: string };

function wireOf(target: NonNullable<Move["target"]>): Record<string, unknown> | null {
  if (target.id !== undefined) return { testID: target.id };
  if (target.label !== undefined) return { label: target.label };
  if (target.text !== undefined) return { text: target.text };
  if (typeof target.x === "number" && typeof target.y === "number") return { x: target.x, y: target.y };
  return null;
}

/** Fills `[param]` pieces of a link with the values the agent gave; a missing one is named. */
export function fillLink(link: string, values: Record<string, string>): { ok: true; url: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const url = link.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (whole, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined || value === "") {
      missing.push(name);
      return whole;
    }
    return encodeURIComponent(value);
  });
  return missing.length > 0 ? { ok: false, missing } : { ok: true, url };
}

/** The request a road's move makes. A row with no id can't be replayed: the driver chooses the row (§18.2). */
function build(move: Move, values: Record<string, string>, names?: MapRoad["names"], eyes = false): Built {
  switch (move.tool) {
    case "tap":
    case "long_press":
    case "toggle": {
      const target = move.target;
      if (target === undefined) return { ok: false, why: "the road has no target" };
      if (target.row === true) return { ok: false, why: "it is a list row with no id of its own, so the driver chooses the row" };
      // A person can't see ids: in their eyes the move is aimed by the text the road saw, and the app doesn't scroll for them (§18.12).
      let wire: Record<string, unknown> | null;
      if (eyes) {
        const text = names?.text;
        if (text === undefined || text === "") return { ok: false, why: NO_TEXT };
        wire = { text };
      } else wire = wireOf(target);
      if (wire === null) return { ok: false, why: "the road has no target" };
      const method = move.tool === "tap" ? "press" : move.tool === "long_press" ? "longPress" : "toggle";
      return { ok: true, tool: move.tool === "tap" ? "tap" : move.tool === "long_press" ? "long_press" : "toggle", method, params: { target: wire, ...(eyes ? { noScroll: true } : {}) }, wire };
    }
    case "back":
      return { ok: true, tool: "back", method: "back", params: {} };
    case "open_url": {
      if (move.url === undefined) return { ok: false, why: "the road has no link" };
      const filled = fillLink(move.url, values);
      if (!filled.ok) return { ok: false, why: `the link needs ${filled.missing.join(", ")}` };
      return { ok: true, tool: "open_url", method: "openURL", params: { url: filled.url } };
    }
    case "swipe": {
      const { x0, y0, x1, y1, seconds: length } = move;
      if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return { ok: false, why: "the road has no swipe points" };
      return { ok: true, tool: "swipe", method: "swipe", params: { x0, y0, x1, y1, ...(length !== undefined ? { seconds: length } : {}) } };
    }
    default:
      return { ok: false, why: `Tapline doesn't drive "${move.tool}"` };
  }
}

/** Every policy-relevant field of the element that receives the touch; an absent field stays absent (never a wildcard). */
export const guardOf = (element: TreeElement): Guard => ({
  id: typeof element.testID === "string" && element.testID !== "" ? element.testID : null,
  label: typeof element.label === "string" && element.label !== "" ? element.label : null,
  text: typeof element.text === "string" && element.text !== "" ? element.text : null,
  role: typeof element.role === "string" && element.role !== "" ? element.role : null,
});

/** How a road names an element now: by id, else label, else text (§18.2). */
function moveTargetOf(element: TreeElement): { target: NonNullable<Move["target"]>; names: NonNullable<MapRoad["names"]> } | null {
  const names: NonNullable<MapRoad["names"]> = {};
  // A list row keeps only its id: its label and text are content, never saved (§18.2).
  if (element.row === true) {
    if (typeof element.testID !== "string" || element.testID === "") return null;
    return { target: { id: element.testID }, names: { id: element.testID } };
  }
  if (typeof element.testID === "string" && element.testID !== "") names.id = element.testID;
  if (typeof element.label === "string" && element.label !== "") names.label = element.label;
  if (typeof element.text === "string" && element.text !== "") names.text = element.text;
  if (names.id !== undefined) return { target: { id: names.id }, names };
  if (names.label !== undefined) return { target: { label: names.label }, names };
  if (names.text !== undefined) return { target: { text: names.text }, names };
  return null;
}

// -- repair (§18.4: when the road is wrong, 1)

const normal = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

function close(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return true;
  return Math.max(a.length, b.length) >= 5 && editDistance(a, b) <= 1;
}

/**
 * The element the road meant, when its own target isn't there: the same element by its other names, then the closest match.
 * Only a single match is taken (the arrival check and the policy still decide).
 */
export function repairTarget(
  names: NonNullable<MapRoad["names"]>,
  elements: TreeElement[],
  find: (target: Record<string, unknown>, elements: TreeElement[]) => TreeElement[],
  eyes = false,
): TreeElement | null {
  const wires: Array<Record<string, unknown>> = [];
  // A person sees text only: in their eyes no id or label names the element, and a list row's content is never a name (§18.12).
  if (names.id !== undefined && !eyes) wires.push({ testID: names.id });
  if (names.label !== undefined && !eyes) wires.push({ label: names.label });
  if (names.text !== undefined) wires.push({ text: names.text });
  const usable = (element: TreeElement): boolean =>
    eyes ? element.row !== true && typeof element.text === "string" && element.text !== "" : element.row !== true || (typeof element.testID === "string" && element.testID !== "");
  for (const wire of wires) {
    const found = find(wire, elements).filter(usable);
    if (found.length === 1 && found[0] !== undefined) return found[0];
  }
  const wanted = [eyes ? undefined : names.label, names.text].filter((s): s is string => s !== undefined).map(normal);
  const near = elements.filter(
    (element) =>
      usable(element) &&
      (element.actions?.length ?? 0) > 0 &&
      [element.label, element.text].some((s) => typeof s === "string" && wanted.some((w) => close(normal(s), w))),
  );
  return near.length === 1 && near[0] !== undefined ? near[0] : null;
}

const shownName = (element: TreeElement): string => {
  if (element.row === true) return `id=${element.testID ?? "?"}`;
  const words = element.text ?? element.label;
  return typeof words === "string" && words !== "" ? JSON.stringify(words) : `id=${element.testID ?? "?"}`;
};

// -- the drive

interface Leg {
  i: number;
  n: number;
  road: MapRoad;
  eyes: boolean;
}

type Core =
  | { ok: true; answer: CallToolResult; line: string; notes: string[]; arrived: string }
  | { ok: false; code: string; message: string; answer: CallToolResult };

const OFF_ROUTE_CODES: ReadonlySet<string> = new Set(["not_found", "ambiguous", "not_actionable", "stale"]);
const MAX_REPLANS = 2;
/** Moments only a person can clear (AGENT-TOOLS 1.13 11.5): a drive is a batch, so they are answered in a batch's form and never re-run. */
const MOMENT_CODES: ReadonlySet<string> = new Set(["not_connected", "in_background", "not_answering"]);

function batchFailure(code: string, message: string, leg: Leg, done: number): Core {
  const text = `Ran ${done} of ${leg.n} steps; stopped at step ${leg.i + 1} (${stepWords(leg.road, leg.eyes)}): ${message} Nothing else was touched.`;
  return { ok: false, code, message: text, answer: failed(`Error ${code}: ${text}`) };
}

type Finish = (code: string, why: string, leg: Leg | null, now: Place | null, isNew: boolean) => Promise<Core>;

/** The next target is covered: an alert goes to the person's moment, anything else is off_route (and blames no road). */
async function covered(svc: DriveServices, leg: Leg, done: number, now: Place | null, finish: Finish): Promise<Core> {
  let alert = false;
  try {
    alert = ((await svc.tree()).alerts?.length ?? 0) > 0;
  } catch {
    alert = false;
  }
  if (alert) return batchFailure("not_actionable", "behind_alert: An alert is open; a person has to answer it.", leg, done);
  return finish("off_route", "it's covered by something on the screen", leg, now, false);
}

function offRouteWhy(code: string, message: string): string {
  if (code === "not_found") return "it isn't on this screen";
  if (code === "ambiguous") return "it matches more than one element on this screen";
  if (code === "stale") return "it is another element now than the one the policy checked";
  const reason = message.split(":")[0] ?? "";
  return /^[a-z_]{3,30}$/.test(reason) ? `it can't be touched now (${reason.replace(/_/g, " ")})` : "it can't be touched now";
}

/** The first line of an answer, replaced; the rest (the screen, the notes) stays. */
function withFirstLine(answer: CallToolResult, line: string): CallToolResult {
  const [top, ...rest] = answer.content;
  if (top === undefined || top.type !== "text") return answer;
  const [, ...lines] = top.text.split("\n");
  return { ...answer, content: [{ type: "text", text: [line, ...lines].join("\n") }, ...rest] };
}

/** Lines put in front of an answer's text. */
function withLinesBefore(answer: CallToolResult, lines: string[]): CallToolResult {
  const [top, ...rest] = answer.content;
  if (top === undefined || top.type !== "text") return answer;
  return { ...answer, content: [{ type: "text", text: [...lines, top.text].join("\n") }, ...rest] };
}

/**
 * Takes the app to a place (AGENT-TOOLS 1.13 18.4), then runs `then` (ordinary `run` steps) when given. `rs` lets the way go
 * through a saved route and run the `then` steps; without it a way is roads and links only.
 */
export async function driveTo(svc: DriveServices, args: DriveArgs, rs: RouteServices): Promise<CallToolResult> {
  const steps = args.then as Step[] | undefined;
  // The steps are checked like `run` checks its own, before anything is touched.
  if (steps !== undefined) {
    const refused = rs.checkSteps(steps);
    if (refused !== null) return refused;
  }
  return afterThen(await driveCore(svc, args, rs, steps !== undefined || args.quiet === true), args, rs);
}

/** A drive for a caller that wants no screen on success (a replay going to a route's start). */
export async function driveQuietly(svc: DriveServices, args: DriveArgs, rs?: RouteServices): Promise<{ ok: true } | { ok: false; message: string }> {
  const core = await driveCore(svc, args, rs, true);
  return core.ok ? { ok: true } : { ok: false, message: core.message };
}

/** `then`: the steps go on after the arrival, in the same call; the answer follows `run`'s (18.4, 9.3). */
async function afterThen(core: Core, args: DriveArgs, rs: RouteServices | undefined): Promise<CallToolResult> {
  // A dry run touches nothing, so the steps after it don't run either.
  if (!core.ok || args.then === undefined || rs === undefined || args.dry_run === true) return core.answer;
  const ran = await rs.runSteps(args.then as Step[], true);
  if (ran.isError === true) return appendLines(ran, [...core.notes, `Note: arrived at ${core.arrived} before the steps ran.`]);
  return withLinesBefore(ran, [core.line, ...core.notes]);
}

async function driveCore(svc: DriveServices, args: DriveArgs, rs: RouteServices | undefined, quiet: boolean): Promise<Core> {
  try {
    return await travel(svc, args, rs, quiet);
  } catch (error) {
    const text = svc.describe(error);
    const found = /^Error (\w+): ([\s\S]*)$/.exec(text);
    return { ok: false, code: found?.[1] ?? "internal", message: found?.[2] ?? text, answer: failed(text) };
  }
}

/** The routes that are running now, by map folder: a route that comes back to itself would never end. */
const activeRoutes = new Map<string, Set<string>>();

/** Marks a route as running; null when it already is. Call the returned function when it ends. */
function enterRoute(folder: string, name: string): (() => void) | null {
  const set = activeRoutes.get(folder) ?? new Set<string>();
  if (set.has(name)) return null;
  set.add(name);
  activeRoutes.set(folder, set);
  return () => {
    set.delete(name);
    if (set.size === 0 && activeRoutes.get(folder) === set) activeRoutes.delete(folder);
  };
}

const repeatedRoute = (name: string): string => `route "${name}" is already running; a route can't run itself, so this drive was refused.`;

async function travel(svc: DriveServices, args: DriveArgs, rs: RouteServices | undefined, quiet: boolean): Promise<Core> {
  const { map } = svc;
  const started = svc.clock();
  const to = args.to ?? "";
  const by = args.by ?? "any";
  const values = args.with ?? {};
  const eyes = svc.eyes;
  const bad = (code: string, message: string): Core => ({ ok: false, code, message, answer: failed(`Error ${code}: ${message}`) });
  // A success carries no screen when the caller adds its own (`then`, a `run` step, a replay).
  const screenOf = (line: string): Promise<CallToolResult> => (quiet ? Promise.resolve(said(line)) : svc.screen(line, args.brief));

  if (by === "link" && svc.tapsOnly) {
    return bad("not_allowed", "in a journey, a jump is a shortcut a user doesn't have, and this journey's allow doesn't name drive; reach the place by its roads (by: \"taps\").");
  }

  // The place: one the map holds, or one the app lists up front (it may have a link and no roads yet).
  const saved = map.data().places[to];
  const known = await svc.known();
  const up = saved === undefined ? known.places.find((place) => placeNameFromRoute(place.route) === to) : undefined;
  if (saved === undefined && up === undefined) return bad("not_found", `no place named "${to}"; map lists the places.`);
  // A saved place without a link of its own still has the one the app declares for it.
  const target = { name: to, link: saved !== undefined ? (saved.link ?? declaredLink(saved.key, known, args.with ?? {})) : (up?.link ?? null) };

  // 1. Where am I? One read: it names the place, and it holds the first target for the policy.
  let tree = await svc.tree();
  const first = map.observe(tree);
  let here: Place | null = first.place;
  if (here.name === to) {
    const line = `Already at ${to}.`;
    if (args.dry_run === true) return { ok: true, answer: said(line), line, notes: [], arrived: to };
    return { ok: true, answer: await screenOf(line), line, notes: [], arrived: to };
  }

  // 2. The way.
  const options: PlanOptions = { by, tapsOnly: svc.tapsOnly, ...(rs !== undefined ? { routes: routeEdges(map) } : {}) };
  // A screen the map doesn't hold yet is not a start a road can leave from.
  const startKnown = !first.isNew;
  let plan = planWay(map, startKnown ? here : null, target, options);
  if ("error" in plan) return stopBeforeAnything(svc, plan.error, here, target, by, args);
  const link = target.link;
  if (plan.by === "link" && link !== null) {
    const filled = fillLink(link, values);
    if (!filled.ok) return bad("bad_params", `${to} needs ${filled.missing.join(", ")} (give it in with).`);
  }
  // A saved route on the way is checked (its steps, its account) before anything is touched.
  const prepared = new Map<string, Step[]>();
  for (const planned of plan.moves) {
    if (planned.route === undefined || rs === undefined) continue;
    const ready = prepareRoute(svc, rs, planned.route.route, {}, args.account, false);
    if (!ready.ok) return { ok: false, code: ready.code, message: ready.message, answer: refusal(ready) };
    prepared.set(planned.route.route, ready.steps);
  }
  if (args.dry_run === true) {
    const line = describePlan(plan, map, here, target, eyes);
    return { ok: true, answer: said(line), line, notes: [], arrived: to };
  }

  // 3. Go.
  const run = {
    done: 0,
    links: 0,
    taps: 0,
    others: 0,
    routes: [] as string[],
    path: [here.name],
    repairs: [] as string[],
    provenAgain: 0,
    dropped: [] as string[],
    replans: 0,
    reflexes: 0,
  };
  // Each leg gives reflexes one chance before a failure is answered (1.13.1 item 10).
  const reflexTried = new Set<number>();
  const allowed = new Set<string>();
  let fresh: TreeElement[] | null = tree.elements;
  let waiting: NextWait | undefined;
  const droppedNote = (road: string): string => (eyes ? "Note: dropped a road (it failed twice in a row)." : `Note: dropped the road ${road} (it failed twice in a row).`);

  const finish: Finish = async (code, why, leg, now, isNew) => {
    // A person can't see the app's place names (18.12).
    const where = eyes ? "" : now === null ? "Now at: unknown." : `Now at: ${now.name} (${isNew ? "new" : "known"}).`;
    const at = leg === null ? "" : `stopped at step ${leg.i + 1} of ${leg.n} (${stepWords(leg.road, eyes)}):`;
    const message = [at, `${why}.`, where, `Done: ${plural(run.done, "move", "moves")}.`, "Nothing else was touched."].filter((part) => part !== "").join(" ");
    const notes = run.dropped.map(droppedNote);
    const screen = await svc.screen(`Error ${code}: ${message}`, args.brief);
    return { ok: false, code, message, answer: appendLines({ ...screen, isError: true }, notes) };
  };

  for (;;) {
    const moves = plan.moves;
    let replanned = false;
    for (let i = 0; i < moves.length; i++) {
      const planned = moves[i];
      if (planned === undefined) break;
      const { road, viaLink } = planned;
      if (svc.aborted()) {
        const message = `the call was cancelled. Done: ${plural(run.done, "move", "moves")}. Nothing else was touched.`;
        return { ok: false, code: "cancelled", message, answer: failed(`Error cancelled: ${message}`) };
      }
      const leg: Leg = { i, n: moves.length, road, eyes };
      const reflexed = async (): Promise<boolean> => {
        if (svc.reflexes === undefined || reflexTried.has(i)) return false;
        reflexTried.add(i);
        const fired = await svc.reflexes();
        if (fired === 0) return false;
        run.reflexes += fired;
        waiting = undefined;
        fresh = null;
        return true;
      };

      // A saved route is one leg: its steps run as `run` runs them, and the arrival is checked as for a road (18.5).
      if (planned.route !== undefined) {
        const steps = prepared.get(planned.route.route);
        if (rs === undefined || steps === undefined) return finish("off_route", "the route can't be run here", leg, here, false);
        waiting = undefined;
        fresh = null;
        const leave = enterRoute(svc.map.folder(), planned.route.route);
        if (leave === null) return finish("bad_params", repeatedRoute(planned.route.route), leg, here, false);
        const ran = await rs.runSteps(steps, false, planned.route.route).finally(leave);
        if (ran.isError === true) {
          const body = ran.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
          const found = /^Error (\w+): ([\s\S]*)$/.exec(body);
          const stop = `Stopped at step ${i + 1} of ${moves.length} (${stepWords(road, eyes)}). Done: ${plural(run.done, "move", "moves")}. Nothing else was touched.`;
          return { ok: false, code: found?.[1] ?? "internal", message: `${found?.[2] ?? body} ${stop}`, answer: appendLines(ran, [stop]) };
        }
        run.done += planned.route.moves;
        run.routes.push(planned.route.route);
        const arrival = await arrivedAt(svc, null);
        if (arrival === null) return finish("off_route", "the app's place can't be read, so the arrival isn't checked", leg, null, false);
        here = arrival.obs.place;
        if (here.name !== road.to) return finish("off_route", "it didn't lead where the road says", leg, here, arrival.obs.isNew);
        run.path.push(here.name);
        continue;
      }

      const built = build(road.move, values, road.names, eyes);
      if (!built.ok) return finish("off_route", built.why, leg, here, false);

      // The element this move touches, as the policy sees it.
      let element: TreeElement | undefined;
      let repaired: { element: TreeElement; was: string } | undefined;
      if (built.wire !== undefined && !("x" in built.wire)) {
        const state = waiting?.state;
        if (state === "ready" || state === "moving") element = waiting?.element;
        else if (state === "covered") {
          if (await reflexed()) {
            i--;
            continue;
          }
          return covered(svc, leg, run.done, here, finish);
        }
        if (element === undefined) {
          const elements = fresh ?? (tree = await svc.tree()).elements;
          const found = svc.candidates(built.wire, elements);
          if (found.length === 1 && found[0] !== undefined) element = found[0];
          else if (found.length > 1) return finish("off_route", offRouteWhy("ambiguous", ""), leg, here, false);
          else {
            const meant = repairTarget({ ...road.names, ...(road.move.target?.id !== undefined ? { id: road.move.target.id } : {}) }, elements, svc.candidates, eyes);
            if (meant === null) {
              if (await reflexed()) {
                i--;
                continue;
              }
              markFailed(road, viaLink, map, run.dropped);
              return finish("off_route", offRouteWhy("not_found", ""), leg, here, false);
            }
            element = meant;
            repaired = { element: meant, was: targetWords(road.move.target).trim() };
          }
        }
      }
      waiting = undefined;
      fresh = null;

      // The next target, so the app waits for it as part of this move (F7).
      const pipelined = svc.capabilities.includes("move");
      const nextPlanned = moves[i + 1];
      const nextRoad = nextPlanned?.road;
      const nextBuilt = nextRoad === undefined || nextPlanned?.viaLink === true || nextPlanned?.route !== undefined ? undefined : build(nextRoad.move, values, nextRoad.names, eyes);
      const nextWire = nextBuilt?.ok === true && nextBuilt.wire !== undefined && !("x" in nextBuilt.wire) ? nextBuilt.wire : undefined;
      const capMs = nextRoad === undefined ? 0 : Math.min(10_000, Math.max(2000, nextRoad.ms * 3));
      // The next target is dry-run with its own action: a long press or a toggle isn't a press.
      const nextKind = nextBuilt?.ok === true && (nextBuilt.method === "longPress" || nextBuilt.method === "toggle") ? nextBuilt.method : "press";

      const touched = element !== undefined && repaired !== undefined ? moveTargetOf(element) : null;
      // A repaired target in a user's eyes is aimed by its text too, and the app doesn't scroll for the person.
      const params =
        touched !== null
          ? eyes && typeof element?.text === "string"
            ? { target: { text: element.text }, noScroll: true }
            : { target: wireOf(touched.target) ?? {} }
          : built.params;
      const guard = pipelined && element !== undefined ? guardOf(element) : undefined;
      const call: TouchCall = {
        tool: built.tool,
        method: built.method,
        params,
        ...(pipelined && element !== undefined ? { known: [element] } : {}),
        ...(guard !== undefined ? { guard } : {}),
        ...(pipelined && nextWire !== undefined ? { next: { target: nextWire, capMs, kind: nextKind } } : {}),
        pipelined,
        of: "drive",
      };
      const movedAt = svc.clock();
      const outcome = await svc.touch(call);
      if (outcome.kind === "stop") {
        const lines = [`Stopped at step ${i + 1} of ${moves.length} (${stepWords(road, eyes)}). Done: ${plural(run.done, "move", "moves")}. Nothing else was touched.`];
        const body = outcome.answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
        const found = /^Error (\w+): ([\s\S]*)$/.exec(body);
        return { ok: false, code: found?.[1] ?? "not_allowed", message: `${found?.[2] ?? body} ${lines[0] ?? ""}`.trim(), answer: appendLines(outcome.answer, lines) };
      }
      if (outcome.kind === "error") {
        if (isReflexFailure(outcome.code, outcome.message) && (await reflexed())) {
          i--;
          continue;
        }
        // Only a target that isn't there, or an arrival elsewhere, blames a road (18.2).
        if (outcome.code === "not_actionable" && /^behind_alert/.test(outcome.message)) return batchFailure(outcome.code, outcome.message, leg, run.done);
        if (OFF_ROUTE_CODES.has(outcome.code)) {
          if (outcome.code === "not_found") markFailed(road, viaLink, map, run.dropped);
          return finish("off_route", offRouteWhy(outcome.code, outcome.message), leg, here, false);
        }
        if (MOMENT_CODES.has(outcome.code)) return batchFailure(outcome.code, outcome.message, leg, run.done);
        const message = `${outcome.message} Done: ${plural(run.done, "move", "moves")}.`;
        return { ok: false, code: outcome.code, message, answer: failed(`Error ${outcome.code}: ${message}`) };
      }
      run.done++;
      svc.moved?.(road.move.tool, viaLink);
      if (outcome.via !== undefined) allowed.add(outcome.via);
      if (viaLink) run.links++;
      else if (road.move.tool === "tap") run.taps++;
      else run.others++;

      // Is it where the road leads? (A claim of arrival is never made without this.)
      const arrival = await arrivedAt(svc, outcome.place);
      if (arrival === null) return finish("off_route", "the app's place can't be read, so the arrival isn't checked", leg, null, false);
      if (arrival.tree !== undefined) fresh = arrival.tree.elements;
      here = arrival.obs.place;
      if (here.name !== road.to) {
        markFailed(road, viaLink, map, run.dropped);
        // Nothing moved, or a jump that missed on its own say: the same road or link would only miss again.
        if (!viaLink && here.name === road.from) return finish("off_route", "the screen didn't change", leg, here, false);
        if (arrival.obs.isNew || run.replans >= MAX_REPLANS || (viaLink && by === "link")) return finish("off_route", "it didn't lead where the road says", leg, here, arrival.obs.isNew);
        // Planned again from where it is, by roads: a link that missed would only miss again.
        const again = planWay(map, here, target, { by: by === "link" ? "link" : "taps", tapsOnly: svc.tapsOnly, ...(rs !== undefined ? { routes: routeEdges(map) } : {}) });
        if ("error" in again) return finish("off_route", "it didn't lead where the road says", leg, here, false);
        for (const planned2 of again.moves) {
          if (planned2.route === undefined || rs === undefined || prepared.has(planned2.route.route)) continue;
          const ready = prepareRoute(svc, rs, planned2.route.route, {}, args.account, false);
          if (!ready.ok) return finish("off_route", "it didn't lead where the road says", leg, here, false);
          prepared.set(planned2.route.route, ready.steps);
        }
        run.replans++;
        if (viaLink) run.path = [here.name];
        else run.path.push(here.name);
        plan = again;
        // A new plan's legs each get their own reflex retry.
        reflexTried.clear();
        replanned = true;
        break;
      }
      // Clean: the road is updated only now, after the arrival check passed (18.4).
      let proven = road;
      if (!viaLink && repaired !== undefined && touched !== null) {
        proven = map.repairRoad(road, { ...road.move, target: touched.target }, touched.names, repaired.element.row !== true) ?? road;
        run.repairs.push(eyes ? `Road repaired: ${shownName(repaired.element)}.` : `Road repaired: ${shownName(repaired.element)} (was ${repaired.was}).`);
      }
      if (!viaLink) {
        if (!map.isProven(proven)) run.provenAgain++;
        map.markDriven(proven, svc.clock() - movedAt);
      }
      if (viaLink) run.path = [here.name];
      else run.path.push(here.name);
      waiting = outcome.next;
      if (!pipelined && nextWire !== undefined) waiting = await pollNext(svc, nextWire, capMs);
      // A place change is a moment for reflexes (§18.7): one may close what came up on arrival, before the next target is read.
      if (svc.reflexes !== undefined && here.name !== road.from) {
        const fired = await svc.reflexes(here.name);
        if (fired > 0) {
          run.reflexes += fired;
          waiting = undefined;
          fresh = null;
        }
      }
    }
    if (replanned) continue;
    break;
  }

  // 4. Arrived and checked.
  // `, 1 reflex` when one fired (§18.4).
  const how = `${howText(run.links, run.taps, run.others, run.routes, eyes)}${run.reflexes > 0 ? `, ${plural(run.reflexes, "reflex", "reflexes")}` : ""}`;
  const roadsDriven = run.taps + run.others + run.routes.length;
  // A person can't see the app's place names (18.12).
  const path = !eyes && roadsDriven > 0 && run.path.length > 1 ? ` (${run.path.join(" > ")})` : "";
  const arrived = `${to} ${how} in ${seconds(svc.clock() - started)} s`;
  const line = `Arrived at ${arrived}${path}.`;
  const notes = [
    ...[...allowed].map((via) => `Note: allowed by a person (in ${via === "chat" ? "chat" : "the live view"}).`),
    ...run.repairs,
    ...(run.provenAgain > 0 ? [`Note: ${plural(run.provenAgain, "road", "roads")} proven again for build ${map.currentBuild()}.`] : []),
    ...run.dropped.map(droppedNote),
  ];
  return { ok: true, answer: appendLines(await screenOf(line), notes), line, notes, arrived };
}

function markFailed(road: MapRoad, viaLink: boolean, map: AppMap, dropped: string[]): void {
  if (viaLink) return;
  if (map.markFailed(road) === "dropped") dropped.push(`${road.from} > ${road.to}`);
}

/** Where the app is after a move: the move's own answer when it holds a route, else a read. */
async function arrivedAt(svc: DriveServices, state: PlaceState | null): Promise<{ obs: Observation; tree?: TreeResult } | null> {
  if (state !== null) {
    const key = keyFromState(state);
    if (key !== null) return { obs: svc.map.observeKey(key) };
    try {
      const tree = await svc.tree();
      return { obs: svc.map.observe(tree), tree };
    } catch {
      return null;
    }
  }
  const obs = await placeNow(svc.source, svc.map);
  return obs === null ? null : { obs };
}

/** An app without `move`: waits until the next target is on screen and steady (the same frame on two looks 40 ms apart). */
async function pollNext(svc: DriveServices, target: Record<string, unknown>, capMs: number): Promise<NextWait> {
  const began = svc.clock();
  let previous: TreeElement | undefined;
  for (;;) {
    let found: TreeElement[] = [];
    try {
      found = svc.candidates(target, (await svc.tree()).elements);
    } catch {
      found = [];
    }
    const [only] = found;
    if (found.length === 1 && only !== undefined) {
      const a = previous?.frame;
      const b = only.frame;
      if (previous !== undefined && a != null && b != null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height) {
        return { state: "ready", element: only, waitedMs: svc.clock() - began };
      }
      previous = only;
    } else previous = undefined;
    if (svc.clock() - began >= capMs) return previous !== undefined ? { state: "moving", element: previous, waitedMs: capMs } : { state: "missing", waitedMs: capMs };
    await svc.sleep(40);
  }
}

// -- answers that touch nothing

function describePlan(plan: DrivePlan, map: AppMap, from: Place | null, to: { name: string; link: string | null }, eyes: boolean): string {
  const legs: WayLeg[] = plan.moves.map((move) => ({
    from: move.road.from,
    to: move.road.to,
    kind: move.viaLink ? "link" : move.route !== undefined ? "route" : move.road.move.tool === "tap" ? "tap" : "other",
    ...(move.route !== undefined ? { route: move.route.route } : {}),
    ...(move.viaLink ? { url: move.road.move.url ?? to.link ?? "" } : {}),
    proven: move.viaLink || move.route !== undefined || map.isProven(move.road),
  }));
  return describeWay(to.name, from?.name ?? "?", legs, map.currentBuild(), eyes);
}
async function stopBeforeAnything(
  svc: DriveServices,
  error: "no_way" | "unknown_start",
  here: Place | null,
  target: { name: string; link: string | null },
  by: "any" | "taps" | "link",
  args: DriveArgs,
): Promise<Core> {
  if (error === "unknown_start") {
    const now = here === null ? "unknown" : `${here.name} (new)`;
    // A person can't see the app's place names (18.12).
    const where = svc.eyes ? "" : ` Now at: ${now}.`;
    const message = `the app's current place isn't known, so no road can be followed.${where} Nothing was touched.`;
    const screen = await svc.screen(`Error off_route: ${message}`, args.brief);
    return { ok: false, code: "off_route", message, answer: { ...screen, isError: true } };
  }
  const message =
    by === "link"
      ? `${target.name} has no link to jump to; add one with map link, or drive it once (the driver), and it is remembered.`
      : svc.eyes
        ? `no known way to ${target.name}; drive it once (the driver), and it is remembered.`
        : `no known way from ${here?.name ?? "here"} to ${target.name}; drive it once (the driver), and it is remembered.`;
  return { ok: false, code: "not_found", message, answer: failed(`Error not_found: ${message}`) };
}

// -- a saved route (18.5), driven from wherever the app is

export interface RouteServices {
  accounts: AccountStore | undefined;
  /** Whether the account can be typed here: the message when it can't (never a value). */
  probeAccount(field: string, account: string | undefined): string | null;
  /** The steps, the way `run` runs them, with the call's account as their default; `look: false` answers no screen. */
  runSteps(steps: Step[], look: boolean, route?: string): Promise<CallToolResult>;
  /** `run`'s own checks of steps (their tools, their words, an account), made before anything is touched; null when they hold. */
  checkSteps(steps: Step[]): CallToolResult | null;
}

const ACCOUNT_FIELD = /\$\{account\.([a-z]+)\}/g;
const VAULT_REF = /\$\{vault\.\w+\.\w+\}/g;

/** The vault references a route's steps type, whole, once each. */
function vaultRefsUsed(steps: Step[]): string[] {
  const refs = new Set<string>();
  for (const step of steps) {
    const typed = (step as { text?: unknown }).text;
    if (typeof typed !== "string") continue;
    for (const found of typed.matchAll(VAULT_REF)) refs.add(found[0]);
  }
  return [...refs];
}

/** The account fields a route's steps type, in order, once each. */
export function accountFieldsUsed(steps: Step[]): string[] {
  const fields = new Set<string>();
  for (const step of steps) {
    const typed = (step as { text?: unknown }).text;
    if (typeof typed !== "string") continue;
    for (const found of typed.matchAll(ACCOUNT_FIELD)) if (found[1] !== undefined) fields.add(found[1]);
  }
  return [...fields];
}

type Prepared = { ok: true; route: SharedScriptV2; steps: Step[] } | { ok: false; code: string; message: string; answer?: CallToolResult };

/** A refused route as the call's answer: `run`'s own refusal when it gave one, else the error with its code. */
const refusal = (ready: { code: string; message: string; answer?: CallToolResult | undefined }): CallToolResult => ready.answer ?? failed(`Error ${ready.code}: ${ready.message}`);

/**
 * A route's steps with the variables and the account filled in, checked before anything is touched. `strictAccount` is for a
 * route driven by name: an account it never types is a mistake. A route that is one leg of a way takes the call's account only if it types one.
 */
function prepareRoute(svc: DriveServices, rs: RouteServices, name: string, values: Record<string, string>, account: string | undefined, strictAccount: boolean): Prepared {
  const route = loadRoute(svc.map.folder(), name);
  if (route === null) return { ok: false, code: "not_found", message: `no route named "${name}"; map lists the routes.` };
  const used = accountFieldsUsed(route.steps);
  if (strictAccount && used.length === 0 && account !== undefined && vaultRefsUsed(route.steps).length === 0) {
    return { ok: false, code: "bad_params", message: `account "${account}" is named but the route ${route.name} types no \${account.username} or \${account.password}.` };
  }
  // A vault value is probed whole (`${vault.home.street}`); an account's by its field.
  for (const field of [...used, ...vaultRefsUsed(route.steps)]) {
    const refused = rs.probeAccount(field, account);
    if (refused !== null) return { ok: false, code: "bad_params", message: refused };
  }
  const filled = substituteSteps(route.steps, values, rs.accounts, route.variables ?? []);
  if (!filled.ok) return { ok: false, code: filled.code, message: filled.message };
  // `run`'s own checks of the steps, made now: a step a journey's eyes refuse is found before the app is driven anywhere.
  const refused = rs.checkSteps(filled.steps);
  if (refused !== null) return { ok: false, code: "refused", message: "", answer: refused };
  return { ok: true, route, steps: filled.steps };
}

/**
 * `drive {route}`: takes the app to the route's start place when it is elsewhere, then runs its steps with the variables
 * and the account filled in, then checks its end (18.4, 18.5). The values and the account are checked before anything is touched.
 * The answer is the drive answer: `Arrived at home by route sign_in in 3.2 s.` and the screen.
 */
export async function driveRoute(svc: DriveServices, rs: RouteServices, args: DriveArgs): Promise<CallToolResult> {
  const started = svc.clock();
  const name = args.route ?? "";
  const prepared = prepareRoute(svc, rs, name, args.with ?? {}, args.account, true);
  if (!prepared.ok) return refusal(prepared);
  const { route } = prepared;
  const then = args.then as Step[] | undefined;
  if (then !== undefined) {
    const refused = rs.checkSteps(then);
    if (refused !== null) return refused;
  }
  if (args.dry_run === true) {
    const from = route.start !== undefined ? ` from ${route.start}` : "";
    return said(`Would run route ${route.name} (${plural(route.steps.length, "step", "steps")})${from}; nothing is touched.`);
  }
  // No screen is built where another answer follows: the `then` steps, a `run` step's own line.
  const quiet = then !== undefined || args.quiet === true;
  let startNotes: string[] = [];
  let startFailure: CallToolResult | undefined;
  const ctx = {
    here: async (): Promise<string | null> => {
      const obs = await placeNow(svc.source, svc.map);
      return obs === null ? null : obs.place.name;
    },
    driveTo: async (place: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      const result = await driveCore(svc, { to: place, by: "any", with: args.with, brief: args.brief, account: args.account }, rs, true);
      if (result.ok) {
        startNotes = result.notes;
        return { ok: true };
      }
      // No way to the start is the same stop as a road that went wrong: off_route (18.5).
      startFailure = result.code === "not_found" && result.message.startsWith("no known way") ? withFirstLine(result.answer, `Error off_route: ${result.message}`) : result.answer;
      return { ok: false, message: result.message };
    },
    runSteps: (steps: Step[]) => rs.runSteps(steps, !quiet, route.name),
  };
  const leave = enterRoute(svc.map.folder(), route.name);
  if (leave === null) return failed(`Error bad_params: ${repeatedRoute(route.name)}`);
  const outcome = await routeRunner.run(route, args.with ?? {}, ctx, rs.accounts).finally(leave);
  if (outcome.kind === "refused") return startFailure ?? failed(`Error ${outcome.code}: ${outcome.message}`);
  const ran = outcome.answer;
  if (ran.isError === true) return ran;

  // The end is checked, never assumed.
  const now = await placeNow(svc.source, svc.map);
  const wanted = route.end;
  if (wanted !== undefined) {
    const stop = (why: string): CallToolResult => ({ ...withFirstLine(ran, `Error off_route: ${why}`), isError: true });
    if (now === null) return stop(`the app's place can't be read, so the end of the route ${route.name} isn't checked.`);
    if (now.place.name !== wanted) {
      return stop(
        svc.eyes
          ? `the route ${route.name} ran its steps but didn't end where it should.`
          : `the route ${route.name} ran its steps but ended at ${now.place.name}, not at ${wanted} (its end).`,
      );
    }
  }
  const place = wanted ?? now?.place.name;
  const arrived = `${place !== undefined && !svc.eyes ? `${place} ` : ""}by route ${route.name} in ${seconds(svc.clock() - started)} s`;
  const line = `Arrived ${place !== undefined && !svc.eyes ? "at " : ""}${arrived}.`;
  const core: Core = { ok: true, answer: appendLines(withFirstLine(ran, line), startNotes), line, notes: startNotes, arrived };
  return afterThen(core, args, rs);
}

/**
 * Whether the app, as it is now, has a way to a route's start place: null when it does (or is there already). A replay asks this
 * before it restarts the app, so a route that can't be reached never costs a restart (AGENT-TOOLS 1.13 18.5).
 */
export function startProblem(map: AppMap, here: string | null, start: string, tapsOnly: boolean): { code: "unsupported" | "off_route"; message: string } | null {
  if (here === start) return null;
  const saved = map.data().places[here ?? ""];
  if (here === null || saved === undefined) {
    return { code: "unsupported", message: `the route starts at ${start}, and the app's place isn't known. Go to ${start} first, then run it again.` };
  }
  const goal = map.data().places[start];
  const plan = planWay(map, { name: here, key: saved.key, link: saved.link }, { name: start, link: goal?.link ?? null }, { by: "any", tapsOnly });
  if (!("error" in plan)) return null;
  return { code: "off_route", message: `no known way from ${here} to ${start}; drive it once (the driver), and it is remembered.` };
}
