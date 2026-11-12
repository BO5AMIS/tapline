import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

// The map file (AGENT-TOOLS 1.13 §18.9). The format is shared with Tapwright, so a field
// this module doesn't know is kept as it is, and a file it can't read is left alone.

export const MAP_FORMAT = "agent-tools-map";
export const MAP_VERSION = 1;

/** A lock older than this is counted as left behind (§18.9). */
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

export interface MapPlace {
  key: PlaceKey;
  link: string | null;
  titles?: Record<string, string>;
  last: string;
  [unknown: string]: unknown;
}

export type Move = {
  tool: "tap" | "long_press" | "toggle" | "back" | "open_url" | "swipe";
  target?: { id?: string; label?: string; text?: string; row?: true; x?: number; y?: number };
  url?: string;
};

export interface MapRoad {
  from: string;
  to: string;
  move: Move;
  names?: { id?: string; label?: string; text?: string };
  by: "tapline" | "tapwright" | "both";
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
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Creates the file only if it is absent; false when it already exists. */
  createExclusive(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** The file's modified time in ms, or null when it doesn't exist. */
  statMtimeMs(path: string): Promise<number | null>;
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
    writeFile: (path, data) => writeFile(path, data, "utf8"),
    rename: (from, to) => rename(from, to),
    async createExclusive(path) {
      try {
        const handle = await open(path, "wx");
        await handle.close();
        return true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
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
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

/** The folder is named by the app's own id, reduced so it can never leave the maps folder. */
export function mapDir(app: string, options: { mapsDir?: string; home?: string }): string {
  let id = app.replace(/[^A-Za-z0-9._-]/g, "_");
  if (/^\.*$/.test(id)) id = "_";
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
  tool: z.enum(["tap", "long_press", "toggle", "back", "open_url", "swipe"]),
  target: z.looseObject({}).optional(),
  url: z.string().optional(),
});
const roadSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  move: moveSchema,
  names: z.looseObject({}).optional(),
  by: z.enum(["tapline", "tapwright", "both"]),
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
  // A file for another app in this folder is not ours either.
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
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function placeIdentity(key: PlaceKey): string {
  // A signature key is the same place by its signature; `parts` is only for fuzzy matching.
  return "signature" in key ? `sig:${key.signature}` : `route:${stable(key)}`;
}

function newer<T extends { last: string }>(older: T, candidate: T): { older: T; newer: T } {
  // Equal stamps: the candidate (mine) is the newer one.
  return candidate.last >= older.last ? { older, newer: candidate } : { older: candidate, newer: older };
}

function mergePlace(disk: MapPlace, mine: MapPlace): MapPlace {
  const { older, newer: latest } = newer(disk, mine);
  const titles = { ...older.titles, ...latest.titles };
  const merged: MapPlace = { ...older, ...latest, link: latest.link ?? older.link };
  if (Object.keys(titles).length > 0) merged.titles = titles;
  return merged;
}

function mergeRoad(disk: MapRoad, mine: MapRoad): MapRoad {
  const { older, newer: latest } = newer(disk, mine);
  const by = disk.by === mine.by ? disk.by : "both";
  const merged: MapRoad = { ...older, ...latest, by };
  const names = { ...older.names, ...latest.names };
  if (Object.keys(names).length > 0) merged.names = names;
  return merged;
}

export function mergeMaps(disk: MapFile, mine: MapFile): MapFile {
  const places: Record<string, MapPlace> = {};
  const nameByKey = new Map<string, string>();
  for (const [name, place] of Object.entries(disk.places)) {
    places[name] = place;
    nameByKey.set(placeIdentity(place.key), name);
  }
  // Names of my places that are the same place under another name.
  const renamed = new Map<string, string>();
  for (const [name, place] of Object.entries(mine.places)) {
    const identity = placeIdentity(place.key);
    const known = nameByKey.get(identity);
    if (known !== undefined) {
      const existing = places[known];
      if (existing === undefined) continue;
      // One key under two names keeps the older name.
      if (known !== name) {
        const keepMine = place.last < existing.last;
        const keptName = keepMine ? name : known;
        const merged = mergePlace(existing, place);
        if (keepMine) delete places[known];
        places[keptName] = merged;
        nameByKey.set(identity, keptName);
        renamed.set(name, keptName);
        renamed.set(known, keptName);
      } else {
        places[known] = mergePlace(existing, place);
      }
      continue;
    }
    const clash = places[name];
    places[name] = clash === undefined ? place : mergePlace(clash, place);
    nameByKey.set(identity, name);
  }

  const rename = (name: string): string => renamed.get(name) ?? name;
  const roads = new Map<string, MapRoad>();
  for (const road of [...disk.roads, ...mine.roads]) {
    const moved: MapRoad = { ...road, from: rename(road.from), to: rename(road.to) };
    const id = `${moved.from}\u0000${stable(moved.move)}\u0000${moved.to}`;
    const have = roads.get(id);
    roads.set(id, have === undefined ? moved : mergeRoad(have, moved));
  }

  const reflexes = new Map<string, MapReflex>();
  for (const reflex of [...disk.reflexes, ...mine.reflexes]) reflexes.set(reflex.name, reflex);

  const merged: MapFile = {
    ...disk,
    ...mine,
    places,
    roads: [...roads.values()],
    routes: { ...disk.routes, ...mine.routes },
    reflexes: [...reflexes.values()],
  };
  // One random key per map: the file on disk decides, so older hashes stay comparable.
  const titleKey = disk.titleKey ?? mine.titleKey;
  if (titleKey !== undefined) merged.titleKey = titleKey;
  return merged;
}

// Writing: read, merge and write under a lock (§18.9).

async function withLock<T>(io: MapIo, lockPath: string, body: () => Promise<T>): Promise<T> {
  const deadline = io.now() + LOCK_WAIT_MS;
  for (;;) {
    if (await io.createExclusive(lockPath)) break;
    const madeAt = await io.statMtimeMs(lockPath);
    // It vanished between the two calls: try again at once.
    if (madeAt === null) continue;
    if (io.now() - madeAt > LOCK_STALE_MS) {
      await io.remove(lockPath);
      continue;
    }
    if (io.now() > deadline) throw new Error(`the map file is locked (${lockPath}); try again`);
    await io.sleep(LOCK_POLL_MS);
  }
  try {
    return await body();
  } finally {
    await io.remove(lockPath);
  }
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

/** Merges `map` into what is on disk and writes it. `readOnly` (replay) throws before touching anything. */
export async function saveMap(dir: string, map: MapFile, options: { readOnly?: boolean; io?: MapIo } = {}): Promise<void> {
  if (options.readOnly === true) throw new Error("the map is read-only here (replay never writes it)");
  const io = options.io ?? nodeMapIo();
  const file = join(dir, "map.json");
  await io.mkdirp(dir);
  await withLock(io, `${file}.lock`, async () => {
    const text = await io.readFile(file);
    let merged = map;
    if (text !== null) {
      const disk = parseMap(text, map.app);
      // A file we can't read is left alone, never overwritten.
      if (disk === null) throw new Error(`the map file is unreadable and was left alone (${file})`);
      merged = mergeMaps(disk, map);
    }
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await io.writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`);
      await renameWithRetry(io, temp, file);
    } catch (error) {
      await io.remove(temp).catch(() => undefined);
      throw error;
    }
  });
}
