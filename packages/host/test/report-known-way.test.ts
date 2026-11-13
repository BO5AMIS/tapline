import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionLogEntry } from "../src/actionlog.js";
import { analyze, buildCalls, formatReport } from "../src/report.js";
import { MapRegistry } from "../src/places.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §16.1: the waste flag for calls made one by one along a way the map knows.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const START = Date.parse("2026-11-12T10:00:00.000Z");

function at(call: number, tool: string, atMs: number, extra: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return { t: new Date(START + atMs).toISOString(), source: "tapline", by: "agent", tool, ok: true, session: "s1", call, v: 2, ms: 100, ...extra };
}
const way = (from: string, to: string, known = true): Partial<ActionLogEntry> => ({ way: { from, to, known } });
const flags = (entries: ActionLogEntry[]): string[] =>
  formatReport(analyze(buildCalls(entries)))
    .split("\n")
    .filter((l) => l.startsWith("- ") && l.includes("a way the map knows"));

describe("the known-way flag", () => {
  it("names 3 taps in a row along a way the map knows, with the call that replaces them", () => {
    const entries = [at(1, "tap", 0, way("settings", "general")), at(2, "tap", 1000, way("general", "language")), at(3, "tap", 2000, way("language", "trips"))];
    expect(flags(entries)).toEqual(['- 3 calls in a row on a way the map knows (calls 1–3): drive {"to": "trips"} is one call']);
  });

  it("two are not enough, and a break in the chain starts over", () => {
    expect(flags([at(1, "tap", 0, way("a", "b")), at(2, "tap", 1000, way("b", "c"))])).toEqual([]);
    const broken = [at(1, "tap", 0, way("a", "b")), at(2, "tap", 1000, way("b", "c")), at(3, "tap", 2000, way("x", "y")), at(4, "tap", 3000, way("y", "z"))];
    expect(flags(broken)).toEqual([]);
  });

  it("a road the map didn't know breaks the way", () => {
    const entries = [at(1, "tap", 0, way("a", "b")), at(2, "tap", 1000, way("b", "c", false)), at(3, "tap", 2000, way("c", "d"))];
    expect(flags(entries)).toEqual([]);
  });

  it("looks between taps don't break it, and the count is every call in the stretch", () => {
    const entries = [
      at(1, "tap", 0, way("a", "b")),
      at(2, "look", 1000, { kind: "read" }),
      at(3, "tap", 2000, way("b", "c")),
      at(4, "look", 3000, { kind: "read" }),
      at(5, "tap", 4000, way("c", "d")),
    ];
    expect(flags(entries)).toEqual(['- 5 calls in a row on a way the map knows (calls 1–5): drive {"to": "d"} is one call']);
  });

  it("another action or a drive ends the stretch", () => {
    const typed = [at(1, "tap", 0, way("a", "b")), at(2, "tap", 1000, way("b", "c")), at(3, "type_text", 2000), at(4, "tap", 3000, way("c", "d"))];
    expect(flags(typed)).toEqual([]);
    const drove = [at(1, "tap", 0, way("a", "b")), at(2, "tap", 1000, way("b", "c")), at(3, "tap", 2000, { of: "drive" }), at(4, "tap", 3000, way("c", "d"))];
    expect(flags(drove)).toEqual([]);
  });

  it("a failed call ends the stretch", () => {
    const entries = [at(1, "tap", 0, way("a", "b")), at(2, "tap", 1000, { ok: false, code: "not_found" }), at(3, "tap", 2000, way("b", "c")), at(4, "tap", 3000, way("c", "d"))];
    expect(flags(entries)).toEqual([]);
  });

  it("two stretches are two lines", () => {
    const entries = [
      at(1, "tap", 0, way("a", "b")),
      at(2, "tap", 1000, way("b", "c")),
      at(3, "tap", 2000, way("c", "d")),
      at(4, "type_text", 3000),
      at(5, "tap", 4000, way("d", "e")),
      at(6, "tap", 5000, way("e", "f")),
      at(7, "tap", 6000, way("f", "g")),
    ];
    expect(flags(entries)).toEqual([
      '- 3 calls in a row on a way the map knows (calls 1–3): drive {"to": "d"} is one call',
      '- 3 calls in a row on a way the map knows (calls 5–7): drive {"to": "g"} is one call',
    ]);
  });

  it("is written from a real session: three taps along proven roads", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const root = mkdtempSync(join(tmpdir(), "tapline-known-way-"));
    dirs.push(root);
    const screens = ["a", "b", "c", "d"];
    let index = 0;
    const frame = { x: 1, y: 1, width: 100, height: 40 };
    const handler = (req: IncomingRequest): Reply => {
      const route = [screens[index] ?? "d"];
      const button = { ref: "e1", type: "Pressable", role: "button", testID: `go-${route[0]}`, text: `Go ${route[0]}`, frame, actions: ["press"] };
      switch (req.method) {
        case "tree":
          return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [button], route: { names: route }, place: { route } } };
        case "place":
          return { ok: true, result: { route, seenAt: Date.now() } };
        case "press":
          index++;
          return { ok: true, result: { element: button, settledMs: 10 } };
        default:
          return { ok: true, result: {} };
      }
    };
    const app = (await FakeApp.connect(port, { app: { name: "Wayfare", id: "com.example.wayfare", version: "1.5.0", build: "220" }, capabilities: ["tree", "press", "logs", "dryRun", "place"] }, handler)).app;
    apps.push(app);
    const mapsDir = join(root, "maps");
    const folder = join(mapsDir, "com.example.wayfare");
    mkdirSync(folder, { recursive: true });
    const stamp = "2026-11-12T10:00:00.000Z";
    const placeOf = (r: string) => ({ key: { route: [r] }, link: null, last: stamp });
    const roadOf = (from: string, to: string) => ({ from, to, move: { tool: "tap", target: { id: `go-${from}` } }, names: { id: `go-${from}`, text: `Go ${from}` }, by: "tapline", seen: 2, failed: 0, ms: 300, last: stamp, build: "1.5.0 (220)" });
    writeFileSync(
      join(folder, "map.json"),
      JSON.stringify({
        format: "agent-tools-map",
        version: 1,
        app: "com.example.wayfare",
        places: { a: placeOf("a"), b: placeOf("b"), c: placeOf("c"), d: placeOf("d") },
        roads: [roadOf("a", "b"), roadOf("b", "c"), roadOf("c", "d")],
        routes: {},
        reflexes: [],
      }),
    );
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, maps: new MapRegistry({ mapsDir }), logDir: join(root, "log"), policy: { version: 1, confirm: [], block: [] } });
    await tools.look({ screenshot: false });
    for (const id of ["go-a", "go-b", "go-c"]) await tools.tap({ target: { id }, look: false });
    const said = tools.sessionReport().content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(said).toContain('- 3 calls in a row on a way the map knows (calls 2–4): drive {"to": "d"} is one call');
  });
});
