import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { BRIEF_MAX_LINES, briefLines, briefScreen, isActionable, orderForCut } from "../src/brief.js";
import { parseCli, runtimeOptionsOf } from "../src/cli.js";
import { callTool } from "../src/dispatch.js";
import type { TreeElement } from "../src/protocol.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §13.4 and 1.13.1 item 1: `brief` answers.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const runtimes: Runtime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

function lines(count: number, make: (i: number) => string): string[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

const el = (over: Partial<TreeElement> & { ref: string }): TreeElement => ({
  type: "Pressable",
  role: "button",
  text: "",
  frame: { x: 10, y: 10, width: 100, height: 40 },
  actions: ["press"],
  ...over,
});

describe("briefLines", () => {
  it("cuts a change block at 12 lines and says how many", () => {
    const changes = lines(15, (i) => `~ e${i} button "B${i}" (was "A")`);
    const out = briefLines({ first: "Tapped e1.", label: "Same screen. Changes:", changes, fixed: [] });
    expect(out.slice(0, 2)).toEqual(["Tapped e1.", "Same screen. Changes:"]);
    expect(out.slice(2, 2 + BRIEF_MAX_LINES)).toEqual(changes.slice(0, 12));
    expect(out.at(-1)).toBe("…3 more: look shows them.");
    expect(out).toHaveLength(2 + 12 + 1);
  });

  it("leaves a block of 12 lines whole", () => {
    const changes = lines(12, (i) => `~ e${i} button "B${i}" (was "A")`);
    const out = briefLines({ first: "x", changes, fixed: [] });
    expect(out).toEqual(["x", ...changes]);
  });

  it("keeps + text lines ahead of ~ and ↕ when it cuts", () => {
    const moved = lines(14, (i) => `~ e${i} button "B${i}" (was "A")`);
    const text = '+ e90 text "Wrong password" @20,300 200x20';
    const ordered = orderForCut([...moved, text, "↕ e5 button \"Go\" @1,2 3x4"]);
    expect(ordered[0]).toBe(text);
    const out = briefLines({ first: "x", changes: [...moved, text], fixed: [] });
    expect(out[1]).toBe(text);
    expect(out.at(-1)).toBe("…3 more: look shows them.");
  });

  it("does not reorder a block that fits", () => {
    const changes = ['~ e1 button "A" (was "B")', '+ e2 text "Hello"'];
    expect(briefLines({ first: "x", changes, fixed: [] })).toEqual(["x", ...changes]);
  });

  it("a new screen lists new text, headers and actionable elements, at most 12 together, then the …n more line", () => {
    const screen = {
      newText: lines(3, (i) => `e${i} text "T${i}"`),
      headers: ["e50 header \"Settings\""],
      actionable: lines(20, (i) => `e${100 + i} button "B${i}"`),
    };
    const out = briefLines({ first: "Tapped e1.", changes: [], screen, fixed: [] });
    expect(out.slice(1, 4)).toEqual(screen.newText);
    expect(out[4]).toBe(screen.headers[0]);
    expect(out).toHaveLength(1 + 12 + 1);
    expect(out.at(-1)).toBe("…12 more: look shows them.");
  });

  it("never cuts Alert:, Network:, Keyboard:, Place:, Note:, Error and Reflex: lines", () => {
    const changes = lines(30, (i) => `~ e${i} button "B${i}" (was "A")`);
    const fixed = [
      'Alert: "Sure?" [OK]',
      "Keyboard: shown",
      "Network: 2 requests in flight",
      "Place: settings",
      "Note: a person used the app since your last look.",
      "Error not_found: gone",
      "Reflex: closed the rating popup",
    ];
    const out = briefLines({ first: "x", label: "Same screen. Changes:", changes, fixed });
    for (const line of fixed) expect(out).toContain(line);
    const asScreen = briefLines({
      first: "x",
      changes: [],
      screen: { newText: [], headers: [], actionable: lines(30, (i) => `e${i} button "B"`) },
      fixed,
    });
    for (const line of fixed) expect(asScreen).toContain(line);
    // The header lines stand above the block and the notes close the answer.
    expect(out.indexOf("Keyboard: shown")).toBeLessThan(out.indexOf(changes[0] as string));
    expect(out.indexOf("Note: a person used the app since your last look.")).toBeGreaterThan(out.indexOf("…18 more: look shows them."));
  });

  it("puts the Place: line right after the first line", () => {
    const out = briefLines({ first: "Tapped e1.", place: "Place: language", label: "Same screen. Changes:", changes: ["No visible change."], fixed: [] });
    expect(out.slice(0, 3)).toEqual(["Tapped e1.", "Place: language", "Same screen. Changes:"]);
  });
});

describe("actionable elements", () => {
  it("list rows, radios and checkboxes count as actionable (1.13.1 item 1)", () => {
    expect(isActionable(el({ ref: "e1", role: "cell", type: "View", actions: [] }))).toBe(true);
    expect(isActionable(el({ ref: "e2", role: "radio", type: "View", actions: [] }))).toBe(true);
    expect(isActionable(el({ ref: "e3", role: "checkbox", type: "View", actions: [] }))).toBe(true);
    // Any pressable element counts, whatever its role.
    expect(isActionable(el({ ref: "e4", role: "text", type: "Text", text: "Terms", actions: ["press"] }))).toBe(true);
    expect(isActionable(el({ ref: "e5", role: "link", type: "Text", actions: ["press"] }))).toBe(true);
  });

  it("text, images and headers are not actionable", () => {
    expect(isActionable(el({ ref: "e1", role: "text", type: "Text", text: "Hi", actions: [] }))).toBe(false);
    expect(isActionable(el({ ref: "e2", role: "image", type: "Image", actions: [] }))).toBe(false);
    expect(isActionable(el({ ref: "e3", role: "header", type: "Text", text: "Title", actions: [] }))).toBe(false);
  });

  it("briefScreen sorts a screen into headers, actionable elements and new text", () => {
    const elements = [
      el({ ref: "e1", role: "header", type: "Text", text: "Log in", actions: [] }),
      el({ ref: "e2", role: "text", type: "Text", text: "Wrong password", actions: [] }),
      el({ ref: "e3", role: "text", type: "Text", text: "Already here", actions: [] }),
      el({ ref: "e4", role: "cell", type: "View", text: "Row", actions: [] }),
      el({ ref: "e5", role: "radio", type: "View", text: "Choice", actions: [] }),
    ];
    const previous = [el({ ref: "e9", role: "text", type: "Text", text: "Already here", actions: [] })];
    const parts = briefScreen(elements, previous);
    expect(parts.headers).toHaveLength(1);
    expect(parts.newText).toEqual(['e2 text "Wrong password" @10,10 100x40']);
    expect(parts.actionable.map((l) => l.split(" ")[1])).toEqual(["cell", "radio"]);
  });
});

// ---- through the tools ------------------------------------------------------

const BUTTON = (i: number): Record<string, unknown> => ({
  ref: `e${i}`,
  type: "Pressable",
  role: "button",
  text: `Button ${i}`,
  frame: { x: 20, y: 40 + i * 50, width: 200, height: 44 },
  actions: ["press"],
});
const SAVE = { ref: "e1", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 20, y: 40, width: 200, height: 44 }, actions: ["press"] };
const SCREEN = { width: 430, height: 932, scale: 3 };

function wantsChanges(req: IncomingRequest): boolean {
  return typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
}

interface Scene {
  list: unknown[];
  changes?: unknown;
  extra?: Record<string, unknown>;
}

async function setup(scene: () => Scene, options: Partial<ToolsOptions> = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "tree") {
      const now = scene();
      return { ok: true, result: { screen: SCREEN, elements: now.list, ...(now.extra ?? {}), ...(wantsChanges(req) && now.changes !== undefined ? { changes: now.changes } : {}) } };
    }
    return { ok: true, result: { element: SAVE, settledMs: 120 } };
  };
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, ...options });
  await tools.look({ screenshot: false });
  return { tools, app };
}

const SAME = { sameRoute: true, added: [] as string[], removed: [] as unknown[], changed: [] as unknown[], moved: [] as string[] };

describe("brief answers through the tools", () => {
  it("a same-screen answer is the first line, the block capped at 12 lines, and the never-cut lines", async () => {
    const buttons = lines(40, (i) => String(i + 10)).map((n) => BUTTON(Number(n)));
    const { tools } = await setup(() => ({
      list: buttons,
      changes: { ...SAME, changed: buttons.slice(0, 15).map((b) => ({ ref: b["ref"], was: { text: "Old" } })) },
      extra: { keyboard: true, network: { inFlight: 2 } },
    }));
    const answer = textOf(await tools.tap({ target: { id: "save" }, brief: true }));
    const rows = answer.split("\n");
    expect(rows[0]).toBe('Tapped e1 button "Save" id=save.');
    expect(rows).toContain("Same screen. Changes:");
    expect(rows.filter((r) => r.startsWith("~ "))).toHaveLength(12);
    expect(rows).toContain("…3 more: look shows them.");
    expect(rows).toContain("Network: 2 requests in flight");
    expect(answer).not.toContain("Settled in");
  });

  it("the Settled in line is in a normal answer and not in a brief one", async () => {
    const { tools } = await setup(() => ({ list: [SAVE], changes: SAME }));
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toMatch(/Settled in 0\.12 s\./);
    expect(textOf(await tools.tap({ target: { id: "save" }, brief: true }))).not.toMatch(/Settled in/);
  });

  it("a new screen shows its headers, its actionable elements and its new text, 12 lines at most", async () => {
    const buttons = lines(30, (i) => String(i + 10)).map((n) => BUTTON(Number(n)));
    let phase = 0;
    const { tools } = await setup(() =>
      phase === 0
        ? { list: [SAVE] }
        : {
            list: [
              { ref: "e2", type: "Text", role: "header", text: "Log in", frame: { x: 0, y: 0, width: 100, height: 20 }, actions: [] },
              { ref: "e3", type: "Text", role: "text", text: "Wrong password", frame: { x: 0, y: 30, width: 100, height: 20 }, actions: [] },
              ...buttons,
            ],
            changes: { ...SAME, sameRoute: false },
          },
    );
    phase = 1;
    const answer = textOf(await tools.tap({ target: { id: "save" }, brief: true }));
    const rows = answer.split("\n");
    expect(rows[0]).toBe('Tapped e1 button "Save" id=save.');
    // New text stays, even with 30 buttons on the screen.
    expect(rows[1]).toBe('e3 text "Wrong password" @0,30 100x20');
    expect(rows[2]).toMatch(/^e2 header "Log in"/);
    expect(rows).toContain("…20 more: look shows them.");
    expect(rows.filter((r) => /^e\d+ /.test(r))).toHaveLength(12);
    expect(answer).not.toContain("Screen 430x932");
  });

  it("list rows and radios show on a new screen", async () => {
    let phase = 0;
    const { tools } = await setup(() =>
      phase === 0
        ? { list: [SAVE] }
        : {
            list: [
              { ref: "e2", type: "View", role: "cell", text: "English", frame: { x: 0, y: 0, width: 300, height: 44 }, actions: ["press"] },
              { ref: "e3", type: "View", role: "radio", text: "Arabic", frame: { x: 0, y: 50, width: 300, height: 44 }, actions: [] },
            ],
            changes: { ...SAME, sameRoute: false },
          },
    );
    phase = 1;
    const answer = textOf(await tools.tap({ target: { id: "save" }, brief: true }));
    expect(answer).toContain('e2 cell "English"');
    expect(answer).toContain('e3 radio "Arabic"');
  });

  it("look is never brief, with --brief on", async () => {
    const { tools } = await setup(() => ({ list: [SAVE] }), { brief: true });
    const answer = textOf(await tools.look({ screenshot: false }));
    expect(answer).toMatch(/^Screen 430x932/);
    expect(answer).toContain("App:");
  });

  it("brief: true on look is bad_params", async () => {
    const { tools } = await setup(() => ({ list: [SAVE] }));
    const answer = await callTool(tools, "look", { brief: true });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: look doesn't take brief; it takes /);
  });

  it("the server's --brief is the default and brief: false beats it", async () => {
    const { tools } = await setup(() => ({ list: [SAVE], changes: SAME }), { brief: true });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).not.toMatch(/Settled in/);
    expect(textOf(await tools.tap({ target: { id: "save" }, brief: false }))).toMatch(/Settled in/);
  });

  it("run with brief: true answers its lines briefly and a step's own brief is ignored", async () => {
    const buttons = lines(40, (i) => String(i + 10)).map((n) => BUTTON(Number(n)));
    const { tools } = await setup(() => ({
      list: buttons,
      changes: { ...SAME, changed: buttons.slice(0, 15).map((b) => ({ ref: b["ref"], was: { text: "Old" } })) },
    }));
    const answer = textOf(
      await tools.run({
        steps: [
          { tool: "tap", target: { id: "save" }, brief: true },
          { tool: "tap", target: { id: "save" } },
        ],
        brief: true,
      }),
    );
    const rows = answer.split("\n");
    expect(rows[0]).toMatch(/^Ran 2 of 2 steps in /);
    expect(rows.filter((r) => r.startsWith("~ "))).toHaveLength(12);
    expect(rows).toContain("…3 more: look shows them.");
    expect(answer).not.toMatch(/Settled in/);
  });

  it("a step's brief on a tool without it is dropped like look, and not-brief run is unchanged", async () => {
    const { tools } = await setup(() => ({ list: [SAVE], changes: SAME }));
    const answer = textOf(await tools.run({ steps: [{ tool: "wait", seconds: 0.1, brief: true }] }));
    expect(answer).toMatch(/^Ran 1 of 1 steps/);
  });

  it("run with brief: false under --brief answers in full", async () => {
    const { tools } = await setup(() => ({ list: [SAVE], changes: SAME }), { brief: true });
    expect(textOf(await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }], brief: false }))).toContain("Same screen. Changes:");
  });

  it("a tool that isn't brief ignores --brief (wait answers its changes whole)", async () => {
    const { tools } = await setup(() => ({ list: [SAVE], changes: SAME }), { brief: true });
    expect(textOf(await tools.wait({ seconds: 0.1 }))).toContain("Same screen. Changes:");
  });
});

describe("tool text", () => {
  it("the instructions carry TOOL-TEXT's brief bullet after the Settled in line", async () => {
    const { CORE_INSTRUCTIONS } = await import("../src/tool-text-data.js");
    const settled = CORE_INSTRUCTIONS.indexOf("`Settled in 0.31 s.`");
    const brief = CORE_INSTRUCTIONS.indexOf("- `brief: true` on an action, `run` or `drive` cuts the answer to its first line");
    expect(settled).toBeGreaterThan(-1);
    expect(brief).toBeGreaterThan(settled);
    expect(CORE_INSTRUCTIONS).toContain("then `…<n> more: look shows them.`; a new screen shows its headers, its actionable elements and its new text.");
  });

  it("brief is on the shapes of the action tools and not on look", async () => {
    const { toolShapes } = await import("../src/tools.js");
    for (const name of ["tap", "long_press", "type_text", "scroll", "toggle", "back", "swipe", "open_url", "app_command", "wait_for", "run"] as const) {
      expect(Object.keys(toolShapes[name])).toContain("brief");
    }
    expect(Object.keys(toolShapes.look)).not.toContain("brief");
  });
});

describe("a new screen in brief keeps the off-screen count", () => {
  async function newScreen(extra: Record<string, unknown>, options: Partial<ToolsOptions> = {}): Promise<string[]> {
    let phase = 0;
    const { tools } = await setup(
      () =>
        phase === 0
          ? { list: [SAVE] }
          : {
              list: [{ ref: "e2", type: "Text", role: "header", text: "Log in", frame: { x: 0, y: 0, width: 100, height: 20 }, actions: [] }, BUTTON(3)],
              changes: { ...SAME, sameRoute: false },
              extra,
            },
      options,
    );
    phase = 1;
    return textOf(await tools.tap({ target: { id: "save" }, brief: true })).split("\n");
  }

  it("says (+N below) when there is more below, and (+N above) when above", async () => {
    const rows = await newScreen({ offScreen: { below: 41, above: 2 } });
    expect(rows).toContain("(+41 below, +2 above)");
    // It stands above the element lines, with the other never-cut lines.
    expect(rows.indexOf("(+41 below, +2 above)")).toBeLessThan(rows.findIndex((r) => r.startsWith("e2 header")));
  });

  it("leaves it out when both counts are zero or unknown", async () => {
    expect((await newScreen({ offScreen: { below: 0, above: 0 } })).some((r) => r.startsWith("(+"))).toBe(false);
    expect((await newScreen({})).some((r) => r.startsWith("(+"))).toBe(false);
  });

  it("is never cut, even when the new screen is", async () => {
    const buttons = lines(30, (i) => String(i + 10)).map((n) => BUTTON(Number(n)));
    let phase = 0;
    const { tools } = await setup(() =>
      phase === 0 ? { list: [SAVE] } : { list: buttons, changes: { ...SAME, sameRoute: false }, extra: { offScreen: { below: 7, above: 0 } } },
    );
    phase = 1;
    const rows = textOf(await tools.tap({ target: { id: "save" }, brief: true })).split("\n");
    expect(rows).toContain("(+7 below)");
    expect(rows).toContain("…18 more: look shows them.");
  });
});

describe("the first action after connecting, with 12 or more texts", () => {
  it("shows 12 lines of new text, then the count, and leaves the buttons to look", async () => {
    // No look first: the agent has no list, so every text is new and new text goes ahead of the rest.
    const { host, port } = await startHost();
    hosts.push(host);
    const texts = lines(15, (i) => `Line ${i}`).map((t, i) => ({ ref: `e${i + 10}`, type: "Text", role: "text", text: t, frame: { x: 0, y: 20 * i, width: 100, height: 18 }, actions: [] }));
    const { app } = await FakeApp.connect(port, {}, (req) => (req.method === "tree" ? { ok: true, result: { screen: SCREEN, elements: [...texts, SAVE, BUTTON(30)] } } : { ok: true, result: { element: SAVE, settledMs: 50 } }));
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const rows = textOf(await tools.tap({ target: { id: "save" }, brief: true })).split("\n");
    expect(rows[0]).toBe('Tapped e1 button "Save" id=save.');
    expect(rows.filter((r) => /^e\d+ text /.test(r))).toHaveLength(12);
    expect(rows.filter((r) => /^e\d+ button /.test(r))).toHaveLength(0);
    expect(rows.at(-1)).toBe("…5 more: look shows them.");
  });
});

describe("the --brief flag path", () => {
  it("parses --brief for mcp and for host, and leaves it out otherwise", () => {
    for (const command of ["mcp", "host"]) {
      expect(runtimeOptionsOf(parseCli([command, "--brief"]).values, {})).toMatchObject({ brief: true });
      expect(runtimeOptionsOf(parseCli([command]).values, {})).not.toHaveProperty("brief");
    }
  });

  it("createRuntime({ brief: true }) makes every client's actions brief, and brief: false still beats it", async () => {
    const home = mkdtempSync(join(tmpdir(), "tapline-brief-"));
    dirs.push(home);
    const answers: Record<string, string> = {};
    for (const brief of [true, false]) {
      const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, ...(brief ? { brief: true } : {}) });
      runtimes.push(runtime);
      const { app } = await FakeApp.connect(
        runtime.port,
        { token: runtime.config.token },
        (req) => (req.method === "tree" ? { ok: true, result: { screen: SCREEN, elements: [SAVE] } } : { ok: true, result: { element: SAVE, settledMs: 120 } }),
      );
      apps.push(app);
      const tools = runtime.toolsFor("agent");
      await tools.look({ screenshot: false });
      answers[`default ${brief}`] = textOf(await tools.tap({ target: { id: "save" } }));
      if (brief) answers["override"] = textOf(await tools.tap({ target: { id: "save" }, brief: false }));
    }
    expect(answers["default true"]).not.toMatch(/Settled in/);
    expect(answers["default false"]).toMatch(/Settled in/);
    expect(answers["override"]).toMatch(/Settled in/);
  });
});
