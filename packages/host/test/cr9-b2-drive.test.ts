import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import type { MapFile, MapRoad } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { ALL_CAPS, baseMap, button, flushDriveMaps, note, place, road, setupDrive, textOf, type Setup, type SetupOptions } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// PR 9 review (CodeRabbit), second pass: the next target's own action, one reflex retry per leg of each plan, and no route that runs itself.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const setup = (options: SetupOptions = {}): Promise<Setup> => setupDrive(hosts, apps, dirs, options);
const moves = (s: Setup): Array<{ method: string; next?: { kind?: string; target: Record<string, unknown>; capMs: number } }> =>
  s.app.requests.filter((r) => r.method === "move").map((r) => r.params as never);
const withTool = (r: MapRoad, tool: "long_press" | "toggle"): MapRoad => ({ ...r, move: { ...r.move, tool } });

describe("the next target's own action", () => {
  it.each([
    ["long_press", "longPress"],
    ["toggle", "toggle"],
  ] as const)("a %s next move is sent as kind %s", async (tool, kind) => {
    const map: MapFile = { ...baseMap(), roads: [road("settings", "general", "general-row", "General"), withTool(road("general", "language", "language-row", "Language"), tool)] };
    const s = await setup({ map });
    await callTool(s.tools, "drive", { to: "language" });
    expect(moves(s)[0]?.next?.kind).toBe(kind);
  });

  it("a tap next move is sent as kind press", async () => {
    const s = await setup();
    await callTool(s.tools, "drive", { to: "language" });
    expect(moves(s)[0]?.next?.kind).toBe("press");
  });
});

describe("a reflex gets its retry again in a new plan", () => {
  it("leg 0 of the plan made after a replan can fire a reflex too", async () => {
    const state = { up: true };
    const sheet = [note("e20", "Rate Wayfare"), button("e21", "not-now", "Not now")];
    const map: MapFile = {
      ...baseMap(),
      places: { ...baseMap().places, welcome: place(["welcome"]) },
      roads: [...baseMap().roads, road("welcome", "settings", "continue", "Continue")],
      reflexes: [{ name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Not now" } }, max: 2 }],
    };
    const s = await setup({
      map,
      world: (w) => {
        w.elements.settings = [...w.elements.settings, ...sheet];
        w.refuse = (testID) => (state.up && testID !== "not-now" ? { code: "not_actionable", message: 'covered: e1 button "General" is behind e20 text "Rate Wayfare"; close that first.' } : undefined);
        w.onPress = (testID) => {
          if (testID === "not-now") {
            state.up = false;
            for (const key of Object.keys(w.elements) as Array<keyof typeof w.elements>) w.elements[key] = w.elements[key].filter((e) => e.testID !== "not-now" && e.text !== "Rate Wayfare");
          } else if (testID === "general-row" && w.goes["settings|general-row"] === "welcome") {
            // This press lands on welcome, and the sheet comes back there. The next one goes to general.
            state.up = true;
            w.elements.welcome = [...w.elements.welcome, ...sheet];
            w.goes["settings|general-row"] = "general";
          }
        };
        // The first press that gets through lands on welcome, so the drive plans again from there.
        w.goes["settings|general-row"] = "welcome";
      },
    });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(textOf(answer)).toMatch(/^Arrived at language/);
    expect(s.world.screen).toBe("language");
  });
});

describe("a route that runs itself", () => {
  const routeFile = (steps: unknown[]): string => JSON.stringify({ format: "agent-tools-script", version: 2, app: "com.example.wayfare", name: "loop", start: "settings", end: "general", steps });

  it("is refused, naming the route, instead of running down", async () => {
    // The only way from settings to general is the route, and its step drives to general again.
    const map: MapFile = { ...baseMap(), roads: [], routes: { loop: "routes/loop.json" } };
    const s = await setup({ map, capabilities: [...ALL_CAPS, "waitOnce"] });
    writeFileSync(join(s.folder, "routes", "loop.json"), routeFile([{ tool: "drive", to: "general" }]));
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain('route "loop" is already running');
  }, 5000);
});
