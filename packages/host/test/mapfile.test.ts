import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAP_FORMAT,
  MAP_VERSION,
  loadMap,
  mapDir,
  mergeMaps,
  mergeMapsWithRenames,
  roadId,
  saveMap,
  type MapFile,
  type MapIo,
  type MapRoad,
} from "../src/mapfile.js";

// AGENT-TOOLS 1.13 §18.9: the map file. Every test works in a temp folder, never in ~/.tapline.

const APP = "com.example.wayfare";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-map-"));
  dirs.push(dir);
  return dir;
}

function emptyMap(): MapFile {
  return { format: MAP_FORMAT, version: MAP_VERSION, app: APP, places: {}, roads: [], routes: {}, reflexes: [] };
}

function road(from: string, to: string, id: string, last: string, by: MapRoad["by"] = "tapline"): MapRoad {
  return {
    from,
    to,
    move: { tool: "tap", target: { id } },
    by,
    seen: 1,
    failed: 0,
    ms: 400,
    last,
    build: "1.0.0 (1)",
  };
}

/** A real-disk io with a fake clock and a record of the sleeps. */
function fakeIo(real: MapIo, clock: { t: number }, sleeps: number[]): MapIo {
  return {
    ...real,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
  };
}

async function realIo(): Promise<MapIo> {
  const mod = await import("../src/mapfile.js");
  return mod.nodeMapIo();
}

describe("mapDir", () => {
  it("--maps DIR gives DIR/<id>/ and the default is under ~/.tapline/maps/<id>/", () => {
    expect(mapDir(APP, { mapsDir: "/tmp/maps" })).toBe(resolve("/tmp/maps", APP));
    expect(mapDir(APP, { home: "/home/tester" })).toBe(resolve("/home/tester", ".tapline", "maps", APP));
  });

  it("an id with ../ or slashes is reduced", () => {
    const base = resolve("/tmp/maps");
    for (const id of ["../../etc/passwd", "a/b\\c", "..", ".", "", "com.example/../wayfare", "id with spaces"]) {
      const dir = mapDir(id, { mapsDir: "/tmp/maps" });
      expect(dir.startsWith(base + sep)).toBe(true);
      expect(dir.slice(base.length + 1)).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(dir.slice(base.length + 1)).not.toMatch(/^\.+$/);
    }
  });
});

describe("mapDir on Windows", () => {
  it("strips trailing dots and spaces", () => {
    const base = resolve("/tmp/maps");
    expect(mapDir("com.example.wayfare...", { mapsDir: "/tmp/maps" })).toBe(join(base, "com.example.wayfare"));
    expect(mapDir("com.example.wayfare. . ", { mapsDir: "/tmp/maps" })).toBe(join(base, "com.example.wayfare"));
  });

  it("prefixes device names with _", () => {
    const base = resolve("/tmp/maps");
    for (const id of ["con", "CON", "nul.txt", "aux", "com1", "LPT9", "prn.x"]) {
      expect(mapDir(id, { mapsDir: "/tmp/maps" })).toBe(join(base, `_${id}`));
    }
    for (const id of ["console", "com10", "auxiliary", "com.example.wayfare"]) {
      expect(mapDir(id, { mapsDir: "/tmp/maps" })).toBe(join(base, id));
    }
  });
});

describe("loadMap and saveMap", () => {
  it("a missing file is new", () => {
    const dir = temp();
    const { map, status } = loadMap(dir, APP);
    expect(status).toBe("new");
    expect(map).toMatchObject({ format: MAP_FORMAT, version: 1, app: APP, places: {}, roads: [], routes: {}, reflexes: [] });
  });

  it("round trip keeps unknown fields, titleKey and titles", async () => {
    const dir = temp();
    const file: MapFile = {
      ...emptyMap(),
      titleKey: "ab12cd34",
      futureField: { keep: ["me"] },
      places: {
        language: {
          key: { route: ["(tabs)", "settings", "language"], tab: "settings" },
          link: null,
          titles: { en: "3fa9c1d27b0e44a8", ar: "9c01e7a5d2b84f36" },
          last: "2026-11-12T18:20:00Z",
          extraPlaceField: 7,
        },
      },
      roads: [{ ...road("settings", "language", "language-row", "2026-11-12T18:20:00Z"), extraRoadField: "x" }],
      routes: { sign_in: "routes/sign_in.json" },
      reflexes: [{ name: "rate_prompt", when: { text: "Rate" }, do: { tool: "tap", target: { text: "Not now" } }, max: 1 }],
    };
    await saveMap(dir, file);
    const back = loadMap(dir, APP);
    expect(back.status).toBe("ok");
    expect(back.map).toEqual(file);
    expect(existsSync(join(dir, "map.json"))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["map.json"]);
  });

  it("an unparseable file is left alone and loadMap says unreadable", async () => {
    const dir = temp();
    writeFileSync(join(dir, "map.json"), "{ not json");
    const out = loadMap(dir, APP);
    expect(out.status).toBe("unreadable");
    expect(out.map.places).toEqual({});
    await expect(saveMap(dir, emptyMap())).rejects.toThrow(/unreadable/);
    expect(readFileSync(join(dir, "map.json"), "utf8")).toBe("{ not json");
    expect(readdirSync(dir)).toEqual(["map.json"]);
  });

  it("a file of the wrong shape, another format or a newer version is unreadable and untouched", async () => {
    const cases: unknown[] = [
      { format: "something-else", version: 1, app: APP, places: {}, roads: [], routes: {}, reflexes: [] },
      { format: MAP_FORMAT, version: 2, app: APP, places: {}, roads: [], routes: {}, reflexes: [], future: true },
      { format: MAP_FORMAT, version: 1, app: APP, places: [], roads: [], routes: {}, reflexes: [] },
      { format: MAP_FORMAT, version: 1, app: APP, places: {}, roads: [{ from: 1 }], routes: {}, reflexes: [] },
      [],
      null,
    ];
    for (const body of cases) {
      const dir = temp();
      const text = JSON.stringify(body);
      writeFileSync(join(dir, "map.json"), text);
      expect(loadMap(dir, APP).status).toBe("unreadable");
      await expect(saveMap(dir, emptyMap())).rejects.toThrow(/unreadable/);
      expect(readFileSync(join(dir, "map.json"), "utf8")).toBe(text);
    }
  });

  it("an older file without optional lists is filled in, not refused", () => {
    const dir = temp();
    writeFileSync(join(dir, "map.json"), JSON.stringify({ format: MAP_FORMAT, version: 1, app: APP }));
    const out = loadMap(dir, APP);
    expect(out.status).toBe("ok");
    expect(out.map.roads).toEqual([]);
  });

  it("readOnly never writes", async () => {
    const dir = join(temp(), "never-made");
    await expect(saveMap(dir, emptyMap(), { readOnly: true })).rejects.toThrow(/read-only/);
    expect(existsSync(dir)).toBe(false);
  });

  it("creates the app folder when it is missing", async () => {
    const dir = join(temp(), "nested", APP);
    await saveMap(dir, emptyMap());
    expect(existsSync(join(dir, "map.json"))).toBe(true);
  });
});

describe("mergeMaps", () => {
  it("merge keeps both tools' roads and the newest last", () => {
    const disk: MapFile = {
      ...emptyMap(),
      roads: [road("a", "b", "x", "2026-11-12T10:00:00Z", "tapwright"), road("b", "c", "y", "2026-11-12T12:00:00Z", "tapwright")],
    };
    const mine: MapFile = {
      ...emptyMap(),
      roads: [{ ...road("a", "b", "x", "2026-11-12T11:00:00Z", "tapline"), seen: 5 }, road("c", "d", "z", "2026-11-12T09:00:00Z")],
    };
    const out = mergeMaps(disk, mine);
    expect(out.roads).toHaveLength(3);
    const ab = out.roads.find((r) => r.from === "a" && r.to === "b");
    expect(ab?.last).toBe("2026-11-12T11:00:00Z");
    expect(ab?.seen).toBe(5);
    // Each tool has driven it once, so it is both's.
    expect(ab?.by).toBe("both");
    expect(out.roads.find((r) => r.from === "b")?.by).toBe("tapwright");
    expect(out.roads.find((r) => r.from === "c")?.by).toBe("tapline");
  });

  it("the older side wins nothing when lasts are equal order-wise: mine is kept on a tie", () => {
    const disk: MapFile = { ...emptyMap(), roads: [{ ...road("a", "b", "x", "2026-11-12T10:00:00Z"), seen: 1 }] };
    const mine: MapFile = { ...emptyMap(), roads: [{ ...road("a", "b", "x", "2026-11-12T10:00:00Z"), seen: 2 }] };
    expect(mergeMaps(disk, mine).roads[0]?.seen).toBe(2);
  });

  it("keeps the other tool's titles, titleKey and unknown fields", () => {
    const disk: MapFile = {
      ...emptyMap(),
      titleKey: "disk-key",
      theirs: { n: 1 },
      places: {
        home: { key: { signature: "s1", parts: { tab: "home" } }, link: null, titles: { en: "aaaa" }, last: "2026-11-12T10:00:00Z", note: "kept" },
      },
    };
    const mine: MapFile = {
      ...emptyMap(),
      mine: true,
      places: {
        home: { key: { signature: "s1", parts: { tab: "home" } }, link: "wayfare://", last: "2026-11-12T11:00:00Z" },
      },
    };
    const out = mergeMaps(disk, mine);
    expect(out.titleKey).toBe("disk-key");
    expect(out["theirs"]).toEqual({ n: 1 });
    expect(out["mine"]).toBe(true);
    const home = out.places["home"];
    expect(home?.titles).toEqual({ en: "aaaa" });
    expect(home?.link).toBe("wayfare://");
    expect(home?.["note"]).toBe("kept");
    expect(home?.last).toBe("2026-11-12T11:00:00Z");
  });

  it("a newer place keeps the old link when its own is null", () => {
    const key = { route: ["home"] };
    const disk: MapFile = { ...emptyMap(), places: { home: { key, link: "wayfare://home", last: "2026-11-12T10:00:00Z" } } };
    const mine: MapFile = { ...emptyMap(), places: { home: { key, link: null, last: "2026-11-12T11:00:00Z" } } };
    expect(mergeMaps(disk, mine).places["home"]?.link).toBe("wayfare://home");
  });

  it("a place under two names with one key keeps the older name", () => {
    const key = { route: ["(tabs)", "settings"] };
    const disk: MapFile = {
      ...emptyMap(),
      places: { settings: { key, link: null, last: "2026-11-12T10:00:00Z" } },
      roads: [road("home", "settings", "s", "2026-11-12T10:00:00Z")],
    };
    const mine: MapFile = {
      ...emptyMap(),
      places: { prefs: { key, link: "wayfare://settings", last: "2026-11-12T12:00:00Z" } },
      roads: [road("home", "prefs", "s", "2026-11-12T12:00:00Z")],
    };
    const out = mergeMaps(disk, mine);
    expect(Object.keys(out.places)).toEqual(["settings"]);
    expect(out.places["settings"]?.link).toBe("wayfare://settings");
    // The road that used the dropped name follows the kept one, and folds into the same road.
    expect(out.roads).toHaveLength(1);
    expect(out.roads[0]?.to).toBe("settings");
  });

  it("merges routes and reflexes by name", () => {
    const disk: MapFile = {
      ...emptyMap(),
      routes: { sign_in: "routes/sign_in.json" },
      reflexes: [{ name: "a", when: { text: "A" }, do: { tool: "tap" } }],
    };
    const mine: MapFile = {
      ...emptyMap(),
      routes: { checkout: "routes/checkout.json" },
      reflexes: [{ name: "b", when: { text: "B" }, do: { tool: "tap" } }],
    };
    const out = mergeMaps(disk, mine);
    expect(Object.keys(out.routes).sort()).toEqual(["checkout", "sign_in"]);
    expect(out.reflexes.map((r) => r.name).sort()).toEqual(["a", "b"]);
  });
});

describe("the lock and the write", () => {
  it("two interleaved saves never drop a road", async () => {
    const dir = temp();
    const real = await realIo();
    const yielding: MapIo = {
      ...real,
      readFile: async (p) => {
        await new Promise((r) => setTimeout(r, 5));
        return real.readFile(p);
      },
      writeFile: async (p, d) => {
        await new Promise((r) => setTimeout(r, 5));
        return real.writeFile(p, d);
      },
      rename: async (a, b) => {
        await new Promise((r) => setTimeout(r, 5));
        return real.rename(a, b);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    };
    const a: MapFile = { ...emptyMap(), roads: [road("a", "b", "one", "2026-11-12T10:00:00Z")] };
    const b: MapFile = { ...emptyMap(), roads: [road("b", "c", "two", "2026-11-12T10:00:01Z", "tapwright")] };
    await Promise.all([saveMap(dir, a, { io: yielding }), saveMap(dir, b, { io: yielding })]);
    const out = loadMap(dir, APP);
    expect(out.map.roads.map((r) => `${r.from}>${r.to}`).sort()).toEqual(["a>b", "b>c"]);
    expect(readdirSync(dir)).toEqual(["map.json"]);
  });

  it("a fresh lock waits, then the save goes through when it is released", async () => {
    const dir = temp();
    const real = await realIo();
    const clock = { t: Date.now() };
    const sleeps: number[] = [];
    const io = fakeIo(real, clock, sleeps);
    // A lock another process just made, and which that process releases after a few polls.
    writeFileSync(join(dir, "map.json.lock"), "other");
    const base = io.sleep;
    let polls = 0;
    io.sleep = async (ms) => {
      await base(ms);
      polls += 1;
      if (polls === 3) rmSync(join(dir, "map.json.lock"));
    };
    // The lock file is stamped "now" by the real clock, so give the fake clock the same time.
    clock.t = Date.now();
    await saveMap(dir, emptyMap(), { io });
    expect(polls).toBe(3);
    expect(existsSync(join(dir, "map.json"))).toBe(true);
    expect(existsSync(join(dir, "map.json.lock"))).toBe(false);
  });

  it("a stale lock (older than 10 s) is reclaimed", async () => {
    const dir = temp();
    const real = await realIo();
    writeFileSync(join(dir, "map.json.lock"), "dead");
    const clock = { t: Date.now() + 11_000 };
    const sleeps: number[] = [];
    const io = fakeIo(real, clock, sleeps);
    await saveMap(dir, emptyMap(), { io });
    expect(existsSync(join(dir, "map.json"))).toBe(true);
    expect(existsSync(join(dir, "map.json.lock"))).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it("a lock just under 10 s old is not reclaimed", async () => {
    const dir = temp();
    const real = await realIo();
    writeFileSync(join(dir, "map.json.lock"), "busy");
    const created = (await real.statMtimeMs(join(dir, "map.json.lock"))) ?? 0;
    const clock = { t: created + 9_000 };
    const sleeps: number[] = [];
    const io = fakeIo(real, clock, sleeps);
    const base = io.sleep;
    io.sleep = async (ms) => {
      await base(ms);
      // Once the lock turns stale, the loop reclaims it.
    };
    await saveMap(dir, emptyMap(), { io });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "map.json"))).toBe(true);
  });

  it("EPERM on rename retries up to 5 times at 50 ms, then succeeds", async () => {
    const dir = temp();
    const real = await realIo();
    const sleeps: number[] = [];
    let failures = 0;
    const io: MapIo = {
      ...real,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      rename: async (a, b) => {
        if (failures < 5) {
          failures += 1;
          throw Object.assign(new Error("busy"), { code: failures % 2 ? "EPERM" : "EBUSY" });
        }
        return real.rename(a, b);
      },
    };
    await saveMap(dir, emptyMap(), { io });
    expect(failures).toBe(5);
    expect(sleeps).toEqual([50, 50, 50, 50, 50]);
    expect(existsSync(join(dir, "map.json"))).toBe(true);
  });

  it("EPERM on rename that never clears fails after 5 retries and leaves nothing behind", async () => {
    const dir = temp();
    const real = await realIo();
    let attempts = 0;
    const sleeps: number[] = [];
    const io: MapIo = {
      ...real,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      rename: async () => {
        attempts += 1;
        throw Object.assign(new Error("busy"), { code: "EPERM" });
      },
    };
    await expect(saveMap(dir, emptyMap(), { io })).rejects.toThrow(/busy/);
    expect(attempts).toBe(6);
    expect(sleeps).toEqual([50, 50, 50, 50, 50]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("another rename error is not retried", async () => {
    const dir = temp();
    const real = await realIo();
    let attempts = 0;
    const io: MapIo = {
      ...real,
      rename: async () => {
        attempts += 1;
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    };
    await expect(saveMap(dir, emptyMap(), { io })).rejects.toThrow(/gone/);
    expect(attempts).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  // The child runs the TypeScript source directly, which needs Node 22.6 or later.
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  const canStripTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);

  it.skipIf(!canStripTypes)("two processes writing at once never lose a road (needs Node 22.6+ to run the source)", async () => {
    const root = temp();
    const dir = join(root, "map");
    const script = join(root, "child.mjs");
    const modUrl = pathToFileURL(resolve(import.meta.dirname, "../src/mapfile.ts")).href;
    writeFileSync(
      script,
      `
const { saveMap } = await import(${JSON.stringify(modUrl)});
const [dir, who] = process.argv.slice(2);
for (let i = 0; i < 12; i++) {
  const mine = {
    format: "agent-tools-map", version: 1, app: ${JSON.stringify(APP)}, places: {}, routes: {}, reflexes: [],
    roads: [{ from: who, to: "n" + i, move: { tool: "tap", target: { id: who + i } }, by: who === "p1" ? "tapline" : "tapwright",
      seen: 1, failed: 0, ms: 1, last: new Date().toISOString(), build: "1.0.0 (1)" }],
  };
  await saveMap(dir, mine);
}
`,
    );
    const run = (who: string): Promise<number> =>
      new Promise((res, rej) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, dir, who], { stdio: "inherit" });
        child.on("error", rej);
        child.on("exit", (code) => res(code ?? 1));
      });
    const codes = await Promise.all([run("p1"), run("p2")]);
    expect(codes).toEqual([0, 0]);
    const out = loadMap(dir, APP);
    expect(out.status).toBe("ok");
    expect(out.map.roads).toHaveLength(24);
    expect(readdirSync(dir)).toEqual(["map.json"]);
  }, 60_000);

  it("two reclaimers of one stale lock never both hold it", async () => {
    const dir = temp();
    const real = await realIo();
    const lock = join(dir, "map.json.lock");
    writeFileSync(lock, "dead");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    const slow: MapIo = {
      ...real,
      rename: async (a, b) => {
        await new Promise((r) => setTimeout(r, 5));
        return real.rename(a, b);
      },
      readFile: async (p) => {
        await new Promise((r) => setTimeout(r, 3));
        return real.readFile(p);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    };
    const a: MapFile = { ...emptyMap(), roads: [road("a", "b", "one", "2026-11-12T10:00:00Z")] };
    const b: MapFile = { ...emptyMap(), roads: [road("b", "c", "two", "2026-11-12T10:00:01Z", "tapwright")] };
    await Promise.all([saveMap(dir, a, { io: slow }), saveMap(dir, b, { io: slow })]);
    expect(loadMap(dir, APP).map.roads).toHaveLength(2);
    expect(readdirSync(dir)).toEqual(["map.json"]);
  });

  it("a fresh lock grabbed by mistake is given back and waited for", async () => {
    const dir = temp();
    const real = await realIo();
    const lock = join(dir, "map.json.lock");
    writeFileSync(lock, "holder");
    let lied = false;
    let sawGivenBack = false;
    const io: MapIo = {
      ...real,
      // The first look at the lock says it is old; the rename then finds it fresh.
      statMtimeMs: async (p) => {
        if (p === lock && !lied) {
          lied = true;
          return Date.now() - 20_000;
        }
        return real.statMtimeMs(p);
      },
      sleep: async () => {
        if (!sawGivenBack) {
          sawGivenBack = readFileSync(lock, "utf8") === "holder";
          rmSync(lock);
        }
      },
    };
    await saveMap(dir, emptyMap(), { io });
    expect(sawGivenBack).toBe(true);
    expect(existsSync(join(dir, "map.json"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["map.json"]);
  });

  it("a lock that changed hands is not removed on release", async () => {
    const dir = temp();
    const real = await realIo();
    const lock = join(dir, "map.json.lock");
    const io: MapIo = {
      ...real,
      rename: async (a, b) => {
        writeFileSync(lock, "someone-else");
        return real.rename(a, b);
      },
    };
    await saveMap(dir, emptyMap(), { io });
    expect(readFileSync(lock, "utf8")).toBe("someone-else");
  });

  it("sweeps old temp files under the lock and keeps fresh ones", async () => {
    const dir = temp();
    const oldTmp = join(dir, "map.json.123.abc.tmp");
    const freshTmp = join(dir, "map.json.456.def.tmp");
    writeFileSync(oldTmp, "x");
    writeFileSync(freshTmp, "y");
    const old = new Date(Date.now() - 20_000);
    utimesSync(oldTmp, old, old);
    await saveMap(dir, emptyMap());
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true);
  });

  it("syncs the temp file before the rename", async () => {
    const dir = temp();
    const real = await realIo();
    const calls: string[] = [];
    const io: MapIo = {
      ...real,
      writeFile: async (p, d) => {
        calls.push("write");
        return real.writeFile(p, d);
      },
      rename: async (a, b) => {
        calls.push("rename");
        return real.rename(a, b);
      },
    };
    await saveMap(dir, emptyMap(), { io });
    expect(calls).toEqual(["write", "rename"]);
  });
});

describe("renames, clashes and removals", () => {
  it("a rename made on purpose is not undone by the disk copy", async () => {
    const dir = temp();
    const key = { route: ["(tabs)", "settings"] };
    const before: MapFile = {
      ...emptyMap(),
      places: { settings: { key, link: null, last: "2026-11-12T10:00:00Z" } },
      roads: [road("home", "settings", "s", "2026-11-12T10:00:00Z")],
      reflexes: [{ name: "r", when: { text: "x" }, do: { tool: "tap" }, at: "settings" }],
    };
    await saveMap(dir, before);
    const mine: MapFile = {
      ...emptyMap(),
      places: { prefs: { key, link: null, last: "2026-11-12T11:00:00Z" } },
      roads: [road("home", "prefs", "s", "2026-11-12T11:00:00Z")],
    };
    const out = await saveMap(dir, mine, { removed: { renamed: { settings: "prefs" } } });
    expect(Object.keys(out.places)).toEqual(["prefs"]);
    expect(out.roads).toHaveLength(1);
    expect(out.roads[0]?.to).toBe("prefs");
    expect(out.reflexes[0]?.at).toBe("prefs");
    expect(loadMap(dir, APP).map).toEqual(out);
  });

  it("a rename also rewrites start and end in the route files", async () => {
    const dir = temp();
    mkdirSync(join(dir, "routes"), { recursive: true });
    writeFileSync(join(dir, "routes", "sign_in.json"), JSON.stringify({ name: "sign_in", start: "welcome", end: "home" }));
    const key = { route: ["welcome"] };
    const disk: MapFile = {
      ...emptyMap(),
      places: { welcome: { key, link: null, last: "2026-11-12T10:00:00Z" } },
      routes: { sign_in: "routes/sign_in.json" },
    };
    await saveMap(dir, disk);
    const mine: MapFile = { ...emptyMap(), places: { intro: { key, link: null, last: "2026-11-12T11:00:00Z" } } };
    await saveMap(dir, mine, { removed: { renamed: { welcome: "intro" } } });
    const route = JSON.parse(readFileSync(join(dir, "routes", "sign_in.json"), "utf8")) as { start: string; end: string };
    expect(route).toMatchObject({ start: "intro", end: "home" });
  });

  it("two places with different keys and one name stay two: mine gets the next free _n", () => {
    const disk: MapFile = {
      ...emptyMap(),
      places: { trips: { key: { route: ["trips"] }, link: null, last: "2026-11-12T10:00:00Z" } },
      roads: [road("home", "trips", "a", "2026-11-12T10:00:00Z")],
    };
    const mine: MapFile = {
      ...emptyMap(),
      places: {
        trips: { key: { route: ["(admin)", "trips"] }, link: null, last: "2026-11-12T11:00:00Z" },
        trips_2: { key: { route: ["other"] }, link: null, last: "2026-11-12T11:00:00Z" },
      },
      roads: [road("trips", "trips_2", "b", "2026-11-12T11:00:00Z")],
      reflexes: [{ name: "r", when: { text: "x" }, do: { tool: "tap" }, at: "trips" }],
    };
    const { map, renames } = mergeMapsWithRenames(disk, mine);
    expect(renames).toEqual({ trips: "trips_3" });
    expect(Object.keys(map.places).sort()).toEqual(["trips", "trips_2", "trips_3"]);
    expect(map.places["trips"]?.key).toEqual({ route: ["trips"] });
    expect(map.places["trips_3"]?.key).toEqual({ route: ["(admin)", "trips"] });
    expect(map.roads.find((r) => r.move.target?.id === "b")?.from).toBe("trips_3");
    expect(map.roads.find((r) => r.move.target?.id === "a")?.to).toBe("trips");
    expect(map.reflexes[0]?.at).toBe("trips_3");
  });

  it("roads of a clash-renamed place follow it in a saved route file of mine", async () => {
    const dir = temp();
    mkdirSync(join(dir, "routes"), { recursive: true });
    await saveMap(dir, { ...emptyMap(), places: { trips: { key: { route: ["trips"] }, link: null, last: "2026-11-12T10:00:00Z" } } });
    writeFileSync(join(dir, "routes", "go.json"), JSON.stringify({ start: "trips", end: "home" }));
    const mine: MapFile = {
      ...emptyMap(),
      places: { trips: { key: { route: ["(admin)", "trips"] }, link: null, last: "2026-11-12T11:00:00Z" } },
      routes: { go: "routes/go.json" },
    };
    await saveMap(dir, mine);
    const route = JSON.parse(readFileSync(join(dir, "routes", "go.json"), "utf8")) as { start: string };
    expect(route.start).toBe("trips_2");
  });

  it("an unknown by or tool from a newer tool does not make the file unreadable", () => {
    const dir = temp();
    const odd = { ...road("a", "b", "x", "2026-11-12T10:00:00Z"), by: "someone-new", move: { tool: "pinch", target: { id: "x" } } };
    writeFileSync(join(dir, "map.json"), JSON.stringify({ ...emptyMap(), roads: [odd] }));
    const out = loadMap(dir, APP);
    expect(out.status).toBe("ok");
    expect(out.map.roads[0]?.by).toBe("someone-new");
  });

  it("last compares as a time, with a text fallback", () => {
    const key = { route: ["home"] };
    // The same instant written two ways; the later instant must win even though it sorts first as text.
    const disk: MapFile = { ...emptyMap(), places: { home: { key, link: "disk://", last: "2026-11-12T12:00:00+02:00" } } };
    const mine: MapFile = { ...emptyMap(), places: { home: { key, link: "mine://", last: "2026-11-12T11:00:00Z" } } };
    expect(mergeMaps(disk, mine).places["home"]?.link).toBe("mine://");
    const odd1: MapFile = { ...emptyMap(), places: { home: { key, link: "a://", last: "b" } } };
    const odd2: MapFile = { ...emptyMap(), places: { home: { key, link: "b://", last: "a" } } };
    expect(mergeMaps(odd1, odd2).places["home"]?.link).toBe("a://");
  });

  it("an unknown top-level field newer on disk is not overwritten by a stale one in memory", () => {
    const disk: MapFile = { ...emptyMap(), extra: "new" };
    const mine: MapFile = { ...emptyMap(), extra: "stale", onlyMine: 1 };
    const out = mergeMaps(disk, mine);
    expect(out["extra"]).toBe("new");
    expect(out["onlyMine"]).toBe(1);
  });

  it("removes a place with its roads and reflexes, and a route that starts there", async () => {
    const dir = temp();
    mkdirSync(join(dir, "routes"), { recursive: true });
    writeFileSync(join(dir, "routes", "r.json"), JSON.stringify({ start: "gone", end: "home" }));
    const file: MapFile = {
      ...emptyMap(),
      places: {
        gone: { key: { route: ["gone"] }, link: null, last: "2026-11-12T10:00:00Z" },
        home: { key: { route: ["home"] }, link: null, last: "2026-11-12T10:00:00Z" },
      },
      roads: [road("home", "gone", "g", "2026-11-12T10:00:00Z"), road("home", "home", "h", "2026-11-12T10:00:00Z")],
      reflexes: [{ name: "x", when: { text: "t" }, do: { tool: "tap" }, at: "gone" }],
      routes: { r: "routes/r.json" },
    };
    await saveMap(dir, file);
    const out = await saveMap(dir, file, { removed: { places: [{ name: "gone", before: "2026-11-12T10:00:00Z" }] } });
    expect(Object.keys(out.places)).toEqual(["home"]);
    expect(out.roads.map((r) => r.move.target?.id)).toEqual(["h"]);
    expect(out.reflexes).toEqual([]);
    expect(out.routes).toEqual({});
    expect(loadMap(dir, APP).map).toEqual(out);
  });

  it("a removal waits for the other tool's newer evidence", async () => {
    const dir = temp();
    const newer = road("a", "b", "x", "2026-11-12T12:00:00Z", "tapwright");
    const place = { key: { route: ["p"] }, link: null, last: "2026-11-12T12:00:00Z" };
    await saveMap(dir, { ...emptyMap(), roads: [newer], places: { p: place } });
    // I last saw them at 10:00 and drop them; the disk copies are newer, so they stay.
    const mine: MapFile = { ...emptyMap(), roads: [road("a", "b", "x", "2026-11-12T10:00:00Z")], places: { p: { ...place, last: "2026-11-12T10:00:00Z" } } };
    const out = await saveMap(dir, mine, {
      removed: {
        roads: [{ from: "a", move: { tool: "tap", target: { id: "x" } }, to: "b", before: "2026-11-12T10:00:00Z" }],
        places: [{ name: "p", before: "2026-11-12T10:00:00Z" }],
      },
    });
    expect(out.roads).toHaveLength(1);
    expect(out.places["p"]).toBeDefined();
  });

  it("removes a road and a reflex by name when the disk copy is not newer", async () => {
    const dir = temp();
    const file: MapFile = {
      ...emptyMap(),
      roads: [road("a", "b", "x", "2026-11-12T10:00:00Z"), road("b", "c", "y", "2026-11-12T10:00:00Z")],
      reflexes: [{ name: "k", when: { text: "t" }, do: { tool: "tap" } }],
    };
    await saveMap(dir, file);
    const out = await saveMap(dir, file, {
      removed: {
        roads: [{ from: "a", move: { tool: "tap", target: { id: "x" } }, to: "b", before: "2026-11-12T10:00:00Z" }],
        reflexes: ["k"],
      },
    });
    expect(out.roads.map((r) => r.from)).toEqual(["b"]);
    expect(out.reflexes).toEqual([]);
    expect(roadId("a", { tool: "tap", target: { id: "x" } }, "b")).toBe(roadId("a", { target: { id: "x" }, tool: "tap" }, "b"));
  });
});
