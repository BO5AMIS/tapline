import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Confirmations } from "../src/confirm.js";
import { loadMap } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { FakeApp, delay, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.1 to §18.3: the Place: line and the roads an agent's own calls leave behind.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const frame = { x: 20, y: 100, width: 300, height: 44 };

const LANGUAGE = { ref: "e1", type: "Pressable", role: "button", testID: "language-row", label: "Language", text: "Language", frame, actions: ["press"] };
const DELETE = { ref: "e2", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame, actions: ["press"] };
const SEARCH = { ref: "e3", type: "TextInput", role: "input", testID: "search", frame, actions: ["type"] };
const NOTE = { ref: "e4", type: "Text", role: "text", text: "Hello", frame, actions: [] };
const ROW = { ref: "e5", type: "Pressable", role: "button", text: "Paris, France", row: true, frame, actions: ["press"] };

type Screen = "settings" | "language" | "trips" | "invite";
const ROUTES: Record<Screen, string[]> = {
  settings: ["(tabs)", "settings"],
  language: ["(tabs)", "settings", "language"],
  trips: ["trips", "[id]"],
  invite: ["invite"],
};
const ELEMENTS: Record<Screen, unknown[]> = {
  settings: [LANGUAGE, DELETE, SEARCH, NOTE, ROW],
  language: [{ ...NOTE, ref: "e6", text: "English" }],
  trips: [{ ...NOTE, ref: "e7", text: "Trip to Paris" }],
  invite: [{ ...NOTE, ref: "e8", text: "Join" }],
};
const KNOWN = {
  source: "expo-router",
  places: [
    { route: ["(tabs)", "settings"], link: "wayfare://settings", params: [] },
    { route: ["trips", "[id]"], link: "wayfare://trips/[id]", params: ["id"] },
  ],
};

async function setup(options: { maps?: boolean; capabilities?: string[]; tools?: Partial<ToolsOptions> } = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const mapsDir = mkdtempSync(join(tmpdir(), "tapline-place-tools-"));
  dirs.push(mapsDir);
  const state = { screen: "settings" as Screen, reportedFor: "" };
  const handler = (req: IncomingRequest): Reply => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "tree": {
        const changed = state.reportedFor !== state.screen;
        if (params["peek"] !== true) state.reportedFor = state.screen;
        return {
          ok: true,
          result: {
            screen: { width: 430, height: 932 },
            elements: ELEMENTS[state.screen],
            route: { names: ROUTES[state.screen] },
            place: { route: ROUTES[state.screen] },
            ...(params["changes"] === true
              ? { changes: { sameRoute: !changed, added: [], removed: [], changed: [], moved: [] } }
              : {}),
          },
        };
      }
      case "place":
        return { ok: true, result: { route: ROUTES[state.screen], seenAt: Date.now() } };
      case "places":
        return { ok: true, result: KNOWN };
      case "press": {
        const target = params["target"] as { testID?: string; ref?: string; text?: string } | undefined;
        const testID = target?.testID ?? (target?.ref === "e1" ? "language-row" : undefined);
        if (testID === "language-row" || target?.text === "Paris") state.screen = "language";
        if (testID === "delete-trip") state.screen = "trips";
        const element = testID === "delete-trip" ? DELETE : target?.text === "Paris" ? ROW : LANGUAGE;
        return { ok: true, result: { element, settledMs: 100 } };
      }
      case "back":
        state.screen = "settings";
        return { ok: true, result: { settledMs: 100 } };
      case "type":
        return { ok: true, result: { element: SEARCH, settledMs: 50 } };
      case "openURL": {
        const url = String(params["url"]);
        state.screen = url.includes("trips") ? "trips" : "invite";
        return { ok: true, result: { settledMs: 100 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const caps = options.capabilities ?? ["tree", "press", "longPress", "logs", "dryRun", "place", "places"];
  const { app } = await FakeApp.connect(port, { capabilities: caps }, handler);
  apps.push(app);
  const registry = new MapRegistry({ mapsDir });
  const confirmations = new Confirmations();
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    confirmations,
    ...(options.maps === false ? {} : { maps: registry }),
    ...options.tools,
  });
  const mapOf = () => registry.forApp({ id: "com.example.demo", name: "Demo", version: "1.0.0", build: "1" });
  const file = () => {
    return loadMap(join(mapsDir, "com.example.demo"), "com.example.demo").map;
  };
  return { host, app, tools, state, registry, confirmations, mapOf, file, mapsDir };
}

describe("the Place: line", () => {
  it("is not there for the first screen of an app with no map, then says new, then the name", async () => {
    const { tools } = await setup();
    const first = textOf(await tools.look({ screenshot: false }));
    expect(first).not.toContain("Place:");
    const tapped = textOf(await tools.tap({ target: { id: "language-row" } }));
    const lines = tapped.split("\n");
    expect(lines[0]).toBe('Tapped e1 button "Language" id=language-row.');
    expect(lines[1]).toBe("Place: new (call it with map name).");
    const again = textOf(await tools.look({ screenshot: false }));
    expect(again).toContain("Place: language.");
  });

  it("goes in the header of look, after the route", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" } });
    const header = textOf(await tools.look({ screenshot: false })).split("\n");
    const at = header.findIndex((line) => line.startsWith("Place: "));
    expect(header[at - 1]).toMatch(/^Route: /);
  });

  it("goes after the first line of an answer that arrives at a known place", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" } });
    const back = textOf(await tools.back({}));
    expect(back.split("\n")[1]).toBe("Place: settings.");
  });

  it("is in a brief answer, right after its first line", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" } });
    const back = textOf(await tools.back({ brief: true }));
    expect(back.split("\n").slice(0, 2)).toEqual(["Went back.", "Place: settings."]);
  });

  it("is not on a same-screen answer", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" } });
    await tools.back({});
    const same = textOf(await tools.tap({ target: { id: "search" } }));
    expect(same).toMatch(/Same screen|No visible change/);
    expect(same).not.toContain("Place:");
  });

  it("is not there without a map", async () => {
    const { tools } = await setup({ maps: false });
    await tools.look({ screenshot: false });
    expect(textOf(await tools.tap({ target: { id: "language-row" } }))).not.toContain("Place:");
  });
});

describe("roads from an agent's own calls", () => {
  it("a tap that leaves one place for another is saved, and the file is written", async () => {
    const { tools, mapOf, registry, file } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" } });
    expect(mapOf()?.data().roads).toHaveLength(1);
    await registry.flushAll();
    const saved = file();
    expect(saved.roads).toHaveLength(1);
    expect(saved.roads[0]).toMatchObject({
      from: "settings",
      to: "language",
      move: { tool: "tap", target: { id: "language-row" } },
      names: { id: "language-row", label: "Language", text: "Language" },
      by: "tapline",
    });
    expect(Object.keys(saved.places).sort()).toEqual(["language", "settings"]);
  });

  it("a ref target is saved by name, never as a ref", async () => {
    const { tools, mapOf } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { ref: "e1" } });
    expect(JSON.stringify(mapOf()?.data().roads)).not.toContain('"ref"');
    expect(mapOf()?.data().roads[0]?.move.target).toEqual({ id: "language-row" });
  });

  it("back is a road too", async () => {
    const { tools, mapOf } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" } });
    await tools.back({});
    expect(mapOf()?.data().roads.map((road) => `${road.from}>${road.to}:${road.move.tool}`)).toEqual(["settings>language:tap", "language>settings:back"]);
  });

  it("a tap with look: false knows the place from the app's place request", async () => {
    const { tools, mapOf, app } = await setup();
    await tools.look({ screenshot: false });
    const answer = textOf(await tools.tap({ target: { id: "language-row" }, look: false }));
    expect(answer).toBe('Tapped e1 button "Language" id=language-row.');
    expect(mapOf()?.data().roads).toHaveLength(1);
    expect(app.requests.map((r) => r.method)).toContain("place");
  });

  it("a read saves nothing", async () => {
    const { tools, mapOf } = await setup();
    await tools.look({ screenshot: false });
    await tools.scroll({ direction: "down" });
    expect(mapOf()?.data().roads).toEqual([]);
  });

  it("typing at a place stops the moves that leave it from being saved", async () => {
    const { tools, mapOf } = await setup();
    await tools.look({ screenshot: false });
    await tools.typeText({ target: { id: "search" }, text: "paris" });
    await tools.tap({ target: { id: "language-row" } });
    expect(mapOf()?.data().roads).toEqual([]);
    expect(JSON.stringify(mapOf()?.data())).not.toContain("paris");
  });

  it("a row without an id is saved as {\"row\": true}", async () => {
    const { tools, mapOf, registry, file } = await setup();
    await tools.look({ screenshot: false });
    const answer = await tools.tap({ target: { text: "Paris" }, look: false });
    expect(answer.isError).not.toBe(true);
    expect(mapOf()?.data().roads[0]?.move).toEqual({ tool: "tap", target: { row: true } });
    await registry.flushAll();
    // The row's text is content: it is nowhere in the file.
    expect(JSON.stringify(file())).not.toMatch(/Paris|France/);
  });

  it("a move that needed a person's OK is not saved, and the answer says so", async () => {
    const { tools, confirmations, mapOf } = await setup();
    const events: Array<{ type: string; id?: string }> = [];
    confirmations.onEvent((event) => events.push(event));
    await tools.look({ screenshot: false });
    const refused = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(refused.isError).toBe(true);
    const asked = events.find((event) => event.type === "confirm");
    if (asked?.id === undefined) throw new Error("no prompt");
    confirmations.answer(asked.id, true);
    const allowed = textOf(await tools.tap({ target: { id: "delete-trip" }, look: false }));
    expect(allowed).toContain("Note: allowed by a person");
    expect(allowed).toContain("Note: not saved as a road (it needed a person's OK).");
    expect(mapOf()?.data().roads).toEqual([]);
  });

  it("a replay never writes the map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-scripts-"));
    dirs.push(dir);
    const { tools, mapOf, state } = await setup({ tools: { scriptsDir: dir } });
    await tools.look({ screenshot: false });
    await tools.record({ start: true, name: "go" });
    await tools.tap({ target: { id: "language-row" }, look: false });
    await tools.record({ stop: true });
    expect(mapOf()?.data().roads[0]?.seen).toBe(1);
    // The fake app can't reload, so the script starts on the screen as it is.
    const path = join(dir, "go.json");
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), fresh: false }));
    state.screen = "settings";
    await tools.replay({ name: "go" });
    expect(state.screen).toBe("language");
    // The replay tapped again and landed on the language screen: the map is as the recording left it.
    expect(mapOf()?.data().roads).toHaveLength(1);
    expect(mapOf()?.data().roads[0]?.seen).toBe(1);
  });
});

describe("links from open_url (§18.3)", () => {
  it("a place reached by open_url keeps the link as a pattern, never the real id", async () => {
    const { tools, mapOf, registry, file } = await setup();
    await tools.look({ screenshot: false });
    const answer = textOf(await tools.openUrl({ url: "wayfare://trips/42?token=abc123", look: false }));
    expect(answer).not.toContain("Link not saved");
    expect(mapOf()?.data().places["trips_id"]?.link).toBe("wayfare://trips/[id]");
    expect(mapOf()?.data().roads[0]).toMatchObject({ from: "settings", to: "trips_id", move: { tool: "open_url", url: "wayfare://trips/[id]" } });
    await registry.flushAll();
    const text = readFileSync(join(registry["options"].mapsDir as string, "com.example.demo", "map.json"), "utf8");
    expect(text).not.toMatch(/42|abc123/);
    expect(file().places["trips_id"]?.link).toBe("wayfare://trips/[id]");
  });

  it("a url that matches no pattern is not saved, and the answer says so", async () => {
    const { tools, mapOf } = await setup();
    await tools.look({ screenshot: false });
    const answer = textOf(await tools.openUrl({ url: "wayfare://invite/9f8e7d6c5b", look: false }));
    expect(answer).toContain("Link not saved: it may hold a value; add it with map link.");
    expect(JSON.stringify(mapOf()?.data())).not.toContain("9f8e7d6c5b");
    expect(mapOf()?.data().roads).toEqual([]);
  });
});

describe("the map's wiring", () => {
  it("an app that has no place capability gets its places from a tree read", async () => {
    const { tools, mapOf, app } = await setup({ capabilities: ["tree", "press", "dryRun"] });
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "language-row" }, look: false });
    expect(app.requests.map((r) => r.method)).not.toContain("place");
    expect(mapOf()?.data().roads).toHaveLength(1);
  });

  it("a map that can't be written never fails the call", async () => {
    const { tools, mapsDir } = await setup();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(mapsDir, "com.example.demo"), { recursive: true });
    writeFileSync(join(mapsDir, "com.example.demo", "map.json"), "{ not json");
    await tools.look({ screenshot: false });
    const answer = await tools.tap({ target: { id: "language-row" } });
    expect(answer.isError).not.toBe(true);
    await delay(20);
  });
});
