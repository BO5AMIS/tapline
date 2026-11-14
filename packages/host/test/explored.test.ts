import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coverageCounts, coverageLine, frontierOf, mergeExplored, recomputeFrontier, withSeen, withSkipped, withTried, type ExploredRecord } from "../src/explored.js";
import { loadMap, mergeMaps, saveMap, type MapFile, type MapPlace } from "../src/mapfile.js";
import { AppMap } from "../src/places.js";
import { callTool } from "../src/dispatch.js";
import { MapRegistry } from "../src/places.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";
import type { TaplineHost } from "../src/server.js";

// AGENT-TOOLS 1.15 §28: the map's explored record, its merge, the helpers the explorer calls, and coverage in `map`.

const BUILD = "1.5.0 (220)";
const OLD = "1.4.0 (212)";
const APP = { name: "Wayfare", id: "com.example.wayfare", version: "1.5.0", build: "220" };
const T1 = "2026-11-14T09:00:00.000Z";
const T2 = "2026-11-14T09:05:00.000Z";
const T3 = "2026-11-14T09:10:00.000Z";

const dirs: string[] = [];
const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const registries: MapRegistry[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(registries.splice(0).map((r) => r.flushAll()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-explored-"));
  dirs.push(dir);
  return dir;
};

const record = (over: Partial<ExploredRecord> = {}): ExploredRecord => ({ last: T1, actions: [], frontier: [], ...over });
const place = (route: string[], explored?: ExploredRecord): MapPlace => ({ key: { route }, link: null, last: T1, ...(explored !== undefined ? { explored } : {}) });
const mapOf = (places: Record<string, MapPlace>): MapFile => ({ format: "agent-tools-map", version: 1, app: APP.id, places, roads: [], routes: {}, reflexes: [] });

describe("record helpers", () => {
  it("withTried adds an entry with its build and time, and takes the signature off the frontier", () => {
    const r = withTried(record({ frontier: ["id:a", "id:b"] }), "id:a", { result: "road", to: "language_picker" }, BUILD, T2);
    expect(r.actions).toEqual([{ sig: "id:a", result: "road", to: "language_picker", build: BUILD, last: T2 }]);
    expect(r.frontier).toEqual(["id:b"]);
    expect(r.last).toBe(T2);
  });
  it("keeps the result kinds the spec lists", () => {
    let r: ExploredRecord | undefined;
    r = withTried(r, "id:same", { result: "same" }, BUILD, T1);
    r = withTried(r, "role:button@c1r6", { result: "refused", code: "covered" }, BUILD, T1);
    r = withTried(r, "id:boom", { result: "crash" }, BUILD, T1);
    r = withTried(r, "id:out", { result: "left" }, BUILD, T1);
    expect(r.actions.map((a) => [a.sig, a.result, a.code])).toEqual([
      ["id:same", "same", undefined],
      ["role:button@c1r6", "refused", "covered"],
      ["id:boom", "crash", undefined],
      ["id:out", "left", undefined],
    ]);
  });
  it("a new try replaces the old entry of the same signature", () => {
    let r = withTried(undefined, "id:a", { result: "same" }, OLD, T1);
    r = withTried(r, "id:a", { result: "road", to: "x" }, BUILD, T2);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ result: "road", to: "x", build: BUILD });
  });
  it("withSkipped keeps why and word, and no build", () => {
    const r = withSkipped(undefined, "text:Sign out", "floor", "Sign out", T1);
    expect(r.actions).toEqual([{ sig: "text:Sign out", result: "skipped", why: "floor", word: "Sign out", last: T1 }]);
    expect(withSkipped(undefined, "id:x", "app_mark", undefined, T1).actions[0]).not.toHaveProperty("word");
  });
  it("withSeen adds untried signatures and never a tried one", () => {
    const r = withSeen(withTried(undefined, "id:a", { result: "same" }, BUILD, T1), ["id:a", "id:b", "id:b", "id:c"], T2);
    expect(r.frontier).toEqual(["id:b", "id:c"]);
  });
  it("cuts the frontier at 50 with …", () => {
    const sigs = Array.from({ length: 60 }, (_, n) => `id:s${n}`);
    const r = withSeen(undefined, sigs, T1);
    expect(r.frontier).toHaveLength(51);
    expect(r.frontier[50]).toBe("…");
    // The mark survives a later change, and is not a signature.
    const after = withTried(r, "id:s0", { result: "same" }, BUILD, T2);
    expect(after.frontier.filter((s) => s === "…")).toHaveLength(1);
    expect(frontierOf(after, BUILD)).not.toContain("…");
  });
});

describe("frontierOf and builds", () => {
  it("an action of another build is untried again; a skip holds for every build", () => {
    let r = withTried(undefined, "id:old", { result: "same" }, OLD, T1);
    r = withTried(r, "id:now", { result: "same" }, BUILD, T1);
    r = withSkipped(r, "text:Delete", "floor", "Delete", T1);
    r = withSeen(r, ["id:new"], T1);
    expect(frontierOf(r, BUILD)).toEqual(["id:new", "id:old"]);
    expect(frontierOf(r, OLD)).toEqual(["id:new", "id:now"]);
  });
  it("is empty without a record", () => {
    expect(frontierOf(undefined, BUILD)).toEqual([]);
  });
});

describe("merging (§28.2)", () => {
  it("by signature, the newest last wins; both tools' work is kept", () => {
    const disk = record({ last: T2, actions: [{ sig: "id:a", result: "same", build: BUILD, last: T2 }, { sig: "id:d", result: "same", build: BUILD, last: T1 }] });
    const mine = record({ last: T3, actions: [{ sig: "id:a", result: "road", to: "x", build: BUILD, last: T1 }, { sig: "id:m", result: "left", build: BUILD, last: T3 }] });
    const merged = mergeExplored(disk, mine);
    const by = Object.fromEntries(merged.actions.map((a) => [a.sig, a]));
    expect(by["id:a"]?.result).toBe("same");
    expect(Object.keys(by).sort()).toEqual(["id:a", "id:d", "id:m"]);
    expect(merged.last).toBe(T3);
  });
  it("on equal stamps mine wins", () => {
    const disk = record({ actions: [{ sig: "id:a", result: "same", build: BUILD, last: T1 }] });
    const mine = record({ actions: [{ sig: "id:a", result: "left", build: BUILD, last: T1 }] });
    expect(mergeExplored(disk, mine).actions[0]?.result).toBe("left");
    expect(mergeExplored(mine, disk).actions[0]?.result).toBe("same");
  });
  it("recomputes the frontier: what is in actions leaves it", () => {
    const disk = record({ frontier: ["id:a", "id:b"] });
    const mine = record({ frontier: ["id:c"], actions: [{ sig: "id:b", result: "same", build: BUILD, last: T1 }] });
    expect(mergeExplored(disk, mine).frontier).toEqual(["id:a", "id:c"]);
  });
  it("keeps keys it doesn't know", () => {
    const merged = mergeExplored(record({ extra: 1 }), record({ last: T2, other: 2 }));
    expect(merged["extra"]).toBe(1);
    expect(merged["other"]).toBe(2);
  });
  it("recomputeFrontier alone drops what was tried", () => {
    expect(recomputeFrontier(record({ frontier: ["id:a"], actions: [{ sig: "id:a", result: "same", last: T1 }] })).frontier).toEqual([]);
  });
  it("mergeMaps merges the record of a place found on both sides, and keeps a one-sided record", () => {
    const a = withTried(undefined, "id:a", { result: "same" }, BUILD, T2);
    const b = withTried(undefined, "id:b", { result: "same" }, BUILD, T3);
    const disk = mapOf({ home: place(["index"], a), only_disk: place(["d"], a) });
    const mine = mapOf({ home: place(["index"], b), only_mine: place(["m"], b), plain: place(["p"]) });
    const merged = mergeMaps(disk, mine);
    expect(merged.places["home"]?.explored?.actions.map((x) => x.sig).sort()).toEqual(["id:a", "id:b"]);
    expect(merged.places["only_disk"]?.explored).toBeDefined();
    expect(merged.places["only_mine"]?.explored).toBeDefined();
    expect(merged.places["plain"]).not.toHaveProperty("explored");
  });
  it("a save never drops another tool's explored work", async () => {
    const dir = join(temp(), APP.id);
    const other = withTried(undefined, "id:theirs", { result: "same" }, BUILD, T2);
    await saveMap(dir, mapOf({ home: place(["index"], other) }));
    // My memory has the place with no record at all (an older copy).
    const result = await saveMap(dir, mapOf({ home: place(["index"]) }));
    expect(result.places["home"]?.explored?.actions[0]?.sig).toBe("id:theirs");
    expect(loadMap(dir, APP.id).map.places["home"]?.explored?.actions[0]?.sig).toBe("id:theirs");
  });
});

describe("the map file", () => {
  it("an old map without explored loads, and its version stays 1", () => {
    const dir = join(temp(), APP.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "map.json"), JSON.stringify(mapOf({ home: place(["index"]) })));
    const loaded = loadMap(dir, APP.id);
    expect(loaded.status).toBe("ok");
    expect(loaded.map.version).toBe(1);
    expect(loaded.map.places["home"]?.explored).toBeUndefined();
  });
  it("round-trips the record through a save, keeping fields it doesn't know", async () => {
    const dir = join(temp(), APP.id);
    const explored = withTried(undefined, "id:a", { result: "road", to: "b" }, BUILD, T1);
    (explored["actions"] as Array<Record<string, unknown>>)[0]!["futureField"] = "kept";
    await saveMap(dir, mapOf({ home: place(["index"], explored) }));
    const text = JSON.parse(readFileSync(join(dir, "map.json"), "utf8")) as { version: number; places: { home: { explored: { actions: Array<Record<string, unknown>> } } } };
    expect(text.version).toBe(1);
    expect(text.places.home.explored.actions[0]).toMatchObject({ sig: "id:a", result: "road", to: "b", futureField: "kept" });
  });
  it("a record that doesn't fit is dropped; the map still loads", () => {
    const dir = join(temp(), APP.id);
    mkdirSync(dir, { recursive: true });
    const broken = mapOf({ home: place(["index"]) });
    (broken.places["home"] as Record<string, unknown>)["explored"] = { actions: "no" };
    writeFileSync(join(dir, "map.json"), JSON.stringify(broken));
    const loaded = loadMap(dir, APP.id);
    expect(loaded.status).toBe("ok");
    expect(loaded.map.places["home"]?.explored).toBeUndefined();
  });
});

describe("AppMap helpers", () => {
  const appMap = (map: MapFile, build = "220"): { app: AppMap; dir: string } => {
    const dir = join(temp(), APP.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "map.json"), JSON.stringify(map));
    return { app: new AppMap({ ...APP, build }, { dir, clock: () => Date.parse(T2), writeGapMs: 0 }), dir };
  };

  it("markSeen, markTried and markSkipped drive frontier(place)", () => {
    const { app } = appMap(mapOf({ home: place(["index"]) }));
    expect(app.frontier("home")).toEqual([]);
    expect(app.markSeen("home", ["id:a", "id:b", "text:Sign out"])).toBe(true);
    expect(app.frontier("home")).toEqual(["id:a", "id:b", "text:Sign out"]);
    app.markTried("home", "id:a", { result: "road", to: "settings" });
    app.markSkipped("home", "text:Sign out", "floor", "Sign out");
    expect(app.frontier("home")).toEqual(["id:b"]);
    expect(app.isTried("home", "id:a")).toBe(true);
    expect(app.isTried("home", "text:Sign out")).toBe(true);
    expect(app.isTried("home", "id:b")).toBe(false);
    expect(app.triedAction("home", "id:a")).toMatchObject({ result: "road", to: "settings", build: BUILD, last: T2 });
  });
  it("a new build tries again, except skips", () => {
    const { app, dir } = appMap(mapOf({ home: place(["index"]) }));
    app.markSeen("home", ["id:a", "text:Delete"]);
    app.markTried("home", "id:a", { result: "same" });
    app.markSkipped("home", "text:Delete", "policy", "Delete");
    expect(app.frontier("home")).toEqual([]);
    app.updateApp({ ...APP, version: "1.6.0", build: "230" });
    expect(app.frontier("home")).toEqual(["id:a"]);
    expect(app.isTried("home", "text:Delete")).toBe(true);
    expect(dir).toBeTruthy();
  });
  it("an unknown place changes nothing, and a read-only map never writes", () => {
    const { app } = appMap(mapOf({ home: place(["index"]) }));
    expect(app.markTried("nowhere", "id:a", { result: "same" })).toBe(false);
    expect(app.markSkipped("nowhere", "id:a", "floor")).toBe(false);
    expect(app.markSeen("nowhere", ["id:a"])).toBe(false);
    expect(app.frontier("nowhere")).toEqual([]);
  });
  it("is written to the file, and forgetting the place removes the record", async () => {
    const { app, dir } = appMap(mapOf({ home: place(["index"]), settings: place(["settings"]) }));
    app.markTried("home", "id:a", { result: "same" });
    await app.flush();
    expect(loadMap(dir, APP.id).map.places["home"]?.explored?.actions[0]?.sig).toBe("id:a");
    app.removePlace("home");
    await app.flush();
    expect(loadMap(dir, APP.id).map.places["home"]).toBeUndefined();
  });
  it("a read-only copy writes no record", async () => {
    const { app, dir } = appMap(mapOf({ home: place(["index"]) }));
    const copy = await app.readOnlyCopy();
    expect(copy.markTried("home", "id:a", { result: "same" })).toBe(false);
    await copy.flush();
    expect(loadMap(dir, APP.id).map.places["home"]?.explored).toBeUndefined();
  });
});

describe("coverage", () => {
  it("counts explored and frontier places (§28.3)", () => {
    const done = withTried(undefined, "id:a", { result: "same" }, BUILD, T1);
    const open = withSeen(undefined, ["id:z"], T1);
    const stale = withTried(undefined, "id:a", { result: "same" }, OLD, T1);
    expect(coverageCounts([done, open, undefined, stale], BUILD)).toEqual({ places: 4, explored: 1, frontier: 3 });
  });
  it("a cut frontier is not explored", () => {
    const r = withSeen(undefined, Array.from({ length: 60 }, (_, n) => `id:s${n}`), T1);
    expect(coverageCounts([r], BUILD).explored).toBe(0);
  });
  it("words the line as the spec does", () => {
    const done = withTried(undefined, "id:a", { result: "same" }, BUILD, T1);
    const records = [...Array.from({ length: 12 }, () => done), undefined, undefined];
    expect(coverageLine(records, BUILD, 3)).toBe("Coverage: 14 places (12 explored, 2 frontier); known up front, not reached: 3.");
    expect(coverageLine(records, BUILD, null)).toBe("Coverage: 14 places (12 explored, 2 frontier).");
    expect(coverageLine([undefined, undefined], BUILD, 3)).toBeNull();
  });
});

describe("map listing: Coverage", () => {
  async function listing(map: MapFile, known?: unknown): Promise<string[]> {
    const { host, port } = await startHost();
    hosts.push(host);
    const mapsDir = temp();
    mkdirSync(join(mapsDir, APP.id), { recursive: true });
    writeFileSync(join(mapsDir, APP.id, "map.json"), JSON.stringify(map));
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [], route: { names: ["index"] }, place: { route: ["index"] } } };
      if (req.method === "place") return { ok: true, result: { route: ["index"], seenAt: Date.now() } };
      if (req.method === "places") return { ok: true, result: known ?? { source: "none", places: [] } };
      return { ok: true, result: {} };
    };
    const { app } = await FakeApp.connect(port, { app: APP, capabilities: ["tree", "press", "logs", "dryRun", "place", "places"] }, handler);
    apps.push(app);
    const registry = new MapRegistry({ mapsDir });
    registries.push(registry);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, maps: registry });
    const result = await callTool(tools, "map", {});
    return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").split("\n");
  }

  it("is left out when no place has a record", async () => {
    const lines = await listing(mapOf({ index: place(["index"]), settings: place(["settings"]) }));
    expect(lines.some((l) => l.startsWith("Coverage:"))).toBe(false);
  });
  it("comes right after the Places line, with the not-reached count when places are known up front", async () => {
    const done = withTried(undefined, "id:a", { result: "same" }, BUILD, T1);
    const known = { source: "expo-router", places: [{ route: ["settings"], link: null, params: [] }, { route: ["admin"], link: null, params: [] }, { route: ["debug"], link: null, params: [] }] };
    const lines = await listing(mapOf({ index: place(["index"], done), settings: place(["settings"], withSeen(undefined, ["id:z"], T1)) }), known);
    const at = lines.findIndex((l) => l.startsWith("Places: "));
    expect(lines[at + 1]).toBe("Coverage: 2 places (1 explored, 1 frontier); known up front, not reached: 2.");
  });
  it("leaves the not-reached part out for a tool with no places known up front", async () => {
    const done = withTried(undefined, "id:a", { result: "same" }, BUILD, T1);
    const lines = await listing(mapOf({ index: place(["index"], done) }));
    expect(lines).toContain("Coverage: 1 places (1 explored, 0 frontier).");
  });
});
