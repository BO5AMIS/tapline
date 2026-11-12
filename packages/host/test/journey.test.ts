import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { Journey, formatDuration, summaryLine, withoutIds, type JourneyState } from "../src/journey.js";
import { formatChanges, formatElement, formatTree } from "../src/format.js";
import type { TreeElement } from "../src/protocol.js";
import type { PolicyFile } from "../src/policy.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.12 §17.1: `journey`, its user's eyes and what it measures.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const SCREEN = { width: 402, height: 874, scale: 3 };
const frame = (y: number) => ({ x: 24, y, width: 354, height: 48 });

const HOME: TreeElement[] = [
  { ref: "e1", type: "Text", role: "header", testID: "home-title", text: "Home", frame: frame(60), actions: [] },
  { ref: "e2", type: "Pressable", role: "button", testID: "open-settings", text: "Settings", frame: frame(120), actions: ["press"] },
  { ref: "e3", type: "Pressable", role: "button", testID: "search-icon", label: "Search", text: "", frame: { x: 340, y: 60, width: 40, height: 40 }, actions: ["press"] },
  { ref: "e4", type: "TextInput", role: "textfield", testID: "name-input", label: "Name", text: "", placeholder: "Your name", value: "", frame: frame(200), actions: ["press", "type"] },
];
const SETTINGS: TreeElement[] = [
  { ref: "e1", type: "Text", role: "header", testID: "settings-title", text: "Settings", frame: frame(60), actions: [] },
  { ref: "e2", type: "Pressable", role: "button", testID: "dark-mode", text: "Dark mode", frame: frame(120), actions: ["press"] },
];

interface World {
  route: string[];
  moreBelow: boolean;
  /** Extra answers by method, to override the defaults. */
  override?: (req: IncomingRequest) => Reply | undefined;
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

async function setup(options: { policy?: PolicyFile; world?: Partial<World>; onRequest?: (req: IncomingRequest) => Reply | undefined } = {}) {
  const world: World = { route: ["home"], moreBelow: true, ...options.world };
  let now = 1_000_000;
  let lastRoute = world.route.join("/");
  const elementsFor = (): TreeElement[] => (world.route[0] === "settings" ? SETTINGS : HOME);
  const handler = (req: IncomingRequest): Reply => {
    const custom = options.onRequest?.(req);
    if (custom !== undefined) return custom;
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "tree": {
        const route = world.route.join("/");
        const sameRoute = route === lastRoute;
        lastRoute = route;
        const base = {
          screen: SCREEN,
          elements: elementsFor(),
          route: { names: world.route },
          ...(params["glass"] === true ? { glass: { moreAbove: false, moreBelow: world.moreBelow } } : { offScreen: { above: 0, below: 3 } }),
        };
        return {
          ok: true,
          result: params["changes"] === true
            ? { ...base, changes: { sameRoute, added: [], removed: [], changed: [], moved: [] } }
            : base,
        };
      }
      case "press": {
        const target = params["target"] as { text?: string; ref?: string; testID?: string } | undefined;
        if (target?.text === "Covered") return { ok: false, error: { code: "not_actionable", message: "covered: Settings is behind the open sheet" } };
        if (target?.text === "Missing") return { ok: false, error: { code: "not_found", message: 'nothing on screen shows "Missing"; Closest: e2 button "Settings" id=open-settings.' } };
        if (target?.text === "Settings" || target?.ref === "e2" || target?.testID === "open-settings") world.route = ["settings"];
        return { ok: true, result: { element: elementsFor()[1], settledMs: 310 } };
      }
      case "back": {
        world.route = ["home"];
        return { ok: true, result: { route: ["settings"], settledMs: 200 } };
      }
      case "type":
        return { ok: true, result: { element: HOME[3], value: String(params["text"] ?? ""), settledMs: 100 } };
      case "scroll":
        return { ok: true, result: { element: HOME[0], offset: { x: 0, y: 300 }, moved: true, settledMs: 120 } };
      case "waitFor":
        now += 5000;
        return { ok: true, result: { met: true, waitedMs: 5000 } };
      case "openURL":
        return { ok: true, result: { settledMs: 100 } };
      case "command": {
        const name = String(params["name"]);
        const args = (params["args"] ?? {}) as Record<string, unknown>;
        if (name === "language") return { ok: true, result: { name, result: { language: args["language"], previous: "en", say: `Language ${String(args["language"])}.` } } };
        if (name === "region") return { ok: true, result: { name, result: { region: args["region"], say: `Region ${String(args["region"])}.` } } };
        if (name === "network") return { ok: true, result: { name, result: { mode: args["mode"] } } };
        return { ok: true, result: { name, result: null, settledMs: 50 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, {
    connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
    clock: () => now,
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
  });
  return { app, host, tools, world, advance: (ms: number) => { now += ms; } };
}

const start = (tools: TaplineTools, extra: Record<string, unknown> = {}) => tools.journey({ start: true, goal: "change the settings", persona: "a first-timer", ...extra });

describe("journey start and stop", () => {
  it("answers the start line and the screen, in a user's eyes", async () => {
    const { tools } = await setup();
    const said = textOf(await start(tools));
    const lines = said.split("\n");
    expect(lines[0]).toBe('Journey started: "change the settings" as a first-timer, in a user\'s eyes.');
    expect(lines[1]).toMatch(/^Screen 402x874 pt @3x · 4 elements \(more below\)$/);
    expect(said).toContain("Route: home");
  });

  it('says "no persona" without one', async () => {
    const { tools } = await setup();
    expect(textOf(await tools.journey({ start: true, goal: "x" })).split("\n")[0]).toBe('Journey started: "x" as no persona, in a user\'s eyes.');
  });

  it("refuses a second start while one runs, a stop without a journey, and a start without a goal", async () => {
    const { tools } = await setup();
    const none = await tools.journey({ stop: true, reached: true });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/^Error bad_params: no journey is running/);
    const noGoal = await tools.journey({ start: true });
    expect(textOf(noGoal)).toMatch(/^Error bad_params: start needs a goal/);
    await start(tools);
    const again = await start(tools);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/^Error bad_params: a journey is already running \("change the settings"\)/);
    const noReached = await tools.journey({ stop: true });
    expect(textOf(noReached)).toMatch(/^Error bad_params: stop needs reached/);
    // the journey survived those: it still stops properly
    expect(textOf(await tools.journey({ stop: true, reached: false }))).toMatch(/^Journey "change the settings" as a first-timer: not reached/);
  });

  it("refuses arguments that belong to the other call", async () => {
    const { tools } = await setup();
    expect(textOf(await tools.journey({ goal: "x" }))).toMatch(/^Error bad_params: goal go with start: true/);
    expect(textOf(await tools.journey({ reached: true }))).toMatch(/^Error bad_params: reached go with stop: true/);
    expect(textOf(await tools.journey({ start: true, stop: true }))).toMatch(/^Error bad_params: give start or stop, not both/);
    expect(textOf(await tools.journey({}))).toMatch(/^Error bad_params: give start: true/);
  });

  it("needs a connected app", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
    const said = await start(tools);
    expect(said.isError).toBe(true);
    expect(textOf(said)).toMatch(/^Error not_connected/);
  });

  it("stop answers the summary line and clears the journey", async () => {
    const { tools, advance } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Settings" } });
    await tools.waitFor({ text: "Dark mode" });
    advance(106_000);
    const said = textOf(await tools.journey({ stop: true, reached: true, why: "found Dark mode" }));
    const lines = said.split("\n");
    expect(lines[0]).toBe('Journey "change the settings" as a first-timer: reached in 1 tap, 1 min 51 s (5 s waiting), 0 wrong turns, 0 hesitations.');
    expect(said).toContain("Why: found Dark mode");
    expect(tools.currentJourney()).toBeUndefined();
    expect(tools.finishedJourney()?.reached).toBe(true);
    // a new one can start
    expect((await start(tools)).isError).not.toBe(true);
  });

  it("validates export and says it comes later", async () => {
    const { tools } = await setup();
    await start(tools);
    expect(textOf(await tools.journey({ export: { to: "issue", repo: "owner/repo" } }))).toMatch(/^Error bad_params: export go with stop/);
    const said = textOf(await tools.journey({ stop: true, reached: true, export: { to: "pr", repo: "owner/repo", pr: 12 } }));
    expect(said).toContain("Export comes later");
  });

  it("hands the report writer's hook the state and shows its lines after the summary", async () => {
    let seen: JourneyState | undefined;
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: true, result: { screen: SCREEN, elements: HOME } }));
    apps.push(app);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      onJourneyStop: (state) => {
        seen = state;
        return ["Findings: none.", "Report: /somewhere"];
      },
    });
    await start(tools);
    const said = textOf(await tools.journey({ stop: true, reached: true })).split("\n");
    expect(said[1]).toBe("Findings: none.");
    expect(said[2]).toBe("Report: /somewhere");
    expect(seen?.goal).toBe("change the settings");
    expect(seen?.screens).toHaveLength(1);
  });

  it("turns the user's eyes off for the rest of the journey, once, and says so in the summary", async () => {
    const { app, tools } = await setup();
    await start(tools);
    expect(textOf(await tools.journey({ eyes: "agent" }))).toMatch(/^Eyes: the agent's from now on/);
    expect(textOf(await tools.journey({ eyes: "agent" }))).toBe("Already in the agent's eyes.");
    expect((await tools.journey({ eyes: "user" })).isError).toBe(true);
    const looked = textOf(await tools.look({ screenshot: false }));
    expect(looked).toContain("id=open-settings");
    expect(app.requests.filter((r) => r.method === "tree").at(-1)?.params).not.toHaveProperty("glass");
    expect(textOf(await tools.journey({ stop: true, reached: false }))).toContain("Eyes: the agent's, not a user's");
  });

  it("stress is accepted in shape but not built yet", async () => {
    const { tools } = await setup();
    expect(textOf(await tools.journey({ stress: { kind: "background" } }))).toMatch(/^Error bad_params: no journey is running/);
    await start(tools);
    const said = await tools.journey({ stress: { kind: "network", mode: "offline" }, survives: { text: "2 eggs" } });
    expect(said.isError).toBe(true);
    expect(textOf(said)).toMatch(/^Error unsupported: stress moments are not in this build yet/);
  });
});

describe("a user's eyes", () => {
  it("asks the app for the glass only, and the header says more below only where a view can scroll", async () => {
    const { app, tools, world } = await setup();
    await start(tools);
    expect(app.requests.find((r) => r.method === "tree")?.params).toMatchObject({ glass: true });
    // no counts: the plain tree's `+3 below` never shows
    expect(textOf(await tools.look({ screenshot: false }))).not.toMatch(/\+\d+ below/);
    world.moreBelow = false;
    const header = textOf(await tools.look({ screenshot: false })).split("\n")[0];
    expect(header).toBe("Screen 402x874 pt @3x · 4 elements");
  });

  it("says more above and more below with no numbers", () => {
    const tree = { screen: SCREEN, elements: [], glass: { moreAbove: true, moreBelow: true }, offScreen: { above: 2, below: 5 } };
    expect(formatTree(tree, undefined, { eyes: true }).split("\n")[0]).toBe("Screen 402x874 pt @3x · 0 elements (more below, more above)");
    expect(formatTree(tree).split("\n")[0]).toContain("+5 below, +2 above");
  });

  it("shows no ids, shows icon-only buttons with their VoiceOver label, and keeps the placeholder", async () => {
    const { tools } = await setup();
    const lines = textOf(await start(tools)).split("\n");
    expect(lines.some((line) => line.includes("id="))).toBe(false);
    expect(lines).toContain("e2 button \"Settings\" @24,120 354x48");
    expect(lines).toContain('e3 button (icon only) (VoiceOver: "Search") @340,60 40x40');
    expect(lines.find((line) => line.startsWith("e4 input"))).toBe('e4 input placeholder="Your name" @24,200 354x48');
  });

  it("formats names as a person sees them", () => {
    const base: TreeElement = { ref: "e12", role: "button", label: "Settings", text: "", actions: ["press"] };
    expect(formatElement(base, { eyes: true })).toBe('e12 button (icon only) (VoiceOver: "Settings")');
    expect(formatElement({ ...base, label: null }, { eyes: true })).toBe("e12 button (icon only)");
    // visible text wins; a label that differs is not on the glass
    expect(formatElement({ ...base, text: "Open", testID: "x" }, { eyes: true })).toBe('e12 button "Open"');
    expect(formatElement({ ...base, text: "Open", testID: "x" })).toContain("id=x");
    expect(formatElement({ ref: "e5", role: "image", label: "Logo", text: "" }, { eyes: true })).toBe('e5 image (VoiceOver: "Logo")');
  });

  it("answers id and label targets with bad_params, on every tool that takes a target", async () => {
    const { app, tools } = await setup();
    await start(tools);
    const before = app.requests.length;
    const hidden = "Error bad_params: in a journey, ids and labels are hidden; use a ref or the visible text";
    for (const answer of [
      await tools.tap({ target: { id: "open-settings" } }),
      await tools.tap({ target: { label: "Search" } }),
      await tools.longPress({ target: { id: "open-settings" } }),
      await tools.typeText({ text: "x", target: { id: "name-input" } }),
      await tools.toggle({ target: { label: "Dark" } }),
      await tools.scroll({ target: { id: "list" } }),
      await tools.waitFor({ id: "open-settings" }),
      await tools.waitFor({ label: "Search" }),
      await tools.inspect({ target: { id: "open-settings" } }),
    ]) {
      expect(answer.isError).toBe(true);
      expect(textOf(answer)).toBe(hidden);
    }
    // nothing reached the app
    expect(app.requests.length).toBe(before);
  });

  it("lets ref, visible text and a point through", async () => {
    const { app, tools } = await setup();
    await start(tools);
    for (const target of [{ ref: "e2" }, { text: "Settings" }, { x: 100, y: 130 }]) {
      const answer = await tools.tap({ target, look: false });
      expect(answer.isError, JSON.stringify(target)).not.toBe(true);
    }
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(3);
  });

  it("sends noScroll with every touch, so nothing scrolls by itself; outside a journey it does not", async () => {
    const { app, tools } = await setup();
    await tools.tap({ target: { text: "Settings" }, look: false });
    expect(app.requests.at(-1)?.params).not.toHaveProperty("noScroll");
    await start(tools);
    await tools.tap({ target: { text: "Settings" }, look: false });
    await tools.longPress({ target: { text: "Settings" }, look: false });
    await tools.typeText({ text: "a", target: { ref: "e4" }, look: false });
    await tools.toggle({ target: { text: "Dark mode" }, look: false });
    const sent = app.requests.filter((r) => ["press", "longPress", "type", "toggle"].includes(r.method)).slice(-4);
    expect(sent).toHaveLength(4);
    for (const request of sent) expect(request.params, request.method).toMatchObject({ noScroll: true });
  });

  it('refuses scroll to: "target" and plain scrolls still work', async () => {
    const { app, tools } = await setup();
    await start(tools);
    const refused = await tools.scroll({ to: "target", target: { text: "Dark mode" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error not_allowed: in a journey, scroll to: "target" is off/);
    expect(app.requests.some((r) => r.method === "scroll")).toBe(false);
    expect((await tools.scroll({ direction: "down", look: false })).isError).not.toBe(true);
    expect(app.requests.some((r) => r.method === "scroll")).toBe(true);
  });

  it("wait_for matches what is on the glass only", async () => {
    const { app, tools } = await setup();
    await tools.waitFor({ text: "Home", look: false });
    expect(app.requests.at(-1)?.params).not.toHaveProperty("glass");
    await start(tools);
    await tools.waitFor({ text: "Home", look: false });
    expect(app.requests.at(-1)?.params).toMatchObject({ text: "Home", glass: true });
  });

  it("refuses open_url and app_command unless allow names them, and records the ones that went through", async () => {
    const { app, tools } = await setup();
    await start(tools, { allow: ["open_url", "sample_data"] });
    expect((await tools.openUrl({ url: "myapp://settings", look: false })).isError).not.toBe(true);
    expect((await tools.appCommand({ name: "sample_data", look: false })).isError).not.toBe(true);
    const refused = await tools.appCommand({ name: "login_as_test_user" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error not_allowed: in a journey, app_command "login_as_test_user" is a shortcut a user doesn't have/);
    expect(app.requests.some((r) => r.method === "command" && (r.params as { name: string }).name === "login_as_test_user")).toBe(false);
    expect(tools.currentJourney()?.state.shortcuts).toEqual([
      { tool: "open_url", what: "myapp://settings" },
      { tool: "app_command", what: "sample_data" },
    ]);
    const said = textOf(await tools.journey({ stop: true, reached: true }));
    expect(said).toContain('Shortcuts used (a person doesn\'t have these): open_url "myapp://settings", app_command "sample_data".');
  });

  it("refuses open_url without allow, and lets the app's command list be read", async () => {
    const { app, tools } = await setup({ onRequest: (req) => (req.method === "commands" ? { ok: true, result: { commands: [{ name: "x", description: "y" }] } } : undefined) });
    await start(tools);
    const refused = await tools.openUrl({ url: "myapp://settings" });
    expect(textOf(refused)).toMatch(/^Error not_allowed: in a journey, open_url is a shortcut a user doesn't have/);
    expect(app.requests.some((r) => r.method === "openURL")).toBe(false);
    expect(textOf(await tools.appCommand({}))).toContain("x: y");
  });

  it("outside a user's eyes (eyes: agent) shortcuts and ids are free", async () => {
    const { tools } = await setup();
    await start(tools, { eyes: "agent" });
    expect(textOf(await tools.look({ screenshot: false }))).toContain("id=open-settings");
    expect((await tools.openUrl({ url: "myapp://settings", look: false })).isError).not.toBe(true);
    expect((await tools.tap({ target: { id: "open-settings" }, look: false })).isError).not.toBe(true);
    expect(tools.currentJourney()?.state.shortcuts).toEqual([]);
  });

  it("removes ids from errors the app composed", async () => {
    const { tools } = await setup();
    await start(tools);
    const said = textOf(await tools.tap({ target: { text: "Missing" } }));
    expect(said).toContain('Closest: e2 button "Settings".');
    expect(said).not.toContain("id=");
    expect(withoutIds('a id=save, b id=x.y) c id=z.')).toBe("a, b) c.");
  });

  it("change answers follow the same filter: no ids, nothing that changed out of view", () => {
    const element: TreeElement = { ref: "e2", role: "button", text: "Done", testID: "done", label: "Finish", actions: ["press"] };
    const tree = {
      screen: SCREEN,
      elements: [element],
      glass: { moreAbove: false, moreBelow: false },
      changes: {
        sameRoute: true,
        added: ["e2"],
        removed: [{ ref: "e9", role: "button", text: "", label: "Close", testID: "close" }],
        changed: [{ ref: "e2", was: { label: "Old label" } }],
        moved: [],
        offScreen: [{ element: { ...element, ref: "" }, was: { text: "Before" } }],
        offScreenMore: 2,
      },
    };
    const eyes = formatChanges(tree, { eyes: true }) ?? "";
    expect(eyes).toBe(['Same screen. Changes:', '+ e2 button "Done" @' + "", '- button (icon only) (VoiceOver: "Close")'].join("\n").replace(" @", ""));
    const agent = formatChanges(tree, {}) ?? "";
    expect(agent).toContain("id=done");
    expect(agent).toContain("off screen");
  });

  it("run is checked before it starts: an id or label in a step, an expectation, a jump, a shortcut", async () => {
    const { app, tools } = await setup();
    await start(tools);
    const before = app.requests.length;
    const cases: Array<[Record<string, unknown>[], RegExp]> = [
      [[{ tool: "tap", target: { text: "Settings" } }, { tool: "tap", target: { id: "x" } }], /^Error bad_params: step 2: in a journey, ids and labels are hidden/],
      [[{ tool: "tap", target: { text: "Settings" }, expect: { id: "dark-mode" } }], /^Error bad_params: step 1: in a journey, ids and labels are hidden/],
      [[{ tool: "wait_for", label: "Search" }], /^Error bad_params: step 1: in a journey, ids and labels are hidden/],
      [[{ tool: "scroll", to: "target", target: { text: "x" } }], /^Error not_allowed: step 1: in a journey, scroll to: "target" is off/],
      [[{ tool: "open_url", url: "myapp://x" }], /^Error not_allowed: step 1: in a journey, open_url is a shortcut/],
      [[{ tool: "app_command", name: "x" }], /^Error not_allowed: step 1: in a journey, app_command "x" is a shortcut/],
    ];
    for (const [steps, pattern] of cases) {
      const answer = await tools.run({ steps: steps as never });
      expect(answer.isError).toBe(true);
      expect(textOf(answer)).toMatch(pattern);
    }
    // not one step touched the app
    expect(app.requests.slice(before).filter((r) => r.method !== "tree")).toEqual([]);
  });

  it("run steps work, and each counts as the call it is", async () => {
    const { tools } = await setup();
    await start(tools);
    const answer = await tools.run({ steps: [{ tool: "tap", target: { text: "Settings" } }, { tool: "tap", target: { text: "Dark mode" } }], look: false });
    expect(answer.isError).not.toBe(true);
    expect(tools.currentJourney()?.state.measures.taps).toBe(2);
    expect(tools.currentJourney()?.state.steps.map((s) => s.tool)).toEqual(["tap", "tap"]);
  });
});

describe("measures", () => {
  it("counts taps, typing and scrolls, and keeps the steps with their targets", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Settings" }, look: false });
    await tools.longPress({ target: { text: "Dark mode" }, look: false });
    await tools.typeText({ text: "secret words", target: { ref: "e4" }, look: false });
    await tools.scroll({ direction: "down", look: false });
    const state = tools.currentJourney()?.state;
    expect(state?.measures).toMatchObject({ taps: 2, typing: 1, scrolls: 1 });
    expect(state?.steps.map((s) => [s.tool, s.target])).toEqual([
      ["tap", '"Settings"'],
      ["long_press", '"Dark mode"'],
      ["type_text", "e4"],
      ["scroll", undefined],
    ]);
    // typed text is never kept
    expect(JSON.stringify(state?.steps)).not.toContain("secret words");
  });

  it("counts screens by route and keeps each screen's first full list with its route", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Settings" } });
    await tools.tap({ target: { text: "Dark mode" } });
    await tools.back({});
    const state = tools.currentJourney()?.state;
    expect(state?.measures.screensEntered).toBe(3);
    expect(state?.screens.map((s) => s.route)).toEqual([["home"], ["settings"]]);
    expect(state?.screens[0]?.firstList).toContain("button \"Settings\"");
    expect(state?.screens[1]?.firstList).toContain('header "Settings"');
    expect(state?.screens[0]?.visits).toBe(2);
    expect(state?.currentScreen).toBe(1);
  });

  it("separates time from waits: wait_for and the Settled time", async () => {
    const { tools, advance } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Dark mode" } }); // Settled in 0.31 s
    await tools.waitFor({ text: "Done" }); // the app waited 5 s
    advance(34_000);
    const state = tools.currentJourney()?.state;
    expect(state?.measures.waitMs).toBe(5000 + 310);
    const finished = (await tools.journey({ stop: true, reached: true })) && tools.finishedJourney();
    expect(finished?.endedAt).toBeDefined();
    expect(summaryLine(finished as JourneyState)).toBe('Journey "change the settings" as a first-timer: reached in 1 tap, 39 s (5 s waiting), 0 wrong turns, 0 hesitations.');
  });

  it("counts a wrong turn: a screen entered, then left by back without acting on it", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Settings" } }); // enters settings
    await tools.back({}); // leaves it, nothing done there
    expect(tools.currentJourney()?.state.measures.wrongTurns).toBe(1);
    await tools.tap({ target: { text: "Settings" } });
    await tools.tap({ target: { text: "Dark mode" } }); // acts on it
    await tools.back({});
    expect(tools.currentJourney()?.state.measures.wrongTurns).toBe(1);
  });

  it("backing out of the first screen is no wrong turn, and a sheet that closes is none either", () => {
    const journey = new Journey({ goal: "x" }, () => 0);
    journey.noteFullList({ route: ["home"], text: "list", fromAction: false });
    journey.record({ tool: "back", ok: true, text: "Went back from home.", at: 0, ms: 1 }, journey.pre());
    journey.noteFullList({ route: ["a"], text: "list", fromAction: true });
    journey.record({ tool: "back", ok: true, text: "Closed the sheet.", at: 0, ms: 1 }, journey.pre());
    expect(journey.state.measures.wrongTurns).toBe(0);
  });

  it("counts dead ends (not_actionable, refusals) and errors hit (not_found, crash notes)", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Covered" } }); // not_actionable
    await tools.openUrl({ url: "myapp://x" }); // refused: not_allowed
    await tools.tap({ target: { text: "Missing" } }); // not_found
    await tools.tap({ target: { id: "x" } }); // bad_params: neither
    const m = tools.currentJourney()?.state.measures;
    expect(m).toMatchObject({ deadEnds: 2, errors: 1 });
    const journey = new Journey({ goal: "x" }, () => 0);
    journey.record({ tool: "tap", ok: true, text: 'Tapped e1.\nNote: the app crashed: boom', at: 0, ms: 1 }, journey.pre());
    expect(journey.state.measures.errors).toBe(1);
  });

  it("counts a hesitation for two or more reads in a row with no action, once per run", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.look({ screenshot: false });
    expect(tools.currentJourney()?.state.measures.hesitations).toBe(0);
    await tools.look({ screenshot: false }); // second read in a row
    await tools.look({ screenshot: false });
    await tools.look({ screenshot: false });
    expect(tools.currentJourney()?.state.measures.hesitations).toBe(1);
    await tools.tap({ target: { text: "Settings" }, look: false });
    await tools.look({ screenshot: false });
    await tools.logs({});
    expect(tools.currentJourney()?.state.measures.hesitations).toBe(2);
    // a look right after the start answer is one read, not two
  });

  it("a wait between two reads does not break the run, an action does", () => {
    const journey = new Journey({ goal: "x" }, () => 0);
    const call = (tool: string): void => journey.record({ tool, ok: true, text: "", at: 0, ms: 0 }, journey.pre());
    call("look");
    call("wait_for");
    call("look");
    expect(journey.state.measures.hesitations).toBe(1);
    call("tap");
    call("look");
    expect(journey.state.measures.hesitations).toBe(1);
  });

  it("keeps the taps from the first screen to the goal, and none when it was not reached", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Settings" }, look: false });
    await tools.tap({ target: { text: "Dark mode" }, look: false });
    await tools.journey({ stop: true, reached: true });
    expect(tools.finishedJourney()?.tapsToGoal).toBe(2);
    await start(tools);
    await tools.tap({ target: { text: "Settings" }, look: false });
    const said = textOf(await tools.journey({ stop: true, reached: false, why: "no such setting" }));
    expect(said.split("\n")[0]).toMatch(/: not reached after 1 tap, /);
    expect(tools.finishedJourney()?.tapsToGoal).toBeNull();
  });

  it("dry runs and calls the journey doesn't count are not measured", async () => {
    const { tools } = await setup();
    await start(tools);
    await tools.tap({ target: { text: "Settings" }, dry_run: true });
    await tools.sessionReport();
    expect(tools.currentJourney()?.state.steps).toEqual([]);
  });

  it("tells the report's hook about every counted call", async () => {
    const { tools } = await setup();
    await start(tools);
    const seen: string[] = [];
    tools.currentJourney()?.onStep((step) => seen.push(`${step.n}:${step.tool}:${step.ok}`));
    await tools.tap({ target: { text: "Settings" }, look: false });
    await tools.tap({ target: { text: "Missing" }, look: false });
    expect(seen).toEqual(["1:tap:true", "2:tap:false"]);
  });

  it("words the time", () => {
    expect(formatDuration(52_000)).toBe("52 s");
    expect(formatDuration(112_000)).toBe("1 min 52 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(0)).toBe("0 s");
  });
});

describe("conditions", () => {
  const commands = (app: FakeApp): Array<{ name: string; args: Record<string, unknown> }> =>
    app.requests.filter((r) => r.method === "command").map((r) => r.params as { name: string; args: Record<string, unknown> });

  it("applies them at the start through the app's commands, and undoes them at the stop", async () => {
    const { app, tools } = await setup();
    const said = textOf(await start(tools, { conditions: { network: "3g", language: "ar", region: "QA", text_size: "xl" } }));
    expect(commands(app)).toEqual([
      { name: "network", args: { mode: "3g" } },
      { name: "language", args: { language: "ar" } },
      { name: "region", args: { region: "QA" } },
      { name: "text_size", args: { size: "xl" } },
    ]);
    expect(said.split("\n")[1]).toBe("Conditions: network 3g, language ar, region QA, text size xl.");
    const stopped = textOf(await tools.journey({ stop: true, reached: true }));
    expect(commands(app).slice(4)).toEqual([
      { name: "network", args: { mode: "normal" } },
      { name: "language", args: { language: "en" } },
      { name: "text_size", args: { size: "system" } },
    ]);
    expect(stopped).toContain("Undone: network is normal again.");
    expect(stopped).toContain("Undone: language is en again.");
    expect(stopped).toContain("Undone: text size is the phone's own again.");
    // the app didn't say what the region was
    expect(stopped).toContain("Note: region QA was not restored: the app doesn't report what it was before.");
  });

  it("applies none without conditions, and does not count them as the agent's calls or shortcuts", async () => {
    const { app, tools } = await setup();
    await start(tools, { conditions: { network: "offline" } });
    expect(commands(app)).toHaveLength(1);
    expect(tools.currentJourney()?.state.steps).toEqual([]);
    expect(tools.currentJourney()?.state.shortcuts).toEqual([]);
  });

  it("says when one is not applied, and does not undo that one", async () => {
    const { app, tools } = await setup({
      onRequest: (req) =>
        req.method === "command" && (req.params as { name: string }).name === "text_size"
          ? { ok: false, error: { code: "unsupported", message: "this app doesn't use useTaplineFontScale" } }
          : undefined,
    });
    const said = textOf(await start(tools, { conditions: { text_size: "ax3", network: "lossy" } }));
    expect(said).toContain("Note: condition text_size ax3 was not applied: this app doesn't use useTaplineFontScale");
    expect(said).toContain("Conditions: network lossy.");
    await tools.journey({ stop: true, reached: false });
    expect(commands(app).filter((c) => c.name === "text_size")).toHaveLength(1);
    expect(commands(app).at(-1)).toEqual({ name: "network", args: { mode: "normal" } });
  });

  it("a policy that blocks network stops that condition and nothing else", async () => {
    const { app, tools } = await setup({ policy: { version: 1, confirm: [], block: ["network"] } });
    const said = textOf(await start(tools, { conditions: { network: "offline", text_size: "l" } }));
    expect(said).toContain("Note: condition network offline was not applied: blocked: the safety policy blocks network here");
    expect(commands(app)).toEqual([{ name: "text_size", args: { size: "l" } }]);
  });

  it("undoes them even when the journey was not reached", async () => {
    const { app, tools } = await setup();
    await start(tools, { conditions: { network: "offline" } });
    await tools.journey({ stop: true, reached: false });
    expect(commands(app).at(-1)).toEqual({ name: "network", args: { mode: "normal" } });
  });
});
