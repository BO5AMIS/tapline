import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { parseFrames, isAppFrame, crashSummary } from "../src/crash.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, delay, startHost, until, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TREE = {
  screen: { width: 402, height: 874, scale: 3 },
  elements: [
    { ref: "e3", type: "Pressable", role: "button", testID: "go", label: "Go", text: "Go", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] },
  ],
};

const STACK = [
  "TypeError: undefined is not an object (evaluating 'trip.days')",
  "    at TripScreen (/app/src/screens/TripScreen.tsx:42:13)",
  "    at renderWithHooks (/app/node_modules/react-native/Libraries/Renderer/ReactNativeRenderer-dev.js:100:1)",
  "    at http://192.0.2.1:8081/index.bundle?platform=ios:1234:5",
  "    at DayCard (/app/src/DayCard.tsx:7:3)",
].join("\n");

const FATAL = { message: "undefined is not an object (evaluating 'trip.days')", stack: STACK, fatal: true, name: "TypeError", ts: 1_000 };

function defaultHandler(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: TREE };
  if (req.method === "screenshot") return { ok: true, result: { mime: "image/jpeg", data: "QUJD", width: 600, height: 1305 } };
  if (req.method === "press") return { ok: true, result: { element: TREE.elements[0] } };
  return { ok: true, result: {} };
}

async function setup(options: { logDir?: string } = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, defaultHandler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, ...options });
  return { host, port, app, tools };
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

/** The app answers nothing and goes away a moment after `before` has been sent. */
function dieDuring(app: FakeApp, before: () => void): void {
  app.handler = (req) => {
    if (req.method !== "press") return defaultHandler(req);
    before();
    setTimeout(() => app.ws.terminate(), 30);
    return "ignore";
  };
}

describe("stack reading", () => {
  it("tells the app's frames from libraries, bundle URLs and native code", () => {
    const frames = parseFrames(STACK);
    expect(frames).toHaveLength(4);
    expect(frames.map(isAppFrame)).toEqual([true, false, false, true]);
    expect(parseFrames("render@/app/src/A.tsx:3:4\n[native code]")[0]).toMatchObject({ fn: "render", line: 3 });
  });

  it("names the error and the top app frame on one line", () => {
    expect(crashSummary({ ts: 1, name: "TypeError", message: "boom.", stack: STACK, source: "live" })).toBe("TypeError: boom, at TripScreen.tsx:42");
  });
});

describe("the note when the app crashes during a call", () => {
  it("ends the answer, an error answer too, with the error and where, and no time", async () => {
    const { app, tools } = await setup();
    dieDuring(app, () => app.send({ type: "event", event: "error", data: FATAL }));
    const said = textOf(await tools.tap({ target: { id: "go" } }));
    expect(said).toMatch(/^Error /);
    expect(said.trimEnd().split("\n").at(-1)).toBe(
      "Note: the app crashed: TypeError: undefined is not an object (evaluating 'trip.days'), at TripScreen.tsx:42. logs and crash show more.",
    );
    // told once
    expect(textOf(await tools.apps())).not.toContain("the app crashed");
  });

  it("does not repeat the note for a calls of `run`'s steps, only the batch", async () => {
    const { app, tools } = await setup();
    dieDuring(app, () => app.send({ type: "event", event: "error", data: FATAL }));
    const said = textOf(await tools.run({ steps: [{ tool: "tap", target: { id: "go" } }] }));
    expect(said.match(/the app crashed/g)).toHaveLength(1);
  });
});

describe("a crash that reaches the host later", () => {
  const AT = new Date(2026, 10, 12, 10, 42, 7).getTime();

  it("is told on the next answer with its time, once", async () => {
    const { host, app, tools } = await setup();
    app.send({ type: "event", event: "crash", data: { name: "RangeError", message: "kept from last run", stack: "", ts: AT } });
    await until(() => host.crashMark() === 1);
    const first = textOf(await tools.look({ screenshot: false }));
    expect(first.trimEnd().split("\n").at(-1)).toBe("Note: the app crashed at 10:42:07: RangeError: kept from last run. logs and crash show more.");
    expect(textOf(await tools.look({ screenshot: false }))).not.toContain("the app crashed");
  });

  it("counts a saved crash the host already heard live only once", async () => {
    const { host, app, tools } = await setup();
    app.send({ type: "event", event: "error", data: FATAL });
    await until(() => host.crashMark() === 1);
    app.send({ type: "event", event: "crash", data: { name: "TypeError", message: FATAL.message, stack: FATAL.stack, ts: FATAL.ts } });
    await delay(50);
    expect(host.crashMark()).toBe(1);
    expect(textOf(await tools.crash({ all: true })).match(/TypeError/g)?.length).toBeGreaterThan(0);
    expect(host.crashes()).toHaveLength(1);
  });

  it("survives the app connecting again with a new session", async () => {
    const { host, port, app, tools } = await setup();
    app.send({ type: "event", event: "error", data: FATAL });
    await until(() => host.crashMark() === 1);
    app.ws.terminate();
    await until(() => host.sessions().length === 0);
    const { app: again } = await FakeApp.connect(port, {}, defaultHandler);
    apps.push(again);
    expect(textOf(tools.crash({}))).toContain("TypeError");
  });
});

describe("the app disconnecting during a call", () => {
  const DISCONNECTED = "Note: the app disconnected during this call (it may have crashed; Tapline can't read native crash reports, Tapwright's crash can).";

  it("is noted when the app goes away without a JS error", async () => {
    const { app, tools } = await setup();
    dieDuring(app, () => undefined);
    const said = textOf(await tools.tap({ target: { id: "go" } }));
    expect(said.trimEnd().split("\n").at(-1)).toBe(DISCONNECTED);
  });

  it("is not noted for a reload the agent asked for", async () => {
    const { app, tools } = await setup();
    app.handler = (req) => {
      if (req.method !== "reload") return defaultHandler(req);
      setTimeout(() => app.ws.terminate(), 30);
      return "ignore";
    };
    const said = textOf(await tools.reload({ look: false }));
    expect(said).not.toContain("may have crashed");
    expect(textOf(await tools.apps())).not.toContain("may have crashed");
  });

  it("is not noted when the user left the app (it went to the background)", async () => {
    const { app, tools } = await setup();
    dieDuring(app, () => app.send({ type: "event", event: "appState", data: { state: "background" } }));
    const said = textOf(await tools.tap({ target: { id: "go" } }));
    expect(said).not.toContain("disconnected during");
    expect(said).not.toContain("the app crashed");
  });

  it("is not noted when nothing was in flight", async () => {
    const { host, app, tools } = await setup();
    app.ws.terminate();
    await until(() => host.sessions().length === 0);
    expect(textOf(await tools.apps())).not.toContain("may have crashed");
  });

  it("is not noted on top of a JS crash that explains it", async () => {
    const { app, tools } = await setup();
    dieDuring(app, () => app.send({ type: "event", event: "error", data: FATAL }));
    const said = textOf(await tools.tap({ target: { id: "go" } }));
    expect(said).toContain("the app crashed");
    expect(said).not.toContain("the app disconnected");
  });
});

describe("the crash tool", () => {
  const AT = new Date(2026, 10, 12, 10, 42, 7).getTime();

  it("says so when there is none", async () => {
    const { tools } = await setup();
    expect(textOf(tools.crash({}))).toBe("No JS crash since the app connected. A native crash doesn't show here; Tapwright's crash reads those.");
  });

  it("shows the newest crash with the app's frames marked and the component stack", async () => {
    const { host, app, tools } = await setup();
    app.send({ type: "event", event: "error", data: { ...FATAL, ts: AT - 5000, message: "older" } });
    app.send({ type: "event", event: "error", data: { ...FATAL, ts: AT, componentStack: "\n    in DayCard\n    in TripScreen" } });
    await until(() => host.crashMark() === 2);
    const said = textOf(tools.crash({}));
    expect(said.split("\n")[0]).toBe("10:42:07 TypeError: undefined is not an object (evaluating 'trip.days')");
    expect(said).toContain("  * at TripScreen (/app/src/screens/TripScreen.tsx:42:13)");
    expect(said).toContain("    at renderWithHooks");
    expect(said).not.toContain("  * at renderWithHooks");
    expect(said).toContain("Component stack:\n  in DayCard\n  in TripScreen");
    expect(said).not.toContain("older");
  });

  it("shows the last 5 with all, newest first, and stops at 8 frames", async () => {
    const { host, app, tools } = await setup();
    const long = ["Error: deep", ...Array.from({ length: 12 }, (_, i) => `    at f${i} (/app/src/F${i}.tsx:${i + 1}:1)`)].join("\n");
    for (let i = 0; i < 6; i++) app.send({ type: "event", event: "error", data: { ...FATAL, stack: long, message: `crash ${i}`, ts: AT + i * 1000 } });
    await until(() => host.crashMark() === 6);
    const one = textOf(tools.crash({}));
    expect(one).toContain("crash 5");
    expect(one).not.toContain("crash 4");
    expect(one).toContain("…(+4 more frames)");
    expect(one).not.toContain("at f8 ");
    const all = textOf(tools.crash({ all: true }));
    expect(all.match(/TypeError: crash \d/g)).toEqual(["TypeError: crash 5", "TypeError: crash 4", "TypeError: crash 3", "TypeError: crash 2", "TypeError: crash 1"]);
  });

  it("reading it clears the pending note", async () => {
    const { host, app, tools } = await setup();
    app.send({ type: "event", event: "crash", data: { message: "late", ts: AT } });
    await until(() => host.crashMark() === 1);
    tools.crash({});
    expect(textOf(await tools.apps())).not.toContain("the app crashed");
  });
});

describe("the action log", () => {
  it("holds no crash text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-crash-"));
    dirs.push(dir);
    const { app, tools } = await setup({ logDir: dir });
    dieDuring(app, () => app.send({ type: "event", event: "error", data: FATAL }));
    await tools.tap({ target: { id: "go" } });
    tools.crash({ all: true });
    const files = existsSync(dir) ? readdirSync(dir) : [];
    const written = files.map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
    expect(written).not.toContain("trip.days");
    expect(written).not.toContain("TripScreen");
    expect(written).not.toContain("crashed");
  });
});
