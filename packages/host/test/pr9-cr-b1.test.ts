import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiAnswer } from "../src/api.js";
import { afterPause, animationsOn, endAnimations, restoreAnimations, withNormalAnimations } from "../src/animations.js";
import { Dialogs, askDone, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import { regionsFromMask } from "../src/images.js";
import { Journey } from "../src/journey.js";
import { secondTapSentence } from "../src/nochange.js";
import { CLIENT_IDLE_MS, createRuntime, type Runtime } from "../src/runtime.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, until, type IncomingRequest, type Reply } from "./helpers.js";

// PR 9 CodeRabbit findings, host side (batch B1): one regression test for each.

const runtimes: Runtime[] = [];
const apps: FakeApp[] = [];
const hosts: TaplineHost[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const TREE = { screen: { width: 430, height: 932 }, elements: [SAVE] };

async function runtime(options: { viewer?: "off" | "local"; clock?: () => number } = {}): Promise<Runtime> {
  const home = mkdtempSync(join(tmpdir(), "tapline-pr9b1-"));
  dirs.push(home);
  const r = await createRuntime({ port: 0, host: "127.0.0.1", viewer: options.viewer ?? "off", env: { TAPLINE_HOME: home }, log: () => undefined, api: true, ...(options.clock ? { clock: options.clock } : {}) });
  runtimes.push(r);
  return r;
}

async function post(r: Runtime, tool: string, args: unknown, client: string): Promise<ApiAnswer> {
  const res = await fetch(`http://127.0.0.1:${r.port}/api/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.config.token}`, "x-agent-client": client },
    body: JSON.stringify(args),
  });
  return (await res.json()) as ApiAnswer;
}

describe("runtime: clients that share a tools object", () => {
  it("serializes their calls: the second waits for the first", async () => {
    const r = await runtime();
    const held: IncomingRequest[] = [];
    const { app } = await FakeApp.connect(r.port, { token: r.config.token }, (req): Reply => {
      if (req.method === "tree") {
        held.push(req);
        return "ignore";
      }
      return { ok: true, result: {} };
    });
    apps.push(app);
    const first = post(r, "look", { screenshot: false }, "agent-a");
    await until(() => held.length === 1);
    const second = post(r, "look", { screenshot: false }, "agent-a");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(held).toHaveLength(1);
    // another client is not held up by it
    const other = post(r, "look", { screenshot: false }, "agent-b");
    await until(() => held.length === 2);
    for (const req of held.splice(0)) app.send({ type: "response", id: req.id, ok: true, result: TREE });
    await other;
    await first;
    await until(() => held.length === 1);
    app.send({ type: "response", id: held[0]?.id, ok: true, result: TREE });
    await second;
  });
});

describe("runtime: an idle client is disposed", () => {
  it("takes its listeners off the host when it is dropped", async () => {
    let now = 1_000_000;
    const r = await runtime({ clock: () => now });
    r.toolsFor("a");
    const withOne = r.host.listenerCount("touch");
    now += CLIENT_IDLE_MS + 1000;
    r.toolsFor("b");
    expect(r.host.listenerCount("touch")).toBe(withOne);
  });

  it("closing the runtime takes every client's listeners off", async () => {
    const r = await runtime();
    const before = r.host.listenerCount("touch");
    r.toolsFor("a");
    r.toolsFor("b");
    expect(r.host.listenerCount("touch")).toBe(before + 2);
    await r.close();
    expect(r.host.listenerCount("touch")).toBe(0);
  });
});

describe("runtime: viewer input", () => {
  it("makes a thin client's refs stale", async () => {
    const r = await runtime({ viewer: "local" });
    const { app } = await FakeApp.connect(r.port, { token: r.config.token }, (req): Reply => {
      if (req.method === "tree") return { ok: true, result: TREE };
      if (req.method === "overlay") return { ok: true, result: { screen: TREE.screen, elements: [] } };
      return { ok: true, result: { element: SAVE } };
    });
    apps.push(app);
    const seen = await post(r, "look", { screenshot: false }, "agent-a");
    expect(seen.isError).toBe(false);
    const viewerLink = r.viewerLinks[0] ?? "";
    const token = new URL(viewerLink).searchParams.get("token") ?? "";
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "gesture", points: [[0, 0.5, 0.5], [30, 0.5, 0.5]] }));
    await until(() => app.requests.some((q) => q.method === "press"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stale = await post(r, "tap", { target: { ref: "e3" }, look: false }, "agent-a");
    expect(stale.text).toMatch(/^Error stale:/);
  });
});

// Animations -------------------------------------------------------------------------------------

interface World {
  speed: string;
  order: string[];
  failCommand: boolean;
}

async function animationsRig(): Promise<{ host: TaplineHost; tools: TaplineTools; world: World }> {
  const world: World = { speed: "normal", order: [], failCommand: false };
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "command") {
      const params = req.params as { name?: string; args?: { speed?: string } };
      if (params.name === "animations") {
        if (world.failCommand) return { ok: false, error: { code: "internal", message: "no" } };
        world.speed = params.args?.speed ?? "normal";
        world.order.push(`animations ${world.speed}`);
        return { ok: true, result: { name: "animations", result: { speed: world.speed } } };
      }
    }
    if (req.method === "tree") return { ok: true, result: TREE };
    return { ok: true, result: {} };
  };
  const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "animations"] }, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
  return { host, tools, world };
}
const fast = (tools: TaplineTools) => tools.appCommand({ name: "animations", args: { speed: "fast" }, look: false });

describe("animations: restoration that fails", () => {
  it("endAnimations keeps the session tracked as fast and says false", async () => {
    const { host, tools, world } = await animationsRig();
    await fast(tools);
    const id = host.current()?.id ?? "";
    world.failCommand = true;
    expect(await endAnimations(host, id)).toBe(false);
    expect(animationsOn(host, id)).toBe(true);
    world.failCommand = false;
    expect(await endAnimations(host, id)).toBe(true);
    expect(animationsOn(host, id)).toBe(false);
  });

  it("restoreAnimations keeps a session the app would not restore", async () => {
    const { host, tools, world } = await animationsRig();
    await fast(tools);
    const id = host.current()?.id ?? "";
    world.failCommand = true;
    await restoreAnimations(host);
    expect(animationsOn(host, id)).toBe(true);
  });
});

describe("animations: an explicit fast command during a measurement", () => {
  it("waits for the pause to end instead of changing the speed inside it", async () => {
    const { host, tools, world } = await animationsRig();
    await fast(tools);
    const id = host.current()?.id ?? "";
    world.order.length = 0;
    let end: () => void = () => undefined;
    const measuring = withNormalAnimations(host, id, () => new Promise<string>((resolve) => (end = () => resolve("done"))));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const explicit = fast(tools);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(world.speed).toBe("normal");
    expect(world.order).toEqual(["animations normal"]);
    end();
    await measuring;
    await explicit;
    expect(world.speed).toBe("fast");
    await afterPause(host, id);
  });
});

// Elicit -----------------------------------------------------------------------------------------

class Quiet implements ElicitClient {
  asked = 0;
  canShowForm(): boolean {
    return true;
  }
  elicit(_message: string, _schema: unknown, signal: AbortSignal): Promise<ElicitAnswer> {
    this.asked++;
    return new Promise<ElicitAnswer>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }
}

describe("askDone: cancelled during the first check", () => {
  it("says cancelled and does not report cleared", async () => {
    const client = new Quiet();
    const controller = new AbortController();
    const outcome = await askDone(
      new Dialogs(client),
      "open the app",
      async () => {
        controller.abort();
        return true;
      },
      { signal: controller.signal },
    );
    expect(outcome).toBe("cancelled");
    expect(client.asked).toBe(0);
  });

  it("does not open a dialog when the first check says no and the caller cancelled meanwhile", async () => {
    const client = new Quiet();
    const controller = new AbortController();
    const outcome = await askDone(
      new Dialogs(client),
      "open the app",
      async () => {
        controller.abort();
        return false;
      },
      { signal: controller.signal, ttlMs: 5000 },
    );
    expect(outcome).toBe("cancelled");
    expect(client.asked).toBe(0);
  });
});

// Double tap -------------------------------------------------------------------------------------

describe("the second tap of a double tap", () => {
  it("says a handler that threw is a handler failure, not a tap that didn't land", () => {
    const said = secondTapSentence({ done: true, afterMs: 80, threw: "boom\nat x" });
    expect(said).toBe("The first tap went through; the second, 80 ms later, reached the handler, but the handler threw: boom at x");
    expect(said).not.toContain("didn't land");
  });

  it("keeps the other two sentences", () => {
    expect(secondTapSentence({ done: true, afterMs: 80 })).toBe("Both taps went through, 80 ms apart.");
    expect(secondTapSentence({ done: false, reason: "disabled", afterMs: 81 })).toBe("The first tap went through; the second, 81 ms later, didn't land (disabled).");
  });
});

// Journey ----------------------------------------------------------------------------------------

describe("a drive step inside run keeps its repair", () => {
  it("stores the repair line whether or not it is prefixed with Note:", () => {
    const j = new Journey({ goal: "g" }, () => 0);
    j.record({ tool: "drive", ok: true, text: 'Arrived at language by 2 taps in 1.0 s.\nNote: Road repaired: "Languag".', at: 0, ms: 1 }, j.pre());
    expect(j.state.steps[0]?.travel).toEqual(['Road repaired: "Languag".']);
  });
});

// Images -----------------------------------------------------------------------------------------

describe("changed regions count only their own pixels", () => {
  it("a region inside another one's box does not add to it", () => {
    const size = 80;
    const mask = new Uint8Array(size * size);
    const fill = (cx: number, cy: number): void => {
      for (let y = cy * 16; y < cy * 16 + 16; y++) for (let x = cx * 16; x < cx * 16 + 16; x++) mask[y * size + x] = 1;
    };
    for (let i = 0; i < 5; i++) {
      fill(i, 0);
      fill(i, 4);
      fill(0, i);
      fill(4, i);
    }
    fill(2, 2);
    const regions = regionsFromMask(mask, size, size);
    expect(regions).toHaveLength(2);
    const ring = regions.find((box) => box.width === size);
    const inner = regions.find((box) => box.width === 16);
    expect(ring?.pixels).toBe(16 * 256);
    expect(inner?.pixels).toBe(256);
  });
});
