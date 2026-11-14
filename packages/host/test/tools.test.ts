import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import type { TaplineHost } from "../src/server.js";
import { ControlQueue } from "../src/control.js";
import { z } from "zod";
import { TaplineTools, targetSchema, toolShapes } from "../src/tools.js";
import { NO_POLICY } from "../src/policy.js";
import type { ViewerAction } from "../src/viewer.js";
import { FakeApp, TOKEN, startHost, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const TREE = {
  screen: { width: 402, height: 874, scale: 3 },
  elements: [
    {
      ref: "e3",
      type: "Pressable",
      role: "button",
      testID: "login-button",
      label: "Log in",
      text: "Log in",
      frame: { x: 24, y: 610, width: 354, height: 48 },
      actions: ["press", "longPress"],
    },
  ],
};
const SHOT = { mime: "image/jpeg", data: "QUJD", width: 600, height: 1305 };

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `<${block.type}>`))
    .join("\n");
}

function setup(handler: (req: IncomingRequest) => Reply) {
  return async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, handler);
    apps.push(app);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
    });
    return { host, app, tools };
  };
}

const defaultHandler = (req: IncomingRequest): Reply => {
  switch (req.method) {
    case "tree":
      return { ok: true, result: TREE };
    case "screenshot":
      return { ok: true, result: SHOT };
    case "press":
      return { ok: true, result: { element: TREE.elements[0] } };
    default:
      return { ok: true, result: {} };
  }
};

describe("target validation", () => {
  it("accepts exactly one kind of target", () => {
    expect(targetSchema.safeParse({ ref: "e1" }).success).toBe(true);
    expect(targetSchema.safeParse({ id: "a" }).success).toBe(true);
    expect(targetSchema.safeParse({ label: "a" }).success).toBe(true);
    expect(targetSchema.safeParse({ text: "a", index: 1 }).success).toBe(true);
    expect(targetSchema.safeParse({ x: 1, y: 2 }).success).toBe(true);
  });
  it("rejects none, several, half a point, or a stray index", () => {
    expect(targetSchema.safeParse({}).success).toBe(false);
    expect(targetSchema.safeParse({ ref: "e1", id: "a" }).success).toBe(false);
    expect(targetSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(targetSchema.safeParse({ ref: "e1", index: 0 }).success).toBe(false);
  });
});

describe("targets (AGENT-TOOLS §2)", () => {
  it("takes {id} and sends the app's testID; index works with id, label and text", () => {
    expect(targetSchema.safeParse({ id: "save" }).success).toBe(true);
    expect(targetSchema.safeParse({ id: "a", testID: "b" }).success).toBe(false);
    expect(targetSchema.safeParse({ x: 1, y: 2, index: 0 }).success).toBe(false);
    expect(targetSchema.safeParse({ id: "row", index: 2 }).success).toBe(true);
    expect(targetSchema.safeParse({ label: "Delete", index: 1 }).success).toBe(true);
    expect(targetSchema.safeParse({ ref: "e3", index: 1 }).success).toBe(false);
  });

  it("passes id and index on to the app", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.tap({ target: { id: "row", index: 2 }, look: false });
    expect(app.requests[0]).toMatchObject({ method: "press", params: { target: { testID: "row", index: 2 } } });
  });

  it("wait_for takes id", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.waitFor({ id: "done", look: false });
    expect(app.requests[0]).toMatchObject({ method: "waitFor", params: { testID: "done" } });
  });
});

describe("press", () => {
  it("ends an action's answer with how long the app took to settle, and doesn't wait on its own", async () => {
    const { tools } = await setup((req) =>
      req.method === "press" ? { ok: true, result: { element: TREE.elements[0], settledMs: 310 } } : defaultHandler(req),
    )();
    const started = Date.now();
    const text = textOf(await tools.tap({ target: { id: "login-button" } }));
    expect(text.trimEnd().split("\n").at(-1)).toBe("Settled in 0.31 s.");
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("puts the settle line before any Note: lines", async () => {
    const { tools } = await setup((req) =>
      req.method === "press"
        ? { ok: true, result: { element: TREE.elements[0], settledMs: 310 } }
        : req.method === "screenshot"
          ? { ok: false, error: { code: "unsupported", message: "no view-shot" } }
          : defaultHandler(req),
    )();
    const lines = textOf(await tools.tap({ target: { id: "login-button" }, screenshot: true })).split("\n");
    expect(lines.at(-2)).toBe("Settled in 0.31 s.");
    expect(lines.at(-1)).toMatch(/^Note: no screenshot/);
  });

  it("prints no settle line when the app doesn't report one, and only the first line without look", async () => {
    const { tools } = await setup(defaultHandler)();
    expect(textOf(await tools.tap({ target: { id: "login-button" } }))).not.toContain("Settled in");
    const { tools: tools2 } = await setup((req) =>
      req.method === "press" ? { ok: true, result: { element: TREE.elements[0], settledMs: 120 } } : defaultHandler(req),
    )();
    expect(textOf(await tools2.tap({ target: { id: "login-button" }, look: false }))).toBe('Tapped e3 button "Log in" id=login-button.');
  });

  it("an action answer reads like AGENT-TOOLS §3.1", async () => {
    const { tools } = await setup((req) =>
      req.method === "tree"
        ? {
            ok: true,
            result: { ...TREE, changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } },
          }
        : req.method === "press"
          ? { ok: true, result: { element: TREE.elements[0], settledMs: 310 } }
          : defaultHandler(req),
    )();
    await tools.look({ screenshot: false });
    const text = textOf(await tools.tap({ target: { id: "login-button" } }));
    const lines = text.split("\n");
    // The no-change note closes the answer, after the Settled line (AGENT-TOOLS 1.13 §3).
    expect(lines.at(-2)).toBe("Settled in 0.31 s.");
    expect(lines.at(-1)).toMatch(/^Note: the tap was delivered, and nothing on screen changed within 0.5 s./);
    expect(text).not.toContain("\n\n");
    expect(textOf(await tools.tap({ target: { id: "login-button" }, look: false })).split("\n")).toHaveLength(1);
    expect(lines[0]).toBe('Tapped e3 button "Log in" id=login-button.');
    expect(lines[1]).toBe("Same screen. Changes:");
    expect(text).not.toContain("Unchanged elements keep their refs");
  });

  it("returns the result line and the fresh element list, without a screenshot", async () => {
    const { app, tools } = await setup(defaultHandler)();
    const result = await tools.tap({ target: { id: "login-button" } });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('Tapped e3 button "Log in" id=login-button.');
    expect(text).toContain('e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]');
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    expect(app.requests.map((r) => r.method)).toEqual(["press", "tree"]);
    expect(app.requests[0]?.params).toEqual({ target: { testID: "login-button" } });
  });

  it("passes force through to press, long_press and toggle only when set", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.tap({ target: { ref: "e3" }, force: true, look: false });
    await tools.longPress({ target: { ref: "e3" }, force: true, look: false });
    await tools.toggle({ target: { ref: "e3" }, force: true, look: false });
    await tools.tap({ target: { ref: "e3" }, look: false });
    expect(app.requests.map((r) => r.params)).toEqual([
      { target: { ref: "e3" }, force: true },
      { target: { ref: "e3" }, force: true },
      { target: { ref: "e3" }, force: true },
      { target: { ref: "e3" } },
    ]);
  });

  it("passes force through to type_text only when set", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.typeText({ target: { ref: "e4" }, text: "Ann", force: true, look: false });
    await tools.typeText({ target: { ref: "e4" }, text: "Ann", look: false });
    expect(app.requests.map((r) => r.params)).toEqual([
      { target: { ref: "e4" }, text: "Ann", replace: true, submit: false, force: true },
      { target: { ref: "e4" }, text: "Ann", replace: true, submit: false },
    ]);
  });

  it("skips the look when look is false", async () => {
    const { app, tools } = await setup(defaultHandler)();
    const result = await tools.tap({ target: { ref: "e3" }, look: false });
    expect(textOf(result)).toBe('Tapped e3 button "Log in" id=login-button.');
    expect(app.requests.map((r) => r.method)).toEqual(["press"]);
  });

  it("reports not_found as a tool error with the app's message", async () => {
    const { tools } = await setup((req) =>
      req.method === "press"
        ? { ok: false, error: { code: "not_found", message: 'No element matches testID "nope"' } }
        : defaultHandler(req),
    )();
    const result = await tools.tap({ target: { id: "nope" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error not_found: No element matches testID "nope"');
  });

  it("lists candidates for ambiguous", async () => {
    const { tools } = await setup((req) =>
      req.method === "press"
        ? {
            ok: false,
            error: {
              code: "ambiguous",
              message: 'Text "Delete" matches 2 elements',
              candidates: [
                { ref: "e5", role: "button", text: "Delete", frame: { x: 0, y: 100, width: 80, height: 40 }, actions: ["press"] },
                { ref: "e9", role: "button", text: "Delete", frame: { x: 0, y: 300, width: 80, height: 40 }, actions: ["press"] },
              ],
            },
          }
        : defaultHandler(req),
    )();
    const result = await tools.tap({ target: { text: "Delete" } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error ambiguous");
    expect(text).toContain('e5 button "Delete" @0,100 80x40');
    expect(text).toContain('e9 button "Delete" @0,300 80x40');
    expect(text).toContain("index");
  });

  it("prints full element lines under Candidates, not bare refs, when the app sends both", async () => {
    const { tools } = await setup(() => ({
      ok: false,
      error: {
        code: "ambiguous",
        message: '2 elements match text "Nutrition": e32 text "Nutrition"; e57 tab "Nutrition". Use a ref or "index".',
        refs: ["e32", "e57"],
        candidates: [
          { ref: "e32", type: "Text", role: "text", testID: null, label: null, text: "Nutrition", value: null, frame: { x: 76, y: 733, width: 273, height: 23 }, actions: [], disabled: false, selected: false, checked: null },
          { ref: "e57", type: "Tab", role: "tab", testID: null, label: null, text: "Nutrition", value: null, frame: null, actions: ["press"], disabled: false, selected: false, checked: null },
        ],
      },
    }))();
    const text = textOf(await tools.tap({ target: { text: "Nutrition" } }));
    const lines = text.split("\n");
    const at = lines.indexOf("Candidates:");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 3)).toEqual(['  e32 text "Nutrition" @76,733 273x23', '  e57 tab "Nutrition"']);
    expect(lines[at + 3]).toBe('Retry with one of the refs, or add "index" (0-based).');
  });

  it("accepts refs-only candidates", async () => {
    const { tools } = await setup(() => ({
      ok: false,
      error: { code: "ambiguous", message: "2 matches", refs: ["e5", "e9"] },
    }))();
    const text = textOf(await tools.tap({ target: { text: "Delete" } }));
    expect(text).toContain("  e5");
    expect(text).toContain("  e9");
  });
});

describe("the live viewer's side of the tools", () => {
  const OVERLAY = {
    rev: 12,
    screen: { width: 400, height: 800, scale: 3 },
    elements: [{ ref: "e3", type: "button", label: "Log in", id: "login-button", frame: { x: 24, y: 610, width: 354, height: 48 } }],
  };
  const viewerHandler = (req: IncomingRequest): Reply => {
    if (req.method === "overlay") return { ok: true, result: OVERLAY };
    if (req.method === "scroll") return { ok: true, result: { element: TREE.elements[0], offset: { x: 0, y: 300 } } };
    if (req.method === "type") return { ok: true, result: { element: { ...TREE.elements[0], role: "textfield" }, value: "x" } };
    if (req.method === "longPress") return { ok: true, result: { element: TREE.elements[0] } };
    // A list: nothing in React Native's touch system takes the drag, so it scrolls.
    if (req.method === "swipe") return { ok: false, error: { code: "not_actionable", message: "no_action: Nothing took the swipe" } };
    return defaultHandler(req);
  };

  async function viewerTools() {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, viewerHandler);
    apps.push(app);
    const control = new ControlQueue({ idleMs: 50, giveUpMs: 2000 });
    const actions: ViewerAction[] = [];
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      control,
      onAction: (action) => actions.push(action),
      viewerLinks: () => ["http://127.0.0.1:7210/viewer?token=abc"],
    });
    return { app, tools, control, actions };
  }

  it("maps a person's tap, hold, drag, wheel, typing and keys onto the app's actions, in points", async () => {
    const { app, tools } = await viewerTools();
    const params = (method: string) => app.requests.filter((r) => r.method === method).map((r) => r.params);
    expect((await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.25], [90, 0.5, 0.25]] })).ok).toBe(true);
    expect(params("press")).toEqual([{ target: { x: 200, y: 200 } }]);
    await tools.personInput({ type: "gesture", points: [[0, 0.25, 0.5], [700, 0.25, 0.5]] });
    expect(params("longPress")).toEqual([{ target: { x: 100, y: 400 } }]);
    await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.75], [150, 0.5, 0.5], [300, 0.5, 0.25]] });
    expect(params("scroll").at(-1)).toEqual({ target: { x: 200, y: 600 }, direction: "down", amount: 400 });
    await tools.personInput({ type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: -0.1 });
    expect(params("scroll").at(-1)).toEqual({ target: { x: 200, y: 400 }, direction: "up", amount: 80 });
    await tools.personInput({ type: "text", text: "hi" });
    await tools.personInput({ type: "key", key: "enter" });
    await tools.personInput({ type: "key", key: "backspace" });
    expect(params("type")).toEqual([
      { text: "hi", replace: false, submit: false },
      { replace: false, submit: true },
      { backspace: 1, replace: false, submit: false },
    ]);
  });

  it("calls a path a tap under 10 points from its first point and a drag from there on (the viewer page uses the same number)", async () => {
    const { app, tools } = await viewerTools();
    const params = (method: string) => app.requests.filter((r) => r.method === method).map((r) => r.params);
    // The app is 400 x 800 points: 9 points across is 0.0225 of the width, 11 points is 0.0275.
    await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.25], [60, 0.5225, 0.25]] });
    expect(params("press")).toHaveLength(1);
    expect(params("scroll")).toHaveLength(0);
    await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.25], [60, 0.5275, 0.25]] });
    expect(params("press")).toHaveLength(1);
    expect(params("scroll")).toHaveLength(1);
  });

  it("a person's drag goes to what takes a finger's drag first (a sheet's swipe to close), and scrolls only when nothing does", async () => {
    const { app, tools } = await viewerTools();
    await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.75], [150, 0.5, 0.5], [300, 0.5, 0.25]] });
    const swipes = app.requests.filter((r) => r.method === "swipe").map((r) => r.params);
    expect(swipes).toEqual([{ x0: 200, y0: 600, x1: 200, y1: 200, seconds: 0.3 }]);
    expect(app.requests.filter((r) => r.method === "scroll")).toHaveLength(1);
    // When the drag is taken, nothing scrolls.
    app.handler = (req) => (req.method === "swipe" ? { ok: true, result: { element: TREE.elements[0], settledMs: 10 } } : viewerHandler(req));
    const outcome = await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.6], [200, 0.5, 0.9]] });
    expect(outcome).toMatchObject({ ok: true, action: { kind: "drag" } });
    expect(outcome.action).not.toHaveProperty("caption");
    expect(app.requests.filter((r) => r.method === "scroll")).toHaveLength(1);
  });

  it("inspect sends the target the way every tool does (an id becomes the app's testID)", async () => {
    const { app, tools } = await viewerTools();
    app.handler = (req) =>
      req.method === "inspect"
        ? {
            ok: true,
            result: {
              element: TREE.elements[0],
              source: { components: ["LoginScreen"], location: { file: "/nowhere/src/Login.tsx", line: 12, column: 3, component: "LoginScreen", direct: true }, props: {} },
            },
          }
        : viewerHandler(req);
    const answer = await tools.inspect({ target: { id: "login-button" } });
    expect(answer.isError).toBeUndefined();
    expect(app.requests.find((r) => r.method === "inspect")?.params).toEqual({ target: { testID: "login-button" } });
    expect(textOf(answer)).toContain("Written at: ");
  });

  it("reports a person's action with where it happened, in 0..1", async () => {
    const { tools } = await viewerTools();
    const outcome = await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.25], [90, 0.5, 0.25]] });
    expect(outcome.action).toMatchObject({ kind: "tap", label: "Log in", point: { x: 0.5, y: 0.25 } });
    expect(outcome.action).not.toHaveProperty("caption"); // the page words a person's steps
    expect(outcome.action?.rect?.x).toBeCloseTo(24 / 400, 5);
  });

  it("runs agent actions through the shared queue: refused while paused, shown to viewers", async () => {
    const { tools, control, actions } = await viewerTools();
    control.setPaused(true);
    const refused = await tools.tap({ target: { id: "login-button" }, look: false });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("paused");
    expect(actions.at(-1)).toMatchObject({ by: "agent", kind: "tap", caption: "Tap", ok: false, code: "paused" });
    control.setPaused(false);
    await tools.tap({ target: { id: "login-button" }, look: false });
    expect(actions.at(-1)).toMatchObject({ by: "agent", kind: "tap", label: "Log in", caption: 'Tap "Log in"', ok: true });
  });

  it("a refused step carries its reason word for the viewer (VIEWER-PROTOCOL 1.4), the agent's and a person's", async () => {
    const { app, tools, actions } = await viewerTools();
    app.handler = (req) =>
      req.method === "press"
        ? { ok: false, error: { code: "not_actionable", message: "covered: Save is behind the sheet; close that first." } }
        : viewerHandler(req);
    await tools.tap({ target: { text: "Save" }, look: false });
    expect(actions.at(-1)).toMatchObject({ by: "agent", kind: "tap", caption: 'Tap "Save"', ok: false, code: "not_actionable", reason: "covered" });
    const person = await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.25], [60, 0.5, 0.25]] });
    expect(person).toMatchObject({ ok: false, code: "not_actionable", reason: "covered", action: { kind: "tap" } });
    // An error that isn't a refusal has no reason word.
    app.handler = (req) => (req.method === "press" ? { ok: false, error: { code: "timeout", message: "covered: not a reason here" } } : viewerHandler(req));
    await tools.tap({ target: { text: "Save" }, look: false });
    expect(actions.at(-1)).not.toHaveProperty("reason");
  });

  it("after a person acts, ref targets are stale until the agent looks again; id targets still work", async () => {
    const { tools } = await viewerTools();
    await tools.look({ screenshot: false });
    await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.7], [60, 0.5, 0.7]] });
    const stale = await tools.tap({ target: { ref: "e3" } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/^Error stale: a person used the app since your last look/);
    const byId = await tools.tap({ target: { id: "login-button" } });
    expect(byId.isError).toBeFalsy();
    expect(textOf(byId)).not.toContain("Note: a person used the app"); // already said by the stale error
    await tools.look({ screenshot: false });
    expect((await tools.tap({ target: { ref: "e3" } })).isError).toBeFalsy();
  });

  it("the next answer after a person acts says so, once", async () => {
    const { tools } = await viewerTools();
    await tools.look({ screenshot: false });
    await tools.personInput({ type: "gesture", points: [[0, 0.5, 0.7], [60, 0.5, 0.7]] });
    const first = textOf(await tools.tap({ target: { id: "login-button" } }));
    expect(first.trimEnd().split("\n").at(-1)).toBe("Note: a person used the app since your last look.");
    const second = textOf(await tools.tap({ target: { id: "login-button" } }));
    expect(second).not.toContain("a person used the app");
  });

  it("reads the overlay in points with the screen size, and gives the viewer link", async () => {
    const { tools } = await viewerTools();
    const read = await tools.readOverlay();
    expect(read).toEqual({
      rev: 12,
      size: { w: 400, h: 800 },
      elements: [{ ref: "e3", type: "button", label: "Log in", id: "login-button", rect: { x: 24, y: 610, w: 354, h: 48 } }],
    });
    const text = textOf(await tools.viewer({}));
    expect(text).toContain("http://127.0.0.1:7210/viewer?token=abc");
  });
});

describe("compare_screen and filmstrip", () => {
  /** A 300x600 JPEG, grey, with an optional dark square at (40,40) 60x60. */
  function picture(withSquare: boolean): string {
    const data = Buffer.alloc(300 * 600 * 4, 200);
    if (withSquare) {
      for (let y = 40; y < 100; y++) {
        for (let x = 40; x < 100; x++) {
          const i = (y * 300 + x) * 4;
          data[i] = 20;
          data[i + 1] = 20;
          data[i + 2] = 20;
        }
      }
    }
    return jpeg.encode({ data, width: 300, height: 600 }, 90).data.toString("base64");
  }

  async function screenTools(shots: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "tapline-baselines-"));
    let n = 0;
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "screenshot") {
        const data = shots[Math.min(n, shots.length - 1)] ?? "";
        n += 1;
        return { ok: true, result: { mime: "image/jpeg", data, width: 300, height: 600 } };
      }
      if (req.method === "tree") {
        return {
          ok: true,
          result: {
            screen: { width: 150, height: 300, scale: 3 },
            elements: [
              { ref: "e1", type: "ScrollView", role: "scrollview", text: "Everything on the page", frame: { x: 0, y: 0, width: 150, height: 300 }, actions: ["scroll"] },
              { ref: "e2", type: "Image", role: "image", label: "Avatar", text: "", frame: { x: 18, y: 18, width: 35, height: 35 }, actions: [] },
            ],
          },
        };
      }
      return defaultHandler(req);
    };
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, handler);
    apps.push(app);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      baselinesDir: dir,
      // a still screen: two pictures in a row that agree, taken without a real wait
      stillGapMs: 1,
    });
    return { app, tools, dir };
  }

  it("saves a baseline the first time, then reports what changed with a marked image", async () => {
    const { app, tools, dir } = await screenTools([picture(false), picture(false), picture(true), picture(true)]);
    try {
      const first = textOf(await tools.compareScreen({ name: "home" }));
      expect(first).toContain("Saved");
      expect(existsSync(join(dir, "com.example.demo", "home.jpg"))).toBe(true);
      const second = await tools.compareScreen({ name: "home" });
      const text = textOf(second);
      // The list it names elements from is the host's own: it must not renumber the agent's refs
      // or move the baseline of its next changes.
      expect(app.requests.filter((r) => r.method === "tree").map((r) => r.params)).toEqual([{ peek: true }]);
      expect(text).toMatch(/Differs from the reference "home": [0-9.]+% changed/);
      expect(text).toContain("1 region");
      expect(text).toMatch(/@\d+,\d+ \d+x\d+/);
      expect(text).toContain('e2 image "Avatar"'); // the smallest element there, not the page around it
      expect(text).not.toContain("Everything on the page");
      expect(second.content.some((block) => block.type === "image")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("waits for the screen to stop moving before it saves or compares (a screen still sliding in)", async () => {
    // the first picture is mid-transition (the square not there yet); the next two agree
    const { app, tools, dir } = await screenTools([picture(false), picture(true), picture(true), picture(true), picture(true)]);
    try {
      expect(textOf(await tools.compareScreen({ name: "moving" }))).toContain("Saved");
      expect(app.requests.filter((r) => r.method === "screenshot")).toHaveLength(3);
      // the reference is the settled screen, so the next look at the same screen matches
      expect(textOf(await tools.compareScreen({ name: "moving" }))).toContain('Matches the reference "moving": 0% changed.');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("says nothing changed, and update replaces the baseline", async () => {
    const { tools, dir } = await screenTools([picture(false), picture(false), picture(false), picture(false), picture(true), picture(true), picture(true), picture(true)]);
    try {
      await tools.compareScreen({ name: "home" });
      expect(textOf(await tools.compareScreen({ name: "home" }))).toContain('Matches the reference "home": 0% changed.');
      expect(textOf(await tools.compareScreen({ name: "home", update: true }))).toContain("Saved");
      expect(textOf(await tools.compareScreen({ name: "home" }))).toContain('Matches the reference "home": 0% changed.');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("filmstrip takes several frames and returns them as one image", async () => {
    const { app, tools, dir } = await screenTools([picture(false), picture(true), picture(false)]);
    try {
      const result = await tools.filmstrip({ frames: 3, interval_ms: 50 });
      expect(app.requests.filter((r) => r.method === "screenshot")).toHaveLength(3);
      expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
      expect(textOf(result)).toContain("3 frames");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("filmstrip can tap first, to catch what the tap sets off", async () => {
    const { app, tools, dir } = await screenTools([picture(false), picture(true)]);
    try {
      const result = await tools.filmstrip({ frames: 3, interval_ms: 10, tap: { id: "login-button" } });
      expect(app.requests.map((r) => r.method).slice(0, 4)).toEqual(["screenshot", "press", "screenshot", "screenshot"]);
      expect(textOf(result)).toContain("frame 1 is just before the tap");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("record and replay", () => {
  const SAVE = { ref: "e7", type: "Pressable", role: "button", testID: "save", text: "Save", frame: null, actions: ["press"] };
  const PAY = { ref: "e9", type: "Pressable", role: "button", label: "Pay now", text: "Pay", frame: null, actions: ["press"] };
  const NAME = { ref: "e4", type: "TextInput", role: "textfield", text: "", value: "Ann", frame: null, actions: ["type"] };

  function shop(route: string[], failOn?: string) {
    return (req: IncomingRequest): Reply => {
      const params = req.params as { target?: { testID?: string; label?: string; ref?: string } } | undefined;
      if (failOn !== undefined && req.method === failOn) {
        return { ok: false, error: { code: "not_found", message: "No element matches testID \"save\"" } };
      }
      switch (req.method) {
        case "tree":
          return { ok: true, result: { ...TREE, route: { names: route } } };
        case "press":
          return { ok: true, result: { element: params?.target?.testID === "save" || params?.target?.ref === "e7" ? SAVE : PAY } };
        case "type":
          return { ok: true, result: { element: NAME, value: "Ann" } };
        case "waitFor":
          return { ok: true, result: { met: true, waitedMs: 10 } };
        default:
          return { ok: true, result: {} };
      }
    };
  }

  async function shopTools(route: string[], failOn?: string) {
    const dir = mkdtempSync(join(tmpdir(), "tapline-scripts-"));
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, shop(route, failOn));
    apps.push(app);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      scriptsDir: dir,
      policy: NO_POLICY, // a checkout taps "Pay": recording, not the policy, is under test
      reloadWaitMs: 50,
    });
    return { app, tools, dir };
  }

  it("records actions as a shared script (AGENT-TOOLS 1.8 §9.4): tool steps, targets that survive a new run, the screen each ended on", async () => {
    const { tools, dir } = await shopTools(["basket"]);
    try {
      expect(textOf(await tools.record({ start: true, name: "checkout" }))).toContain("Recording");
      await tools.tap({ target: { ref: "e7" } });
      await tools.tap({ target: { ref: "e9" } });
      await tools.typeText({ target: { ref: "e4" }, text: "Ann" });
      await tools.wait({ seconds: 0.1 });
      await tools.waitFor({ text: "Thanks", timeout: 5 });
      await tools.look({ screenshot: false }); // not an action: not recorded
      const stopped = textOf(await tools.record({ stop: true }));
      expect(stopped).toMatch(/^Saved 5 steps to .*checkout\.json\./);
      expect(stopped).toContain("step 3 targets a ref");
      const script = JSON.parse(readFileSync(join(dir, "checkout.json"), "utf8")) as Record<string, unknown> & { steps: Array<Record<string, unknown>> };
      expect(script).toMatchObject({ format: "agent-tools-script", version: 1, name: "checkout", app: "com.example.demo", fresh: true });
      expect(script.steps).toEqual([
        { tool: "tap", target: { id: "save" }, route: ["basket"] },
        { tool: "tap", target: { label: "Pay now" }, route: ["basket"] },
        { tool: "type_text", target: { ref: "e4" }, text: "Ann", replace: true, submit: false, route: ["basket"] },
        { tool: "wait", seconds: 0.1 },
        { tool: "wait_for", text: "Thanks", timeout: 5, route: ["basket"] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("keeps a target the agent gave by text, label or testID (it already picked one element)", async () => {
    const { tools, dir } = await shopTools(["basket"]);
    try {
      await tools.record({ start: true, name: "kept" });
      await tools.tap({ target: { text: "Pay" } }); // the element also has label "Pay now"
      await tools.record({ stop: true });
      const script = JSON.parse(readFileSync(join(dir, "kept.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
      expect(script.steps[0]).toMatchObject({ tool: "tap", target: { text: "Pay" } });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("folds a wait_for after an action into that step's expect, and replays the script like run", async () => {
    const { app, tools, dir } = await shopTools(["basket"]);
    try {
      await tools.record({ start: true, name: "checkout" });
      await tools.tap({ target: { id: "save" } });
      await tools.waitFor({ text: "Thanks" });
      await tools.record({ stop: true });
      const script = JSON.parse(readFileSync(join(dir, "checkout.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
      expect(script.steps).toEqual([{ tool: "tap", target: { id: "save" }, route: ["basket"], expect: { text: "Thanks" } }]);
      app.requests.length = 0;
      const answer = await tools.replay({ name: "checkout" });
      expect(app.requests.map((r) => r.method).filter((m) => m !== "tree")).toEqual(["reload", "press", "waitFor"]);
      expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps in \d+\.\d s\./);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("replays a wait_for id as the app's testID", async () => {
    const { app, tools, dir } = await shopTools(["basket"]);
    try {
      await tools.record({ start: true, name: "waiting" });
      await tools.waitFor({ id: "done" });
      await tools.record({ stop: true });
      const script = JSON.parse(readFileSync(join(dir, "waiting.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
      expect(script.steps[0]).toMatchObject({ tool: "wait_for", id: "done" });
      app.requests.length = 0;
      await tools.replay({ name: "waiting" });
      expect(app.requests.find((r) => r.method === "waitFor")?.params).toMatchObject({ testID: "done" });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("stops at the first failing step and says why, like run", async () => {
    const first = await shopTools(["basket"]);
    await first.tools.record({ start: true, name: "broken" });
    await first.tools.tap({ target: { id: "save" } });
    await first.tools.tap({ target: { label: "Pay now" } });
    await first.tools.record({ stop: true });
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, shop(["basket"], "press"));
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, scriptsDir: first.dir, reloadWaitMs: 50, policy: NO_POLICY });
    try {
      const result = await tools.replay({ name: "broken" });
      expect(result.isError).toBe(true);
      expect(textOf(result).split("\n")[0]).toBe('Error not_found: Ran 0 of 2 steps; stopped at step 1 (tap id=save): No element matches testID "save"');
    } finally {
      rmSync(first.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("fails a step that ends on a different screen than when it was recorded", async () => {
    const first = await shopTools(["basket"]);
    await first.tools.record({ start: true, name: "nav" });
    await first.tools.tap({ target: { id: "save" } });
    await first.tools.record({ stop: true });
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, shop(["home"]));
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, scriptsDir: first.dir, reloadWaitMs: 50, policy: NO_POLICY });
    try {
      const result = await tools.replay({ name: "nav" });
      expect(result.isError).toBe(true);
      expect(textOf(result).split("\n")[0]).toBe("Error expect_failed: Ran 0 of 1 steps; stopped at step 1 (tap id=save): its action ran, but it ended on home; the recording ended on basket");
    } finally {
      rmSync(first.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("still replays a Tapline script from before 1.1", async () => {
    const { app, tools, dir } = await shopTools(["basket"]);
    try {
      const old = { version: 1, name: "old", app: { name: "Demo" }, recordedAt: "2026-11-10T00:00:00Z", steps: [{ method: "press", params: { target: { testID: "save" } }, route: ["basket"] }] };
      writeFileSync(join(dir, "old.json"), JSON.stringify(old));
      app.requests.length = 0;
      const answer = await tools.replay({ name: "old" });
      expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
      expect(app.requests.find((r) => r.method === "press")?.params).toMatchObject({ target: { testID: "save" } });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("lists saved scripts, refuses bad names, and stop without start", async () => {
    const { tools, dir } = await shopTools(["basket"]);
    try {
      expect((await tools.record({ stop: true })).isError).toBe(true);
      expect((await tools.record({ start: true, name: "../evil" })).isError).toBe(true);
      await tools.record({ action: "start", name: "one" }); // the older form still works
      await tools.tap({ target: { id: "save" } });
      await tools.record({ action: "stop" });
      expect(textOf(await tools.replay({}))).toContain("one (1 step");
      expect((await tools.replay({ name: "missing" })).isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("after the app went to the background", () => {
  it("tells the agent the app was put in the background, and that it reconnects when opened", async () => {
    const { app, tools } = await setup(defaultHandler)();
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const text = textOf(await tools.look({}));
    expect(text).toContain("went to the background");
    expect(text).toContain("open the app");
  });

  it("says when iOS put something in front of the app (a system prompt), not that it went to the background", async () => {
    const { app, tools } = await setup(defaultHandler)();
    app.send({ type: "event", event: "appState", data: { state: "inactive" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const text = textOf(await tools.look({}));
    expect(text).toContain("after iOS put something in front of it (a system prompt");
    expect(text).not.toContain("went to the background");
  });
});

describe("app commands and waiting", () => {
  it("lists the app's commands when no name is given", async () => {
    const commands = [
      { name: "appearance", description: "Switch light/dark (args: { scheme })" },
      { name: "language", description: "Switch language (args: { code })" },
    ];
    const { app, tools } = await setup((req) =>
      req.method === "commands" ? { ok: true, result: { commands } } : defaultHandler(req),
    )();
    const text = textOf(await tools.appCommand({}));
    expect(app.requests.map((r) => r.method)).toEqual(["commands"]);
    expect(text).toContain("appearance: Switch light/dark (args: { scheme })");
    expect(text).toContain("language: Switch language (args: { code })");
  });

  it("runs a command with args, shows its result and what changed", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "command" ? { ok: true, result: { name: "language", result: { code: "ar" } } } : defaultHandler(req),
    )();
    const text = textOf(await tools.appCommand({ name: "language", args: { code: "ar" } }));
    expect(app.requests[0]).toMatchObject({ method: "command", params: { name: "language", args: { code: "ar" } } });
    expect(text).toContain('Ran language: {"code":"ar"}');
    expect(text).toContain("e3 button");
  });

  it("wait_for passes the condition on and reports how long it took", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "waitFor" ? { ok: true, result: { met: true, waitedMs: 1240 } } : defaultHandler(req),
    )();
    const text = textOf(await tools.waitFor({ text: "Saved", gone: false, network_idle: true, timeout: 5 }));
    expect(app.requests[0]).toMatchObject({ method: "waitFor", params: { text: "Saved", gone: false, networkIdle: true, timeout: 5 } });
    expect(text).toContain("Done after 1.2 s");
  });

  it("wait_for waits as long as its own timeout, past the usual request timeout", async () => {
    const { host, port } = await startHost({ requestTimeoutMs: 100 });
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, (req) => {
      if (req.method !== "waitFor") return defaultHandler(req);
      setTimeout(() => app.send({ type: "response", id: req.id, ok: true, result: { met: true, waitedMs: 300 } }), 300);
      return "ignore";
    });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
    const result = await tools.waitFor({ text: "Saved", timeout: 1, look: false });
    expect(textOf(result)).toContain("Done after 0.3 s");
  });

  it("wait_for reports a timeout as an error", async () => {
    const { tools } = await setup((req) =>
      req.method === "waitFor"
        ? { ok: false, error: { code: "timeout", message: 'Waited 5 s for text "Saved" to appear; it didn\'t happen.' } }
        : defaultHandler(req),
    )();
    const result = await tools.waitFor({ text: "Saved", timeout: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("it didn't happen");
  });
});

describe("labels and layout checks", () => {
  const grey = jpeg.encode({ data: Buffer.alloc(300 * 600 * 4, 128), width: 300, height: 600 }, 80).data.toString("base64");
  const realShot = (req: IncomingRequest): Reply =>
    req.method === "screenshot" ? { ok: true, result: { mime: "image/jpeg", data: grey, width: 300, height: 600 } } : defaultHandler(req);

  it("draws element boxes and refs on the screenshot only when labels is set", async () => {
    const { tools } = await setup(realShot)();
    const plain = await tools.look({});
    const labeled = await tools.look({ labels: true });
    const imageOf = (result: CallToolResult): string | undefined =>
      result.content.find((block) => block.type === "image")?.type === "image"
        ? (result.content.find((block) => block.type === "image") as { data: string }).data
        : undefined;
    expect(imageOf(plain)).toBe(grey);
    expect(imageOf(labeled)).toBeDefined();
    expect(imageOf(labeled)).not.toBe(grey);
  });

  it("lists layout findings by ref, or says none were found", async () => {
    const findings = [
      { kind: "small_target", ref: "e3", message: "tap area 32x28 pt is smaller than 44x44" },
      { kind: "overlap", ref: "e4", other: "e7", message: "overlaps e7 by 60% of the smaller element" },
    ];
    const { app, tools } = await setup((req) => (req.method === "check" ? { ok: true, result: { findings } } : defaultHandler(req)))();
    const text = textOf(await tools.checkLayout({}));
    expect(app.requests.map((r) => r.method)).toEqual(["check"]);
    expect(text).toContain("2 findings");
    expect(text).toContain("e3 small_target: tap area 32x28 pt is smaller than 44x44");
    expect(text).toContain("e4 overlap: overlaps e7 by 60% of the smaller element");

    const { tools: clean } = await setup((req) => (req.method === "check" ? { ok: true, result: { findings: [] } } : defaultHandler(req)))();
    expect(textOf(await clean.checkLayout({}))).toContain("No layout problems found");
  });
});

describe("changes after actions", () => {
  const BASKET = {
    screen: { width: 402, height: 874, scale: 3 },
    route: { names: ["basket"] },
    elements: [
      { ref: "e1", type: "Text", role: "text", text: "Basket", frame: { x: 0, y: 0, width: 200, height: 30 }, actions: [] },
      { ref: "e2", type: "Text", role: "text", text: "$8", frame: { x: 0, y: 40, width: 200, height: 30 }, actions: [] },
      { ref: "e5", type: "Text", role: "text", text: "Free delivery", frame: { x: 0, y: 130, width: 200, height: 30 }, actions: [] },
      { ref: "e4", type: "Pressable", role: "button", text: "Pay", frame: { x: 0, y: 650, width: 200, height: 48 }, actions: ["press"] },
    ],
  };
  const CHANGES = {
    sameRoute: true,
    added: ["e5"],
    removed: [{ ref: "e3", type: "Pressable", role: "button", text: "Use coupon", frame: { x: 0, y: 80, width: 200, height: 40 }, actions: ["press"] }],
    changed: [{ ref: "e2", was: { text: "$10" } }],
    moved: ["e4"],
  };

  function basket(changes: unknown) {
    return (req: IncomingRequest): Reply => {
      if (req.method === "tree") {
        const wants = typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
        return { ok: true, result: wants ? { ...BASKET, changes } : BASKET };
      }
      return defaultHandler(req);
    };
  }

  it("shows only what changed once the agent has had a full list", async () => {
    const { app, tools } = await setup(basket(CHANGES))();
    await tools.look({ screenshot: false });
    const text = textOf(await tools.tap({ target: { ref: "e3" } }));
    expect(app.requests.filter((r) => r.method === "tree").map((r) => r.params)).toEqual([{}, { changes: true }]);
    expect(text).toContain("Same screen. Changes:");
    expect(text).toContain('+ e5 text "Free delivery"');
    expect(text).toContain('- button "Use coupon"');
    expect(text).toContain('~ e2 text "$8" (was "$10")');
    expect(text).toContain('↕ e4 button "Pay" @0,650 200x48');
    expect(text).not.toContain('e1 text "Basket"');
    expect(text).not.toContain("call look for the full list");
  });

  it("gives the full list when the agent hasn't had one yet", async () => {
    const { app, tools } = await setup(basket(CHANGES))();
    const text = textOf(await tools.tap({ target: { ref: "e3" } }));
    expect(app.requests.filter((r) => r.method === "tree").map((r) => r.params)).toEqual([{}]);
    expect(text).toContain('e1 text "Basket"');
  });

  it("gives the full list when the screen changed", async () => {
    const { tools } = await setup(basket({ ...CHANGES, sameRoute: false }))();
    await tools.look({ screenshot: false });
    const text = textOf(await tools.tap({ target: { ref: "e3" } }));
    expect(text).toContain('e1 text "Basket"');
    expect(text).toContain("Route: basket");
  });

  it("says the app vanished, with a note, when the tree is empty after an action", async () => {
    const EMPTY = { screen: { width: 402, height: 874, scale: 3 }, elements: [] };
    const { tools } = await setup((req) => {
      if (req.method === "tree") {
        const wants = typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
        return { ok: true, result: wants ? { ...EMPTY, changes: { ...CHANGES, removed: [CHANGES.removed[0]] } } : BASKET };
      }
      if (req.method === "press") return { ok: true, result: { element: TREE.elements[0], settledMs: 310 } };
      return defaultHandler(req);
    })();
    await tools.look({ screenshot: false });
    const text = textOf(await tools.tap({ target: { ref: "e3" } }));
    expect(text).not.toContain("Same screen");
    expect(text).toContain("(nothing visible; the app may still be loading)");
    const lines = text.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(
      "Note: something outside the app (a system sheet or browser) may cover it. Tapline can't see it: ask the user, or use Tapwright.",
    );
    expect(lines.at(-2)).toMatch(/^Settled in /);
  });

  const ALERT = {
    kind: "alert" as const,
    title: "Delete?",
    message: null,
    buttons: [{ text: "OK", style: "default" as const }],
    standIn: false,
  };
  const NO_CHANGES = { sameRoute: true, added: [], removed: [], changed: [], moved: [] };

  it("puts the alert's note at the end, after Settled in, and the Alert: line first", async () => {
    const { tools } = await setup((req) =>
      req.method === "tree"
        ? { ok: true, result: { ...BASKET, alerts: [ALERT] } }
        : req.method === "press"
          ? { ok: true, result: { element: TREE.elements[0], settledMs: 310 } }
          : defaultHandler(req),
    )();
    const look = textOf(await tools.look({ screenshot: false })).split("\n");
    expect(look.at(-1)).toMatch(/^Note: an OS alert:/);
    expect(look.findIndex((l) => l.startsWith("Alert:"))).toBe(3);
    const lines = textOf(await tools.tap({ target: { ref: "e4" } })).trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/^Note: an OS alert:/);
    expect(lines.at(-2)).toMatch(/^Settled in /);
    expect(lines.some((l) => l.startsWith("Alert:"))).toBe(true);
  });

  it("says Alert: gone in the next change block after an alert closed, once", async () => {
    let alertOpen = true;
    const { tools } = await setup((req) => {
      if (req.method === "tree") {
        const wants = typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
        const open = alertOpen ? { alerts: [ALERT] } : {};
        return { ok: true, result: wants ? { ...BASKET, ...open, changes: NO_CHANGES } : { ...BASKET, ...open } };
      }
      if (req.method === "press") return { ok: true, result: { element: TREE.elements[0], settledMs: 310 } };
      return defaultHandler(req);
    })();
    await tools.look({ screenshot: false });
    alertOpen = false;
    const first = textOf(await tools.tap({ target: { ref: "e4" } })).split("\n");
    expect(first.slice(1, 3)).toEqual(["Same screen. Changes:", "Alert: gone"]);
    expect(first.join("\n")).not.toContain("No visible change");
    expect(first.join("\n")).not.toContain("Note: an OS alert");
    expect(textOf(await tools.tap({ target: { ref: "e4" } }))).not.toContain("Alert: gone");
  });

  it("a change in the alert's message alone is a change of the alert (1.14), said once", async () => {
    let message: string | null = "Saving…";
    const { tools } = await setup((req) => {
      if (req.method === "tree") {
        const wants = typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
        const open = { alerts: [{ ...ALERT, title: "Please wait", message }] };
        return { ok: true, result: wants ? { ...BASKET, ...open, changes: NO_CHANGES } : { ...BASKET, ...open } };
      }
      if (req.method === "press") return { ok: true, result: { element: TREE.elements[0], settledMs: 310 } };
      return defaultHandler(req);
    })();
    const look = textOf(await tools.look({ screenshot: false }));
    expect(look).toContain('Alert: "Please wait" "Saving…" [OK]');
    // Unchanged alert: nothing new to say.
    expect(textOf(await tools.tap({ target: { ref: "e4" } }))).toContain("No visible change.");
    message = "Saved.";
    const changed = textOf(await tools.tap({ target: { ref: "e4" } })).split("\n");
    expect(changed.slice(1, 3)).toEqual(["Same screen. Changes:", 'Alert: "Please wait" "Saved." [OK]']);
    expect(changed.join("\n")).not.toContain("No visible change.");
    // The message going away is a change too; then it is quiet again.
    message = null;
    expect(textOf(await tools.tap({ target: { ref: "e4" } }))).toContain('Alert: "Please wait" [OK]');
    expect(textOf(await tools.tap({ target: { ref: "e4" } }))).toContain("No visible change.");
  });

  it("policy words are never matched on an alert's message (1.14 §11.1)", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const alert = { ...ALERT, title: "Notice", message: "Delete everything and pay now? Sign out too.", buttons: [{ text: "OK", style: "default" as const }] };
    const { app } = await FakeApp.connect(port, {}, (req) => {
      if (req.method === "tree") return { ok: true, result: { ...BASKET, alerts: [alert] } };
      if (req.method === "press") return { ok: true, result: { element: TREE.elements[0], settledMs: 100 } };
      return defaultHandler(req);
    });
    apps.push(app);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      policy: { version: 1, confirm: ["delete", "pay"], block: ["sign out"] },
    });
    expect(textOf(await tools.look({ screenshot: false }))).toContain('"Delete everything and pay now? Sign out too."');
    const tapped = await tools.tap({ target: { ref: "e4" } });
    expect(textOf(tapped)).not.toMatch(/not_allowed|needs_confirmation|blocked/);
    expect(app.requests.some((r) => r.method === "press")).toBe(true);
  });

  it("says when nothing visible changed", async () => {
    const { tools } = await setup(basket({ sameRoute: true, added: [], removed: [], changed: [], moved: [] }))();
    await tools.look({ screenshot: false });
    expect(textOf(await tools.tap({ target: { ref: "e3" } }))).toContain("No visible change");
  });
});

describe("back", () => {
  it("asks the app to go back and returns the fresh element list", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "back" ? { ok: true, result: { route: ["(tabs)", "detail"] } } : defaultHandler(req),
    )();
    const result = await tools.back({});
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Went back from (tabs) › detail.");
    expect(textOf(result)).toContain("e3 button");
    expect(app.requests.map((r) => r.method)).toEqual(["back", "tree"]);
  });

  it("reports nothing to go back to as an error", async () => {
    const { tools } = await setup((req) =>
      req.method === "back"
        ? { ok: false, error: { code: "not_actionable", message: "no_action: Nothing to go back to from home." } }
        : defaultHandler(req),
    )();
    const result = await tools.back({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Nothing to go back to");
  });
});

describe("look", () => {
  it("returns text and an image when the app supports screenshots", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.look({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(textOf(result)).toContain("Screen 402x874 pt @3x · 1 element");
    expect(result.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
  });

  it("opens with the screen line, then the app by name and id, with no session id", async () => {
    const { tools } = await setup(defaultHandler)();
    const text = textOf(await tools.look({}));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Screen .* pt /);
    expect(lines[1]).toBe("App: Demo (com.example.demo)");
    expect(text).not.toContain("[s-");
  });

  it("returns text only with a note when screenshot is unsupported", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "screenshot"
        ? { ok: false, error: { code: "unsupported", message: "react-native-view-shot is not installed" } }
        : defaultHandler(req),
    )();
    const first = await tools.look({});
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(1);
    expect(textOf(first)).toContain("Note: no screenshot");
    expect(textOf(first)).toContain("e3 button");
    // remembered for this session: no second screenshot attempt
    await tools.look({});
    expect(app.requests.filter((r) => r.method === "screenshot")).toHaveLength(1);
  });

  it("skips the screenshot when asked", async () => {
    const { app, tools } = await setup(defaultHandler)();
    const result = await tools.look({ screenshot: false });
    expect(result.content).toHaveLength(1);
    expect(app.requests.map((r) => r.method)).toEqual(["tree"]);
  });

  it("asks the app for a 600-pixel screenshot, or the width given", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.look({});
    await tools.look({ width: 300 });
    const shots = app.requests.filter((r) => r.method === "screenshot").map((r) => r.params);
    expect(shots).toEqual([
      { format: "jpg", quality: 0.75, maxWidth: 600 },
      { format: "jpg", quality: 0.75, maxWidth: 300 },
    ]);
  });

  it("saves the screenshot to a file and returns only its path in file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-shots-"));
    try {
      const { host, port } = await startHost();
      hosts.push(host);
      const { app } = await FakeApp.connect(port, {}, defaultHandler);
      apps.push(app);
      const tools = new TaplineTools(host, {
        connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
        screenshots: "file",
        screenshotDir: dir,
      });
      const result = await tools.look({});
      expect(result.content.every((block) => block.type === "text")).toBe(true);
      const match = /Screenshot: (.+\.jpg) \(600x1305\)/.exec(textOf(result));
      expect(match).not.toBeNull();
      const file = match?.[1] ?? "";
      expect(file.startsWith(dir)).toBe(true);
      expect(readFileSync(file).toString()).toBe("ABC");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("keeps only the newest screenshot files in file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-shots-"));
    try {
      const { host, port } = await startHost();
      hosts.push(host);
      const { app } = await FakeApp.connect(port, {}, defaultHandler);
      apps.push(app);
      const tools = new TaplineTools(host, {
        connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
        screenshots: "file",
        screenshotDir: dir,
        screenshotKeep: 2,
      });
      const paths: string[] = [];
      for (let i = 0; i < 3; i++) {
        const match = /Screenshot: (.+\.jpg)/.exec(textOf(await tools.look({})));
        paths.push(match?.[1] ?? "");
      }
      expect(new Set(paths).size).toBe(3);
      expect(paths.map((p) => existsSync(p))).toEqual([false, true, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("still returns the text when the screenshot fails another way", async () => {
    const { tools } = await setup((req) =>
      req.method === "screenshot" ? { ok: false, error: { code: "internal", message: "capture failed" } } : defaultHandler(req),
    )();
    const result = await tools.look({});
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Note: screenshot failed: capture failed");
  });

  it("notes are Note: lines, never parenthesised", async () => {
    const { tools } = await setup((req) =>
      req.method === "screenshot" ? { ok: false, error: { code: "unsupported", message: "no view-shot" } } : defaultHandler(req),
    )();
    const text = textOf(await tools.look({}));
    expect(text).toContain("Note: no screenshot: this app doesn't support it; add react-native-view-shot.");
    expect(text).not.toMatch(/^\(/m);
  });
});

describe("no app connected", () => {
  it("tells the agent to pair a phone", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://100.101.102.103:${port}/`, name: "Dev PC" },
    });
    for (const result of [await tools.look({}), await tools.tap({ target: { ref: "e1" } })]) {
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("No app is connected");
      expect(text).toContain(`ws://100.101.102.103:${port}/`);
      expect(text).toContain("`pair`");
      expect(text).toContain("same Wi-Fi");
    }
    const apps = tools.apps();
    expect(apps.isError).toBeUndefined();
    expect(textOf(apps)).toContain("No app is connected");
  });

  it("without an app, actions fail with Error not_connected and the setup steps", async () => {
    const { host } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, { connect: { url: "ws://127.0.0.1:7210/", name: "Dev PC" } });
    const result = await tools.tap({ target: { id: "save" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error not_connected: No app is connected to Tapline\./);
    expect(textOf(result)).toContain("call `pair`");
  });
});

describe("pair", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function pairTools() {
    const { host, port } = await startHost();
    hosts.push(host);
    const dir = mkdtempSync(join(tmpdir(), "tapline-pair-"));
    dirs.push(dir);
    const imagePath = join(dir, `pair-${port}.png`);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      pairImagePath: imagePath,
    });
    return { port, tools, imagePath };
  }

  it("returns a pairing link with a one-time code, its QR code and the forget link", async () => {
    const { port, tools, imagePath } = await pairTools();
    const result = await tools.pair({ scheme: "myapp" });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    const link = /myapp:\/\/tapline\/pair\?\S+/.exec(text)?.[0] ?? "";
    expect(link).toContain(`url=${encodeURIComponent(`ws://127.0.0.1:${port}/`)}`);
    expect(link).toContain("name=Dev%20PC");
    expect(text).toContain("myapp://tapline/forget");
    expect(text).toContain("10 minutes");
    expect(text).toContain(imagePath);
    expect(existsSync(imagePath)).toBe(true);
    expect(result.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);

    // The code in the link is accepted by the host, once.
    const code = new URLSearchParams(link.split("?")[1] ?? "").get("code") ?? "";
    const { app, welcome } = await FakeApp.connect(port, { token: undefined, pairCode: code });
    apps.push(app);
    expect(welcome["token"]).toBe(TOKEN);
  });

  it("deletes the saved QR code once its code has expired", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const dir = mkdtempSync(join(tmpdir(), "tapline-pair-"));
    dirs.push(dir);
    const imagePath = join(dir, "pair.png");
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      pairImagePath: imagePath,
      pairImageLifetimeMs: 50,
    });
    await tools.pair({ scheme: "myapp" });
    expect(existsSync(imagePath)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(imagePath)).toBe(false);
  });

  it("each call makes a new code", async () => {
    const { tools } = await pairTools();
    const codeOf = async (): Promise<string> => /code=([^&\s]+)/.exec(textOf(await tools.pair({ scheme: "myapp" })))?.[1] ?? "";
    const first = await codeOf();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await codeOf()).not.toBe(first);
  });

  it("rejects something that is not a URL scheme", async () => {
    const { tools } = await pairTools();
    const result = await tools.pair({ scheme: "https" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("scheme");
  });
});

describe("apps and open_app", () => {
  it("lists connected apps and marks the selected one", async () => {
    const { host, app, tools } = await setup(defaultHandler)();
    void app;
    const text = textOf(tools.apps());
    expect(text).toContain("Demo 1.0.0 (1) [com.example.demo]");
    expect(text).toContain("Test iPhone");
    expect(text.split("\n")[1]?.startsWith("*")).toBe(true);
    const id = host.sessions()[0]?.id ?? "";
    expect(textOf(tools.openApp({ app: id }))).toContain("Driving Demo (com.example.demo) on Test iPhone");
  });

  it("open_app picks a connected app by session id, app id or name, and says how to connect one that isn't", async () => {
    const { host, tools } = await setup(defaultHandler)();
    expect(textOf(tools.openApp({ app: "Demo" }))).toMatch(/^Driving Demo/);
    expect(textOf(tools.openApp({ app: "DEMO" }))).toMatch(/^Driving Demo/);
    expect(textOf(tools.openApp({ app: "COM.example.Demo" }))).toMatch(/^Driving Demo/);
    const id = host.sessions()[0]?.id ?? "";
    expect(textOf(tools.openApp({ app: id.toUpperCase() }))).toMatch(/^Driving Demo/);
    const missing = tools.openApp({ app: "Other" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^Error not_connected: Other isn't connected/);
  });

  it("open_app never guesses between two apps with the same name; a session id picks one", async () => {
    const { host, tools } = await setup(defaultHandler)();
    const { app } = await FakeApp.connect(host.boundPort() ?? 0, {
      device: { platform: "ios", osVersion: "26.1", name: "Second iPhone", id: "second-install" },
    });
    apps.push(app);
    const ids = host.sessions().map((s) => s.id);
    expect(ids).toHaveLength(2);
    const ambiguous = tools.openApp({ app: "demo" });
    expect(ambiguous.isError).toBe(true);
    const lines = textOf(ambiguous).split("\n");
    expect(lines[0]).toBe('Error ambiguous: 2 connected apps match "demo".');
    expect(lines[1]).toBe("Candidates:");
    expect(lines[2]?.startsWith("  ")).toBe(true);
    expect(lines.at(-1)).toBe("Retry with open_app and one of these session ids.");
    expect(lines).toHaveLength(5);
    for (const id of ids) expect(lines.some((l) => l.includes(id) && l.includes("Demo") && l.includes("[com.example.demo]"))).toBe(true);
    expect(textOf(ambiguous)).toContain("Second iPhone");
    expect(textOf(tools.openApp({ app: ids[0] ?? "" }))).toMatch(/^Driving Demo/);
    expect(host.current()?.id).toBe(ids[0]);
    expect(textOf(tools.openApp({ app: (ids[1] ?? "").toUpperCase() }))).toMatch(/^Driving Demo/);
    expect(host.current()?.id).toBe(ids[1]);
  });

  it("apps tells a second app to switch with open_app", async () => {
    const { host, tools } = await setup(defaultHandler)();
    const { app } = await FakeApp.connect(host.boundPort() ?? 0, { app: { name: "Other", id: "com.example.other" } });
    apps.push(app);
    expect(textOf(tools.apps())).toContain("Use open_app {app} to switch.");
  });

  it("shows the install id of a phone that sends no name, so two iPhones can be told apart", async () => {
    const { host, tools } = await setup(defaultHandler)();
    const { app } = await FakeApp.connect(host.boundPort() ?? 0, { device: { platform: "ios", osVersion: "26.1", id: "3fa2c9d1e5b7" } });
    apps.push(app);
    expect(textOf(tools.apps())).toContain("ios 26.1, install 3fa2c9");
  });
});

describe("other tools", () => {
  it("type_text sends the documented params", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "type" ? { ok: true, result: { element: { ref: "e2", type: "TextInput" }, value: "hi" } } : defaultHandler(req),
    )();
    const result = await tools.typeText({ text: "hi", target: { id: "email" }, submit: true, look: false });
    expect(app.requests[0]?.params).toEqual({ text: "hi", replace: true, submit: true, target: { testID: "email" } });
    expect(textOf(result)).toBe('Typed into e2 input and submitted. Value is now "hi".');
  });

  it("scroll rejects `to` combined with direction", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.scroll({ to: "end", direction: "up" });
    expect(result.isError).toBe(true);
  });

  it("scroll amount is a share of the scroll area, sent as fraction", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.scroll({ amount: 0.5, look: false });
    expect(app.requests.find((r) => r.method === "scroll")?.params).toMatchObject({ direction: "down", fraction: 0.5 });
    await tools.scroll({ look: false });
    expect(app.requests.filter((r) => r.method === "scroll")[1]?.params).toMatchObject({ direction: "down", fraction: 0.8 });
    await tools.scroll({ to: "end", look: false });
    const last = app.requests.filter((r) => r.method === "scroll")[2]?.params;
    expect(last).toEqual({ to: "end" });
  });

  it("scroll that moved nothing ends with a note after Settled in, and reports the real offset", async () => {
    const { tools } = await setup((req) =>
      req.method === "scroll"
        ? { ok: true, result: { element: TREE.elements[0], offset: { x: 0, y: 0 }, moved: false, settledMs: 310 } }
        : defaultHandler(req),
    )();
    const up = textOf(await tools.scroll({ direction: "up" })).split("\n");
    expect(up[0]).toContain('Offset now {"x":0,"y":0}.');
    expect(up.at(-2)).toBe("Settled in 0.31 s.");
    expect(up.at(-1)).toBe(
      "Note: the scroll view is already at the top (as far as Tapline can scroll it; a person's swipe can reach a little further when the system adds an inset).",
    );
    // to: "start" / "end" with the list already there: the first line says so, and no note (AGENT-TOOLS v1.6 §5).
    const start = textOf(await tools.scroll({ to: "start" })).split("\n");
    expect(start[0]).toMatch(/ is already at its start\.$/);
    expect(start.join("\n")).not.toContain("Note: the scroll view");
    expect(textOf(await tools.scroll({ direction: "down" })).split("\n").at(-1)).toBe("Note: the scroll view is already at the end.");
    expect(textOf(await tools.scroll({ to: "end" })).split("\n")[0]).toMatch(/ is already at its end\.$/);
    expect(textOf(await tools.scroll({ direction: "left" })).split("\n").at(-1)).toBe("Note: the scroll view is already at the start.");
    expect(textOf(await tools.scroll({ direction: "right" })).split("\n").at(-1)).toBe("Note: the scroll view is already at the end.");
    expect(textOf(await tools.scroll({ direction: "down", look: false })).split("\n").at(-1)).toBe("Note: the scroll view is already at the end.");
  });

  it("scroll that moved adds no note", async () => {
    const { tools } = await setup((req) =>
      req.method === "scroll"
        ? { ok: true, result: { element: TREE.elements[0], offset: { x: 0, y: 389 }, moved: true, settledMs: 310 } }
        : defaultHandler(req),
    )();
    const text = textOf(await tools.scroll({ direction: "down" }));
    expect(text).toContain('Offset now {"x":0,"y":389}.');
    expect(text).not.toContain("already at");
    expect(text.split("\n").at(-1)).toBe("Settled in 0.31 s.");
  });

  it("scroll schema refuses an amount outside 0.1 to 1", () => {
    const schema = z.object(toolShapes.scroll);
    expect(schema.safeParse({ amount: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ amount: 0.05 }).success).toBe(false);
    expect(schema.safeParse({ amount: 0.1 }).success).toBe(true);
    expect(schema.safeParse({ amount: 1 }).success).toBe(true);
  });

  it("logs come from the host buffer", async () => {
    const { host, app, tools } = await setup(defaultHandler)();
    app.send({ type: "event", event: "log", data: { level: "warn", message: "careful", ts: 5000 } });
    const id = host.sessions()[0]?.id ?? "";
    for (let i = 0; i < 100 && host.logs(id).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const text = textOf(await tools.logs({}));
    expect(text).toContain("warning careful");
    expect(text).toContain("Latest: 5000");
  });

  it("logs with nothing to show falls back to `since`, else 0, never this computer's clock", async () => {
    const { tools } = await setup(defaultHandler)();
    expect(textOf(await tools.logs({}))).toMatch(/\nLatest: 0$/);
    expect(textOf(await tools.logs({ since: 7000 }))).toMatch(/\nLatest: 7000$/);
  });

  it("logs filters by level, grep and limit (AGENT-TOOLS 1.10 §15.1)", async () => {
    const { host, app, tools } = await setup(defaultHandler)();
    app.send({ type: "event", event: "log", data: { level: "log", message: "loaded trips", ts: 1000 } });
    app.send({ type: "event", event: "log", data: { level: "warn", message: "[network] GET /trips → 404", ts: 2000 } });
    app.send({ type: "event", event: "log", data: { level: "error", message: "Request timeout", ts: 3000 } });
    app.send({ type: "event", event: "log", data: { level: "debug", message: "cache hit", ts: 4000 } });
    const id = host.sessions()[0]?.id ?? "";
    for (let i = 0; i < 100 && host.logs(id).length < 4; i++) await new Promise((r) => setTimeout(r, 10));
    const warn = textOf(await tools.logs({ level: "warning" }));
    expect(warn).toContain("warning [network] GET /trips → 404");
    expect(warn).toContain("error Request timeout");
    expect(warn).not.toContain("loaded trips");
    expect(warn).toMatch(/Latest: 4000$/);
    expect(textOf(await tools.logs({ grep: "TIMEOUT" }))).toMatch(/error Request timeout\nLatest: 4000$/);
    const one = textOf(await tools.logs({ limit: 1 }));
    expect(one).toContain("info cache hit");
    expect(one.split("\n")).toHaveLength(2);
    expect(textOf(await tools.logs({ level: "error", grep: "nothing" }))).toBe('No log entries at error or above, matching "nothing".\nLatest: 4000');
  });

  it("a failed run step carries the app's warnings since that step began (AGENT-TOOLS 1.10 §15.4)", async () => {
    const holder: { app?: FakeApp } = {};
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "press") {
        holder.app?.send({ type: "event", event: "log", data: { level: "log", message: "pressed", ts: 9000 } });
        holder.app?.send({ type: "event", event: "log", data: { level: "error", message: "TypeError: trip is undefined", ts: 9001 } });
        return { ok: false, error: { code: "not_found", message: "No element with id \"save\"." } };
      }
      return defaultHandler(req);
    };
    const { host, app, tools } = await setup(handler)();
    holder.app = app;
    app.send({ type: "event", event: "log", data: { level: "warn", message: "before the run", ts: 1000 } });
    const id = host.sessions()[0]?.id ?? "";
    for (let i = 0; i < 100 && host.logs(id).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const result = await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }], look: false });
    expect(result.isError).toBe(true);
    const said = textOf(result);
    expect(said).toContain("stopped at step 1");
    expect(said).toMatch(/\nLogs \(since step 1\):\n\d\d:\d\d:\d\d\.\d{3} error TypeError: trip is undefined/);
    expect(said).not.toContain("before the run");
    expect(said).not.toContain("pressed");
  });

  it("a passing run carries no logs", async () => {
    const { app, tools } = await setup(defaultHandler)();
    app.send({ type: "event", event: "log", data: { level: "error", message: "noise", ts: 1000 } });
    const said = textOf(await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }], look: false }));
    expect(said).not.toContain("Logs (since");
  });

  it("wait returns a fresh look", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.wait({ seconds: 0.1 });
    expect(textOf(result)).toContain("Waited 0.1 s.");
    expect(textOf(result)).toContain("e3 button");
  });
});

describe("screenshots on actions", () => {
  it("an action with screenshot: true adds one image", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.tap({ target: { id: "login-button" }, screenshot: true });
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
  });

  it("an action without screenshot, or with look: false, adds no image", async () => {
    const { tools } = await setup(defaultHandler)();
    expect((await tools.tap({ target: { id: "login-button" } })).content.filter((c) => c.type === "image")).toHaveLength(0);
    const quiet = await tools.tap({ target: { id: "login-button" }, screenshot: true, look: false });
    expect(quiet.content.filter((c) => c.type === "image")).toHaveLength(0);
  });

  it("wait_for honours screenshot", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.waitFor({ id: "login-button", screenshot: true });
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
  });

  it("wait honours screenshot", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.wait({ seconds: 0.1, screenshot: true });
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
  });

  it("asks the app for JPEG at quality 0.75", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.look({});
    expect(app.requests.find((r) => r.method === "screenshot")?.params).toMatchObject({ format: "jpg", quality: 0.75 });
  });

  it("long_press accepts seconds", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.longPress({ target: { id: "login-button" }, seconds: 2, look: false });
    expect(result.isError).not.toBe(true);
  });
});

describe("mcp server", () => {
  it("registers every tool and validates input over an in-memory transport", async () => {
    const { tools } = await setup(defaultHandler)();
    const server = createMcpServer(tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(
        ["apps", "open_app", "pair", "look", "tap", "long_press", "type_text", "scroll", "toggle", "open_url", "back", "swipe", "check_layout", "audit", "ux_check", "media", "journey", "inspect", "run", "app_command", "wait_for", "record", "replay", "compare_screen", "filmstrip", "viewer", "logs", "crash", "reload", "performance", "wait", "session_report", "map", "drive", "explore"].sort(),
      );
      const ok = await client.callTool({ name: "tap", arguments: { target: { id: "login-button" } } });
      expect(JSON.stringify(ok.content)).toContain("Tapped e3");
      const bad = await client.callTool({ name: "tap", arguments: { target: { ref: "e1", id: "x" } } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  async function connected(): Promise<{ client: Client; close: () => Promise<void> }> {
    const { tools } = await setup(defaultHandler)();
    const server = createMcpServer(tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }
  const answerText = (r: unknown): string => JSON.stringify(r);

  it("refuses an argument the tool doesn't have, naming the tool's own keys", async () => {
    const { client, close } = await connected();
    try {
      const r = await client.callTool({ name: "audit", arguments: { labels: true } });
      expect(r.isError).toBe(true);
      expect(answerText(r)).toContain('Error bad_params: audit doesn\'t take labels; it takes types.');
      const two = await client.callTool({ name: "look", arguments: { screenshot: false, foo: 1, bar: 2 } });
      expect(two.isError).toBe(true);
      expect(answerText(two)).toContain("look doesn't take foo, bar; it takes screenshot, width, labels.");
      const none = await client.callTool({ name: "apps", arguments: { x: 1 } });
      expect(none.isError).toBe(true);
      expect(answerText(none)).toContain("apps doesn't take x; it takes no arguments.");
      const withRequired = await client.callTool({ name: "open_app", arguments: { app: "x", nme: "y" } });
      expect(answerText(withRequired)).toContain("open_app doesn't take nme; it takes app.");
      const fine = await client.callTool({ name: "look", arguments: { screenshot: false } });
      expect(fine.isError).not.toBe(true);
    } finally {
      await close();
    }
  });

  it("checks every tool the same way, and publishes the schema of its shape only", async () => {
    const { client, close } = await connected();
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(Object.keys(toolShapes).length);
      for (const tool of listed.tools) {
        const keys = Object.keys(toolShapes[tool.name as keyof typeof toolShapes]);
        expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toEqual(keys);
        expect(tool.inputSchema, tool.name).not.toHaveProperty("additionalProperties");
        const r = await client.callTool({ name: tool.name, arguments: { not_a_real_key: 1 } });
        expect(r.isError, tool.name).toBe(true);
        // A missing required argument is reported first (the SDK's own validation runs before the check).
        if ((tool.inputSchema.required ?? []).length === 0) {
          expect(answerText(r), tool.name).toContain("doesn't take not_a_real_key; it takes");
        }
      }
    } finally {
      await close();
    }
  });

  it("ignores a step's own look and screenshot even on tools without them (§9.1)", async () => {
    const { client, close } = await connected();
    try {
      const r = await client.callTool({
        name: "run",
        arguments: { steps: [{ tool: "wait", seconds: 0.1, look: true, screenshot: true }, { tool: "back", look: false }], look: false },
      });
      expect(answerText(r)).not.toContain("bad_params");
    } finally {
      await close();
    }
  });

  it("names the step for an unknown key inside a run step", async () => {
    const { client, close } = await connected();
    try {
      const r = await client.callTool({
        name: "run",
        arguments: { steps: [{ tool: "wait", seconds: 0.1 }, { tool: "tap", target: { id: "login-button" }, labels: true }] },
      });
      expect(r.isError).toBe(true);
      expect(answerText(r)).toMatch(/Error bad_params: step 2: tap doesn't take labels; it takes target, /);
    } finally {
      await close();
    }
  });
});
