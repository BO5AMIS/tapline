import { describe, expect, it } from "vitest";
import { AppMap } from "../src/places.js";
import type { MapFile } from "../src/mapfile.js";

// PR 13 CodeRabbit round (R3): a rename in the live map moves explored destinations too.

describe("R3: renaming a place in the live map", () => {
  it("rewrites the destination of an explored action", () => {
    const map = new AppMap({ id: "com.example.r3", name: "R3", version: "1.0.0", build: "1.0.0 (1)" }, { save: () => Promise.resolve("x") } as never);
    const data = map.data() as MapFile;
    const T = "2026-11-14T10:00:00.000Z";
    data.places["home"] = { key: { route: ["home"] }, link: null, last: T, explored: { last: T, frontier: [], actions: [{ sig: "id:go", result: "road", to: "settings", last: T }] } };
    data.places["settings"] = { key: { route: ["settings"] }, link: null, last: T };
    expect(map.renamePlace("settings", "preferences")).toBe(true);
    expect(map.data().places["home"]?.explored?.actions[0]?.to).toBe("preferences");
  });
});

import { mergeExplored, type ExploredRecord } from "../src/mapfile.js";

describe("R3: a merged frontier drops completed signatures before the cut", () => {
  it("keeps the one untried action when the disk's 50 were completed by mine", () => {
    const T1 = "2026-11-13T10:00:00.000Z";
    const T2 = "2026-11-14T10:00:00.000Z";
    const sigs = Array.from({ length: 50 }, (_, i) => `id:a${String(i).padStart(2, "0")}`);
    const disk: ExploredRecord = { last: T1, actions: [], frontier: sigs };
    const mine: ExploredRecord = { last: T2, actions: sigs.map((sig) => ({ sig, result: "same" as const, build: "1", last: T2 })), frontier: ["id:b"] };
    const merged = mergeExplored(disk, mine);
    expect(merged.frontier).toEqual(["id:b"]);
  });
});
