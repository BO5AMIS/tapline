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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  // Saved by this run of the app (after the host started): the note gives the time only.
  // (AT is taken inside each test, after its host started, so a slow collection never makes it "an earlier run".)
  const two = (n: number): string => String(n).padStart(2, "0");
  const clock = (ts: number): string => {
    const d = new Date(ts);
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  };
  const day = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  };

  it("is told on the next answer with its time, once", async () => {
    const { host, app, tools } = await setup();
    const AT = Date.now() + 1000;
    app.send({ type: "event", event: "crash", data: { name: "RangeError", message: "kept from last run", stack: "", ts: AT } });
    await until(() => host.crashMark() === 1);
    const first = textOf(await tools.look({ screenshot: false }));
    expect(first.trimEnd().split("\n").at(-1)).toBe(`Note: the app crashed at ${clock(AT)}: RangeError: kept from last run. logs and crash show more.`);
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

  it("says so, with the date, when the saved crash is from before this host started", async () => {
    const { host, app, tools } = await setup();
    const OLD = new Date(2026, 0, 5, 9, 3, 4).getTime();
    expect(OLD).toBeLessThan(host.startedAt);
    app.send({ type: "event", event: "crash", data: { name: "RangeError", message: "kept from last run", stack: "", ts: OLD } });
    await until(() => host.crashMark() === 1);
    const said = textOf(await tools.look({ screenshot: false }));
    expect(said.trimEnd().split("\n").at(-1)).toBe(
      `Note: the app crashed in an earlier run, at ${day(OLD)} ${clock(OLD)}: RangeError: kept from last run. logs and crash show more.`,
    );
  });

  it("tells the app it has the crash (crashAck with the same ts), also when it already had it", async () => {
    const { host, app } = await setup();
    app.send({ type: "event", event: "crash", data: { message: "kept", ts: 4321 } });
    await until(() => app.requests.some((r) => r.method === "crashAck"));
    expect(app.requests.filter((r) => r.method === "crashAck").map((r) => r.params)).toEqual([{ ts: 4321 }]);
    app.send({ type: "event", event: "crash", data: { message: "kept", ts: 4321 } });
    await until(() => app.requests.filter((r) => r.method === "crashAck").length === 2);
    expect(host.crashes()).toHaveLength(1);
  });

  it("counts a saved crash once when the phone cut its long message", async () => {
    const { host, app } = await setup();
    const long = `boom ${"x".repeat(900)}`;
    app.send({ type: "event", event: "error", data: { ...FATAL, message: long, ts: 77 } });
    await until(() => host.crashMark() === 1);
    app.send({ type: "event", event: "crash", data: { name: "TypeError", message: long.slice(0, 400), stack: "", ts: 77 } });
    await until(() => app.requests.some((r) => r.method === "crashAck"));
    expect(host.crashMark()).toBe(1);
    expect(host.crashes()).toHaveLength(1);
    // another crash at the same time with another message is another crash
    app.send({ type: "event", event: "crash", data: { message: "something else", ts: 77 } });
    await until(() => host.crashMark() === 2);
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

describe("which calls carry a note", () => {
  it("a call that runs beside another one still carries the note (nesting is per call)", async () => {
    const { host, app, tools } = await setup();
    app.handler = (req) => {
      if (req.method === "tree") return { ok: true, result: TREE };
      return defaultHandler(req);
    };
    const slow = tools.wait({ seconds: 0.3 });
    app.send({ type: "event", event: "crash", data: { message: "late", ts: Date.now() + 1000 } });
    await until(() => host.crashMark() === 1);
    const quick = textOf(await tools.apps());
    expect(quick).toContain("the app crashed");
    await slow;
  });
});

describe("crashes of another app", () => {
  async function twoApps() {
    const { host, port, app: a, tools } = await setup();
    const { app: b, session: bSession } = await FakeApp.connect(port, { app: { name: "Other", id: "com.example.other", version: "1.0.0", build: "1" } }, defaultHandler);
    apps.push(b);
    const aSession = host.sessions().find((s) => s.app.id === "com.example.demo")?.id ?? "";
    host.select(aSession);
    return { host, port, a, b, bSession, aSession, tools };
  }

  it("shows on the answers of that app, not of the one being driven", async () => {
    const { host, b, bSession, tools } = await twoApps();
    b.send({ type: "event", event: "error", data: FATAL });
    await until(() => host.crashMark() === 1);
    expect(textOf(await tools.look({ screenshot: false }))).not.toContain("the app crashed");
    host.select(bSession);
    expect(textOf(await tools.look({ screenshot: false }))).toContain("the app crashed");
    expect(textOf(await tools.look({ screenshot: false }))).not.toContain("the app crashed");
  });

  it("crash reads the app being driven and marks only its events as told", async () => {
    const { host, a, b, bSession, aSession, tools } = await twoApps();
    a.send({ type: "event", event: "error", data: { ...FATAL, message: "in demo" } });
    b.send({ type: "event", event: "error", data: { ...FATAL, message: "in other" } });
    await until(() => host.crashMark() === 2);
    const said = textOf(tools.crash({}));
    expect(said).toContain("in demo");
    expect(said).not.toContain("in other");
    host.select(bSession);
    const note = textOf(await tools.look({ screenshot: false }));
    expect(note).toContain("the app crashed");
    expect(note).toContain("in other");
    host.select(aSession);
    expect(textOf(await tools.look({ screenshot: false }))).not.toContain("the app crashed");
  });

  it("with no app connected, crash reads the app of the most recent crash event, not every app", async () => {
    const { host, port, a, tools } = await twoApps();
    a.send({ type: "event", event: "error", data: { ...FATAL, message: "in demo" } });
    await until(() => host.crashMark() === 1);
    // the other app drops last, without a crash
    for (const app of apps) app.ws.terminate();
    await until(() => host.sessions().length === 0);
    const { app: c } = await FakeApp.connect(port, { app: { name: "Third", id: "com.example.third", version: "1.0.0", build: "1" } }, defaultHandler);
    apps.push(c);
    c.ws.terminate();
    await until(() => host.sessions().length === 0);
    const said = textOf(tools.crash({ all: true }));
    expect(said).toContain("in demo");
  });
});

describe("when the end of a session is explained", () => {
  it("a fatal error no longer explains a later end once the app is back in front", async () => {
    const { app, tools } = await setup();
    dieDuring(app, () => {
      app.send({ type: "event", event: "error", data: FATAL });
      app.send({ type: "event", event: "appState", data: { state: "active" } });
    });
    const said = textOf(await tools.tap({ target: { id: "go" } }));
    expect(said).toContain("the app crashed");
    expect(said).toContain("the app disconnected");
  });

  it("a reload that 'worked' without the app going away does not leave the next real crash explained away", async () => {
    const { app, tools } = await setup();
    // the reload is answered and the app stays
    expect(textOf(await tools.reload({ look: false }))).toBe("Reload requested.");
    dieDuring(app, () => undefined);
    const said = textOf(await tools.tap({ target: { id: "go" } }));
    expect(said.trimEnd().split("\n").at(-1)).toContain("the app disconnected during this call");
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
