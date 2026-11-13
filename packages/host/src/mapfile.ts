import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

// The map file (AGENT-TOOLS 1.13 §18.9). The format is shared with Tapwright, so a field
// this module doesn't know is kept as it is, and a file it can't read is left alone.

export const MAP_FORMAT = "agent-tools-map";
export const MAP_VERSION = 1;

/** A lock or temp file older than this is counted as left behind (§18.9). */
const LOCK_STALE_MS = 10_000;
/** How long a save waits for a fresh lock before it gives up. */
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 25;
/** A rename over a file the other tool has open can fail on Windows (§18.9). */
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 50;

export type PlaceKey =
  | { route: string[]; tab?: string; layer?: string }
  | { signature: string; parts: Record<string, unknown> };

export type MoveTool = "tap" | "long_press" | "toggle" | "back" | "open_url" | "swipe";
export type RoadBy = "tapline" | "tapwright" | "both";

export interface MapPlace {
  key: PlaceKey;
  link: string | null;
  titles?: Record<string, string>;
  last: string;
  [unknown: string]: unknown;
}

// `tool` and `by` are plain strings on read: a value a newer Tapwright adds must not make the
// file unreadable. Only `version` gates. Narrow at the use site (MoveTool, RoadBy).
export type Move = {
  tool: MoveTool | (string & {});
  target?: { id?: string; label?: string; text?: string; row?: true; x?: number; y?: number };
  url?: string;
  /** A swipe is a step as `run` takes it: both points and, when given, its length (1.13.1 item 14). */
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
  seconds?: number;
};

export interface MapRoad {
  from: string;
  to: string;
  move: Move;
  names?: { id?: string; label?: string; text?: string };
  by: RoadBy | (string & {});
  seen: number;
  failed: number;
  ms: number;
  last: string;
  build: string;
  [unknown: string]: unknown;
}

export interface MapReflex {
  name: string;
  when: { text?: string; label?: string; id?: string };
  do: Record<string, unknown>;
  max?: number;
  at?: string;
  [unknown: string]: unknown;
}

export interface MapFile {
  format: typeof MAP_FORMAT;
  version: 1;
  app: string;
  titleKey?: string;
  places: Record<string, MapPlace>;
  roads: MapRoad[];
  routes: Record<string, string>;
  reflexes: MapReflex[];
  [unknown: string]: unknown;
}

/** The file system and the clock, injectable so tests can interleave steps and fake time. */
export interface MapIo {
  /** The file's text, or null when it doesn't exist. */
  readFile(path: string): Promise<string | null>;
  /** Writes the file and syncs it to disk before it returns. */
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Creates the file with `data` only if it is absent; false when it already exists. */
  createExclusive(path: string, data: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** The file's modified time in ms, or null when it doesn't exist. */
  statMtimeMs(path: string): Promise<number | null>;
  /** The names in a folder; empty when it doesn't exist. */
  listDir(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function nodeMapIo(): MapIo {
  return {
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
    async writeFile(path, data) {
      // Open, write, sync, close: the rename must never publish a file that isn't on disk yet.
      const handle = await open(path, "w");
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename: (from, to) => rename(from, to),
    async createExclusive(path, data) {
      let handle;
      try {
        handle = await open(path, "wx");
      } catch (error) {
        // Windows says EPERM (or EBUSY) while a rival's rename or delete of the lock is under way: it is held.
        const code = errorCode(error);
        if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") return false;
        throw error;
      }
      try {
        await handle.writeFile(data, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    },
    async remove(path) {
      try {
        await unlink(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    },
    async statMtimeMs(path) {
      try {
        return (await stat(path)).mtimeMs;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
    async listDir(path) {
      try {
        return await readdir(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    },
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

/** The folder is named by the app's own id, reduced so it can never leave the maps folder. */
export function mapDir(app: string, options: { mapsDir?: string; home?: string }): string {
  // Windows drops trailing dots and spaces from a folder name, so two ids could meet in one folder.
  let id = app.replace(/[. ]+$/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (/^\.*$/.test(id)) id = "_";
  // Device names such as CON or NUL can't be folders on Windows.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(id)) id = `_${id}`;
  const base = options.mapsDir !== undefined ? resolve(options.mapsDir) : resolve(options.home ?? homedir(), ".tapline", "maps");
  return join(base, id);
}

// What the file must hold. Every object is loose so unknown fields survive a round trip.
const keySchema = z.union([
  z.looseObject({ route: z.array(z.string()), tab: z.string().optional(), layer: z.string().optional() }),
  z.looseObject({ signature: z.string(), parts: z.record(z.string(), z.unknown()) }),
]);
const placeSchema = z.looseObject({
  key: keySchema,
  link: z.string().nullable(),
  titles: z.record(z.string(), z.string()).optional(),
  last: z.string(),
});
const moveSchema = z.looseObject({
  tool: z.string(),
  target: z.looseObject({}).optional(),
  url: z.string().optional(),
});
const roadSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  move: moveSchema,
  names: z.looseObject({}).optional(),
  by: z.string(),
  seen: z.number(),
  failed: z.number(),
  ms: z.number(),
  last: z.string(),
  build: z.string(),
});
const reflexSchema = z.looseObject({
  name: z.string(),
  when: z.looseObject({}),
  do: z.record(z.string(), z.unknown()),
});
const fileSchema = z.looseObject({
  format: z.literal(MAP_FORMAT),
  // A newer version is not ours to read or rewrite: it counts as unreadable and stays untouched.
  version: z.literal(MAP_VERSION),
  app: z.string(),
  titleKey: z.string().optional(),
  places: z.record(z.string(), placeSchema).default({}),
  roads: z.array(roadSchema).default([]),
  routes: z.record(z.string(), z.string()).default({}),
  reflexes: z.array(reflexSchema).default([]),
});

function parseMap(text: string, app: string): MapFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = fileSchema.safeParse(raw);
  // A file for another app id in this folder is not ours either.
  if (!parsed.success || parsed.data.app !== app) return null;
  return parsed.data as MapFile;
}

function emptyMap(app: string): MapFile {
  return { format: MAP_FORMAT, version: MAP_VERSION, app, places: {}, roads: [], routes: {}, reflexes: [] };
}

/** `unreadable`: the file is left alone and driving goes on with an empty map. */
export function loadMap(dir: string, app: string): { map: MapFile; status: "ok" | "new" | "unreadable" } {
  let text: string;
  try {
    text = readFileSync(join(dir, "map.json"), "utf8");
  } catch (error) {
    return { map: emptyMap(app), status: errorCode(error) === "ENOENT" ? "new" : "unreadable" };
  }
  const map = parseMap(text, app);
  return map === null ? { map: emptyMap(app), status: "unreadable" } : { map, status: "ok" };
}

// Merge, by place key and by road (from, move, to). The newest `last` wins; on a tie, mine.

/** A stable text for a value: object keys sorted, so the same key always compares equal. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What names one road: where it starts, the move, where it ends. */
export function roadId(from: string, move: Move, to: string): string {
  return `${from}\u0000${stable(move)}\u0000${to}`;
}

function placeIdentity(key: PlaceKey): string {
  // A signature key is the same place by its signature; `parts` is only for fuzzy matching.
  return "signature" in key ? `sig:${key.signature}` : `route:${stable(key)}`;
}

/** Negative when a is older than b. Dates compare as times; anything else as text. */
function compareLast(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderByLast<T extends { last: string }>(older: T, candidate: T): { older: T; newer: T } {
  // Equal stamps: the candidate (mine) is the newer one.
  return compareLast(candidate.last, older.last) >= 0 ? { older, newer: candidate } : { older: candidate, newer: older };
}

function mergePlace(disk: MapPlace, mine: MapPlace): MapPlace {
  const { older, newer } = orderByLast(disk, mine);
  const titles = { ...older.titles, ...newer.titles };
  const merged: MapPlace = { ...older, ...newer, link: newer.link ?? older.link };
  if (Object.keys(titles).length > 0) merged.titles = titles;
  return merged;
}

function mergeRoad(disk: MapRoad, mine: MapRoad): MapRoad {
  const { older, newer } = orderByLast(disk, mine);
  // Each tool has driven it once: it is both's.
  const by = disk.by === mine.by ? disk.by : "both";
  const merged: MapRoad = { ...older, ...newer, by };
  const names = { ...older.names, ...newer.names };
  if (Object.keys(names).length > 0) merged.names = names;
  return merged;
}

function renameName(name: string, renames: Record<string, string>): string {
  return Object.hasOwn(renames, name) ? (renames[name] as string) : name;
}

function renamePlaces(file: MapFile, renames: Record<string, string>): MapFile {
  if (Object.keys(renames).length === 0) return file;
  const places: Record<string, MapPlace> = {};
  for (const [name, place] of Object.entries(file.places)) {
    const target = renameName(name, renames);
    // A name that is already taken is not overwritten by a rename.
    places[target !== name && file.places[target] !== undefined ? name : target] = place;
  }
  return {
    ...file,
    places,
    roads: file.roads.map((r) => ({ ...r, from: renameName(r.from, renames), to: renameName(r.to, renames) })),
    reflexes: file.reflexes.map((r) => (typeof r.at === "string" ? { ...r, at: renameName(r.at, renames) } : r)),
  };
}

/**
 * Merges mine into the disk copy. `options.renamed` (old to new) are renames I made on purpose:
 * they are applied to the disk copy first so the merge doesn't bring the old name back.
 * `renames` in the answer lists every name of mine that ended up under another (a clash with a
 * different place of the same name gets the next free `_n`).
 */
export function mergeMapsWithRenames(
  disk: MapFile,
  mine: MapFile,
  options: { renamed?: Record<string, string> } = {},
): { map: MapFile; renames: Record<string, string> } {
  const base = options.renamed !== undefined ? renamePlaces(disk, options.renamed) : disk;
  const places: Record<string, MapPlace> = { ...base.places };
  const nameByKey = new Map<string, string>();
  for (const [name, place] of Object.entries(places)) nameByKey.set(placeIdentity(place.key), name);
  const taken = new Set([...Object.keys(base.places), ...Object.keys(mine.places)]);
  // One key found under two names: both sides follow the kept name.
  const both: Record<string, string> = {};
  // A different place with the same name: only my side takes the new name.
  const clash: Record<string, string> = {};

  for (const [name, place] of Object.entries(mine.places)) {
    const identity = placeIdentity(place.key);
    const known = nameByKey.get(identity);
    if (known !== undefined) {
      const existing = places[known] as MapPlace;
      if (known === name) {
        places[known] = mergePlace(existing, place);
        continue;
      }
      // Found independently under two names: the older name stays.
      const keepMine = compareLast(place.last, existing.last) < 0 && places[name] === undefined;
      const kept = keepMine ? name : known;
      if (keepMine) delete places[known];
      places[kept] = mergePlace(existing, place);
      nameByKey.set(identity, kept);
      both[name] = kept;
      both[known] = kept;
      continue;
    }
    if (places[name] !== undefined) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n += 1;
      const fresh = `${name}_${n}`;
      taken.add(fresh);
      places[fresh] = place;
      nameByKey.set(identity, fresh);
      clash[name] = fresh;
      continue;
    }
    places[name] = place;
    nameByKey.set(identity, name);
  }

  const mineMap = { ...both, ...clash };
  const roads = new Map<string, MapRoad>();
  const add = (road: MapRoad, renames: Record<string, string>): void => {
    const moved: MapRoad = { ...road, from: renameName(road.from, renames), to: renameName(road.to, renames) };
    const id = roadId(moved.from, moved.move, moved.to);
    const have = roads.get(id);
    roads.set(id, have === undefined ? moved : mergeRoad(have, moved));
  };
  for (const road of base.roads) add(road, both);
  for (const road of mine.roads) add(road, mineMap);

  const reflexes = new Map<string, MapReflex>();
  const addReflex = (reflex: MapReflex, renames: Record<string, string>): void => {
    reflexes.set(reflex.name, typeof reflex.at === "string" ? { ...reflex, at: renameName(reflex.at, renames) } : reflex);
  };
  for (const reflex of base.reflexes) addReflex(reflex, both);
  for (const reflex of mine.reflexes) addReflex(reflex, mineMap);

  // Unknown top-level fields: the disk copy decides, so a stale one in memory never overwrites a newer one.
  const merged: MapFile = {
    ...mine,
    ...base,
    places,
    roads: [...roads.values()],
    routes: { ...base.routes, ...mine.routes },
    reflexes: [...reflexes.values()],
  };
  // One random key per map: the file on disk decides, so older hashes stay comparable.
  const titleKey = base.titleKey ?? mine.titleKey;
  if (titleKey !== undefined) merged.titleKey = titleKey;
  return { map: merged, renames: mineMap };
}

export function mergeMaps(disk: MapFile, mine: MapFile, options: { renamed?: Record<string, string> } = {}): MapFile {
  return mergeMapsWithRenames(disk, mine, options).map;
}

/** What a caller took out on purpose. Each removal waits for the other tool's newer evidence. */
export interface MapRemovals {
  places?: { name: string; before: string }[];
  roads?: { from: string; move: Move; to: string; before: string }[];
  reflexes?: string[];
  /** Places renamed on purpose (old to new). */
  renamed?: Record<string, string>;
}

// Writing: read, merge and write under a lock (§18.9).

function tokenFor(io: MapIo): string {
  return `${process.pid}.${io.now()}.${Math.random().toString(36).slice(2, 12)}`;
}

async function withLock<T>(io: MapIo, lockPath: string, body: () => Promise<T>): Promise<T> {
  const token = tokenFor(io);
  const deadline = io.now() + LOCK_WAIT_MS;
  for (;;) {
    if (await io.createExclusive(lockPath, token)) break;
    const madeAt = await io.statMtimeMs(lockPath);
    // It vanished between the two calls: try again at once.
    if (madeAt === null) {
      // A real permission error looks the same as a busy lock; never spin past the deadline.
      if (io.now() > deadline) throw new Error(`the map file is locked (${lockPath}); try again`);
      continue;
    }
    if (io.now() - madeAt > LOCK_STALE_MS) {
      await reclaim(io, lockPath, token);
      continue;
    }
    if (io.now() > deadline) throw new Error(`the map file is locked (${lockPath}); try again`);
    await io.sleep(LOCK_POLL_MS);
  }
  try {
    return await body();
  } finally {
    // Remove the lock only if it is still mine. A reclaimer may have taken it over.
    if ((await io.readFile(lockPath)) === token) await io.remove(lockPath);
  }
}

/** Takes a lock that looked stale by renaming it away, so only one reclaimer wins. */
async function reclaim(io: MapIo, lockPath: string, token: string): Promise<void> {
  const grabbed = `${lockPath}.${token}.stale`;
  try {
    await io.rename(lockPath, grabbed);
  } catch (error) {
    // Someone else reclaimed it first, or its holder released it.
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const madeAt = await io.statMtimeMs(grabbed);
  if (madeAt !== null && io.now() - madeAt <= LOCK_STALE_MS) {
    // It was fresh after all (it changed hands between our look and our rename): give it back.
    const text = (await io.readFile(grabbed)) ?? "";
    await io.createExclusive(lockPath, text);
  }
  await io.remove(grabbed);
}

async function renameWithRetry(io: MapIo, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "EPERM" && code !== "EBUSY") || attempt >= RENAME_RETRIES) throw error;
      await io.sleep(RENAME_RETRY_MS);
    }
  }
}

/** A temp file, then a rename over the target. The temp file is removed on any failure. */
async function writeAtomic(io: MapIo, target: string, data: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await io.writeFile(temp, data);
    await renameWithRetry(io, temp, target);
  } catch (error) {
    await io.remove(temp).catch(() => undefined);
    throw error;
  }
}

/** Removes temp and grabbed-lock files a crashed writer left behind. Runs under the lock. */
async function sweepLeftovers(io: MapIo, dir: string): Promise<void> {
  for (const name of await io.listDir(dir)) {
    if (!/^map\.json(\.lock)?\..+\.(tmp|stale)$/.test(name)) continue;
    const path = join(dir, name);
    const madeAt = await io.statMtimeMs(path);
    if (madeAt !== null && io.now() - madeAt > LOCK_STALE_MS) await io.remove(path).catch(() => undefined);
  }
}

// Route files (§18.5) live next to the map. Only paths inside the folder are touched.
function insideDir(dir: string, relative: string): string | null {
  const full = resolve(dir, relative);
  return full.startsWith(resolve(dir) + sep) ? full : null;
}

async function readRoute(io: MapIo, dir: string, relative: string): Promise<Record<string, unknown> | null> {
  const full = insideDir(dir, relative);
  if (full === null) return null;
  const text = await io.readFile(full);
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function rewriteRouteFiles(io: MapIo, dir: string, paths: string[], renames: Record<string, string>): Promise<void> {
  if (Object.keys(renames).length === 0) return;
  for (const relative of paths) {
    const route = await readRoute(io, dir, relative);
    const full = insideDir(dir, relative);
    if (route === null || full === null) continue;
    let changed = false;
    for (const field of ["start", "end"]) {
      const value = route[field];
      if (typeof value === "string" && Object.hasOwn(renames, value)) {
        route[field] = renames[value];
        changed = true;
      }
    }
    if (changed) await writeAtomic(io, full, `${JSON.stringify(route, null, 2)}\n`);
  }
}

async function applyRemovals(io: MapIo, dir: string, disk: MapFile, merged: MapFile, removed: MapRemovals): Promise<void> {
  // A removal only holds when the disk copy is not newer than what the caller saw.
  for (const { name, before } of removed.places ?? []) {
    const onDisk = disk.places[name];
    if (onDisk !== undefined && compareLast(onDisk.last, before) > 0) continue;
    delete merged.places[name];
    merged.roads = merged.roads.filter((r) => r.from !== name && r.to !== name);
    merged.reflexes = merged.reflexes.filter((r) => r.at !== name);
    for (const [route, relative] of Object.entries(merged.routes)) {
      const file = await readRoute(io, dir, relative);
      if (file !== null && (file["start"] === name || file["end"] === name)) delete merged.routes[route];
    }
  }
  for (const { from, move, to, before } of removed.roads ?? []) {
    const id = roadId(from, move, to);
    const onDisk = disk.roads.find((r) => roadId(r.from, r.move, r.to) === id);
    if (onDisk !== undefined && compareLast(onDisk.last, before) > 0) continue;
    merged.roads = merged.roads.filter((r) => roadId(r.from, r.move, r.to) !== id);
  }
  if (removed.reflexes !== undefined) merged.reflexes = merged.reflexes.filter((r) => !removed.reflexes?.includes(r.name));
}

/**
 * Merges `map` into what is on disk and writes it; answers the merged file, which the caller
 * adopts. `readOnly` (replay) throws before touching anything.
 */
export async function saveMap(
  dir: string,
  map: MapFile,
  options: { readOnly?: boolean; io?: MapIo; removed?: MapRemovals } = {},
): Promise<MapFile> {
  if (options.readOnly === true) throw new Error("the map is read-only here (replay never writes it)");
  const io = options.io ?? nodeMapIo();
  const file = join(dir, "map.json");
  await io.mkdirp(dir);
  return withLock(io, `${file}.lock`, async () => {
    await sweepLeftovers(io, dir);
    const text = await io.readFile(file);
    let merged = map;
    let renames: Record<string, string> = {};
    let disk = emptyMap(map.app);
    if (text !== null) {
      const parsed = parseMap(text, map.app);
      // A file we can't read is left alone, never overwritten.
      if (parsed === null) throw new Error(`the map file is unreadable and was left alone (${file})`);
      disk = parsed;
      const result = mergeMapsWithRenames(disk, map, { renamed: options.removed?.renamed });
      merged = result.map;
      renames = result.renames;
    }
    if (options.removed !== undefined) await applyRemovals(io, dir, disk, merged, options.removed);
    await writeAtomic(io, file, `${JSON.stringify(merged, null, 2)}\n`);
    // Route files follow a rename: explicit ones in every route, a clash only in my own new routes.
    const explicit = options.removed?.renamed ?? {};
    await rewriteRouteFiles(io, dir, Object.values(merged.routes), explicit);
    const mineOnly = Object.entries(merged.routes)
      .filter(([name]) => disk.routes[name] === undefined)
      .map(([, relative]) => relative);
    await rewriteRouteFiles(io, dir, mineOnly, renames);
    return merged;
  });
}
