import { describe, expect, it } from "vitest";
import { mergeMaps, mergeMapsWithRenames, type ExploredAction, type MapFile, type MapPlace } from "../src/mapfile.js";

// PR 13 security review, round 2, finding 4: an explored record's destination follows a place's rename, as a road's does.

const T1 = "2026-11-12T10:00:00.000Z";
const T2 = "2026-11-13T10:00:00.000Z";
const action = (sig: string, to: string): ExploredAction => ({ sig, result: "road", to, last: T1 });
const place = (route: string[], actions: ExploredAction[] = [], last = T1): MapPlace => ({
  key: { route },
  link: null,
  last,
  ...(actions.length > 0 ? { explored: { last, actions, frontier: [] } } : {}),
});
const file = (places: Record<string, MapPlace>): MapFile => ({ format: "agent-tools-map", version: 1, app: "app.test", places, roads: [], routes: {}, reflexes: [] });

describe("R2 finding 4: explored destinations follow renames", () => {
  it("the disk's explored action follows a place the other tool kept under its own name", () => {
    // Disk calls the place `settings`; mine found it first (older stamp) as `sibling_settings`, so that name stays.
    const disk = file({ home: place(["home"], [action("id:go-settings", "settings")], T2), settings: place(["settings"], [], T2) });
    const mine = file({ home: place(["home"]), sibling_settings: place(["settings"], [], T1) });
    const { map, renames } = mergeMapsWithRenames(disk, mine);
    expect(Object.keys(map.places).sort()).toEqual(["home", "sibling_settings"]);
    expect(renames).toEqual({});
    expect(map.places["home"]?.explored?.actions.map((a) => a.to)).toEqual(["sibling_settings"]);
  });

  it("my explored action follows the name my place was folded into", () => {
    const disk = file({ home: place(["home"]), settings: place(["settings"], [], T1) });
    const mine = file({ home: place(["home"], [action("id:go-settings", "sibling_settings")], T2), sibling_settings: place(["settings"], [], T2) });
    const { map, renames } = mergeMapsWithRenames(disk, mine);
    expect(renames).toEqual({ sibling_settings: "settings" });
    expect(map.places["home"]?.explored?.actions.map((a) => a.to)).toEqual(["settings"]);
  });

  it("a clash gives my place a fresh name, and only my actions follow it", () => {
    const disk = file({ home: place(["home"], [action("id:a", "list")]), list: place(["list"]) });
    const mine = file({ list: place(["other"]), shelf: place(["shelf"], [action("id:b", "list")]) });
    const { map, renames } = mergeMapsWithRenames(disk, mine);
    expect(renames).toEqual({ list: "list_2" });
    expect(map.places["home"]?.explored?.actions.map((a) => a.to)).toEqual(["list"]);
    expect(map.places["shelf"]?.explored?.actions.map((a) => a.to)).toEqual(["list_2"]);
  });

  it("an explicit rename on purpose moves the explored destinations too", () => {
    const disk = file({ home: place(["home"], [action("id:go", "settings")]), settings: place(["settings"]) });
    const merged = mergeMaps(disk, disk, { renamed: { settings: "preferences" } });
    expect(Object.keys(merged.places).sort()).toEqual(["home", "preferences"]);
    expect(merged.places["home"]?.explored?.actions.map((a) => a.to)).toEqual(["preferences"]);
  });
});
