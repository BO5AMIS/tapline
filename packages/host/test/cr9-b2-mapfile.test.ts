import { describe, expect, it } from "vitest";
import { MAP_FORMAT, MAP_VERSION, mergeMapsWithRenames, nodeMapIo, saveMap, type MapFile, type MapIo, type MapRoad } from "../src/mapfile.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PR 9 review (CodeRabbit): renames and merges keep roads and reflexes on the right place.

const empty = (): MapFile => ({ format: MAP_FORMAT, version: MAP_VERSION, app: "com.example.wayfare", places: {}, roads: [], routes: {}, reflexes: [] });
const at = (route: string[], last = "2026-11-12T10:00:00Z") => ({ key: { route }, link: null, last });
const road = (from: string, to: string, id: string): MapRoad => ({ from, to, move: { tool: "tap", target: { id } }, by: "tapline", seen: 1, failed: 0, ms: 400, last: "2026-11-12T10:00:00Z", build: "1.0.0 (1)" });

describe("a rename that is blocked by a taken name", () => {
  it("leaves the roads and reflexes of the place that kept its name alone", () => {
    // I renamed a to b. The disk already has another place b, so the disk's a stays a.
    const disk: MapFile = {
      ...empty(),
      places: { a: at(["a"]), b: at(["other"]) },
      roads: [road("home", "a", "to-a")],
      reflexes: [{ name: "r", when: { text: "x" }, do: { tool: "tap" }, at: "a" }],
    };
    const mine: MapFile = { ...empty(), places: { b: at(["a2"], "2026-11-12T11:00:00Z") } };
    const { map } = mergeMapsWithRenames(disk, mine, { renamed: { a: "b" } });
    expect(map.roads.find((r) => r.move.target?.id === "to-a")?.to).toBe("a");
    expect(map.reflexes[0]?.at).toBe("a");
  });
});

describe("one key under two names", () => {
  it("doesn't move the disk's roads of a different place that has my old name", () => {
    const disk: MapFile = {
      ...empty(),
      places: { trips: at(["trips"], "2026-11-12T11:00:00Z"), trips_2: at(["other"]) },
      roads: [road("home", "trips_2", "to-real-trips-2")],
      reflexes: [{ name: "r", when: { text: "x" }, do: { tool: "tap" }, at: "trips_2" }],
    };
    // My trips_2 has the disk's trips key, so it merges into trips.
    const mine: MapFile = { ...empty(), places: { trips_2: at(["trips"], "2026-11-12T12:00:00Z") }, roads: [road("home", "trips_2", "mine")] };
    const { map } = mergeMapsWithRenames(disk, mine);
    expect(map.roads.find((r) => r.move.target?.id === "to-real-trips-2")?.to).toBe("trips_2");
    expect(map.reflexes[0]?.at).toBe("trips_2");
    expect(map.roads.find((r) => r.move.target?.id === "mine")?.to).toBe("trips");
  });
});

describe("the lock with no modified time", () => {
  it("waits before it tries again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-b2-"));
    try {
      const real = nodeMapIo();
      let now = 0;
      let tries = 0;
      const sleeps: number[] = [];
      const io: MapIo = {
        ...real,
        now: () => now,
        // The lock looks held, but has no time, three times.
        createExclusive: async (path, data) => (path.endsWith(".lock") && tries++ < 3 ? false : real.createExclusive(path, data)),
        statMtimeMs: async (path) => (path.endsWith(".lock") ? null : real.statMtimeMs(path)),
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      };
      await saveMap(dir, empty(), { io });
      expect(sleeps.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
