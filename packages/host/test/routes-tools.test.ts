import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { loadMap, saveMap, type MapFile } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.5 and §9.4 through the tools: `record` with `route`, `type_text` with `as`, `replay` of a route.

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
const CONTINUE = { ref: "e1", type: "Pressable", role: "button", testID: "continue", text: "Continue", frame, actions: ["press"] };
const EMAIL = { ref: "e2", type: "TextInput", role: "input", testID: "email", frame, actions: ["type"] };
const PASSWORD = { ref: "e3", type: "TextInput", role: "input", testID: "password", frame, actions: ["type"] };
const CITY = { ref: "e4", type: "TextInput", role: "input", testID: "city", frame, actions: ["type"] };
const WELCOME = { ref: "e5", type: "Text", role: "text", text: "Welcome", frame, actions: [] };
const HOME = { ref: "e6", type: "Text", role: "text", text: "Home", frame, actions: [] };

type Screen = "welcome" | "home";
const ELEMENTS: Record<Screen, unknown[]> = { welcome: [CONTINUE, EMAIL, PASSWORD, CITY, WELCOME], home: [HOME, CITY] };

const USER = "tester2@example.com";
const PASS = "fake-pass-9137";
const store = accountStore({ version: 1, accounts: { tester2: { username: USER, password: PASS, apps: ["com.example.demo"] } } });

const APP_ID = "com.example.demo";

async function setup(options: { start?: Screen } = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const root = mkdtempSync(join(tmpdir(), "tapline-routes-tools-"));
  dirs.push(root);
  const mapsDir = join(root, "maps");
  const scriptsDir = join(root, "scripts");
  const state = { screen: (options.start ?? "welcome") as Screen };
  const handler = (req: IncomingRequest): Reply => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: ELEMENTS[state.screen], route: { names: [state.screen] }, place: { route: [state.screen] } } };
      case "place":
        return { ok: true, result: { route: [state.screen], seenAt: Date.now() } };
      case "press":
        state.screen = "home";
        return { ok: true, result: { element: CONTINUE, settledMs: 50 } };
      case "type": {
        const target = params["target"] as { testID?: string } | undefined;
        const secure = target?.testID === "password";
        const element = secure ? PASSWORD : target?.testID === "email" ? EMAIL : CITY;
        const value = secure ? "•".repeat(String(params["text"]).length) : String(params["text"]);
        return { ok: true, result: { element: { ...element, value }, value, ...(secure ? { secure: true } : {}), settledMs: 30 } };
      }
      case "waitFor":
        return { ok: true, result: { met: true, waitedMs: 10 } };
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "type", "typeKind", "logs", "dryRun", "place"] }, handler);
  apps.push(app);
  const saves: string[] = [];
  const registry = new MapRegistry({
    mapsDir,
    save: (dir: string, map: MapFile, opts) => {
      saves.push(dir);
      return saveMap(dir, map, opts);
    },
  });
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    maps: registry,
    scriptsDir,
    accounts: { store },
    reloadWaitMs: 50,
    policy: { version: 1, confirm: [], block: [] },
  });
  const mapFolder = join(mapsDir, APP_ID);
  return { tools, app, state, registry, saves, mapFolder, scriptsDir };
}

const routeFile = (folder: string, name: string): Record<string, unknown> & { steps: Array<Record<string, unknown>> } =>
  JSON.parse(readFileSync(join(folder, "routes", `${name}.json`), "utf8")) as Record<string, unknown> & { steps: Array<Record<string, unknown>> };

describe("record a route", () => {
  it("saves start and end from the places seen, in the map folder, and lists it in the map", async () => {
    const { tools, registry, mapFolder } = await setup();
    await tools.look({ screenshot: false });
    const started = textOf(await tools.record({ start: true, route: "sign_in" }));
    expect(started).toContain('Recording route "sign_in"');
    await tools.tap({ target: { id: "continue" } });
    const stopped = textOf(await tools.record({ stop: true }));
    expect(stopped).toContain("Saved route sign_in (welcome → home): 1 step");
    const route = routeFile(mapFolder, "sign_in");
    expect(route).toMatchObject({ format: "agent-tools-script", version: 2, name: "sign_in", app: APP_ID, start: "welcome", end: "home" });
    expect(route.steps[0]).toMatchObject({ tool: "tap", target: { id: "continue" } });
    await registry.flushAll();
    expect(loadMap(mapFolder, APP_ID).map.routes).toEqual({ sign_in: "routes/sign_in.json" });
  });

  it("start: true with a route name works as action start", async () => {
    const { tools, mapFolder } = await setup();
    await tools.record({ action: "start", route: "go" });
    await tools.tap({ target: { id: "continue" } });
    await tools.record({ action: "stop" });
    expect(existsSync(join(mapFolder, "routes", "go.json"))).toBe(true);
  });

  it("a route name is reduced, and said", async () => {
    const { tools, mapFolder } = await setup();
    const started = textOf(await tools.record({ start: true, route: "Sign in!" }));
    expect(started).toContain('Recording route "Sign_in"');
    await tools.tap({ target: { id: "continue" } });
    await tools.record({ stop: true });
    expect(existsSync(join(mapFolder, "routes", "Sign_in.json"))).toBe(true);
  });

  it("refuses a name that differs only in case from a saved route, and a name that is nothing", async () => {
    const { tools } = await setup();
    await tools.record({ start: true, route: "Sign_in" });
    await tools.tap({ target: { id: "continue" } });
    await tools.record({ stop: true });
    const twin = await tools.record({ start: true, route: "sign_in" });
    expect(twin.isError).toBe(true);
    expect(textOf(twin)).toBe('Error bad_params: the route "sign_in" differs only in case from the existing "Sign_in"; use that name.');
    expect(textOf(await tools.record({ start: true, route: "***" }))).toMatch(/^Error bad_params: /);
  });

  it("route and a different name together are bad_params", async () => {
    const { tools } = await setup();
    const both = await tools.record({ start: true, name: "other", route: "sign_in" });
    expect(textOf(both)).toMatch(/^Error bad_params: .*route/);
  });

  it("as saves ${name}, lists the variable, and the app still gets the real text", async () => {
    const { tools, app, mapFolder } = await setup();
    await tools.record({ start: true, route: "pick_city" });
    await tools.typeText({ target: { id: "city" }, text: "Paris", as: "city" });
    const stopped = textOf(await tools.record({ stop: true }));
    expect(stopped).toContain("Variables: city.");
    const route = routeFile(mapFolder, "pick_city");
    expect(route["variables"]).toEqual(["city"]);
    expect(route.steps[0]).toMatchObject({ tool: "type_text", text: "${city}" });
    expect(JSON.stringify(route)).not.toContain("Paris");
    const sent = app.requests.find((r) => r.method === "type")?.params as Record<string, unknown>;
    expect(sent["text"]).toBe("Paris");
    expect(sent).not.toHaveProperty("as");
  });

  it("as outside a route recording is bad_params and sends nothing", async () => {
    const { tools, app } = await setup();
    const answer = await tools.typeText({ target: { id: "city" }, text: "Paris", as: "city" });
    expect(textOf(answer)).toMatch(/^Error bad_params: as goes only while recording a route/);
    await tools.record({ start: true, name: "plain" });
    expect(textOf(await tools.typeText({ target: { id: "city" }, text: "Paris", as: "city" }))).toMatch(/^Error bad_params: as goes only while recording a route/);
    expect(app.requests.filter((r) => r.method === "type")).toHaveLength(0);
  });

  it("as with a name that isn't a variable name, or account, or an account's text, is bad_params", async () => {
    const { tools, app } = await setup();
    await tools.record({ start: true, route: "r" });
    expect(textOf(await tools.typeText({ target: { id: "city" }, text: "x", as: "a b" }))).toMatch(/^Error bad_params: as names a variable/);
    expect(textOf(await tools.typeText({ target: { id: "city" }, text: "x", as: "account" }))).toMatch(/^Error bad_params: as can't be "account"/);
    expect(textOf(await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2", as: "who" }))).toMatch(/^Error bad_params: /);
    expect(app.requests.filter((r) => r.method === "type")).toHaveLength(0);
  });

  it("a secure field's text is never saved", async () => {
    const { tools, mapFolder } = await setup();
    await tools.record({ start: true, route: "pw" });
    await tools.typeText({ target: { id: "password" }, text: "hunter2-secret" });
    const stopped = textOf(await tools.record({ stop: true }));
    expect(stopped).toContain("types into a password field: that text isn't saved");
    const raw = readFileSync(join(mapFolder, "routes", "pw.json"), "utf8");
    expect(raw).not.toContain("hunter2-secret");
    expect(JSON.parse(raw)).toMatchObject({ steps: [{ tool: "type_text", text: "" }] });
  });

  it("$${ round trips: a literal ${ in typed text is written $${ and typed back as ${", async () => {
    const { tools, app, state, mapFolder } = await setup();
    await tools.record({ start: true, route: "dollar" });
    await tools.typeText({ target: { id: "city" }, text: "cost ${x}" });
    await tools.record({ stop: true });
    expect(routeFile(mapFolder, "dollar").steps[0]).toMatchObject({ text: "cost $${x}" });
    state.screen = "welcome";
    app.requests.length = 0;
    const answer = await tools.replay({ name: "dollar" });
    expect(answer.isError).not.toBe(true);
    const typed = app.requests.filter((r) => r.method === "type").map((r) => (r.params as { text: string }).text);
    expect(typed).toEqual(["cost ${x}"]);
  });

  it("an account value is saved as its placeholder, with account in variables, and never as the value", async () => {
    const { tools, mapFolder } = await setup();
    await tools.record({ start: true, route: "login" });
    await tools.typeText({ target: { id: "email" }, text: "${account.username}", account: "tester2" });
    await tools.typeText({ target: { id: "password" }, text: "${account.password}", account: "tester2" });
    const stopped = textOf(await tools.record({ stop: true }));
    expect(stopped).toContain("Variables: account.");
    expect(stopped).not.toContain("that text isn't saved");
    const raw = readFileSync(join(mapFolder, "routes", "login.json"), "utf8");
    expect(raw).not.toContain(USER);
    expect(raw).not.toContain(PASS);
    const route = JSON.parse(raw) as { variables: string[]; steps: Array<{ text: string }> };
    expect(route.variables).toEqual(["account"]);
    expect(route.steps.map((s) => s.text)).toEqual(["${account.username}", "${account.password}"]);
  });

  it("a status of a route recording names it", async () => {
    const { tools } = await setup();
    await tools.record({ start: true, route: "r" });
    expect(textOf(await tools.record({ action: "status" }))).toContain('route "r"');
  });
});

describe("replay a route", () => {
  async function saved() {
    const world = await setup();
    await world.tools.look({ screenshot: false });
    await world.tools.record({ start: true, route: "sign_in" });
    await world.tools.typeText({ target: { id: "city" }, text: "Paris", as: "city" });
    await world.tools.tap({ target: { id: "continue" } });
    await world.tools.record({ stop: true });
    world.state.screen = "welcome";
    await world.tools.record({ start: true, route: "plain" });
    await world.tools.tap({ target: { id: "continue" } });
    await world.tools.record({ stop: true });
    await world.registry.flushAll();
    world.state.screen = "welcome";
    world.app.requests.length = 0;
    return world;
  }

  it("never writes the map, and finds the route by name in the map folder", async () => {
    const world = await saved();
    const before = readFileSync(join(world.mapFolder, "map.json"), "utf8");
    const savesBefore = world.saves.length;
    const answer = await world.tools.replay({ name: "plain" });
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
    expect(world.state.screen).toBe("home");
    await world.registry.flushAll();
    expect(world.saves.length).toBe(savesBefore);
    expect(readFileSync(join(world.mapFolder, "map.json"), "utf8")).toBe(before);
  });

  it("a route that needs a value replay can't give is bad_params naming it, and nothing is touched", async () => {
    const world = await saved();
    const answer = await world.tools.replay({ name: "sign_in" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: step 1: no value given for the variable "city"\./);
    expect(world.app.requests.filter((r) => r.method === "type" || r.method === "press" || r.method === "reload")).toHaveLength(0);
  });

  it("with the app elsewhere, answers unsupported and touches nothing", async () => {
    const world = await saved();
    world.state.screen = "home";
    world.app.requests.length = 0;
    const answer = await world.tools.replay({ name: "plain" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error unsupported: the route "plain" starts at welcome, and the app is at home\./);
    expect(world.app.requests.filter((r) => r.method === "press")).toHaveLength(0);
  });

  it("version 1 files still replay", async () => {
    const world = await setup();
    mkdirSync(world.scriptsDir, { recursive: true });
    writeFileSync(join(world.scriptsDir, "old.json"), JSON.stringify({ format: "agent-tools-script", version: 1, name: "old", app: APP_ID, fresh: false, steps: [{ tool: "tap", target: { id: "continue" } }] }));
    const answer = await world.tools.replay({ name: "old" });
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
  });
});

describe("a route in the map", () => {
  it("map `to` plans through a saved route and says so", async () => {
    const world = await setup();
    await world.tools.look({ screenshot: false });
    await world.tools.record({ start: true, route: "sign_in" });
    await world.tools.tap({ target: { id: "continue" } });
    await world.tools.record({ stop: true });
    world.state.screen = "welcome";
    const answer = textOf(await world.tools.map({ to: "home" }));
    expect(answer).toBe("Would drive to home by 1 move: welcome > home (all proven; via route sign_in).");
  });
});

describe("the tool text", () => {
  it("record carries TOOL-TEXT's route paragraph, and type_text and record take as and route", async () => {
    const { toolDescription } = await import("../src/tool-text.js");
    const { toolShapes } = await import("../src/tools.js");
    expect(toolDescription("record")).toContain('`action: "start"` with `route: "<name>"` (`start: true` works too) records a route for `drive`: it starts from the place the app is at and is saved in the app\'s map folder. In it, a `type_text` with `as: "<variable>"` is saved as `${variable}` (filled by `drive`\'s `with`); a secure field\'s text is never saved.');
    expect(Object.keys(toolShapes.record)).toContain("route");
    expect(Object.keys(toolShapes.type_text)).toContain("as");
  });
});
