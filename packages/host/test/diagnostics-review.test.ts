import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ControlQueue } from "../src/control.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// The Codex review of release 1.3.0 (PR #4): with two apps connected, one app's failure never reports the other's
// logs or crashes, and launch timing never measures the other app; a performance tap goes through the live view's
// queue like any agent touch.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const textOf = (r: CallToolResult): string => r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
const TREE = { screen: { width: 400, height: 800, scale: 2 }, elements: [{ ref: "e1", role: "button", text: "Save", frame: { x: 10, y: 10, width: 100, height: 40 } }] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function base(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: TREE };
  if (req.method === "press") return { ok: true, result: { element: TREE.elements[0], settledMs: 0 } };
  if (req.method === "perfStart") return { ok: true, result: { started: true, id: 1, dev: true, heap: true } };
  if (req.method === "perfStop") return { ok: true, result: { seconds: 0.1, frames: 6, fps: 60, fpsLowest: 60, drops: 0, busyMs: 10, heapMb: 10, heapPeakMb: 10, renders: [] } };
  if (req.method === "perfSettle") return { ok: true, result: {} };
  return { ok: true, result: {} };
}

describe("two apps connected", () => {
  it("a step that ends app A reports A's logs, not app B's", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    let a: FakeApp | undefined;
    let b: FakeApp | undefined;
    const handlerA = (req: IncomingRequest): Reply => {
      if (req.method === "press" && a !== undefined && (req.params as { dryRun?: boolean } | undefined)?.dryRun !== true) {
        // A logs its error and goes away in the middle of the press, without answering
        a.send({ type: "event", event: "error", data: { message: "A broke while saving", ts: Date.now() } });
        const dying = a;
        setTimeout(() => dying.ws.terminate(), 10);
        // app B logs during the step too, after A is gone (and B is the current app)
        setTimeout(() => b?.send({ type: "event", event: "error", data: { message: "B's own trouble", ts: Date.now() } }), 40);
        return "ignore";
      }
      return base(req);
    };
    a = (await FakeApp.connect(port, { app: { name: "Alpha", id: "com.example.alpha", version: "1", build: "1" } }, handlerA)).app;
    apps.push(a);
    b = (await FakeApp.connect(port, { app: { name: "Beta", id: "com.example.beta", version: "1", build: "1" } }, base)).app;
    apps.push(b);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    await tools.openApp({ app: "Alpha" });
    const out = textOf(await tools.run({ steps: [{ tool: "tap", target: { text: "Save" } }, { tool: "tap", target: { text: "Save" } }] }));
    expect(out).toContain("A broke while saving");
    expect(out).not.toContain("B's own trouble");
  });

  it("launch timing waits for app A to come back, and never measures app B", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    let a: FakeApp | undefined;
    const handlerA = (req: IncomingRequest): Reply => {
      if (req.method === "reload" && a !== undefined) {
        const dying = a;
        setTimeout(() => dying.ws.terminate(), 5);
        return { ok: true, result: {} };
      }
      return base(req);
    };
    a = (await FakeApp.connect(port, { app: { name: "Alpha", id: "com.example.alpha", version: "1", build: "1" } }, handlerA)).app;
    apps.push(a);
    const b = (await FakeApp.connect(port, { app: { name: "Beta", id: "com.example.beta", version: "1", build: "1" } }, base)).app;
    apps.push(b);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, reloadWaitMs: 400 });
    await tools.openApp({ app: "Alpha" });
    const out = await tools.performance({ launch: true, seconds: 0.1 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/hadn't reconnected/);
    expect(b.requests.filter((r) => r.method.startsWith("perf"))).toEqual([]);
  });
});

describe("a performance tap goes through the live view's queue", () => {
  it("is refused while the person paused the agent, and nothing is pressed", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "perf"] }, base);
    apps.push(app);
    const control = new ControlQueue();
    control.setPaused(true);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, control });
    const out = await tools.performance({ tap: { text: "Save" }, seconds: 0.1 });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/paused/);
    expect(app.requests.filter((r) => r.method === "press" && (r.params as { dryRun?: boolean } | undefined)?.dryRun !== true)).toEqual([]);
  });

  it("stops the window it started, by its number", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "perf"] }, base);
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    expect((await tools.performance({ seconds: 0.1 })).isError).not.toBe(true);
    expect(app.requests.filter((r) => r.method === "perfStop").map((r) => r.params)).toEqual([{ id: 1 }]);
  });
});

describe("CodeRabbit's review of 1.3.0", () => {
  it("never takes a bundle for a file of the app", async () => {
    const { isAppFrame } = await import("../src/crash.js");
    const frame = (file: string) => ({ text: "", fn: "render", file, line: 1, column: 1 });
    expect(isAppFrame(frame("file:///app/index.bundle"))).toBe(false);
    expect(isAppFrame(frame("/data/main.jsbundle"))).toBe(false);
    expect(isAppFrame(frame("C:/work/app/src/Trip.tsx"))).toBe(true);
  });

  it("tells apart two apps that send no id, by their names", async () => {
    const { identityOf } = await import("../src/server.js");
    const device = { platform: "ios" };
    expect(identityOf({ app: { name: "One", id: "unknown" }, device })).not.toBe(identityOf({ app: { name: "Two", id: "unknown" }, device }));
    expect(identityOf({ app: { name: "One", id: "com.a" }, device })).toBe(identityOf({ app: { name: "Renamed", id: "com.a" }, device }));
  });

  it("refuses launch with tap in a batch before any step runs", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "perf"] }, base);
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const out = await tools.run({ steps: [{ tool: "tap", target: { text: "Save" } }, { tool: "performance", launch: true, tap: { text: "Save" } }] });
    expect(textOf(out)).toMatch(/^Error bad_params: step 2 .*launch reloads the app and tap taps in it/);
    expect(app.requests.filter((r) => r.method === "press")).toEqual([]);
  });
});
