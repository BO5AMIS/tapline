import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_FORMAT, MAP_VERSION, loadMap, type MapFile, type Move } from "../src/mapfile.js";
import { z } from "zod";
import { AppMap, classifyMove, type MoveCall, type Place } from "../src/places.js";
import { stepSchema, type RunTool } from "../src/run.js";
import { toolShapes } from "../src/tools.js";

// AGENT-TOOLS 1.13 §18.2 and §18.3: roads and links. Every test works in a temp folder, never in ~/.tapline.

const APP = { id: "com.example.wayfare", name: "Wayfare", version: "1.4.0", build: "1.4.0 (212)" };
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-roads-"));
  dirs.push(dir);
  return dir;
}

type Save = (dir: string, file: MapFile, options?: { removed?: unknown; readOnly?: boolean }) => Promise<MapFile>;

function memoryMap(over: { app?: typeof APP; readOnly?: boolean; save?: Save } = {}): { map: AppMap; saved: MapFile[]; removed: unknown[] } {
  const saved: MapFile[] = [];
  const removed: unknown[] = [];
  const map = new AppMap(over.app ?? APP, {
    dir: temp(),
    ...(over.readOnly === true ? { readOnly: true } : {}),
    save:
      over.save ??
      (async (_dir, file, options) => {
        saved.push(structuredClone(file));
        removed.push(options?.removed);
        return file;
      }),
  });
  return { map, saved, removed };
}

const at = (map: AppMap, route: string[], layer?: string): Place =>
  map.observe({ elements: [], place: { route, ...(layer !== undefined ? { layer } : {}) } }).place;

const TAP_LANGUAGE: Move = { tool: "tap", target: { id: "language-row" } };
const NAMES = { id: "language-row", label: "Language", text: "Language" };

function seedTwo(map: AppMap): { settings: Place; language: Place } {
  const settings = at(map, ["(tabs)", "settings"]);
  const language = at(map, ["(tabs)", "settings", "language"]);
  return { settings, language };
}

describe("which moves are saved as roads", () => {
  const press = (over: Partial<MoveCall> = {}): MoveCall => ({
    method: "press",
    params: { target: { testID: "language-row" } },
    result: { element: { ref: "e3", role: "button", testID: "language-row", label: "Language", text: "Language" } },
    by: "agent",
    neededOk: false,
    replaying: false,
    ...over,
  });

  it.each([
    ["press", "tap"],
    ["longPress", "long_press"],
    ["toggle", "toggle"],
  ])("%s is saved as %s", (method, tool) => {
    const saved = classifyMove(press({ method }));
    expect(saved).toMatchObject({ move: { tool, target: { id: "language-row" } }, names: NAMES });
  });

  it("back, open_url and swipe are moves", () => {
    expect(classifyMove({ method: "back", params: {}, result: {}, by: "agent", neededOk: false, replaying: false })).toMatchObject({ move: { tool: "back" } });
    expect(classifyMove({ method: "openURL", params: { url: "wayfare://settings" }, result: {}, by: "agent", neededOk: false, replaying: false })).toMatchObject({
      move: { tool: "open_url" },
    });
    expect(classifyMove({ method: "swipe", params: { x0: 10, y0: 600, x1: 10, y1: 100, seconds: 0.3 }, result: {}, by: "agent", neededOk: false, replaying: false })).toMatchObject({
      move: { tool: "swipe", x0: 10, y0: 600, x1: 10, y1: 100, seconds: 0.3 },
    });
  });

  it("a swipe missing a coordinate is no road", () => {
    expect(classifyMove({ method: "swipe", params: { x0: 10, y0: 600, x1: 10 }, result: {}, by: "agent", neededOk: false, replaying: false })).toEqual({ skip: "unnamed" });
  });

  it.each([
    ["a read (scroll)", press({ method: "scroll" }), "read"],
    ["a read (tree)", press({ method: "tree" }), "read"],
    ["a person's input", press({ by: "person" }), "person"],
    ["a dry run", press({ params: { target: { testID: "x" }, dryRun: true } }), "dry_run"],
    ["a move that needed a person's OK", press({ neededOk: true }), "needed_ok"],
    ["typing", press({ method: "type" }), "typed"],
    ["anything a replay does", press({ replaying: true }), "replay"],
  ])("not saved: %s", (_name, call, reason) => {
    expect(classifyMove(call)).toEqual({ skip: reason });
  });

  it("a target is saved by id, else label, else text, never by ref", () => {
    const byLabel = classifyMove(press({ result: { element: { ref: "e3", role: "button", label: "Language", text: "Choose" } } }));
    expect(byLabel).toMatchObject({ move: { target: { label: "Language" } } });
    const byText = classifyMove(press({ result: { element: { ref: "e3", role: "button", text: "Choose" } } }));
    expect(byText).toMatchObject({ move: { target: { text: "Choose" } } });
    const byRef = classifyMove(press({ params: { target: { ref: "e3" } } }));
    expect(JSON.stringify(byRef)).not.toContain('"ref"');
    expect(byRef).toMatchObject({ move: { target: { id: "language-row" } } });
  });

  it("a point is kept only for something with no element", () => {
    const point = classifyMove(press({ params: { target: { x: 10, y: 20 } }, result: {} }));
    expect(point).toMatchObject({ move: { tool: "tap", target: { x: 10, y: 20 } } });
    const noOther = classifyMove(press({ params: { target: { x: 10, y: 20 } } }));
    expect(JSON.stringify(noOther)).not.toContain('"x"');
  });

  it("a row with an id is saved by its id only", () => {
    const saved = classifyMove(press({ result: { element: { ref: "e3", role: "button", testID: "trip-row", text: "Paris, France", row: true } } }));
    expect(saved).toEqual({ move: { tool: "tap", target: { id: "trip-row" } }, names: { id: "trip-row" } });
  });

  it("a row without an id is saved as {\"row\": true}", () => {
    const saved = classifyMove(press({ result: { element: { ref: "e3", role: "button", text: "Paris, France", row: true } }, params: { target: { text: "Paris" } } }));
    expect(saved).toEqual({ move: { tool: "tap", target: { row: true } }, names: {} });
  });

  it("names never hold row text", () => {
    const saved = classifyMove(press({ result: { element: { ref: "e3", role: "button", label: "Order #10432", text: "Order #10432", testID: "order-row", row: true } } }));
    expect(JSON.stringify(saved)).not.toContain("10432");
  });

  it("a long name is cut", () => {
    const saved = classifyMove(press({ result: { element: { ref: "e3", role: "button", text: "x".repeat(500) } }, params: { target: { text: "x" } } }));
    if (!("move" in saved)) throw new Error("expected a move");
    expect((saved.move.target?.text ?? "").length).toBeLessThanOrEqual(80);
  });
});

describe("saving a road", () => {
  it("saves a move that left one place and arrived at another", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    const verdict = map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 840);
    expect(verdict.saved).toBe(true);
    if (!verdict.saved) return;
    expect(verdict.road).toMatchObject({
      from: "settings",
      to: "language",
      move: TAP_LANGUAGE,
      names: NAMES,
      by: "tapline",
      seen: 1,
      failed: 0,
      ms: 840,
      build: "1.4.0 (212)",
    });
    expect(map.data().roads).toHaveLength(1);
  });

  it("the same move again counts as seen, not as a second road", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 840);
    const again = map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 600);
    expect(map.data().roads).toHaveLength(1);
    expect(again.saved && again.road.seen).toBe(2);
  });

  it("a move that stays at one place is not a road", () => {
    const { map } = memoryMap();
    const { settings } = seedTwo(map);
    expect(map.recordMove(settings, TAP_LANGUAGE, NAMES, settings, 100)).toEqual({ saved: false, reason: "same_place" });
  });

  it("a move from nowhere is not a road", () => {
    const { map } = memoryMap();
    const { language } = seedTwo(map);
    expect(map.recordMove(null, TAP_LANGUAGE, NAMES, language, 100)).toEqual({ saved: false, reason: "unknown_start" });
  });

  it.each(["read", "person", "dry_run", "needed_ok", "typed", "replay"] as const)("a %s is not saved", (reason) => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    expect(map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100, reason)).toEqual({ saved: false, reason });
    expect(map.data().roads).toHaveLength(0);
  });

  it("typing at a place stops the moves that leave it from being saved", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    map.observe({ elements: [], place: { route: ["(tabs)", "settings"] } });
    map.noteTyped();
    expect(map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100)).toEqual({ saved: false, reason: "typed" });
    // Another place where nothing was typed is not marked.
    map.observe({ elements: [], place: { route: ["(tabs)", "settings", "language"] } });
    expect(map.recordMove(language, { tool: "back" }, {}, settings, 100).saved).toBe(true);
  });

  it("a place where text was typed stays marked after the app leaves and comes back", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    map.useSession("s1");
    map.observe({ elements: [], place: { route: ["(tabs)", "settings"] } });
    map.noteTyped();
    map.observe({ elements: [], place: { route: ["(tabs)", "settings", "language"] } });
    map.observe({ elements: [], place: { route: ["(tabs)", "settings"] } });
    expect(map.typedHere()).toBe(true);
    expect(map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100)).toEqual({ saved: false, reason: "typed" });
    // Until the app reconnects.
    map.useSession("s1");
    expect(map.typedHere()).toBe(true);
    map.useSession("s2");
    expect(map.typedHere()).toBe(false);
    expect(map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100).saved).toBe(true);
  });

  it("every saved road's move parses as a step of run (1.13.1 item 14)", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    const moves: Move[] = [
      { tool: "tap", target: { id: "a" } },
      { tool: "long_press", target: { label: "Language" } },
      { tool: "toggle", target: { text: "Dark mode" } },
      { tool: "tap", target: { x: 10, y: 20 } },
      { tool: "back" },
      { tool: "open_url", url: "wayfare://trips/[id]" },
      { tool: "swipe", x0: 1, y0: 2, x1: 3, y1: 4, seconds: 0.3 },
    ];
    for (const move of moves) map.recordMove(settings, move, {}, language, 10);
    expect(map.data().roads).toHaveLength(moves.length);
    for (const { move } of map.data().roads) {
      const step = stepSchema.safeParse(move);
      expect(step.success, JSON.stringify(move)).toBe(true);
      const { tool, ...rest } = move;
      expect(z.object(toolShapes[tool as RunTool]).strict().safeParse(rest).success, JSON.stringify(move)).toBe(true);
      expect(JSON.stringify(move)).not.toContain('"ref"');
    }
  });

  it("replay never writes: a read-only map saves no road and no file", async () => {
    const { map, saved } = memoryMap({ readOnly: true });
    const { settings, language } = seedTwo(map);
    expect(map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100)).toEqual({ saved: false, reason: "replay" });
    await map.flush();
    expect(saved).toHaveLength(0);
  });

  it("a road is unproven after a new build and proven after one clean drive", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    const verdict = map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100);
    if (!verdict.saved) throw new Error("expected a saved road");
    expect(map.isProven(verdict.road)).toBe(true);
    const next = memoryMap({ app: { ...APP, version: "1.5.0", build: "1.5.0 (220)" } }).map;
    expect(next.currentBuild()).toBe("1.5.0 (220)");
    expect(next.isProven({ ...verdict.road })).toBe(false);
  });

  it("markDriven makes an unproven road proven for the current build", () => {
    const { map } = memoryMap({ app: { ...APP, version: "1.5.0", build: "1.5.0 (220)" } });
    const { settings, language } = seedTwo(map);
    const old = map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100);
    if (!old.saved) throw new Error("expected a saved road");
    old.road.build = "1.4.0 (212)";
    expect(map.isProven(old.road)).toBe(false);
    map.markDriven(old.road, 700);
    expect(map.isProven(old.road)).toBe(true);
    expect(old.road.seen).toBe(2);
  });

  it("a JavaScript reload is not a new build", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    const verdict = map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100);
    if (!verdict.saved) throw new Error("expected a saved road");
    // The app reconnects after a reload with the same hello: the build text is the same.
    expect(map.currentBuild()).toBe("1.4.0 (212)");
    expect(map.isProven(verdict.road)).toBe(true);
  });

  it("builds that come as a version and a number are joined", () => {
    expect(memoryMap({ app: { ...APP, version: "1.2.0", build: "45" } }).map.currentBuild()).toBe("1.2.0 (45)");
    expect(memoryMap({ app: { id: APP.id, name: "Wayfare", version: "1.2.0" } as typeof APP }).map.currentBuild()).toBe("1.2.0");
  });

  it("a road that fails twice in a row is dropped", () => {
    const { map } = memoryMap();
    const { settings, language } = seedTwo(map);
    const verdict = map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100);
    if (!verdict.saved) throw new Error("expected a saved road");
    expect(map.markFailed(verdict.road)).toBe("kept");
    expect(map.data().roads).toHaveLength(1);
    expect(map.markFailed(verdict.road)).toBe("dropped");
    expect(map.data().roads).toHaveLength(0);
  });
});

describe("links (§18.3)", () => {
  const known = {
    source: "expo-router" as const,
    places: [
      { route: ["(tabs)", "index"], link: "wayfare://", params: [] },
      { route: ["settings"], link: "wayfare://settings", params: [] },
      { route: ["trips", "[id]"], link: "wayfare://trips/[id]", params: ["id"] },
      { route: ["trips", "new"], link: "wayfare://trips/new", params: [] },
      { route: ["docs", "[...rest]"], link: "wayfare://docs/[...rest]", params: ["rest"] },
    ],
  };

  function withKnown(): { map: AppMap; place: Place } {
    const { map } = memoryMap();
    map.setKnown(known);
    return { map, place: at(map, ["trips", "[id]"]) };
  }

  it("a param becomes its variable", () => {
    const { map, place } = withKnown();
    expect(map.rememberLink("wayfare://trips/42", place)).toEqual({ saved: true, link: "wayfare://trips/[id]" });
    expect(map.data().places["trips_id"]?.link).toBe("wayfare://trips/[id]");
  });

  it("a query and a fragment are dropped", () => {
    const { map, place } = withKnown();
    expect(map.rememberLink("wayfare://trips/42?token=abc123#top", place)).toEqual({ saved: true, link: "wayfare://trips/[id]" });
    expect(JSON.stringify(map.data())).not.toContain("abc123");
  });

  it("fixed text is kept where the pattern has fixed text", () => {
    const { map } = memoryMap();
    map.setKnown(known);
    const place = at(map, ["settings"]);
    expect(map.rememberLink("wayfare://settings", place)).toEqual({ saved: true, link: "wayfare://settings" });
    expect(map.rememberLink("wayfare://", at(map, ["(tabs)", "index"]))).toEqual({ saved: true, link: "wayfare://" });
  });

  it("a fixed pattern beats a param pattern", () => {
    const { map, place } = withKnown();
    expect(map.rememberLink("wayfare://trips/new", place)).toEqual({ saved: true, link: "wayfare://trips/new" });
  });

  it("a catch-all takes the rest", () => {
    const { map } = memoryMap();
    map.setKnown(known);
    const place = at(map, ["docs", "[...rest]"]);
    expect(map.rememberLink("wayfare://docs/a/b/secret", place)).toEqual({ saved: true, link: "wayfare://docs/[...rest]" });
  });

  it("an unmatched path is not saved, with the exact message", () => {
    const { map, place } = withKnown();
    expect(map.rememberLink("wayfare://invite/9f8e7d6c5b", place)).toEqual({
      saved: false,
      message: "Link not saved: it may hold a value; add it with map link.",
    });
    expect(map.data().places["trips_id"]?.link).toBeNull();
    expect(JSON.stringify(map.data())).not.toContain("9f8e7d6c5b");
  });

  it("another scheme or a longer path is not saved", () => {
    const { map, place } = withKnown();
    expect(map.rememberLink("other://trips/42", place).saved).toBe(false);
    expect(map.rememberLink("wayfare://trips/42/extra", place).saved).toBe(false);
  });

  it("without a route tree nothing is saved", () => {
    const { map } = memoryMap();
    const place = at(map, ["settings"]);
    expect(map.rememberLink("wayfare://settings", place).saved).toBe(false);
  });

  it("a link added by hand is not overwritten", () => {
    const { map, place } = withKnown();
    map.setLink(place.name, "wayfare://trips/[id]?tab=1");
    map.rememberLink("wayfare://trips/42", place);
    expect(map.data().places["trips_id"]?.link).toBe("wayfare://trips/[id]?tab=1");
  });

  it("a road made by open_url holds the saved link, never the real url", () => {
    const { map, place } = withKnown();
    const from = at(map, ["settings"]);
    const saved = map.rememberLink("wayfare://trips/42", place);
    if (!saved.saved) throw new Error("expected a link");
    const verdict = map.recordMove(from, { tool: "open_url", url: saved.link }, {}, place, 300);
    expect(verdict.saved).toBe(true);
    // Roads carry ISO timestamps that can contain "42" by chance: look at everything but those.
    expect(JSON.stringify(map.data().roads).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")).not.toContain("42");
  });
});

describe("writing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  });

  it("flush writes at most once per second, and on close", async () => {
    const saved: MapFile[] = [];
    const { map } = memoryMap({
      save: async (_dir, file) => {
        saved.push(structuredClone(file));
        return file;
      },
    });
    const { settings, language } = seedTwo(map);
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toHaveLength(1);
    // Many changes inside the second: no new write yet.
    for (let i = 0; i < 5; i++) map.recordMove(settings, { tool: "tap", target: { id: `row-${i}` } }, {}, language, 10);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(2);
    expect(saved[1]?.roads).toHaveLength(5);
    // Nothing changed: nothing is written.
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved).toHaveLength(2);
    // A change and a close: written at once.
    map.recordMove(settings, { tool: "tap", target: { id: "row-9" } }, {}, language, 10);
    await map.flush();
    expect(saved).toHaveLength(3);
  });

  it("writes the real file, and a later map reads it", async () => {
    vi.useRealTimers();
    const dir = temp();
    const map = new AppMap(APP, { dir });
    const { settings, language } = seedTwo(map);
    map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 840);
    await map.flush();
    const file = loadMap(dir, APP.id);
    expect(file.status).toBe("ok");
    expect(Object.keys(file.map.places).sort()).toEqual(["language", "settings"]);
    expect(file.map.roads).toHaveLength(1);
    expect(file.map.roads[0]).toMatchObject({ by: "tapline", build: "1.4.0 (212)" });
  });

  it("the file never holds what a screen showed", async () => {
    vi.useRealTimers();
    const dir = temp();
    const map = new AppMap(APP, { dir });
    map.observe({
      elements: [{ ref: "e1", role: "header", text: "Chat with Sara" }, { ref: "e2", role: "text", text: "Order #10432" }],
      place: { route: ["chat", "[id]"] },
    });
    await map.flush();
    const text = JSON.stringify(loadMap(dir, APP.id).map);
    expect(text).not.toMatch(/Sara|10432/);
  });

  it("adopts the merged file the save returns", async () => {
    vi.useRealTimers();
    const { map } = memoryMap({
      save: async (_dir, file) => {
        const merged = structuredClone(file);
        merged.places["from_other_tool"] = { key: { signature: "ab", parts: {} }, link: null, last: "2026-11-13T09:00:00Z" };
        return merged;
      },
    });
    at(map, ["settings"]);
    await map.flush();
    expect(Object.keys(map.data().places).sort()).toEqual(["from_other_tool", "settings"]);
  });

  it("a removal waits in a pending set until a save succeeds", async () => {
    vi.useRealTimers();
    let fail = true;
    const removed: unknown[] = [];
    const { map } = memoryMap({
      save: async (_dir, file, options) => {
        removed.push(structuredClone(options?.removed));
        if (fail) throw new Error("the map file is locked");
        return file;
      },
    });
    seedTwo(map);
    map.removePlace("language");
    expect(map.data().places["language"]).toBeUndefined();
    await map.flush();
    // The save failed: the removal is still pending and goes again.
    fail = false;
    await map.flush();
    expect(removed).toHaveLength(2);
    expect(removed[0]).toMatchObject({ places: [{ name: "language" }] });
    expect(removed[1]).toMatchObject({ places: [{ name: "language" }] });
    // It succeeded: the third flush has nothing to say.
    map.observe({ elements: [], place: { route: ["x"] } });
    await map.flush();
    expect(removed[2]).toBeUndefined();
  });

  it("a rename is sent as a rename and the road names follow", async () => {
    vi.useRealTimers();
    const removed: unknown[] = [];
    const { map } = memoryMap({
      save: async (_dir, file, options) => {
        removed.push(structuredClone(options?.removed));
        return file;
      },
    });
    const { settings, language } = seedTwo(map);
    map.recordMove(settings, TAP_LANGUAGE, NAMES, language, 100);
    expect(map.renamePlace("language", "lang")).toBe(true);
    expect(map.data().roads[0]?.to).toBe("lang");
    await map.flush();
    expect(removed.at(-1)).toMatchObject({ renamed: { language: "lang" } });
  });

  it("an unreadable file is left alone and driving goes on", async () => {
    vi.useRealTimers();
    const dir = temp();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "map.json"), "{ not json");
    const map = new AppMap(APP, { dir });
    expect(map.status()).toBe("unreadable");
    at(map, ["settings"]);
    await map.flush();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "map.json"), "utf8")).toBe("{ not json");
    expect(map.lastError()).toMatch(/unreadable/);
    expect(map.hasPlaces()).toBe(true);
  });
});
