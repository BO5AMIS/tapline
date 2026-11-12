import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import { conditionOf, conditionsOf, holdsIn } from "../src/conditions.js";
import type { TreeElement } from "../src/protocol.js";
import { skippedLine, type Step } from "../src/run.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §9.1: `if` and `optional`, one look and no wait.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOT_NOW = { ref: "e7", type: "Pressable", role: "button", testID: "not-now", text: "Not now", frame: { x: 24, y: 700, width: 354, height: 48 }, actions: ["press"] };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const SCREEN = { width: 402, height: 874, scale: 3 };

const textOf = (result: CallToolResult): string => result.content.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join("\n");

interface Scene {
  /** What the app's list holds. */
  list: unknown[];
  /** What `waitFor` with `once` answers; by default from the list, as the app's own matching would. */
  found?: (params: Record<string, unknown>) => boolean;
  /** The app's capabilities; default has `waitOnce`. */
  capabilities?: string[];
}

async function setup(scene: Scene) {
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: SCREEN, elements: scene.list } };
      case "press":
        return { ok: true, result: { element: SAVE, settledMs: 40 } };
      case "waitFor": {
        if (params["once"] === true) {
          const found = scene.found?.(params) ?? false;
          return { ok: true, result: { found } };
        }
        return { ok: true, result: { met: true, waitedMs: 10 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, scene.capabilities === undefined ? { capabilities: ["tree", "press", "waitFor", "waitOnce", "dryRun"] } : { capabilities: scene.capabilities }, handler);
  apps.push(app);
  return { app, tools: new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } }) };
}

const pressed = (app: FakeApp): number => app.requests.filter((r) => r.method === "press").length;

describe("conditionsOf", () => {
  it("reads if and optional off a step", () => {
    const step = { tool: "tap", target: { text: "Not now" }, optional: true, if: { id: "sheet", gone: true } } as Step;
    expect(conditionsOf(step)).toEqual([
      { kind: "if", probe: { testID: "sheet" }, gone: true, label: "id=sheet" },
      { kind: "optional", probe: { text: "Not now" }, gone: false, label: '"Not now"' },
    ]);
    expect(conditionOf(step)?.kind).toBe("if");
    expect(conditionOf({ tool: "back" } as Step)).toBeNull();
  });

  it("optional checks the step's own target: id, label or text", () => {
    expect(conditionOf({ tool: "tap", target: { id: "x" }, optional: true } as Step)?.probe).toEqual({ testID: "x" });
    expect(conditionOf({ tool: "tap", target: { label: "Close" }, optional: true } as Step)?.probe).toEqual({ label: "Close" });
    expect(conditionOf({ tool: "tap", target: { text: "Close" }, optional: true } as Step)?.probe).toEqual({ text: "Close" });
  });

  it("an x,y target, or no target, always counts as there", () => {
    expect(conditionOf({ tool: "tap", target: { x: 10, y: 20 }, optional: true } as Step)).toBeNull();
    expect(conditionOf({ tool: "back", optional: true } as Step)).toBeNull();
  });

  it("holdsIn counts the whole list, and gone flips it", () => {
    const list = [NOT_NOW] as unknown as TreeElement[];
    expect(holdsIn(list, { kind: "if", probe: { text: "not now" }, gone: false, label: "" })).toBe(true);
    expect(holdsIn(list, { kind: "if", probe: { text: "not now" }, gone: true, label: "" })).toBe(false);
    expect(holdsIn(list, { kind: "optional", probe: { ref: "e9" }, gone: false, label: "" })).toBe(false);
  });
});

describe("skippedLine", () => {
  it("says which condition kept the step out", () => {
    expect(skippedLine(3, "if", '"Not now"')).toBe('  3. skipped (if: "Not now" isn\'t on screen).');
    expect(skippedLine(3, "optional", '"Not now"')).toBe('  3. skipped (optional: "Not now" isn\'t on screen).');
    expect(skippedLine(3, "if", '"Spinner"', true)).toBe('  3. skipped (if: "Spinner" is still on screen).');
  });
});

describe("if and optional in run", () => {
  it("if text runs the step when it is there", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => true });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: "Rate this app" } }] });
    expect(answer.isError).toBeUndefined();
    expect(pressed(app)).toBe(1);
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
  });

  it("if text skips the step when it isn't there, and says so after line 1", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => false });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: "Rate this app" } }] });
    expect(answer.isError).toBeUndefined();
    expect(pressed(app)).toBe(0);
    const rows = textOf(answer).split("\n");
    expect(rows[0]).toMatch(/^Ran 1 of 1 steps in /);
    expect(rows[1]).toBe('  1. skipped (if: "Rate this app" isn\'t on screen).');
  });

  it("if with gone: true runs the step only when the thing isn't there", async () => {
    // The app answers found = the condition holds; with gone that means it is gone.
    const asked: Record<string, unknown>[] = [];
    const { app, tools } = await setup({
      list: [SAVE],
      found: (params) => {
        asked.push(params);
        return params["gone"] === true;
      },
    });
    await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { id: "spinner", gone: true } }] });
    expect(pressed(app)).toBe(1);
    expect(asked[0]).toMatchObject({ testID: "spinner", gone: true, once: true });
    const { app: app2, tools: tools2 } = await setup({ list: [SAVE], found: () => false });
    const answer = await tools2.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: "Loading", gone: true } }] });
    expect(pressed(app2)).toBe(0);
    expect(textOf(answer)).toContain('  1. skipped (if: "Loading" is still on screen).');
  });

  it("optional checks the step's own target: id, label and text", async () => {
    const asked: Record<string, unknown>[] = [];
    const { tools } = await setup({
      list: [SAVE],
      found: (params) => {
        asked.push(params);
        return true;
      },
    });
    await tools.run({
      steps: [
        { tool: "tap", target: { id: "not-now" }, optional: true },
        { tool: "tap", target: { label: "Close" }, optional: true },
        { tool: "tap", target: { text: "Later" }, optional: true },
      ],
    });
    expect(asked).toEqual([
      { testID: "not-now", once: true },
      { label: "Close", once: true },
      { text: "Later", once: true },
    ]);
  });

  it("an optional step is skipped when its target isn't there", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => false });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { text: "Not now" }, optional: true }, { tool: "tap", target: { id: "save" } }] });
    expect(pressed(app)).toBe(1);
    expect(textOf(answer).split("\n")[1]).toBe('  1. skipped (optional: "Not now" isn\'t on screen).');
    expect(textOf(answer)).toMatch(/^Ran 2 of 2 steps/);
  });

  it("a ref target is checked against the latest list", async () => {
    const { app, tools } = await setup({ list: [SAVE, NOT_NOW] });
    await tools.look({ screenshot: false });
    const here = await tools.run({ steps: [{ tool: "tap", target: { ref: "e7" }, optional: true }] });
    expect(here.isError).toBeUndefined();
    expect(pressed(app)).toBe(1);
    const gone = await tools.run({ steps: [{ tool: "tap", target: { ref: "e99" }, optional: true }] });
    expect(pressed(app)).toBe(1);
    expect(textOf(gone)).toContain("  1. skipped (optional: e99 isn't on screen).");
    // A ref is read from the list, not asked of the app.
    expect(app.requests.filter((r) => r.method === "waitFor")).toHaveLength(0);
  });

  it("an x,y target always counts as there", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => false });
    await tools.run({ steps: [{ tool: "tap", target: { x: 50, y: 630 }, optional: true }] });
    expect(pressed(app)).toBe(1);
    expect(app.requests.filter((r) => r.method === "waitFor")).toHaveLength(0);
  });

  it("a skipped step is said after line 1 without trace as well as with it, in step order", async () => {
    const { tools } = await setup({ list: [SAVE], found: () => false });
    const steps = [{ tool: "tap", target: { id: "save" } }, { tool: "tap", target: { text: "Not now" }, optional: true }];
    const plain = textOf(await tools.run({ steps })).split("\n");
    expect(plain[1]).toBe('  2. skipped (optional: "Not now" isn\'t on screen).');
    const traced = textOf(await tools.run({ steps, trace: true })).split("\n");
    expect(traced[1]).toMatch(/^  1\. Tapped /);
    expect(traced[2]).toBe('  2. skipped (optional: "Not now" isn\'t on screen).');
  });

  it("a skipped step's expect isn't checked", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => false });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { text: "Not now" }, optional: true, expect: { text: "Never shown" } }] });
    expect(answer.isError).toBeUndefined();
    // The only waitFor is the check itself.
    expect(app.requests.filter((r) => r.method === "waitFor").map((r) => (r.params as Record<string, unknown>)["once"])).toEqual([true]);
  });

  it("the check sends one waitFor with once: true and never polls or waits", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => false });
    const started = Date.now();
    await tools.run({ steps: [{ tool: "tap", target: { text: "Not now" }, optional: true }] });
    const waits = app.requests.filter((r) => r.method === "waitFor");
    expect(waits).toHaveLength(1);
    expect(waits[0]?.params).toEqual({ text: "Not now", once: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("without the waitOnce capability the host reads the list once instead", async () => {
    const { app, tools } = await setup({ list: [SAVE, NOT_NOW], capabilities: ["tree", "press", "waitFor", "dryRun"] });
    await tools.run({ steps: [{ tool: "tap", target: { text: "Not now" }, optional: true }, { tool: "tap", target: { text: "Nothing" }, optional: true }] });
    expect(pressed(app)).toBe(1);
    expect(app.requests.filter((r) => r.method === "waitFor")).toHaveLength(0);
  });

  it("bad_params: if needs exactly one of text, id, label", async () => {
    const { app, tools } = await setup({ list: [SAVE] });
    const none = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { gone: true } } as Step] });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/^Error bad_params: step 1 \(tap id=save\): if needs exactly one of text, id or label/);
    const two = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: "a", id: "b" } } as Step] });
    expect(textOf(two)).toMatch(/^Error bad_params: step 1/);
    expect(pressed(app)).toBe(0);
    const viaMcp = await callTool(tools, "run", { steps: [{ tool: "tap", target: { id: "save" }, if: { text: "a", id: "b" } }] });
    expect(viaMcp.isError).toBe(true);
  });
});

describe("if and optional in replay", () => {
  it("a saved script's conditional step is checked and skipped as in run", async () => {
    const { app, tools } = await setup({ list: [SAVE], found: () => false });
    const dir = mkdtempSync(join(tmpdir(), "tapline-if-"));
    dirs.push(dir);
    const path = join(dir, "flow.json");
    writeFileSync(
      path,
      JSON.stringify({
        format: "agent-tools-script",
        version: 1,
        name: "flow",
        fresh: false,
        steps: [
          { tool: "tap", target: { text: "Not now" }, optional: true },
          { tool: "tap", target: { id: "save" } },
        ],
      }),
    );
    const answer = await tools.replay({ path });
    expect(answer.isError).toBeUndefined();
    expect(pressed(app)).toBe(1);
    expect(textOf(answer)).toContain('  1. skipped (optional: "Not now" isn\'t on screen).');
  });
});
