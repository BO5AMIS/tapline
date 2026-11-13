import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";
import { animationsOn, restoreAnimations, withNormalAnimations } from "../src/animations.js";
import { formatChanges, formatTree } from "../src/format.js";
import { treeResultSchema } from "../src/protocol.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { reportFor } from "../src/report.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";

// PLAN-1.6 F4 and AGENT-TOOLS 1.13 18.12: fast-forwarded animations. The app does the work; the host says it in every
// answer while it is on, refuses it in a user's-eyes journey unless `allow` names fast_animations, pauses it inside
// performance, filmstrip, compare_screen and journey frames, and puts it back when the session ends.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const SCREEN = { width: 402, height: 874, scale: 3 };
const LINE = "Animations: fast (Tapline).";

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

function picture(): string {
  const data = Buffer.alloc(100 * 200 * 4, 200);
  return jpeg.encode({ data, width: 100, height: 200 }, 90).data.toString("base64");
}

interface World {
  /** What the app's `animations` command was last set to. */
  speed: string;
  /** The `animations` commands the app received, in order, and every request in order (command speeds inline). */
  order: string[];
  /** The command fails (an app that cannot switch). */
  failCommand: boolean;
  /** `performance` answers an error. */
  perfFails: boolean;
  /** Taps made: the screen changes with each, so a journey keeps a picture of it. */
  taps: number;
}

function makeHandler(world: World): (req: IncomingRequest) => Reply {
  return (req) => {
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: SCREEN, elements: [{ ...SAVE, text: `Save ${world.taps}` }], ...(world.speed === "fast" ? { animations: "fast" } : {}) } };
      case "command": {
        const params = req.params as { name?: string; args?: { speed?: string } };
        if (params.name === "animations") {
          if (world.failCommand) return { ok: false, error: { code: "internal", message: "no" } };
          world.speed = params.args?.speed ?? "normal";
          world.order.push(`animations ${world.speed}`);
          return { ok: true, result: { name: "animations", result: { speed: world.speed, say: world.speed === "fast" ? `${LINE} Layers on: Animated and LayoutAnimation.` : "Animations: normal (Tapline)." } } };
        }
        return { ok: true, result: { name: params.name, result: null } };
      }
      case "screenshot":
        world.order.push(`screenshot while ${world.speed}`);
        return { ok: true, result: { mime: "image/jpeg", data: picture(), width: 100, height: 200 } };
      case "perfStart":
        world.order.push(`performance while ${world.speed}`);
        return { ok: true, result: { started: true, id: 1, dev: true, heap: true } };
      case "perfStop":
        return world.perfFails ? { ok: false, error: { code: "internal", message: "perf failed" } } : { ok: true, result: { seconds: 0.1, frames: 6, fps: 60, fpsLowest: 60, drops: 0, busyMs: 10, heapMb: 10, heapPeakMb: 10, renders: [] } };
      case "press":
        world.taps++;
        return { ok: true, result: { element: SAVE, settledMs: 100 } };
      default:
        return { ok: true, result: {} };
    }
  };
}

async function setup(options: { tools?: Partial<ConstructorParameters<typeof TaplineTools>[1]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tapline-animations-"));
  dirs.push(dir);
  const world: World = { speed: "normal", order: [], failCommand: false, perfFails: false, taps: 0 };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "screenshot", "animations"] }, makeHandler(world));
  apps.push(app);
  const tools = new TaplineTools(host, {
    connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
    baselinesDir: join(dir, "baselines"),
    logDir: join(dir, "log"),
    journeysDir: join(dir, "journeys"),
    ...options.tools,
  });
  return { app, host, tools, world, dir };
}

const fast = (tools: TaplineTools) => tools.appCommand({ name: "animations", args: { speed: "fast" }, look: false });

describe("the line in every answer", () => {
  it("reads the tree's animations and says the line in list and change headers", () => {
    const tree = { screen: SCREEN, elements: [SAVE], animations: "fast" };
    const parsed = treeResultSchema.safeParse(tree);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(formatTree(parsed.data).split("\n")).toContain(LINE);
    expect(formatChanges({ ...parsed.data, changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } }, {})).toContain(LINE);
    expect(formatTree({ screen: SCREEN, elements: [SAVE] })).not.toContain("Animations:");
  });

  it("reads a tree from a newer SDK whose animations is another word, and does not print it as fast", () => {
    const parsed = treeResultSchema.safeParse({ screen: SCREEN, elements: [], animations: "slow" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(formatTree(parsed.data)).not.toContain("Animations:");
  });

  it("every answer carries the line while fast: the switch, a look, a tap, wait_for", async () => {
    const { tools, app } = await setup();
    const said = textOf(await tools.appCommand({ name: "animations", args: { speed: "fast" } }));
    expect(app.requests[0]).toMatchObject({ method: "command", params: { name: "animations", args: { speed: "fast" } } });
    expect(said.split("\n")[0]).toBe(`${LINE} Layers on: Animated and LayoutAnimation.`);
    expect(said.split("\n")).toContain(LINE);
    expect(textOf(await tools.look({ screenshot: false }))).toContain(LINE);
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain(LINE);
    const back = textOf(await tools.appCommand({ name: "animations", args: { speed: "normal" } }));
    expect(back.split("\n")[0]).toBe("Animations: normal (Tapline).");
    expect(textOf(await tools.look({ screenshot: false }))).not.toContain("Animations:");
  });

  it("runs as a step in run", async () => {
    const { tools, world } = await setup();
    const answer = await tools.run({ steps: [{ tool: "app_command", name: "animations", args: { speed: "fast" } }], look: false });
    expect(answer.isError).toBeUndefined();
    expect(world.speed).toBe("fast");
  });

  it("a switch the app refuses is an error and the host does not think it is on", async () => {
    const { tools, world, app } = await setup();
    world.failCommand = true;
    const answer = await fast(tools);
    expect(answer.isError).toBe(true);
    world.failCommand = false;
    // a measurement now does not try to pause something that never started
    await tools.performance({ seconds: 1 });
    expect(app.requests.filter((r) => r.method === "command")).toHaveLength(1);
  });
});

describe("a user's-eyes journey", () => {
  const start = (tools: TaplineTools, extra: Record<string, unknown> = {}) => tools.journey({ start: true, goal: "log two eggs", persona: "a first-timer", eyes: "user", ...extra });

  it("refuses fast animations unless allow names fast_animations, and normal always goes", async () => {
    const { tools, world } = await setup();
    await start(tools);
    const refused = await fast(tools);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error not_allowed: in a journey, fast animations are off: a user waits for them; the journey's allow can name fast_animations\./);
    expect(world.speed).toBe("normal");
    const normal = await tools.appCommand({ name: "animations", args: { speed: "normal" }, look: false });
    expect(normal.isError).toBeUndefined();
    await tools.journey({ stop: true, reached: false });

    await start(tools, { allow: ["fast_animations"] });
    const allowed = await fast(tools);
    expect(allowed.isError).toBeUndefined();
    expect(world.speed).toBe("fast");
    await tools.journey({ stop: true, reached: true });
  });

  it("allow naming only the command (animations) does not lift the ban", async () => {
    const { tools } = await setup();
    await start(tools, { allow: ["animations"] });
    expect((await fast(tools)).isError).toBe(true);
    await tools.journey({ stop: true, reached: false });
  });

  it("refuses it as a step of run too, naming the step", async () => {
    const { tools, world } = await setup();
    await start(tools);
    const answer = await tools.run({ steps: [{ tool: "app_command", name: "animations", args: { speed: "fast" } }] });
    expect(textOf(answer)).toMatch(/^Error not_allowed: step 1: in a journey, fast animations are off/);
    expect(world.speed).toBe("normal");
    await tools.journey({ stop: true, reached: false });
  });

  it("starts with animations normal when they were on, with a note; with fast_animations allowed they stay on", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    const started = textOf(await start(tools));
    expect(world.speed).toBe("normal");
    expect(started).toContain("Note: animations were turned off for this journey: a user waits for them. allow fast_animations keeps them on.");
    expect(started).not.toContain(LINE);
    await tools.journey({ stop: true, reached: false });

    await fast(tools);
    const kept = textOf(await start(tools, { allow: ["fast_animations"] }));
    expect(world.speed).toBe("fast");
    expect(kept).not.toContain("turned off for this journey");
    await tools.journey({ stop: true, reached: true });
  });

  it("in the agent's eyes it is allowed", async () => {
    const { tools, world } = await setup();
    await tools.journey({ start: true, goal: "check the sheet", eyes: "agent" });
    expect((await fast(tools)).isError).toBeUndefined();
    expect(world.speed).toBe("fast");
    await tools.journey({ stop: true, reached: true });
  });

  it("journey frames are taken with animations normal, and fast is back after", async () => {
    const { tools, world } = await setup();
    await start(tools, { allow: ["fast_animations"] });
    await fast(tools);
    world.order.length = 0;
    await tools.tap({ target: { text: "Save 0" }, screenshot: false });
    const shot = world.order.findIndex((entry) => entry.startsWith("screenshot"));
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(world.order[shot]).toBe("screenshot while normal");
    expect(world.order[world.order.length - 1]).toBe("animations fast");
    expect(world.speed).toBe("fast");
    await tools.journey({ stop: true, reached: true });
  });
});

describe("measuring tools pause it", () => {
  it("performance runs with animations normal, puts fast back, and says so", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    world.order.length = 0;
    const said = textOf(await tools.performance({ seconds: 1 }));
    expect(world.order).toEqual(["animations normal", "performance while normal", "animations fast"]);
    expect(world.speed).toBe("fast");
    expect(said.trimEnd().split("\n").pop()).toBe("Note: animations were normal during this call.");
  });

  it("performance that fails still puts fast back and says so", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    world.perfFails = true;
    const answer = await tools.performance({ seconds: 1 });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("Note: animations were normal during this call.");
    expect(world.speed).toBe("fast");
  });

  it("filmstrip pauses and resumes", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    world.order.length = 0;
    const said = textOf(await tools.filmstrip({ frames: 2, interval_ms: 10 }));
    expect(world.order[0]).toBe("animations normal");
    expect(world.order.filter((e) => e.startsWith("screenshot"))).toEqual(["screenshot while normal", "screenshot while normal"]);
    expect(world.order[world.order.length - 1]).toBe("animations fast");
    expect(said).toContain("Note: animations were normal during this call.");
  });

  it("compare_screen pauses and resumes, also as a step of run", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    world.order.length = 0;
    const said = textOf(await tools.compareScreen({ name: "home" }));
    expect(world.order[0]).toBe("animations normal");
    expect(world.order.filter((e) => e.startsWith("screenshot")).every((e) => e === "screenshot while normal")).toBe(true);
    expect(world.order[world.order.length - 1]).toBe("animations fast");
    expect(said).toContain("Note: animations were normal during this call.");

    world.order.length = 0;
    const ran = textOf(await tools.run({ steps: [{ tool: "compare_screen", name: "home" }], look: false }));
    expect(world.order[0]).toBe("animations normal");
    expect(world.order[world.order.length - 1]).toBe("animations fast");
    expect(ran).toContain("Note (step 1): animations were normal during this call.");
    expect(world.speed).toBe("fast");
  });

  it("with animations normal nothing is sent and no note is added", async () => {
    const { tools, world, app } = await setup();
    const said = textOf(await tools.performance({ seconds: 1 }));
    expect(said).not.toContain("animations were normal");
    expect(app.requests.filter((r) => r.method === "command")).toHaveLength(0);
    expect(world.order).toEqual(["performance while normal"]);
  });

  it("a switch back to normal made earlier is not undone by a measurement", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    await tools.appCommand({ name: "animations", args: { speed: "normal" }, look: false });
    world.order.length = 0;
    await tools.performance({ seconds: 1 });
    expect(world.order).toEqual(["performance while normal"]);
  });
});

describe("pauses", () => {
  it("two overlapping pauses send normal once and put fast back only when the last one ends", async () => {
    const { tools, host, world, app } = await setup();
    await fast(tools);
    const id = host.current()?.id ?? "";
    world.order.length = 0;
    let endFirst: () => void = () => undefined;
    let endSecond: () => void = () => undefined;
    const first = withNormalAnimations(host, id, () => new Promise<string>((resolve) => (endFirst = () => resolve("one"))));
    const second = withNormalAnimations(host, id, () => new Promise<string>((resolve) => (endSecond = () => resolve("two"))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(world.order).toEqual(["animations normal"]);
    endFirst();
    expect(await first).toMatchObject({ value: "one", paused: true });
    // the second is still running: fast stays off
    expect(world.order).toEqual(["animations normal"]);
    expect(world.speed).toBe("normal");
    endSecond();
    expect(await second).toMatchObject({ value: "two", paused: true });
    expect(world.order).toEqual(["animations normal", "animations fast"]);
    expect(world.speed).toBe("fast");
    expect(app.requests.filter((r) => r.method === "command")).toHaveLength(3);
  });

  it("when the switch to normal fails the note says so and does not claim animations were normal", async () => {
    const { tools, world } = await setup();
    await fast(tools);
    world.failCommand = true;
    const said = textOf(await tools.performance({ seconds: 1 }));
    expect(said).not.toContain("animations were normal");
    expect(said).toContain("Note: animations could not be set to normal for this call; it ran with fast animations.");
  });

  it("a session that ends is forgotten, so a new one is not thought fast", async () => {
    const { tools, host, app } = await setup();
    await fast(tools);
    const id = host.current()?.id ?? "";
    expect(animationsOn(host, id)).toBe(true);
    app.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(animationsOn(host, id)).toBe(false);
  });
});

describe("the session ends", () => {
  it("restoreAnimations sends normal to a session that is fast, once", async () => {
    const { tools, host, world, app } = await setup();
    await fast(tools);
    await restoreAnimations(host);
    expect(world.speed).toBe("normal");
    const commands = app.requests.filter((r) => r.method === "command").map((r) => r.params);
    expect(commands).toEqual([
      { name: "animations", args: { speed: "fast" } },
      { name: "animations", args: { speed: "normal" } },
    ]);
    await restoreAnimations(host);
    expect(app.requests.filter((r) => r.method === "command")).toHaveLength(2);
  });

  it("closing the runtime sends normal first", async () => {
    const home = mkdtempSync(join(tmpdir(), "tapline-animations-home-"));
    dirs.push(home);
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: home }, log: () => undefined });
    runtimes.push(runtime);
    const world: World = { speed: "normal", order: [], failCommand: false, perfFails: false, taps: 0 };
    const { app } = await FakeApp.connect(runtime.port, { token: runtime.config.token, capabilities: ["tree", "press", "animations"] }, makeHandler(world));
    apps.push(app);
    await fast(runtime.toolsFor(undefined));
    expect(world.speed).toBe("fast");
    await runtime.close();
    expect(world.speed).toBe("normal");
  });

  it("a session that already went away is skipped without an error", async () => {
    const { tools, host, app } = await setup();
    await fast(tools);
    app.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(restoreAnimations(host)).resolves.toBeUndefined();
  });
});

describe("the report", () => {
  it("says fast animations were on, and for how many calls", async () => {
    const { tools, dir } = await setup();
    await tools.look({ screenshot: false });
    await fast(tools);
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "save" }, look: false });
    await tools.appCommand({ name: "animations", args: { speed: "normal" }, look: false });
    await tools.look({ screenshot: false });
    const report = textOf(tools.sessionReport());
    expect(report).toMatch(/^Animations: fast for 3 of 6 calls\.$/m);
    // the first report is itself a call by now
    expect(reportFor(join(dir, "log"), 0)).toContain("Animations: fast for 3 of 7 calls.");
  });

  it("says nothing when they were never on", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    expect(textOf(tools.sessionReport())).not.toContain("Animations:");
  });
});
