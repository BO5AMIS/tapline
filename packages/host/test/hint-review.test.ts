import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool } from "../src/dispatch.js";
import type { TaplineHost } from "../src/server.js";
import { APP, ROUTES, baseMap, button, flushDriveMaps, place, road, setupDrive, textOf, type Setup, type SetupOptions } from "./drive-helpers.js";
import { FakeApp, delay } from "./helpers.js";

// PR 16, Codex review cycle 1: the Known: line and the Hint: lines.

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
const look = async (s: Setup): Promise<string> => textOf(await callTool(s.tools, "look", { screenshot: false }));
const tapQuiet = async (s: Setup, id: string): Promise<string> => textOf(await callTool(s.tools, "tap", { target: { id }, look: false }));
const hintOf = (text: string): string | undefined => text.split("\n").find((line) => line.startsWith("Hint:"));

describe("1. a name a redaction would change is never printed", () => {
  it("leaves a vault value out of Known: and out of the way hint", async () => {
    const map = baseMap();
    map.places["synthetic_password"] = place(ROUTES.welcome);
    map.roads.push(road("language", "synthetic_password", "next-row", "Next"));
    const store = accountStore({ version: 1, accounts: { tester: { password: "synthetic_password" } } });
    const s = await setup({
      map,
      tools: { accounts: { store } },
      world: (w) => {
        w.elements.language = [button("e4", "next-row", "Next")];
        w.goes["language|next-row"] = "welcome";
      },
    });
    const first = await look(s);
    expect(first).toContain("Known:");
    expect(first).not.toContain("synthetic_password");
    const a = await tapQuiet(s, "general-row");
    const b = await tapQuiet(s, "language-row");
    const third = await tapQuiet(s, "next-row");
    expect(a + b + third).not.toContain("synthetic_password");
    expect(hintOf(third)).toBeUndefined();
  });
});

describe("2. places drive can't reach with no arguments", () => {
  it("leaves out a place whose way needs a link value", async () => {
    const map = baseMap();
    const first = map.roads[0];
    if (first === undefined) throw new Error("no road");
    first.move = { tool: "open_url", url: "wayfare://general/[id]" };
    const s = await setup({ map });
    const text = await look(s);
    expect(text).not.toMatch(/Known:.*language/);
    expect(textOf(await callTool(s.tools, "drive", { to: "language" }))).toContain("link needs id");
  });

  it("leaves out a place whose route needs an account", async () => {
    const map = baseMap();
    map.roads = [];
    map.routes = { login: "routes/login.json" };
    const s = await setup({ map });
    writeFileSync(
      join(s.folder, "routes/login.json"),
      JSON.stringify({ format: "agent-tools-script", version: 2, app: APP.id, name: "login", start: "settings", end: "language", variables: ["account"], steps: [{ tool: "type_text", target: { id: "password" }, text: "${account.password}" }] }),
    );
    expect(await look(s)).not.toMatch(/Known:.*language/);
  });
});

describe("3. the app reconnects within one agent session", () => {
  it("does not repeat the hint or the Known: line", async () => {
    const s = await setup();
    s.app.send({ type: "event", event: "error", data: { message: "Synthetic error", ts: Date.now() } });
    await delay(80);
    const first = await look(s);
    expect(hintOf(first)).toBeDefined();
    expect(first).toContain("Known:");
    const handler = s.app.handler;
    s.app.ws.terminate();
    await delay(30);
    const port = hosts[0]?.boundPort();
    if (port === undefined || port === null) throw new Error("no port");
    const next = await FakeApp.connect(port, { app: APP, capabilities: ["tree", "press", "logs", "dryRun", "place", "places", "move"] }, handler);
    apps.push(next.app);
    next.app.send({ type: "event", event: "error", data: { message: "Synthetic error again", ts: Date.now() } });
    await delay(80);
    const second = await look(s);
    expect(hintOf(second)).toBeUndefined();
    expect(second).not.toContain("Known:");
  });
});

describe("4. a user's-eyes journey", () => {
  it("gets no hint that names a map place", async () => {
    const map = baseMap();
    const start = map.places["settings"];
    if (start === undefined) throw new Error("no settings place");
    map.places["internal_destination"] = start;
    delete map.places["settings"];
    const firstRoad = map.roads[0];
    if (firstRoad === undefined) throw new Error("no road");
    firstRoad.from = "internal_destination";
    map.roads.push(road("language", "internal_destination", "back-row", "Back"));
    const s = await setup({
      map,
      world: (w) => {
        w.elements.language = [button("e4", "back-row", "Back")];
        w.goes["language|back-row"] = "settings";
      },
    });
    await callTool(s.tools, "journey", { start: true, goal: "Return to settings" });
    await look(s);
    const seen: string[] = [];
    for (const text of ["General", "Language", "Back"]) seen.push(textOf(await callTool(s.tools, "tap", { target: { text } })));
    expect(seen.join("\n")).not.toContain("internal_destination");
    expect(seen.join("\n")).not.toContain("Hint:");
  });
});

describe("5. the call count", () => {
  it("counts calls of tools that have no notes step", async () => {
    const s = await setup();
    for (let i = 0; i < 19; i++) await callTool(s.tools, "map", {});
    expect(hintOf(await look(s))).toBe("Hint: on a long task, the main session can hand the driving to one small, fast agent; if you are that agent, carry on.");
  });

  it("counts the steps of a run as one call", async () => {
    const s = await setup();
    for (let i = 0; i < 17; i++) await callTool(s.tools, "map", {});
    await callTool(s.tools, "run", { steps: [{ tool: "wait", seconds: 0.01 }, { tool: "wait", seconds: 0.01 }, { tool: "wait", seconds: 0.01 }] });
    expect(hintOf(await look(s))).toBeUndefined();
    expect(hintOf(await look(s))).toBeDefined();
  });
});

describe("CodeRabbit: the log watermark", () => {
  it("1. an error logged while logs waits for the app is still unread", async () => {
    const s = await setup();
    const inner = s.app.handler;
    s.app.handler = (req) => {
      if (req.method === "logs") s.app.send({ type: "event", event: "error", data: { message: "Late error", ts: Date.now() } });
      return inner(req);
    };
    await callTool(s.tools, "logs", {});
    await delay(80);
    expect(hintOf(await look(s))).toBe("Hint: the app logged an error: `logs` shows it.");
  });

  it("2. a logs call that filters the error out does not clear it", async () => {
    const s = await setup();
    s.app.send({ type: "event", event: "error", data: { message: "Render failed", ts: Date.now() } });
    s.app.send({ type: "event", event: "log", data: { level: "info", message: "heartbeat", ts: Date.now() } });
    await delay(80);
    const read = textOf(await callTool(s.tools, "logs", { grep: "heartbeat" }));
    expect(read).toContain("heartbeat");
    expect(hintOf(read)).toBeUndefined();
    expect(hintOf(await look(s))).toBe("Hint: the app logged an error: `logs` shows it.");
  });

  it("3. a plain look after an action whose answer had the changes counts as a picture", async () => {
    const s = await setup();
    await callTool(s.tools, "tap", { target: { id: "general-row" } });
    const text = textOf(await callTool(s.tools, "look", {}));
    expect(hintOf(text)).toBe("Hint: the text answer had the changes; ask for a screenshot only to judge how something looks.");
  });

  it("3. a look without a picture after an action does not", async () => {
    const s = await setup();
    await callTool(s.tools, "tap", { target: { id: "general-row" } });
    expect(hintOf(await look(s))).toBeUndefined();
  });
});

describe("CodeRabbit: overlapping calls", () => {
  it("4. a look in flight does not take the movement of a tap", async () => {
    const map = baseMap();
    map.roads.push(road("language", "settings", "back-row", "Back"));
    const s = await setup({
      map,
      world: (w) => {
        w.elements.language = [button("e4", "back-row", "Back")];
        w.goes["language|back-row"] = "settings";
      },
    });
    await look(s);
    await tapQuiet(s, "general-row");
    await tapQuiet(s, "language-row");
    const inner = s.app.handler;
    s.app.handler = (req) => {
      const reply = inner(req);
      if (reply === "ignore" || req.method !== "press") return reply;
      // The press answers late, so looks overlap the tap's end.
      setTimeout(() => s.app.send({ type: "response", id: req.id, ...reply }), 60);
      return "ignore";
    };
    let done = false;
    const tapped = tapQuiet(s, "back-row").finally(() => {
      done = true;
    });
    while (!done) {
      await look(s);
      await delay(1);
    }
    expect(hintOf(await tapped)).toBe('Hint: this way is known: `drive {"to": "settings"}` reaches settings in one call.');
  });
});

describe("cycle 2: Known: plans as drive does", () => {
  const route = (steps: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ format: "agent-tools-script", version: 2, app: APP.id, name: "login", start: "settings", end: "language", steps, ...extra });
  const typePassword = [{ tool: "type_text", target: { id: "password" }, text: "${account.password}" }];
  const knownOf = (text: string): string => text.split("\n").find((line) => line.startsWith("Known:")) ?? "";

  async function withRoute(file: string): Promise<Setup> {
    const map = baseMap();
    map.routes = { login: "routes/login.json" };
    const s = await setup({ map });
    writeFileSync(join(s.folder, "routes/login.json"), file);
    return s;
  }

  it("1. leaves out a place whose cheaper route needs an account the agent can't give", async () => {
    const s = await withRoute(route(typePassword, { variables: ["account"] }));
    const known = knownOf(await look(s));
    expect(known).toContain("general");
    expect(known).not.toContain("language");
    expect(textOf(await callTool(s.tools, "drive", { to: "language" }))).toMatch(/^Error bad_params:.*account/);
  });

  it("2. finds the need from the steps when variables are not declared", async () => {
    const s = await withRoute(route(typePassword));
    expect(knownOf(await look(s))).not.toContain("language");
    expect(textOf(await callTool(s.tools, "drive", { to: "language" }))).toMatch(/^Error bad_params:.*account/);
  });

  it("keeps a place whose route needs nothing", async () => {
    const s = await withRoute(route([{ tool: "tap", target: { id: "general-row" } }]));
    expect(knownOf(await look(s))).toContain("language");
  });
});

describe("cycle 2: rejected calls count", () => {
  it("3. a refused call counts toward the 20", async () => {
    const s = await setup();
    for (let i = 0; i < 19; i++) expect(textOf(await callTool(s.tools, "look", { unknown: true }))).toMatch(/^Error bad_params/);
    expect(hintOf(await look(s))).toContain("on a long task");
  });
});
