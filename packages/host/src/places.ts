import { createHash } from "node:crypto";
import { z } from "zod";
import { roleOf } from "./format.js";
import {
  loadMap,
  mapDir,
  mergeMaps,
  readRouteSync,
  roadId,
  saveMap,
  stable,
  type MapFile,
  type MapPlace,
  type MapReflex,
  type MapRemovals,
  type MapRoad,
  type Move,
  type MoveTool,
  type PlaceKey,
} from "./mapfile.js";
import { elementSchema, looksLikeValue, placeStateSchema, treeResultSchema, type PlaceState, type TreeResult } from "./protocol.js";

// Places, roads and links (AGENT-TOOLS 1.13 §18.1 to §18.3, §18.11). A place key holds route patterns, never
// params or screen text; the map file never holds what a screen showed; a link holds a pattern, never a real id.

export interface Place {
  name: string;
  key: PlaceKey;
  link: string | null;
}

// -- names and keys (§18.1)

const GROUP = /^\(.*\)$/;
const PARAM = /^\[(?:\.\.\.)?([^\]]*)\]$/;

/** `[a-z0-9_]` from ASCII text; null for anything else, so a name never depends on a language. */
function asciiName(text: string): string | null {
  if (/[^\x00-\x7f]/.test(text)) return null;
  const name = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return name === "" ? null : name;
}

/**
 * §18.1: the last route name, skipping (groups); a param segment becomes its parent and the param ("trips/[id]" is
 * "trips_id"); "index" takes its parent's name. "" when no ASCII name can be made: the map then uses place_<n>.
 */
export function placeNameFromRoute(route: string[]): string {
  const segments = route.filter((segment) => !GROUP.test(segment));
  let last = segments.length - 1;
  if (last < 0) return "";
  if (segments[last] === "index" && last > 0) last -= 1;
  const part = (index: number): string | null => {
    const segment = segments[index] as string;
    const param = PARAM.exec(segment);
    if (param === null) return asciiName(segment);
    const name = asciiName(param[1] ?? "");
    if (name === null) return null;
    if (index === 0) return name;
    const parent = part(index - 1);
    return parent === null ? null : `${parent}_${name}`;
  };
  return part(last) ?? "";
}

/** The key from where the app says it is. Null when it names no route (no router, or no screen yet). */
export function keyFromState(state: PlaceState | undefined): PlaceKey | null {
  // A route piece that looks like a value can't be a pattern: the place falls back to the signature.
  if (state === undefined || state.route.length === 0 || state.route.some(looksLikeValue)) return null;
  const tab = typeof state.tab === "string" && state.tab !== "" && !looksLikeValue(state.tab) ? state.tab : undefined;
  // A layer or tab that looks like a value is dropped, not the place.
  const layer = typeof state.layer === "string" && state.layer !== "" && !looksLikeValue(state.layer) ? state.layer : undefined;
  return { route: [...state.route], ...(tab !== undefined ? { tab } : {}), ...(layer !== undefined ? { layer } : {}) };
}

/** The key from the tree's `place`. Params are never read. Null when the app has no router. */
export function routeKey(tree: Pick<TreeResult, "place">): PlaceKey | null {
  return keyFromState(tree.place);
}

/**
 * The fallback when there is no router, or one route holds several steps: only what doesn't change with content or
 * language (§18.1). List rows, texts and labels never go in.
 */
export function signatureKey(tree: TreeResult): PlaceKey {
  const fixed = tree.elements.filter((element) => element.row !== true);
  // An id that looks like a value (a record's id in a testID) is content, not structure.
  const ids = [...new Set(fixed.map((element) => element.testID ?? "").filter((id) => id !== "" && !looksLikeValue(id)))].sort();
  const containers: string[] = [];
  const add = (kind: string): void => {
    if (!containers.includes(kind)) containers.push(kind);
  };
  for (const element of tree.elements) {
    const role = roleOf(element);
    if (role === "scroll") add("list");
    else if (role === "tab") add("tab bar");
    else if (role === "input") add("form");
    else if (/webview/i.test(element.type ?? "")) add("web view");
  }
  const tabs = fixed.filter((element) => roleOf(element) === "tab");
  const selected = tabs.findIndex((element) => element.selected === true);
  const chosen = selected >= 0 ? tabs[selected] : undefined;
  const tab =
    chosen === undefined ? null : chosen.testID !== undefined && chosen.testID !== null && chosen.testID !== "" && !looksLikeValue(chosen.testID) ? chosen.testID : selected;
  const layer = tree.place?.layer ? tree.place.layer.split(":")[0] : (tree.alerts ?? []).length > 0 ? "alert" : null;
  const parts = { ids, containers, tab, layer };
  return { signature: createHash("sha256").update(stable(parts)).digest("hex").slice(0, 16), parts };
}

/**
 * Whether two keys are one place. Route keys are equal parts for parts; signature keys agree when at least `threshold`
 * of their parts do. A route key and a signature key never match, and neither do keys from two sources.
 */
export function samePlace(a: PlaceKey, b: PlaceKey, threshold = 0.75): boolean {
  if ("route" in a || "route" in b) return "route" in a && "route" in b && stable(a) === stable(b);
  if (a.signature === b.signature) return true;
  const names = new Set([...Object.keys(a.parts), ...Object.keys(b.parts)]);
  if (names.size === 0) return false;
  let agree = 0;
  for (const name of names) if (stable(a.parts[name] ?? null) === stable(b.parts[name] ?? null)) agree++;
  return agree / names.size >= threshold;
}

// -- the places an app lists before any visit (§18.1) and links (§18.3)

const knownSchema = z.object({
  source: z.string().default("none"),
  places: z
    .array(z.object({ route: z.array(z.string()), link: z.string().nullish(), params: z.array(z.string()).optional() }))
    .default([]),
});

export interface KnownPlace {
  route: string[];
  link?: string | null | undefined;
  params?: string[] | undefined;
}
export interface KnownPlaces {
  source: string;
  places: KnownPlace[];
}

/** What the app's `places` request answers; anything else is no list. */
export function parseKnownPlaces(raw: unknown): KnownPlaces {
  const parsed = knownSchema.safeParse(raw);
  return parsed.success ? parsed.data : { source: "none", places: [] };
}

export const LINK_NOT_SAVED = "Link not saved: it may hold a value; add it with map link.";

/** A link as its scheme and path segments. The query and the fragment are dropped here. */
function splitLink(url: string): { scheme: string; segments: string[] } | null {
  const found = /^([a-z][a-z0-9+.-]*):\/\/([^?#]*)/i.exec(url.trim());
  if (found === null) return null;
  return { scheme: (found[1] as string).toLowerCase(), segments: (found[2] as string).split("/").filter((segment) => segment !== "") };
}

/** The pattern's segments laid over a url's: how many are fixed text that matched, and the link to keep. */
function matchPattern(pattern: string[], segments: string[]): { fixed: number; saved: string[] } | null {
  const saved: string[] = [];
  let fixed = 0;
  for (const [index, piece] of pattern.entries()) {
    if (/^\[\.\.\.[^\]]*\]$/.test(piece)) {
      // A catch-all is the last piece and takes one segment or more.
      if (index !== pattern.length - 1 || segments.length <= index) return null;
      saved.push(piece);
      return { fixed, saved };
    }
    const segment = segments[index];
    if (segment === undefined) return null;
    if (PARAM.test(piece)) {
      saved.push(piece);
    } else {
      if (piece !== segment) return null;
      fixed++;
      saved.push(piece);
    }
  }
  return segments.length === pattern.length ? { fixed, saved } : null;
}

/** The link to keep for `url`: fixed text where a known pattern has it, `[param]` where it has a param; null when no pattern fits. */
export function linkFor(url: string, patterns: string[]): string | null {
  const given = splitLink(url);
  if (given === null) return null;
  let best: { fixed: number; scheme: string; saved: string[] } | null = null;
  for (const pattern of patterns) {
    const known = splitLink(pattern);
    if (known === null || known.scheme !== given.scheme) continue;
    const match = matchPattern(known.segments, given.segments);
    if (match !== null && (best === null || match.fixed > best.fixed)) best = { ...match, scheme: known.scheme };
  }
  return best === null ? null : `${best.scheme}://${best.saved.join("/")}`;
}

// -- which moves are roads (§18.2)

export type SkipReason = "read" | "person" | "dry_run" | "needed_ok" | "typed" | "replay" | "same_place" | "unknown_start" | "no_link" | "unnamed";
export type RoadVerdict = { saved: true; road: MapRoad } | { saved: false; reason: SkipReason };

export interface MoveCall {
  method: string;
  params: unknown;
  result: unknown;
  by: "agent" | "person";
  /** The move needed a person's OK. */
  neededOk: boolean;
  /** A script is being replayed: replay never writes the map (§18.9). */
  replaying: boolean;
}

const TOOL_OF_METHOD: Record<string, MoveTool> = {
  press: "tap",
  longPress: "long_press",
  toggle: "toggle",
  back: "back",
  openURL: "open_url",
  swipe: "swipe",
};

const NAME_MAX = 80;
const clip = (text: string): string => (text.length > NAME_MAX ? text.slice(0, NAME_MAX) : text);

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * What a call is as a road: the move and every name its element had, or why it isn't one. A target is saved by id,
 * else label, else text, never by ref; a row only by its id, else as `{"row": true}`; a point only for something with
 * no element. An open_url move has no url yet: the caller fills in the saved link, never the real one.
 */
export function classifyMove(call: MoveCall): { move: Move; names: NonNullable<MapRoad["names"]> } | { skip: SkipReason } {
  if (call.by === "person") return { skip: "person" };
  if (call.replaying) return { skip: "replay" };
  const params = record(call.params);
  if (params["dryRun"] === true) return { skip: "dry_run" };
  if (call.method === "type") return { skip: "typed" };
  const tool = TOOL_OF_METHOD[call.method];
  if (tool === undefined) return { skip: "read" };
  if (call.neededOk) return { skip: "needed_ok" };
  if (tool === "back" || tool === "open_url") return { move: { tool }, names: {} };
  if (tool === "swipe") {
    const [x0, y0, x1, y1] = ["x0", "y0", "x1", "y1"].map((key) => params[key]);
    if (![x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) return { skip: "unnamed" };
    const seconds = params["seconds"];
    // A step exactly as `run` takes it (1.13.1 item 14).
    return {
      move: {
        tool,
        x0: x0 as number,
        y0: y0 as number,
        x1: x1 as number,
        y1: y1 as number,
        ...(typeof seconds === "number" && Number.isFinite(seconds) ? { seconds } : {}),
      },
      names: {},
    };
  }
  const element = elementSchema.safeParse(record(call.result)["element"]);
  if (element.success) {
    const e = element.data;
    const id = typeof e.testID === "string" && e.testID !== "" ? e.testID : undefined;
    // A row's text is content: only its id may be kept.
    if (e.row === true) {
      return id !== undefined ? { move: { tool, target: { id } }, names: { id } } : { move: { tool, target: { row: true } }, names: {} };
    }
    const label = typeof e.label === "string" && e.label.trim() !== "" ? clip(e.label) : undefined;
    // An input's text may be what a person typed.
    const text = roleOf(e) !== "input" && typeof e.text === "string" && e.text.trim() !== "" ? clip(e.text) : undefined;
    const names = { ...(id !== undefined ? { id } : {}), ...(label !== undefined ? { label } : {}), ...(text !== undefined ? { text } : {}) };
    if (id !== undefined) return { move: { tool, target: { id } }, names };
    if (label !== undefined) return { move: { tool, target: { label } }, names };
    if (text !== undefined) return { move: { tool, target: { text } }, names };
    const frame = e.frame;
    if (frame !== null && frame !== undefined) {
      return { move: { tool, target: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) } }, names };
    }
    return { skip: "unnamed" };
  }
  // No element came back: a point is all there is, or what the agent named.
  const target = record(params["target"]);
  const { testID, label, text, x, y } = target;
  if (typeof x === "number" && typeof y === "number") return { move: { tool, target: { x, y } }, names: {} };
  if (typeof testID === "string" && testID !== "") return { move: { tool, target: { id: testID } }, names: { id: testID } };
  if (typeof label === "string" && label !== "") return { move: { tool, target: { label: clip(label) } }, names: { label: clip(label) } };
  if (typeof text === "string" && text !== "") return { move: { tool, target: { text: clip(text) } }, names: { text: clip(text) } };
  return { skip: "unnamed" };
}

// -- the map in memory (§18.9 holds the file)

export type SaveFn = (dir: string, map: MapFile, options?: { readOnly?: boolean; removed?: MapRemovals }) => Promise<MapFile>;

export interface AppMapOptions {
  dir: string;
  clock?: () => number;
  /** Tests: where the file goes. Default: `saveMap`. */
  save?: SaveFn;
  /** Replay reads the map and never writes it (§18.9). */
  readOnly?: boolean;
  /** The least time between two writes. Default 1000 ms (§18.9). */
  writeGapMs?: number;
}

export interface Observation {
  place: Place;
  isNew: boolean;
  /** The `Place:` line, or null while the app has no saved place yet (§18.1). */
  line: string | null;
}

export interface MapApp {
  id: string;
  name: string;
  version?: string | undefined;
  build?: string | undefined;
}

const NEW_LINE = "Place: new (call it with map name).";

export class AppMap {
  private map: MapFile;
  private readonly loadStatus: "ok" | "new" | "unreadable";
  private app: MapApp;
  private readonly dir: string;
  private readonly clock: () => number;
  private readonly save: SaveFn;
  private readonly readOnly: boolean;
  private readonly gapMs: number;
  private here: Place | null = null;
  // Places where text was typed stay marked until the app reconnects: a move from one may depend on that text (§18.2).
  private readonly typedPlaces = new Set<string>();
  private session: string | undefined;
  private known: KnownPlaces | undefined;
  private knownFor: string | undefined;
  private dirty = false;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private error: string | null = null;
  // What was taken out or renamed on purpose, until a save has carried it to the file.
  private readonly pending = {
    places: new Map<string, { name: string; before: string }>(),
    roads: new Map<string, { from: string; move: Move; to: string; before: string }>(),
    renamed: {} as Record<string, string>,
    reflexes: new Set<string>(),
  };

  constructor(app: MapApp, options: AppMapOptions) {
    this.app = app;
    this.dir = options.dir;
    this.clock = options.clock ?? Date.now;
    this.save = options.save ?? saveMap;
    this.readOnly = options.readOnly === true;
    this.gapMs = options.writeGapMs ?? 1000;
    const loaded = loadMap(options.dir, app.id);
    this.map = loaded.map;
    this.loadStatus = loaded.status;
  }

  /** The app reconnected, maybe with a new build. */
  updateApp(app: MapApp): void {
    this.app = app;
  }

  /** The map's folder (it holds the route files). */
  folder(): string {
    return this.dir;
  }

  /** Registers a saved route's file under its name (§18.5). The file itself is written by `saveRoute`. */
  addRoute(name: string, relative: string): void {
    this.map.routes[name] = relative;
    this.touch();
  }

  /** The names of the saved routes that start or end at a place (§18.5). */
  routesAt(place: string): string[] {
    return Object.entries(this.map.routes)
      .filter(([, relative]) => {
        const file = readRouteSync(this.dir, relative);
        return file !== null && (file["start"] === place || file["end"] === place);
      })
      .map(([name]) => name);
  }

  /** The map as it is now. Read only: change it through the methods. */
  data(): MapFile {
    return this.map;
  }

  status(): "ok" | "new" | "unreadable" {
    return this.loadStatus;
  }

  /** Why the last write failed, or null. */
  lastError(): string | null {
    return this.error;
  }

  hasPlaces(): boolean {
    return Object.keys(this.map.places).length > 0;
  }

  current(): Place | null {
    return this.here;
  }

  /** `<version> (<native build>)`, the way a road remembers its build. A JavaScript reload doesn't change it. */
  currentBuild(): string {
    const { version, build } = this.app;
    if (build !== undefined && build !== "" && build.includes("(")) return build;
    if (version !== undefined && version !== "" && build !== undefined && build !== "") return `${version} (${build})`;
    return version ?? build ?? "unknown";
  }

  isProven(road: MapRoad): boolean {
    return road.build === this.currentBuild();
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }

  // -- places

  observe(tree: TreeResult): Observation {
    return this.observeKey(routeKey(tree) ?? signatureKey(tree));
  }

  observeKey(key: PlaceKey): Observation {
    const hadPlaces = this.hasPlaces();
    const found = Object.entries(this.map.places).find(([, place]) => samePlace(place.key, key));
    let name: string;
    let isNew = false;
    if (found !== undefined) {
      name = found[0];
      found[1].last = this.iso();
    } else {
      name = this.freshName(key);
      this.map.places[name] = { key, link: null, last: this.iso() };
      isNew = true;
      this.touch();
    }
    const saved = this.map.places[name] as MapPlace;
    const place: Place = { name, key: saved.key, link: saved.link };
    this.here = place;
    return { place, isNew, line: hadPlaces ? (isNew ? NEW_LINE : `Place: ${name}.`) : null };
  }

  private freshName(key: PlaceKey): string {
    const base = "route" in key ? placeNameFromRoute(key.route) : "";
    if (base !== "") {
      let name = base;
      for (let n = 2; this.map.places[name] !== undefined; n++) name = `${base}_${n}`;
      return name;
    }
    let n = 1;
    while (this.map.places[`place_${n}`] !== undefined) n++;
    return `place_${n}`;
  }

  /** Text was typed at the current place: the moves that leave it may depend on it, so none is saved (§18.2). */
  noteTyped(): void {
    if (this.here !== null) this.typedPlaces.add(this.here.name);
  }

  /** The app connected (again): what was typed before is no longer known, so the marks go. */
  useSession(sessionId: string): void {
    if (this.session === sessionId) return;
    this.session = sessionId;
    this.typedPlaces.clear();
  }

  /** Whether text was typed at the current place in this connection. */
  typedHere(): boolean {
    return this.here !== null && this.typedPlaces.has(this.here.name);
  }

  // -- places the app lists before a visit

  setKnown(known: KnownPlaces): void {
    this.known = known;
  }

  knownPlaces(): KnownPlaces | undefined {
    return this.known;
  }

  /** Asks the app once per connection which places its route tree lists. */
  async ensureKnown(sessionId: string, request: () => Promise<unknown>): Promise<KnownPlaces> {
    if (this.known !== undefined && this.knownFor === sessionId) return this.known;
    try {
      this.known = parseKnownPlaces(await request());
    } catch {
      this.known = { source: "none", places: [] };
    }
    this.knownFor = sessionId;
    return this.known;
  }

  // -- links (§18.3)

  rememberLink(url: string, place: Place): { saved: true; link: string } | { saved: false; message: string } {
    const patterns = (this.known?.places ?? []).map((known) => known.link).filter((link): link is string => typeof link === "string" && link !== "");
    const link = linkFor(url, patterns);
    if (link === null) return { saved: false, message: LINK_NOT_SAVED };
    const saved = this.map.places[place.name];
    // A link added by hand stays as it was given.
    if (saved !== undefined && saved.link === null) {
      saved.link = link;
      place.link = link;
      this.touch();
    }
    return { saved: true, link };
  }

  /** A link added by hand (`map link`), kept as given. */
  setLink(name: string, link: string): boolean {
    const place = this.map.places[name];
    if (place === undefined) return false;
    place.link = link;
    place.last = this.iso();
    this.touch();
    return true;
  }

  // -- roads (§18.2)

  recordMove(from: Place | null, move: Move, names: MapRoad["names"], to: Place, ms: number, skip?: SkipReason): RoadVerdict {
    if (this.readOnly) return { saved: false, reason: "replay" };
    if (skip !== undefined) return { saved: false, reason: skip };
    if (from === null) return { saved: false, reason: "unknown_start" };
    if (from.name === to.name) return { saved: false, reason: "same_place" };
    if (this.typedPlaces.has(from.name)) return { saved: false, reason: "typed" };
    const id = roadId(from.name, move, to.name);
    const existing = this.map.roads.find((road) => roadId(road.from, road.move, road.to) === id);
    const now = this.iso();
    const took = Math.max(0, Math.round(ms));
    this.touch();
    if (existing !== undefined) {
      existing.seen += 1;
      existing.failed = 0;
      existing.ms = took;
      existing.last = now;
      existing.build = this.currentBuild();
      if (existing.by === "tapwright") existing.by = "both";
      if (names !== undefined && Object.keys(names).length > 0) existing.names = { ...existing.names, ...names };
      return { saved: true, road: existing };
    }
    const road: MapRoad = {
      from: from.name,
      to: to.name,
      move,
      ...(names !== undefined && Object.keys(names).length > 0 ? { names } : {}),
      by: "tapline",
      seen: 1,
      failed: 0,
      ms: took,
      last: now,
      build: this.currentBuild(),
    };
    this.map.roads.push(road);
    return { saved: true, road };
  }

  /** A drive went along this road cleanly: it is proven for this build. */
  markDriven(road: MapRoad, ms: number): void {
    road.seen += 1;
    road.failed = 0;
    road.ms = Math.max(0, Math.round(ms));
    road.last = this.iso();
    road.build = this.currentBuild();
    this.touch();
  }

  /** A drive failed on this road. The second failure in a row drops it. */
  markFailed(road: MapRoad): "kept" | "dropped" {
    const id = roadId(road.from, road.move, road.to);
    const stored = this.map.roads.find((candidate) => roadId(candidate.from, candidate.move, candidate.to) === id);
    if (stored === undefined) return "dropped";
    stored.failed += 1;
    if (stored.failed >= 2) {
      this.removeRoad(stored.from, stored.move, stored.to);
      return "dropped";
    }
    stored.last = this.iso();
    this.touch();
    return "kept";
  }

  // -- edits the `map` tool makes

  removeRoad(from: string, move: Move, to: string): boolean {
    const id = roadId(from, move, to);
    const found = this.map.roads.find((road) => roadId(road.from, road.move, road.to) === id);
    if (found === undefined) return false;
    this.pending.roads.set(id, { from, move, to, before: found.last });
    this.map.roads = this.map.roads.filter((road) => road !== found);
    this.touch();
    return true;
  }

  removePlace(name: string): boolean {
    const place = this.map.places[name];
    if (place === undefined) return false;
    this.pending.places.set(name, { name, before: place.last });
    delete this.map.places[name];
    this.map.roads = this.map.roads.filter((road) => road.from !== name && road.to !== name);
    this.map.reflexes = this.map.reflexes.filter((reflex) => reflex.at !== name);
    // Its routes go too, so a merge with the file can't bring them back (the route files stay on disk).
    for (const route of this.routesAt(name)) delete this.map.routes[route];
    if (this.here?.name === name) this.here = null;
    this.touch();
    return true;
  }

  /** Adds a declared reflex (§18.7); one with the same name is replaced. */
  addReflex(reflex: MapReflex): "added" | "replaced" {
    const index = this.map.reflexes.findIndex((existing) => existing.name === reflex.name);
    this.pending.reflexes.delete(reflex.name);
    if (index >= 0) this.map.reflexes[index] = reflex;
    else this.map.reflexes.push(reflex);
    this.touch();
    return index >= 0 ? "replaced" : "added";
  }

  removeReflex(name: string): boolean {
    if (!this.map.reflexes.some((reflex) => reflex.name === name)) return false;
    this.pending.reflexes.add(name);
    this.map.reflexes = this.map.reflexes.filter((reflex) => reflex.name !== name);
    this.touch();
    return true;
  }

  /** Renames a place: ASCII `[a-z0-9_]`, and not a name another place has. */
  renamePlace(from: string, to: string): boolean {
    const place = this.map.places[from];
    if (place === undefined || to === from || !/^[a-z0-9_]+$/.test(to) || this.map.places[to] !== undefined) return false;
    delete this.map.places[from];
    this.map.places[to] = place;
    for (const road of this.map.roads) {
      if (road.from === from) road.from = to;
      if (road.to === from) road.to = to;
    }
    for (const reflex of this.map.reflexes) if (reflex.at === from) reflex.at = to;
    // A rename of a rename is one rename.
    const chained = Object.entries(this.pending.renamed).find(([, now]) => now === from);
    if (chained !== undefined) this.pending.renamed[chained[0]] = to;
    else this.pending.renamed[from] = to;
    if (this.here?.name === from) this.here = { ...this.here, name: to };
    this.touch();
    return true;
  }

  // -- writing: at most once a second, and on close

  private touch(): void {
    this.version++;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.readOnly || this.timer !== undefined || this.saving !== undefined) return;
    const wait = Math.max(0, this.lastWriteAt + this.gapMs - this.clock());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write();
    }, wait);
    this.timer.unref?.();
  }

  /** Writes what changed now (the close, and tests). A failed write stays dirty and is tried again by the next flush. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.readOnly) return;
    while (this.saving !== undefined) await this.saving;
    if (this.dirty) await this.write();
  }

  private write(): Promise<void> {
    if (this.saving !== undefined) return this.saving;
    const run = async (): Promise<void> => {
      this.lastWriteAt = this.clock();
      this.dirty = false;
      const sent = {
        places: new Map(this.pending.places),
        roads: new Map(this.pending.roads),
        renamed: { ...this.pending.renamed },
        reflexes: new Set(this.pending.reflexes),
      };
      const removed: MapRemovals = {
        ...(sent.places.size > 0 ? { places: [...sent.places.values()] } : {}),
        ...(sent.roads.size > 0 ? { roads: [...sent.roads.values()] } : {}),
        ...(sent.reflexes.size > 0 ? { reflexes: [...sent.reflexes] } : {}),
        ...(Object.keys(sent.renamed).length > 0 ? { renamed: sent.renamed } : {}),
      };
      const version = this.version;
      try {
        const merged = await this.save(this.dir, structuredClone(this.map), Object.keys(removed).length > 0 ? { removed } : {});
        this.error = null;
        // Only what this save carried is settled; a removal made meanwhile is still pending.
        for (const [name, entry] of sent.places) if (this.pending.places.get(name) === entry) this.pending.places.delete(name);
        for (const [id, entry] of sent.roads) if (this.pending.roads.get(id) === entry) this.pending.roads.delete(id);
        for (const [old, now] of Object.entries(sent.renamed)) if (this.pending.renamed[old] === now) delete this.pending.renamed[old];
        // A name added again meanwhile is no longer pending, so only the names still waiting stay.
        for (const name of sent.reflexes) this.pending.reflexes.delete(name);
        this.adopt(merged, version);
      } catch (error) {
        this.dirty = true;
        this.error = error instanceof Error ? error.message : String(error);
      }
    };
    this.saving = run().finally(() => {
      this.saving = undefined;
      if (this.dirty && this.error === null) this.schedule();
    });
    return this.saving;
  }

  /** The merged file is the map from now on: another tool's work, and a name a clash changed, come with it. */
  private adopt(merged: MapFile, version: number): void {
    let next = merged;
    if (this.version !== version) {
      next = mergeMaps(merged, this.map, { renamed: this.pending.renamed });
    }
    // Removals still waiting are not brought back by the file.
    for (const name of this.pending.places.keys()) {
      delete next.places[name];
      next.roads = next.roads.filter((road) => road.from !== name && road.to !== name);
    }
    for (const entry of this.pending.roads.values()) {
      const id = roadId(entry.from, entry.move, entry.to);
      next.roads = next.roads.filter((road) => roadId(road.from, road.move, road.to) !== id);
    }
    // A forgotten reflex that is still waiting to be written is not brought back by the file.
    if (this.pending.reflexes.size > 0) next.reflexes = next.reflexes.filter((reflex) => !this.pending.reflexes.has(reflex.name));
    this.map = next;
    if (this.here !== null) {
      const here = this.here;
      const found = Object.entries(next.places).find(([, place]) => samePlace(place.key, here.key));
      this.here = found === undefined ? null : { name: found[0], key: found[1].key, link: found[1].link };
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

/** One map per app id, shared by every client of a host (§18.9). */
export class MapRegistry {
  private readonly maps = new Map<string, AppMap>();

  constructor(private readonly options: { mapsDir?: string; home?: string; readOnly?: boolean; save?: SaveFn; clock?: () => number } = {}) {}

  /** The app's map; none for an app that has no id of its own. */
  forApp(app: MapApp): AppMap | undefined {
    if (app.id === "" || app.id === "unknown") return undefined;
    const known = this.maps.get(app.id);
    if (known !== undefined) {
      known.updateApp(app);
      return known;
    }
    const map = new AppMap(app, {
      dir: mapDir(app.id, { ...(this.options.mapsDir !== undefined ? { mapsDir: this.options.mapsDir } : {}), ...(this.options.home !== undefined ? { home: this.options.home } : {}) }),
      ...(this.options.readOnly === true ? { readOnly: true } : {}),
      ...(this.options.save !== undefined ? { save: this.options.save } : {}),
      ...(this.options.clock !== undefined ? { clock: this.options.clock } : {}),
    });
    this.maps.set(app.id, map);
    return map;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.maps.values()].map((map) => map.flush()));
  }
}

// -- reading where the app is (§18.1, §18.11)

export interface PlaceSource {
  capabilities: string[];
  /** The latest `place` event the host holds for the app, from memory. */
  latest(): PlaceState | undefined;
  request(method: string, params?: unknown): Promise<unknown>;
}

/** Where the app was before a move: the host's latest `place` event when it names a route, else the last place seen. */
export function placeBefore(source: PlaceSource, map: AppMap): Place | null {
  const key = keyFromState(source.latest());
  return key === null ? map.current() : map.observeKey(key).place;
}

/** Where the app is now: the `place` request, else a tree read for a signature. Null when neither can be read. */
export async function placeNow(source: PlaceSource, map: AppMap): Promise<Observation | null> {
  try {
    if (source.capabilities.includes("place")) {
      const state = placeStateSchema.safeParse(await source.request("place", {}));
      const key = state.success ? keyFromState(state.data) : null;
      if (key !== null) return map.observeKey(key);
    }
    const tree = treeResultSchema.safeParse(await source.request("tree", { peek: true }));
    return tree.success ? map.observe(tree.data) : null;
  } catch {
    return null;
  }
}

/**
 * Where the app is, by name, from a read that writes nothing: a `replay` reads the map and never changes it (§18.9).
 * Null when the place can't be read or isn't one the map holds.
 */
export async function placeSeen(source: PlaceSource, map: AppMap): Promise<string | null> {
  try {
    let key: PlaceKey | null = null;
    if (source.capabilities.includes("place")) {
      const state = placeStateSchema.safeParse(await source.request("place", {}));
      key = state.success ? keyFromState(state.data) : null;
    }
    if (key === null) {
      const tree = treeResultSchema.safeParse(await source.request("tree", { peek: true }));
      if (tree.success) key = routeKey(tree.data) ?? signatureKey(tree.data);
    }
    if (key === null) return null;
    const there = key;
    return Object.entries(map.data().places).find(([, place]) => samePlace(place.key, there))?.[0] ?? null;
  } catch {
    return null;
  }
}

// -- GET /place (§18.11)

export interface PlaceAnswer {
  status: 200 | 404;
  body: Record<string, unknown>;
}

interface PlaceSession {
  app: { id: string };
  connectedAt: number;
  appState?: { state: string; at: number } | undefined;
  place?: (PlaceState & { seenAt: number }) | undefined;
}

/** Answers from memory, never from the phone, and never with params: the stored event has only route, tab and layer. */
export function placeAnswer(sessions: PlaceSession[], app: string): PlaceAnswer {
  const matching = sessions.filter((session) => session.app.id === app);
  const newest = [...matching].sort((a, b) => (b.place?.seenAt ?? 0) - (a.place?.seenAt ?? 0) || b.connectedAt - a.connectedAt)[0];
  if (newest === undefined) return { status: 404, body: { error: "no app" } };
  const place = newest.place;
  if (place === undefined) return { status: 404, body: { error: "no place" } };
  return {
    status: 200,
    body: {
      app,
      route: place.route,
      ...(typeof place.tab === "string" && place.tab !== "" ? { tab: place.tab } : {}),
      ...(typeof place.layer === "string" && place.layer !== "" ? { layer: place.layer } : {}),
      seenAt: place.seenAt,
      // The app's own foreground state; one that never reported is taken as in front.
      inFront: newest.appState === undefined || newest.appState.state === "active",
    },
  };
}
