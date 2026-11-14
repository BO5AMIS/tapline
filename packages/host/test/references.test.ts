import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { expectSchema } from "../src/run.js";
import { failureWithDiff, junitXml, readScript, scriptSteps } from "../src/script.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Square {
  x: number;
  y: number;
  size: number;
}

/** A grey JPEG with dark squares (pixels). */
function picture(squares: Square[] = [], width = 300, height = 600): string {
  const data = Buffer.alloc(width * height * 4, 200);
  for (const sq of squares) {
    for (let y = sq.y; y < sq.y + sq.size; y++) {
      for (let x = sq.x; x < sq.x + sq.size; x++) {
        const i = (y * width + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return jpeg.encode({ data, width, height }, 90).data.toString("base64");
}

const BIG: Square[] = [{ x: 40, y: 40, size: 60 }]; // 2% of 300x600

const TREE = {
  screen: { width: 150, height: 300, scale: 3 },
  elements: [
    { ref: "e1", type: "ScrollView", role: "scrollview", text: "Everything on the page", frame: { x: 0, y: 0, width: 150, height: 300 }, actions: ["scroll"] },
    { ref: "e2", type: "Text", role: "text", testID: "clock", text: "12:00", frame: { x: 20, y: 20, width: 40, height: 40 }, actions: [] },
    { ref: "e3", type: "Pressable", role: "button", testID: "save", label: "Save", text: "Save", frame: { x: 10, y: 250, width: 100, height: 30 }, actions: ["press"] },
    { ref: "e4", type: "View", role: "none", frame: { x: 100, y: 100, width: 20, height: 20 }, actions: [] },
  ],
};

async function setup(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), "tapline-refs-"));
  dirs.push(dir);
  const state = { shot: initial };
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "screenshot":
        return { ok: true, result: { mime: "image/jpeg", data: state.shot, width: 300, height: 600 } };
      case "tree":
        return { ok: true, result: TREE };
      case "press":
        return { ok: true, result: { element: TREE.elements[2] } };
      default:
        return { ok: true, result: {} };
    }
  };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const scriptsDir = join(dir, "scripts");
  const baselinesDir = join(dir, "baselines");
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, scriptsDir, baselinesDir });
  return { tools, dir, scriptsDir, baselinesDir, store: join(baselinesDir, "com.example.demo"), state };
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const tap = { target: { id: "save" }, look: false, screenshot: false } as const;

/** The steps without their `seen` (1.16): a step's facts have their own tests; these ones are about the rest of the step. */
function withoutSeen<T>(steps: T[] | undefined): unknown[] | undefined {
  return steps?.map((step) => {
    const { seen: _seen, ...rest } = step as Record<string, unknown>;
    return rest;
  });
}

describe("record carries references", () => {
  it("folds a compare_screen after a tap into expect.matches and copies the reference", async () => {
    const { tools, scriptsDir, store } = await setup(picture());
    await tools.record({ start: true, name: "flow" });
    await tools.tap(tap);
    await tools.compareScreen({ name: "home" }); // first call saves the reference
    const stop = await tools.record({ stop: true });
    const script = readScript(readFileSync(join(scriptsDir, "flow.json"), "utf8"));
    expect(withoutSeen(script?.steps)).toEqual([{ tool: "tap", target: { id: "save" }, expect: { matches: "home" } }]);
    const folder = join(scriptsDir, "flow.references");
    expect(textOf(stop).split("\n")[0]).toBe(`Saved 1 step to ${join(scriptsDir, "flow.json")}, and 1 reference picture to ${folder}.`);
    expect(readFileSync(join(folder, "home.jpg")).equals(readFileSync(join(store, "home.jpg")))).toBe(true);
  });

  it("writes threshold and ignore into the expectation, and never update", async () => {
    const { tools, scriptsDir } = await setup(picture());
    await tools.record({ start: true, name: "flow" });
    await tools.tap(tap);
    await tools.compareScreen({ name: "home", update: true, threshold: 2, ignore: [{ ref: "e2" }, { x: 1, y: 2, width: 3, height: 4 }] });
    await tools.record({ stop: true });
    const script = readScript(readFileSync(join(scriptsDir, "flow.json"), "utf8"));
    expect(script?.steps[0]?.expect).toEqual({ matches: "home", threshold: 2, ignore: [{ id: "clock" }, { x: 1, y: 2, width: 3, height: 4 }] });
    expect(readFileSync(join(scriptsDir, "flow.json"), "utf8")).not.toContain("update");
  });

  it("a compare_screen that is not right after an action is a step of its own; two references say so in the answer", async () => {
    const { tools, scriptsDir } = await setup(picture());
    await tools.record({ start: true, name: "flow" });
    await tools.compareScreen({ name: "first" }); // nothing before it
    await tools.tap(tap);
    await tools.compareScreen({ name: "second", threshold: 1 });
    await tools.compareScreen({ name: "third" }); // the tap already has an expectation
    const stop = await tools.record({ stop: true });
    const script = readScript(readFileSync(join(scriptsDir, "flow.json"), "utf8"));
    expect(withoutSeen(script?.steps)).toEqual([
      { tool: "compare_screen", name: "first" },
      { tool: "tap", target: { id: "save" }, expect: { matches: "second", threshold: 1 } },
      { tool: "compare_screen", name: "third" },
    ]);
    expect(textOf(stop).split("\n")[0]).toBe(`Saved 3 steps to ${join(scriptsDir, "flow.json")}, and 3 reference pictures to ${join(scriptsDir, "flow.references")}.`);
  });

  it("scriptSteps leaves a step with an expectation alone", () => {
    const steps = scriptSteps([
      { method: "press", params: { target: { testID: "a" } } },
      { method: "waitFor", params: { text: "Done" } },
      { method: "compareScreen", params: { name: "x" } },
    ]);
    expect(steps).toEqual([
      { tool: "tap", target: { id: "a" }, expect: { text: "Done" } },
      { tool: "compare_screen", name: "x" },
    ]);
  });

  it("refuses an ignore ref that has no id, label or text, and does not record the call", async () => {
    const { tools, scriptsDir } = await setup(picture());
    await tools.record({ start: true, name: "flow" });
    await tools.tap(tap);
    const result = await tools.compareScreen({ name: "home", ignore: [{ ref: "e4" }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error bad_params: ignore .*e4.* has no id, label or text/);
    const stop = await tools.record({ stop: true });
    const script = readScript(readFileSync(join(scriptsDir, "flow.json"), "utf8"));
    expect(withoutSeen(script?.steps)).toEqual([{ tool: "tap", target: { id: "save" } }]);
    expect(textOf(stop).split("\n")[0]).toBe(`Saved 1 step to ${join(scriptsDir, "flow.json")}.`);
  });

  it("outside a recording an ignore ref is fine", async () => {
    const { tools } = await setup(picture());
    const result = await tools.compareScreen({ name: "home", ignore: [{ ref: "e4" }] });
    expect(result.isError).not.toBe(true);
  });
});

function writeScript(dir: string, name: string, steps: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ format: "agent-tools-script", version: 1, name, fresh: false, steps }));
  return path;
}

describe("replay with references", () => {
  it("looks next to the script first, then in the store", async () => {
    const { tools, dir, scriptsDir, state } = await setup(picture());
    // the store holds a reference that would fail; the script's folder holds the one that matches
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const path = writeScript(scriptsDir, "flow", [{ tool: "tap", target: { id: "save" }, expect: { matches: "home" } }]);
    const failing = await tools.replay({ path });
    expect(failing.isError).toBe(true);
    // the script's folder gets a reference of the screen as it is now
    const folder = join(scriptsDir, "flow.references");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "home.jpg"), Buffer.from(picture(BIG), "base64"));
    const held = await tools.replay({ path });
    expect(held.isError).not.toBe(true);
    expect(textOf(held)).toContain("Ran 1 of 1 steps");
    // a name only the store has still resolves
    const other = writeScript(join(dir, "elsewhere"), "other", [{ tool: "compare_screen", name: "home" }]);
    expect((await tools.replay({ path: other })).isError).toBe(true);
    state.shot = picture();
    expect((await tools.replay({ path: other })).isError).not.toBe(true);
  });

  it("a failed check writes the red picture next to the script and says where", async () => {
    const { tools, scriptsDir, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const path = writeScript(scriptsDir, "flow", [{ tool: "compare_screen", name: "home" }]);
    const result = await tools.replay({ path });
    expect(result.isError).toBe(true);
    const diff = join(scriptsDir, "flow.diff", "home.jpg");
    expect(existsSync(diff)).toBe(true);
    const text = textOf(result);
    expect(text).toContain(`Note: the difference is saved at ${diff}.`);
    const failure = failureWithDiff(text);
    expect(failure.split("\n")[0]).toMatch(/^Error expect_failed: Ran 0 of 1 steps; stopped at step 1 \(compare_screen "home"\): .*\(diff: .*home\.jpg\)$/);
    const xml = junitXml([{ name: "flow", seconds: 1, failure }]);
    expect(xml).toMatch(/<failure message="[^"]*\(diff: [^"]*home\.jpg\)">/);
  });

  it("expect.matches takes ignore", async () => {
    const { tools, scriptsDir, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG); // inside the clock
    const bad = writeScript(scriptsDir, "plain", [{ tool: "tap", target: { id: "save" }, expect: { matches: "home" } }]);
    expect((await tools.replay({ path: bad })).isError).toBe(true);
    const good = writeScript(scriptsDir, "masked", [{ tool: "tap", target: { id: "save" }, expect: { matches: "home", ignore: [{ id: "clock" }] } }]);
    expect((await tools.replay({ path: good })).isError).not.toBe(true);
    const wrong = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, expect: { matches: "home", ignore: [{ id: "a", text: "b" }] } }], look: false });
    expect(textOf(wrong)).toMatch(/^Error bad_params: step 1 .*expect\.ignore/);
    expect(expectSchema.safeParse({ text: "x", ignore: [{ id: "a" }] }).success).toBe(false);
    expect(expectSchema.safeParse({ matches: "x", ignore: [{ id: "a" }] }).success).toBe(true);
  });

  it("--update-references saves into the script's folder instead of comparing, and holds", async () => {
    const { tools, scriptsDir, store, state } = await setup(picture(BIG));
    const path = writeScript(scriptsDir, "flow", [
      { tool: "tap", target: { id: "save" }, expect: { matches: "after-tap" } },
      { tool: "compare_screen", name: "end" },
    ]);
    const result = await tools.replay({ path }, { updateReferences: true });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("Ran 2 of 2 steps");
    const folder = join(scriptsDir, "flow.references");
    expect(existsSync(join(folder, "after-tap.jpg"))).toBe(true);
    expect(existsSync(join(folder, "end.jpg"))).toBe(true);
    expect(existsSync(join(store, "end.jpg"))).toBe(false);
    // a plain replay now compares against them
    expect((await tools.replay({ path })).isError).not.toBe(true);
    state.shot = picture();
    expect((await tools.replay({ path })).isError).toBe(true);
  });
});
