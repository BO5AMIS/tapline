import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ERROR_CODES, looksLikeValue, placeStateSchema, treeResultSchema, type TreeResult } from "../src/protocol.js";
import { AppMap, placeNameFromRoute, routeKey, samePlace, signatureKey } from "../src/places.js";
import { MAP_FORMAT, MAP_VERSION, type MapFile, type PlaceKey } from "../src/mapfile.js";

// AGENT-TOOLS 1.13 §18.1: places. Every test works in a temp folder, never in ~/.tapline.

const APP = { id: "com.example.wayfare", name: "Wayfare", version: "1.4.0", build: "1.4.0 (212)" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-places-"));
  dirs.push(dir);
  return dir;
}

/** A map that never touches the disk: saves go to a list. */
function memoryMap(options: { readOnly?: boolean } = {}): { map: AppMap; saved: MapFile[] } {
  const saved: MapFile[] = [];
  const map = new AppMap(APP, {
    dir: temp(),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    save: async (_dir, file) => {
      saved.push(structuredClone(file));
      return file;
    },
  });
  return { map, saved };
}

function tree(place: TreeResult["place"], elements: TreeResult["elements"] = []): TreeResult {
  return { elements, ...(place !== undefined ? { place } : {}) };
}

const el = (over: Partial<TreeResult["elements"][number]>): TreeResult["elements"][number] => ({ ref: "e1", role: "text", ...over });

describe("naming a place from its route (§18.1)", () => {
  it.each([
    [["(tabs)", "settings", "language"], "language"],
    [["trips", "[id]"], "trips_id"],
    [["trips", "index"], "trips"],
    [["(tabs)", "index"], "index"],
    [["settings", "[...rest]"], "settings_rest"],
    [["(auth)", "Sign In"], "sign_in"],
    [["+not-found"], "not_found"],
    [["(tabs)"], ""],
    [[], ""],
  ])("%j is %j", (route, name) => {
    expect(placeNameFromRoute(route)).toBe(name);
  });

  it("a name that isn't ASCII is left for place_<n>", () => {
    expect(placeNameFromRoute(["(tabs)", "الإعدادات"])).toBe("");
    const { map } = memoryMap();
    const first = map.observe(tree({ route: ["(tabs)", "الإعدادات"] })).place;
    const second = map.observe(tree({ route: ["(tabs)", "اللغة"] })).place;
    expect([first.name, second.name]).toEqual(["place_1", "place_2"]);
  });

  it("a second place with the same name gets _2", () => {
    const { map } = memoryMap();
    const a = map.observe(tree({ route: ["(tabs)", "settings", "language"] })).place;
    const b = map.observe(tree({ route: ["(auth)", "language"] })).place;
    expect([a.name, b.name]).toEqual(["language", "language_2"]);
  });
});

describe("keys", () => {
  it("routeKey ignores params", () => {
    const withParams = { ...tree({ route: ["trips", "[id]"] }), route: { names: ["trips"], params: { id: "42" } } };
    const other = { ...tree({ route: ["trips", "[id]"] }), route: { names: ["trips"], params: { id: "99" } } };
    expect(routeKey(withParams)).toEqual({ route: ["trips", "[id]"] });
    expect(routeKey(withParams)).toEqual(routeKey(other));
    expect(JSON.stringify(routeKey(withParams))).not.toContain("42");
  });

  it("routeKey keeps the tab and the layer, and nothing else", () => {
    expect(routeKey(tree({ route: ["(tabs)", "settings"], tab: "settings", layer: "sheet:Filters" }))).toEqual({
      route: ["(tabs)", "settings"],
      tab: "settings",
      layer: "sheet:Filters",
    });
  });

  it("routeKey is null when the app has no router", () => {
    expect(routeKey(tree({ route: [] }))).toBeNull();
    expect(routeKey(tree(undefined))).toBeNull();
  });

  it("no router falls back to signatureKey and names place_<n>", () => {
    const { map } = memoryMap();
    const seen = map.observe(tree({ route: [] }, [el({ testID: "login-button", role: "button" })]));
    expect(seen.place.name).toBe("place_1");
    expect("signature" in seen.place.key).toBe(true);
    const home = map.observe(tree(undefined, [el({ testID: "home-feed", role: "scroll" })]));
    expect(home.place.name).toBe("place_2");
  });

  it("signature ignores row text and language", () => {
    const english = tree(undefined, [
      el({ ref: "e1", testID: "search", role: "input", text: "Search" }),
      el({ ref: "e2", role: "button", text: "Paris, France", row: true }),
      el({ ref: "e3", role: "button", text: "Rome, Italy", row: true }),
      el({ ref: "e4", testID: "filters", role: "button", label: "Filters" }),
    ]);
    const arabic = tree(undefined, [
      el({ ref: "e1", testID: "search", role: "input", text: "بحث" }),
      el({ ref: "e2", role: "button", text: "باريس", row: true }),
      el({ ref: "e4", testID: "filters", role: "button", label: "عوامل التصفية" }),
    ]);
    expect(signatureKey(english)).toEqual(signatureKey(arabic));
  });

  it("signature changes with the fixed elements and with what lies on top", () => {
    const base = tree(undefined, [el({ testID: "search", role: "input" })]);
    const other = tree(undefined, [el({ testID: "profile-photo", role: "image" })]);
    const alert: TreeResult = {
      ...base,
      alerts: [{ kind: "alert", title: "Sure?", message: null, buttons: [], standIn: false }],
    };
    expect(signatureKey(base)).not.toEqual(signatureKey(other));
    expect(signatureKey(base)).not.toEqual(signatureKey(alert));
  });

  it("a signature never holds text", () => {
    const key = signatureKey(
      tree(undefined, [el({ testID: "search", role: "input", text: "Chat with Sara" }), el({ role: "button", text: "Order #10432", row: true })]),
    );
    expect(JSON.stringify(key)).not.toMatch(/Sara|10432/);
  });

  it("samePlace compares route keys exactly and signature keys by parts", () => {
    const a: PlaceKey = { route: ["a", "b"], tab: "b" };
    expect(samePlace(a, { route: ["a", "b"], tab: "b" })).toBe(true);
    expect(samePlace(a, { route: ["a", "b"] })).toBe(false);
    expect(samePlace(a, { route: ["a", "b"], tab: "b", layer: "alert" })).toBe(false);
    const sig = (signature: string, parts: Record<string, unknown>): PlaceKey => ({ signature, parts });
    const four = { ids: ["a", "b"], containers: ["list"], tab: "home", layer: null };
    expect(samePlace(sig("x", four), sig("x", four))).toBe(true);
    // 3 of 4 parts agree: the default threshold is 0.75.
    expect(samePlace(sig("x", four), sig("y", { ...four, layer: "alert" }))).toBe(true);
    expect(samePlace(sig("x", four), sig("y", { ...four, layer: "alert" }), 0.9)).toBe(false);
    expect(samePlace(sig("x", four), sig("y", { ids: ["z"], containers: ["form"], tab: 2, layer: "alert" }))).toBe(false);
  });

  it("a route key and a signature key are never the same place", () => {
    expect(samePlace({ route: ["a"] }, { signature: "x", parts: {} })).toBe(false);
  });

  it("Expo Router keeps index and React Navigation names it differently: they are different places", () => {
    expect(samePlace({ route: ["(tabs)", "index"] }, { route: ["(tabs)", "Home"] })).toBe(false);
    expect(samePlace({ route: ["(tabs)", "index"] }, { route: ["(tabs)", "index"] })).toBe(true);
  });
});

describe("what the app sends (task 10's wire)", () => {
  it("`stale` is one of the app's error codes: a move's refusal, not a protocol error", () => {
    expect(ERROR_CODES).toContain("stale");
  });

  it("a tree carries `place` and a row's `row` flag", () => {
    const parsed = treeResultSchema.parse({
      elements: [{ ref: "e1", row: true }, { ref: "e2" }],
      place: { route: ["trips", "[id]"], tab: "trips", layer: "sheet:Filters" },
    });
    expect(parsed.place).toEqual({ route: ["trips", "[id]"], tab: "trips", layer: "sheet:Filters" });
    expect(parsed.elements[0]?.row).toBe(true);
  });

  it("a place with params in it keeps none of them", () => {
    const parsed = placeStateSchema.parse({ route: ["trips", "[id]"], params: { id: "42" } });
    expect(JSON.stringify(parsed)).not.toContain("42");
  });
});

describe("values are not names", () => {
  it.each(["12", "20260", "order-10432", "3fa9c1d2-7b0e-44a8-9c01-e7a5d2b84f36", "3fa9c1d27b0e44a8c1", "sheet:12345"])("%s looks like a value", (piece) => {
    expect(looksLikeValue(piece)).toBe(true);
  });
  it.each(["[id]", "settings", "trips", "(tabs)", "sheet:Filters", "tab-2", "abc123"])("%s is a name", (piece) => {
    expect(looksLikeValue(piece)).toBe(false);
  });

  it("a route piece that looks like a value sends the place to the signature", () => {
    expect(routeKey(tree({ route: ["orders", "10432"] }))).toBeNull();
    const { map } = memoryMap();
    const seen = map.observe(tree({ route: ["orders", "10432"] }, [el({ testID: "pay", role: "button" })]));
    expect("signature" in seen.place.key).toBe(true);
    expect(JSON.stringify(map.data())).not.toContain("10432");
  });

  it("a layer or tab that looks like a value is dropped, the place stays", () => {
    expect(routeKey(tree({ route: ["trips"], layer: "sheet:98765", tab: "3fa9c1d27b0e44a8c1" }))).toEqual({ route: ["trips"] });
  });

  it("a signature leaves out ids that look like values", () => {
    const a = signatureKey(tree(undefined, [el({ testID: "search", role: "input" }), el({ testID: "trip-10432", role: "button" })]));
    const b = signatureKey(tree(undefined, [el({ testID: "search", role: "input" }), el({ testID: "trip-99871", role: "button" })]));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("10432");
  });

  it("a tree whose place holds a value still parses, without the place", () => {
    const parsed = treeResultSchema.parse({ elements: [], place: { route: ["orders", "10432"] } });
    expect(parsed.place).toBeUndefined();
  });
});

describe("observing places", () => {
  it("observe says isNew once", () => {
    const { map } = memoryMap();
    const first = map.observe(tree({ route: ["(tabs)", "settings"] }));
    const again = map.observe(tree({ route: ["(tabs)", "settings"] }));
    expect(first.isNew).toBe(true);
    expect(again.isNew).toBe(false);
    expect(again.place.name).toBe(first.place.name);
  });

  it("the Place: line only after the first saved place", () => {
    const { map } = memoryMap();
    expect(map.hasPlaces()).toBe(false);
    // The first sighting saves the place and says nothing: the app had no map yet.
    const first = map.observe(tree({ route: ["(tabs)", "settings"] }));
    expect(first.line).toBeNull();
    expect(map.hasPlaces()).toBe(true);
    expect(map.observe(tree({ route: ["(tabs)", "settings"] })).line).toBe("Place: settings.");
    expect(map.observe(tree({ route: ["(tabs)", "settings", "language"] })).line).toBe("Place: new (call it with map name).");
    expect(map.observe(tree({ route: ["(tabs)", "settings", "language"] })).line).toBe("Place: language.");
  });

  it("places known up front don't count as saved", () => {
    const { map } = memoryMap();
    map.setKnown({ source: "expo-router", places: [{ route: ["(tabs)", "index"], link: "wayfare://", params: [] }] });
    expect(map.hasPlaces()).toBe(false);
  });

  it("the first look of an empty map names nothing from content", () => {
    const { map } = memoryMap();
    const seen = map.observe(tree({ route: ["chat", "[id]"] }, [el({ role: "header", text: "Chat with Sara" })]));
    expect(seen.place.name).toBe("chat_id");
    expect(JSON.stringify(map.data())).not.toContain("Sara");
  });

  it("loads the map from disk and recognises its places", async () => {
    const dir = temp();
    const file: MapFile = {
      format: MAP_FORMAT,
      version: MAP_VERSION,
      app: APP.id,
      places: { language: { key: { route: ["(tabs)", "settings", "language"] }, link: null, last: "2026-11-12T18:20:00Z" } },
      roads: [],
      routes: {},
      reflexes: [],
    };
    const { saveMap } = await import("../src/mapfile.js");
    await saveMap(dir, file);
    const map = new AppMap(APP, { dir });
    const seen = map.observe(tree({ route: ["(tabs)", "settings", "language"] }));
    expect(seen.isNew).toBe(false);
    expect(seen.place.name).toBe("language");
    expect(seen.line).toBe("Place: language.");
  });
});
