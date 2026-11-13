import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool } from "../src/dispatch.js";
import type { MapFile } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { baseMap, button, place, setupDrive, textOf, type El, type Setup, type SetupOptions } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.4 and §18.5: `drive` with a route, with `then`, as a `run` step, and a route as one leg of a way.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const frame = { x: 20, y: 100, width: 300, height: 44 };
const input = (ref: string, testID: string): El => ({ ref, type: "TextInput", role: "input", testID, frame, actions: ["type"] });
const USER = "tester2@example.com";
const PASS = "fake-pass-9137";
const store = accountStore({ version: 1, accounts: { tester2: { username: USER, password: PASS, apps: ["com.example.wayfare"] } } });
const CAPS = ["tree", "press", "type", "typeKind", "logs", "dryRun", "place", "places", "move", "waitOnce"];

const routeFile = (steps: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: "agent-tools-script", version: 2, app: "com.example.wayfare", name: "go", start: "general", steps, ...extra });

async function withRoute(file: string, options: SetupOptions = {}, name = "go"): Promise<Setup> {
  const map: MapFile = { ...baseMap(), routes: { [name]: `routes/${name}.json` } };
  const s = await setupDrive(hosts, apps, dirs, { map, capabilities: CAPS, ...options });
  writeFileSync(join(s.folder, "routes", `${name}.json`), file);
  return s;
}

describe("drive {route}: the answer", () => {
  it("drives to start, runs the steps, checks end, and names the route in the first line", async () => {
    const s = await withRoute(routeFile([{ tool: "tap", target: { id: "language-row" } }], { end: "language" }));
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).not.toBe(true);
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toBe("Arrived at language by route go in 0.0 s.");
    expect(lines[1]).toBe("Place: language.");
    expect(textOf(answer)).toContain("English");
    expect(textOf(answer)).not.toContain("Ran 1 of 1 steps");
    expect(s.world.screen).toBe("language");
    // One move to the start (settings > general), then the route's own tap.
    expect(s.count("move")).toBe(1);
    expect(s.made("press")).toBe(2);
  });

  it("an end the steps didn't reach is off_route, with the screen", async () => {
    const s = await withRoute(routeFile([{ tool: "tap", target: { id: "language-row" } }], { end: "settings" }));
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe("Error off_route: the route go ran its steps but ended at language, not at settings (its end).");
    expect(textOf(answer)).toContain("English");
  });

  it("a route with no end says only that it arrived", async () => {
    const s = await withRoute(routeFile([{ tool: "tap", target: { id: "language-row" } }]));
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(textOf(answer).split("\n")[0]).toBe("Arrived at language by route go in 0.0 s.");
  });

  it("a failing step keeps run's own error", async () => {
    const s = await withRoute(routeFile([{ tool: "tap", target: { id: "missing-row" } }], { end: "language" }));
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_found: Ran 0 of 1 steps; stopped at step 1 \(tap id=missing-row\)/);
  });

  it("variables and the account fill in; a missing one is bad_params and nothing moves", async () => {
    const steps = [
      { tool: "tap", target: { id: "language-row" } },
      { tool: "type_text", target: { id: "email" }, text: "${account.username}" },
      { tool: "type_text", target: { id: "city" }, text: "${city}" },
    ];
    const s = await withRoute(routeFile(steps, { variables: ["account", "city"], end: "language" }), {
      tools: { accounts: { store } },
      world: (w) => {
        w.elements.language.push(input("e20", "email"), input("e21", "city"));
      },
    });
    const missing = await callTool(s.tools, "drive", { route: "go", account: "tester2" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^Error bad_params: .*city/);
    expect(s.count("move") + s.count("press") + s.count("type")).toBe(0);
    const ok = await callTool(s.tools, "drive", { route: "go", account: "tester2", with: { city: "Paris" } });
    expect(ok.isError).not.toBe(true);
    const typed = s.app.requests.filter((r) => r.method === "type").map((r) => (r.params as { text: string }).text);
    expect(typed).toEqual([USER, "Paris"]);
    expect(textOf(ok)).not.toContain(USER);
  });

  it("an off_route on the way to start stops the call with nothing typed", async () => {
    const steps = [{ tool: "type_text", target: { id: "city" }, text: "Paris" }];
    const s = await withRoute(routeFile(steps), { world: (w) => (w.screen = "welcome") });
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: /);
    expect(s.count("type")).toBe(0);
    expect(s.count("press")).toBe(0);
  });
});

describe("drive: then", () => {
  it("runs ordinary steps with expect after arriving, in the same call", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "drive", { to: "language", then: [{ tool: "wait_for", text: "English" }, { tool: "wait", seconds: 0.1 }] });
    expect(answer.isError).not.toBe(true);
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toBe("Arrived at language by 2 taps in 0.0 s (settings > general > language).");
    expect(textOf(answer)).toMatch(/Ran 2 of 2 steps in /);
    expect(s.world.screen).toBe("language");
  });

  it("a then step that fails answers run's error and says it had arrived", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "drive", { to: "language", then: [{ tool: "tap", target: { id: "nope" } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_found: Ran 0 of 1 steps; stopped at step 1 \(tap id=nope\)/);
    expect(textOf(answer)).toContain("Note: arrived at language by 2 taps in 0.0 s before the steps ran.");
  });

  it("a bad then step is bad_params before anything is touched", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "drive", { to: "language", then: [{ tool: "tap", target: { id: "x" } }, { tool: "look" }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: step 2: "look" can't be a step/);
    expect(s.count("move") + s.count("press")).toBe(0);
    expect(s.world.screen).toBe("settings");
  });

  it("a dry run says the way and runs no then step", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "drive", { to: "language", dry_run: true, then: [{ tool: "tap", target: { id: "language-row" } }] });
    expect(textOf(answer)).toBe("Would drive to language by 2 taps: settings > general > language (all proven).");
    expect(s.count("move") + s.count("press")).toBe(0);
  });

  it("then does not run when the drive stops", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS, world: (w) => (w.screen = "welcome") });
    const answer = await callTool(s.tools, "drive", { to: "language", then: [{ tool: "wait", seconds: 0.1 }] });
    expect(textOf(answer)).toMatch(/^Error off_route: /);
    expect(textOf(answer)).not.toContain("Ran 1 of 1");
  });

  it("then steps keep the policy: a Delete step is not run without a person", async () => {
    const s = await setupDrive(hosts, apps, dirs, {
      capabilities: CAPS,
      policy: { version: 1, confirm: ["delete"], block: [] },
      world: (w) => {
        w.elements.language.push(button("e30", "delete-trip", "Delete trip"));
      },
    });
    const answer = await callTool(s.tools, "drive", { to: "language", then: [{ tool: "tap", target: { id: "delete-trip" } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/needs_confirmation/);
  });
});

describe("drive as a run step", () => {
  it("counts as one step however many moves it makes", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "drive", to: "language" }, { tool: "wait_for", text: "English" }], trace: true });
    expect(answer.isError).not.toBe(true);
    const text = textOf(answer);
    expect(text).toMatch(/^Ran 2 of 2 steps in /);
    expect(text).toMatch(/1\. Arrived at language by 2 taps in /);
    expect(s.world.screen).toBe("language");
  });

  it("a failing drive stops the batch at its step", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS, world: (w) => (w.screen = "welcome") });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "wait", seconds: 0.1 }, { tool: "drive", to: "language" }, { tool: "wait", seconds: 0.1 }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error (off_route|not_found): Ran 1 of 3 steps; stopped at step 2 \(drive language\): /);
  });

  it("map as a step is bad_params", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "map" }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: step 1: "map" can't be a step/);
  });

  it("a drive step with neither to nor route, or with then, is bad_params before anything runs", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const none = await callTool(s.tools, "run", { steps: [{ tool: "wait", seconds: 0.1 }, { tool: "drive" }] });
    expect(textOf(none)).toMatch(/^Error bad_params: step 2 \(drive\): give exactly one of to/);
    const then = await callTool(s.tools, "run", { steps: [{ tool: "drive", to: "language", then: [{ tool: "wait", seconds: 0.1 }] }] });
    expect(textOf(then)).toMatch(/^Error bad_params: step 1 \(drive language\): then goes on a drive call of its own/);
    expect(s.count("move") + s.count("press")).toBe(0);
  });

  it("dry_run of a batch that starts with a drive says the way and touches nothing", async () => {
    const s = await setupDrive(hosts, apps, dirs, { capabilities: CAPS });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "drive", to: "language" }], dry_run: true });
    expect(textOf(answer)).toBe("Would run 1 step; step 1 would drive to language by 2 taps: settings > general > language (all proven).");
    expect(s.count("move") + s.count("press")).toBe(0);
  });

  it("every move of the drive keeps its policy check inside a run", async () => {
    const map = baseMap();
    map.roads = [{ ...(map.roads[0] as MapFile["roads"][number]), names: { id: "delete-trip", text: "Delete trip" }, move: { tool: "tap", target: { id: "delete-trip" } } }];
    map.roads[0] = { ...map.roads[0]!, from: "settings", to: "general" };
    const s = await setupDrive(hosts, apps, dirs, {
      map,
      capabilities: CAPS,
      policy: { version: 1, confirm: ["delete"], block: [] },
      world: (w) => {
        w.goes["settings|delete-trip"] = "general";
      },
    });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "drive", to: "general" }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/needs_confirmation/);
    expect(s.world.screen).toBe("settings");
  });
});

describe("a route as one leg of a way", () => {
  const welcomeMap = (): MapFile => {
    const map = baseMap();
    map.places["welcome"] = place(["welcome"]);
    map.routes = { enter: "routes/enter.json" };
    return map;
  };
  const enter = routeFile([{ tool: "tap", target: { id: "continue" } }], { name: "enter", start: "welcome", end: "settings" });

  it("drive {to} takes a saved route when it is the way, and says so", async () => {
    const map = welcomeMap();
    const s = await setupDrive(hosts, apps, dirs, { map, capabilities: CAPS, world: (w) => (w.screen = "welcome") });
    writeFileSync(join(s.folder, "routes", "enter.json"), enter);
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe("Arrived at language by route enter then 2 taps in 0.0 s (welcome > settings > general > language).");
    expect(s.world.screen).toBe("language");
  });

  it("dry_run names the route", async () => {
    const map = welcomeMap();
    const s = await setupDrive(hosts, apps, dirs, { map, capabilities: CAPS, world: (w) => (w.screen = "welcome") });
    writeFileSync(join(s.folder, "routes", "enter.json"), enter);
    expect(textOf(await callTool(s.tools, "drive", { to: "settings", dry_run: true }))).toBe("Would drive to settings by route enter: welcome > settings (all proven; via route enter).");
    expect(s.count("press") + s.count("move")).toBe(0);
  });

  it("a route that ends elsewhere than it says is off_route, never Arrived", async () => {
    const map = welcomeMap();
    const s = await setupDrive(hosts, apps, dirs, { map, capabilities: CAPS, world: (w) => { w.screen = "welcome"; w.goes["welcome|continue"] = "general"; } });
    writeFileSync(join(s.folder, "routes", "enter.json"), enter);
    const answer = await callTool(s.tools, "drive", { to: "settings" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 1 of 1 \(route enter\): it didn't lead where the road says\./);
  });
});

describe("replay of a route", () => {
  it("starts fresh, then drives to start by roads, and never writes the map", async () => {
    const s = await withRoute(routeFile([{ tool: "tap", target: { id: "language-row" } }], { end: "language" }), { tools: { reloadWaitMs: 50, scriptsDir: undefined } });
    await s.registry.flushAll();
    const before = readFileSync(join(s.folder, "map.json"), "utf8");
    const answer = await s.tools.replay({ name: "go" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
    expect(s.world.screen).toBe("language");
    // The reload came first, then the drive to start.
    const order = s.methods().filter((m) => m === "reload" || m === "move" || m === "press");
    expect(order[0]).toBe("reload");
    expect(order.length).toBeGreaterThan(2);
    await s.registry.flushAll();
    expect(readFileSync(join(s.folder, "map.json"), "utf8")).toBe(before);
  });

  it("a place the map does not know is refused before the fresh start, and the map is not written", async () => {
    const s = await withRoute(routeFile([{ tool: "tap", target: { id: "language-row" } }]), { world: (w) => (w.screen = "welcome"), tools: { reloadWaitMs: 50 } });
    await s.registry.flushAll();
    const before = readFileSync(join(s.folder, "map.json"), "utf8");
    const answer = await s.tools.replay({ name: "go" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error unsupported: the route starts at general, and the app's place isn't known/);
    expect(s.count("reload")).toBe(0);
    expect(s.count("press")).toBe(0);
    await s.registry.flushAll();
    // The place the failed drive saw (a screen the map didn't hold) is not added.
    expect(readFileSync(join(s.folder, "map.json"), "utf8")).toBe(before);
  });
});
