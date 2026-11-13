import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AccountStore } from "./accounts.js";
import { cheapestWay, isRouteLeg } from "./mapcmd.js";
import type { MapRoad, Move } from "./mapfile.js";
import { keyFromState, placeNameFromRoute, placeNow, type AppMap, type KnownPlaces, type Observation, type Place, type PlaceSource } from "./places.js";
import { elementSchema, placeStateSchema, type PlaceState, type TreeElement, type TreeResult } from "./protocol.js";
import { loadRoute, routeRunner, substituteSteps } from "./routes.js";
import type { Step } from "./run.js";

// `drive` (AGENT-TOOLS 1.13 §18.4; F7): takes the app to a place along the roads the map knows, with no model in the loop.
// Every move goes through `services.touch`, which runs the same policy check and person's OK as a single call.

// -- the plan

export interface PlannedMove {
  road: MapRoad;
  viaLink: boolean;
}

export interface DrivePlan {
  by: "link" | "taps" | "link then taps";
  moves: PlannedMove[];
  cost: number;
  proven: boolean;
}

export type PlanOptions = { by: "any" | "taps" | "link"; tapsOnly: boolean };

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
  const chain = cheapestWay(map.data().roads, from.name, to.name, (road) => map.isProven(road));
  if (chain === null) return { error: "no_way" };
  const roads = chain.filter((leg): leg is MapRoad => !isRouteLeg(leg));
  return {
    by: "taps",
    moves: roads.map((road) => ({ road, viaLink: false })),
    cost: roads.reduce((sum, road) => sum + (map.isProven(road) ? 1 : 2), 0),
    proven: roads.every((road) => map.isProven(road)),
  };
}

// -- what the host gives drive

export type TouchTool = "tap" | "long_press" | "toggle" | "swipe" | "back" | "open_url";
export type TouchMethod = "press" | "longPress" | "toggle" | "swipe" | "back" | "openURL";

export interface Guard {
  id?: string;
  label?: string;
  text?: string;
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
  next?: { target: Record<string, unknown>; capMs: number };
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
  /** A user's-eyes journey never jumps (§18.4). */
  tapsOnly: boolean;
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

function targetWords(target: Move["target"], names?: MapRoad["names"]): string {
  // What a person would read comes first: the road's text or label, else its id (§18.4's example names "Language").
  const text = names?.text ?? names?.label ?? target?.text ?? target?.label;
  if (text !== undefined) return ` ${JSON.stringify(text)}`;
  const id = target?.id ?? names?.id;
  return id !== undefined ? ` id=${id}` : "";
}

/** `tap "Language"`, for the step an answer names. */
function stepWords(road: MapRoad): string {
  const { move } = road;
  switch (move.tool) {
    case "tap":
      return `tap${targetWords(move.target, road.names)}`;
    case "long_press":
      return `long press${targetWords(move.target, road.names)}`;
    case "toggle":
      return `toggle${targetWords(move.target, road.names)}`;
    case "back":
      return "back";
    case "swipe":
      return "swipe";
    default:
      return "open the link";
  }
}

/** `by link`, `by 3 taps`, `by link then 1 tap` (§18.4: how it travelled is always said). */
function howText(links: number, taps: number, others: number): string {
  const rest = taps + others;
  const noun = others === 0 ? (rest === 1 ? "tap" : "taps") : rest === 1 ? "move" : "moves";
  const link = links === 1 ? "link" : `${links} links`;
  if (links > 0 && rest > 0) return `by ${link} then ${rest} ${noun}`;
  return links > 0 ? `by ${link}` : `by ${rest} ${noun}`;
}

const countsOf = (moves: PlannedMove[]): { links: number; taps: number; others: number } => ({
  links: moves.filter((move) => move.viaLink).length,
  taps: moves.filter((move) => !move.viaLink && move.road.move.tool === "tap").length,
  others: moves.filter((move) => !move.viaLink && move.road.move.tool !== "tap").length,
});

const said = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }] });
const failed = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function appendLines(answer: CallToolResult, lines: string[]): CallToolResult {
  if (lines.length === 0) return answer;
  const [top, ...rest] = answer.content;
  if (top === undefined || top.type !== "text") return answer;
  return { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), ...lines].join("\n") }, ...rest] };
}

// -- one road as a request

type Built = { ok: true; tool: TouchTool; method: TouchMethod; params: Record<string, unknown>; wire?: Record<string, unknown> } | { ok: false; why: string };

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
function build(move: Move, values: Record<string, string>): Built {
  switch (move.tool) {
    case "tap":
    case "long_press":
    case "toggle": {
      const target = move.target;
      if (target === undefined) return { ok: false, why: "the road has no target" };
      if (target.row === true) return { ok: false, why: "it is a list row with no id of its own, so the driver chooses the row" };
      const wire = wireOf(target);
      if (wire === null) return { ok: false, why: "the road has no target" };
      const method = move.tool === "tap" ? "press" : move.tool === "long_press" ? "longPress" : "toggle";
      return { ok: true, tool: move.tool === "tap" ? "tap" : move.tool === "long_press" ? "long_press" : "toggle", method, params: { target: wire }, wire };
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

const guardOf = (element: TreeElement): Guard | undefined => {
  const guard: Guard = {};
  if (typeof element.testID === "string" && element.testID !== "") guard.id = element.testID;
  if (typeof element.label === "string" && element.label !== "") guard.label = element.label;
  if (typeof element.text === "string" && element.text !== "") guard.text = element.text;
  return Object.keys(guard).length > 0 ? guard : undefined;
};

/** How a road names an element now: by id, else label, else text (§18.2). */
function moveTargetOf(element: TreeElement): { target: NonNullable<Move["target"]>; names: NonNullable<MapRoad["names"]> } | null {
  const names: NonNullable<MapRoad["names"]> = {};
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
): TreeElement | null {
  const wires: Array<Record<string, unknown>> = [];
  if (names.id !== undefined) wires.push({ testID: names.id });
  if (names.label !== undefined) wires.push({ label: names.label });
  if (names.text !== undefined) wires.push({ text: names.text });
  for (const wire of wires) {
    const found = find(wire, elements);
    if (found.length === 1 && found[0] !== undefined) return found[0];
  }
  const wanted = [names.label, names.text].filter((s): s is string => s !== undefined).map(normal);
  const near = elements.filter(
    (element) =>
      (element.actions?.length ?? 0) > 0 &&
      [element.label, element.text].some((s) => typeof s === "string" && wanted.some((w) => close(normal(s), w))),
  );
  return near.length === 1 && near[0] !== undefined ? near[0] : null;
}

const shownName = (element: TreeElement): string => {
  const words = element.text ?? element.label;
  return typeof words === "string" && words !== "" ? JSON.stringify(words) : `id=${element.testID ?? "?"}`;
};

// -- the drive

type Core = { ok: true; answer: CallToolResult } | { ok: false; code: string; message: string; answer: CallToolResult };

const OFF_ROUTE_CODES: ReadonlySet<string> = new Set(["not_found", "ambiguous", "not_actionable", "stale"]);
const MAX_REPLANS = 2;

function offRouteWhy(code: string, message: string): string {
  if (code === "not_found") return "it isn't on this screen";
  if (code === "ambiguous") return "it matches more than one element on this screen";
  if (code === "stale") return "it is another element now than the one the policy checked";
  const reason = message.split(":")[0] ?? "";
  return /^[a-z_]{3,30}$/.test(reason) ? `it can't be touched now (${reason.replace(/_/g, " ")})` : "it can't be touched now";
}

/** Takes the app to a place (§18.4). */
export async function driveTo(svc: DriveServices, args: DriveArgs): Promise<CallToolResult> {
  return (await driveCore(svc, args)).answer;
}

async function driveCore(svc: DriveServices, args: DriveArgs): Promise<Core> {
  try {
    return await travel(svc, args);
  } catch (error) {
    const text = svc.describe(error);
    const found = /^Error (\w+): ([\s\S]*)$/.exec(text);
    return { ok: false, code: found?.[1] ?? "internal", message: found?.[2] ?? text, answer: failed(text) };
  }
}

async function travel(svc: DriveServices, args: DriveArgs): Promise<Core> {
  const { map } = svc;
  const started = svc.clock();
  const to = args.to ?? "";
  const by = args.by ?? "any";
  const values = args.with ?? {};
  const bad = (code: string, message: string): Core => ({ ok: false, code, message, answer: failed(`Error ${code}: ${message}`) });

  // The place: one the map holds, or one the app lists up front (it may have a link and no roads yet).
  const saved = map.data().places[to];
  const up = saved === undefined ? (await svc.known()).places.find((place) => placeNameFromRoute(place.route) === to) : undefined;
  if (saved === undefined && up === undefined) return bad("not_found", `no place named "${to}"; map lists the places.`);
  const target = { name: to, link: saved !== undefined ? saved.link : (up?.link ?? null) };

  // 1. Where am I? One read: it names the place, and it holds the first target for the policy.
  let tree = await svc.tree();
  const first = map.observe(tree);
  let here: Place | null = first.place;
  if (here.name === to) {
    const line = `Already at ${to}.`;
    return { ok: true, answer: args.dry_run === true ? said(line) : await svc.screen(line, args.brief) };
  }

  // 2. The way.
  const options: PlanOptions = { by, tapsOnly: svc.tapsOnly };
  // A screen the map doesn't hold yet is not a start a road can leave from.
  const startKnown = !first.isNew;
  let plan = planWay(map, startKnown ? here : null, target, options);
  if ("error" in plan) return stopBeforeAnything(svc, plan.error, here, target, by, args);
  const link = target.link;
  if (plan.by === "link" && link !== null) {
    const filled = fillLink(link, values);
    if (!filled.ok) return bad("bad_params", `${to} needs ${filled.missing.join(", ")} (give it in with).`);
  }
  if (args.dry_run === true) return { ok: true, answer: said(describePlan(plan, map, here, target)) };

  // 3. Go.
  const run = {
    done: 0,
    links: 0,
    taps: 0,
    others: 0,
    path: [here.name],
    repairs: [] as string[],
    provenAgain: 0,
    dropped: [] as string[],
    replans: 0,
  };
  const allowed = new Set<string>();
  let fresh: TreeElement[] | null = tree.elements;
  let waiting: NextWait | undefined;

  const finish = async (code: string, why: string, step: { i: number; n: number; road: MapRoad } | null, now: Place | null, isNew: boolean): Promise<Core> => {
    const where = now === null ? "Now at: unknown." : `Now at: ${now.name} (${isNew ? "new" : "known"}).`;
    const at = step === null ? "" : ` stopped at step ${step.i + 1} of ${step.n} (${stepWords(step.road)}):`;
    const message = `${at} ${why}. ${where} Done: ${plural(run.done, "move", "moves")}. Nothing else was touched.`.trim();
    const notes = [...run.dropped.map((road) => `Note: dropped the road ${road} (it failed twice in a row).`)];
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
      const step = { i, n: moves.length, road };
      const built = build(road.move, values);
      if (!built.ok) return finish("off_route", built.why, step, here, false);

      // The element this move touches, as the policy sees it.
      let element: TreeElement | undefined;
      let repaired: { element: TreeElement; was: string } | undefined;
      if (built.wire !== undefined && !("x" in built.wire)) {
        const state = waiting?.state;
        if (state === "ready" || state === "moving") element = waiting?.element;
        else if (state === "covered") {
          markFailed(road, viaLink, map, run.dropped);
          return finish("off_route", "it's covered by something on the screen", step, here, false);
        }
        if (element === undefined) {
          const elements = fresh ?? (tree = await svc.tree()).elements;
          const found = svc.candidates(built.wire, elements);
          if (found.length === 1 && found[0] !== undefined) element = found[0];
          else if (found.length > 1) return finish("off_route", offRouteWhy("ambiguous", ""), step, here, false);
          else {
            const meant = repairTarget({ ...road.names, ...(road.move.target?.id !== undefined ? { id: road.move.target.id } : {}) }, elements, svc.candidates);
            if (meant === null) {
              markFailed(road, viaLink, map, run.dropped);
              return finish("off_route", offRouteWhy("not_found", ""), step, here, false);
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
      const nextRoad = moves[i + 1]?.road;
      const nextBuilt = nextRoad === undefined || moves[i + 1]?.viaLink === true ? undefined : build(nextRoad.move, values);
      const nextWire = nextBuilt?.ok === true && nextBuilt.wire !== undefined && !("x" in nextBuilt.wire) ? nextBuilt.wire : undefined;
      const capMs = nextRoad === undefined ? 0 : Math.min(10_000, Math.max(2000, nextRoad.ms * 3));

      const touched = element !== undefined && repaired !== undefined ? moveTargetOf(element) : null;
      const params = touched !== null ? { target: wireOf(touched.target) ?? {} } : built.params;
      const guard = pipelined && element !== undefined ? guardOf(element) : undefined;
      const call: TouchCall = {
        tool: built.tool,
        method: built.method,
        params,
        ...(pipelined && element !== undefined ? { known: [element] } : {}),
        ...(guard !== undefined ? { guard } : {}),
        ...(pipelined && nextWire !== undefined ? { next: { target: nextWire, capMs } } : {}),
        pipelined,
      };
      const movedAt = svc.clock();
      const outcome = await svc.touch(call);
      if (outcome.kind === "stop") {
        const lines = [`Stopped at step ${i + 1} of ${moves.length} (${stepWords(road)}). Done: ${plural(run.done, "move", "moves")}. Nothing else was touched.`];
        const body = outcome.answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
        const found = /^Error (\w+): ([\s\S]*)$/.exec(body);
        return { ok: false, code: found?.[1] ?? "not_allowed", message: `${found?.[2] ?? body} ${lines[0] ?? ""}`.trim(), answer: appendLines(outcome.answer, lines) };
      }
      if (outcome.kind === "error") {
        if (OFF_ROUTE_CODES.has(outcome.code)) {
          if (outcome.code !== "stale") markFailed(road, viaLink, map, run.dropped);
          return finish("off_route", offRouteWhy(outcome.code, outcome.message), step, here, false);
        }
        const message = `${outcome.message} Done: ${plural(run.done, "move", "moves")}.`;
        return { ok: false, code: outcome.code, message, answer: failed(`Error ${outcome.code}: ${message}`) };
      }
      run.done++;
      if (outcome.via !== undefined) allowed.add(outcome.via);
      if (viaLink) run.links++;
      else if (road.move.tool === "tap") run.taps++;
      else run.others++;

      // Is it where the road leads? (A claim of arrival is never made without this.)
      const arrival = await arrivedAt(svc, outcome.place);
      if (arrival === null) return finish("off_route", "the app's place can't be read, so the arrival isn't checked", step, null, false);
      if (arrival.tree !== undefined) fresh = arrival.tree.elements;
      here = arrival.obs.place;
      if (here.name !== road.to) {
        markFailed(road, viaLink, map, run.dropped);
        if (arrival.obs.isNew || run.replans >= MAX_REPLANS) return finish("off_route", "it didn't lead where the road says", step, here, arrival.obs.isNew);
        // Planned again from where it is, by roads: a link that missed would only miss again.
        const again = planWay(map, here, target, { by: by === "link" ? "link" : "taps", tapsOnly: svc.tapsOnly });
        if ("error" in again) return finish("off_route", "it didn't lead where the road says", step, here, false);
        run.replans++;
        if (viaLink) run.path = [here.name];
        else run.path.push(here.name);
        plan = again;
        replanned = true;
        break;
      }
      // Clean: the road is updated only now, after the arrival check passed (§18.4).
      let proven = road;
      if (!viaLink && repaired !== undefined && touched !== null) {
        proven = map.repairRoad(road, { ...road.move, target: touched.target }, touched.names) ?? road;
        run.repairs.push(`Road repaired: ${shownName(repaired.element)} (was ${repaired.was}).`);
      }
      if (!viaLink) {
        if (!map.isProven(proven)) run.provenAgain++;
        map.markDriven(proven, svc.clock() - movedAt);
      }
      if (viaLink) run.path = [here.name];
      else run.path.push(here.name);
      waiting = outcome.next;
      if (!pipelined && nextWire !== undefined) waiting = await pollNext(svc, nextWire, capMs);
    }
    if (replanned) continue;
    break;
  }

  // 4. Arrived and checked.
  const counts = { links: run.links, taps: run.taps, others: run.others };
  const how = howText(counts.links, counts.taps, counts.others);
  const roadsDriven = run.taps + run.others;
  const path = roadsDriven > 0 && run.path.length > 1 ? ` (${run.path.join(" > ")})` : "";
  const line = `Arrived at ${to} ${how} in ${seconds(svc.clock() - started)} s${path}.`;
  const notes = [
    ...[...allowed].map((via) => `Note: allowed by a person (in ${via === "chat" ? "chat" : "the live view"}).`),
    ...run.repairs,
    ...(run.provenAgain > 0 ? [`Note: ${plural(run.provenAgain, "road", "roads")} proven again for build ${map.currentBuild()}.`] : []),
    ...run.dropped.map((road) => `Note: dropped the road ${road} (it failed twice in a row).`),
  ];
  return { ok: true, answer: appendLines(await svc.screen(line, args.brief), notes) };
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

function describePlan(plan: DrivePlan, map: AppMap, from: Place | null, to: { name: string; link: string | null }): string {
  const first = plan.moves[0];
  if (plan.by === "link" && first !== undefined) return `Would drive to ${to.name} by link (${first.road.move.url ?? to.link ?? ""}).`;
  const counts = countsOf(plan.moves);
  const how = howText(counts.links, counts.taps, counts.others);
  const names = [from?.name ?? "?", ...plan.moves.map((move) => move.road.to)].join(" > ");
  const unproven = plan.moves.filter((move) => !move.viaLink && !map.isProven(move.road));
  const state = unproven.length === 0 ? "all proven" : `unproven for build ${map.currentBuild()}: ${unproven.map((move) => `${move.road.from} > ${move.road.to}`).join(", ")}`;
  return `Would drive to ${to.name} ${how}: ${names} (${state}).`;
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
    const message = `the app's current place isn't known, so no road can be followed. Now at: ${now}. Nothing was touched.`;
    const screen = await svc.screen(`Error off_route: ${message}`, args.brief);
    return { ok: false, code: "off_route", message, answer: { ...screen, isError: true } };
  }
  const message =
    by === "link"
      ? `${target.name} has no link to jump to; add one with map link, or drive it once (the driver), and it is remembered.`
      : `no known way from ${here?.name ?? "here"} to ${target.name}; drive it once (the driver), and it is remembered.`;
  return { ok: false, code: "not_found", message, answer: failed(`Error not_found: ${message}`) };
}

// -- a saved route (§18.5), driven from wherever the app is

export interface RouteServices {
  accounts: AccountStore | undefined;
  /** Whether the account can be typed here: the message when it can't (never a value). */
  probeAccount(field: string, account: string | undefined): string | null;
  /** The steps, the way `run` runs them, with the call's account as their default. */
  runSteps(steps: Step[]): Promise<CallToolResult>;
}

const ACCOUNT_FIELD = /\$\{account\.([a-z]+)\}/g;

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

/**
 * `drive {route}`: takes the app to the route's start place when it is elsewhere, then runs its steps with the variables
 * and the account filled in (§18.4, §18.5). The values and the account are checked before anything is touched.
 */
export async function driveRoute(svc: DriveServices, rs: RouteServices, args: DriveArgs): Promise<CallToolResult> {
  const name = args.route ?? "";
  const route = loadRoute(svc.map.folder(), name);
  if (route === null) return failed(`Error not_found: no route named "${name}"; map lists the routes.`);
  const used = accountFieldsUsed(route.steps);
  if (used.length === 0 && args.account !== undefined) {
    return failed(`Error bad_params: account "${args.account}" is named but the route ${route.name} types no \${account.username} or \${account.password}.`);
  }
  for (const field of used) {
    const refused = rs.probeAccount(field, args.account);
    if (refused !== null) return failed(`Error bad_params: ${refused}`);
  }
  // Values are checked before anything is touched, in a dry run too.
  const filled = substituteSteps(route.steps, args.with ?? {}, rs.accounts, route.variables ?? []);
  if (!filled.ok) return failed(`Error ${filled.code}: ${filled.message}`);
  if (args.dry_run === true) {
    const from = route.start !== undefined ? ` from ${route.start}` : "";
    return said(`Would run route ${route.name} (${plural(route.steps.length, "step", "steps")})${from}; nothing is touched.`);
  }
  const ctx = {
    here: async (): Promise<string | null> => {
      const obs = await placeNow(svc.source, svc.map);
      return obs === null ? null : obs.place.name;
    },
    driveTo: async (place: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      const result = await driveCore(svc, { to: place, by: "any", with: args.with, brief: true });
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    runSteps: (steps: Step[]) => rs.runSteps(steps),
  };
  const outcome = await routeRunner.run(route, args.with ?? {}, ctx, rs.accounts);
  return outcome.kind === "ran" ? outcome.answer : failed(`Error ${outcome.code}: ${outcome.message}`);
}
