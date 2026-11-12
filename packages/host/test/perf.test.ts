import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { checkUnder, formatPerfLines, perfFirstLine, type PerfResult } from "../src/perf.js";
import { describeRunStep, expectSchema } from "../src/run.js";
import { refStep } from "../src/script.js";
import { toolDescription } from "../src/tool-text.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, toolShapes } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS §15.3 `performance`, Tapline's side.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: CallToolResult): string => result.content.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join("\n");

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame: { x: 0, y: 600, width: 200, height: 40 }, actions: ["press"] };
const TREE = { screen: { width: 402, height: 874, scale: 3 }, elements: [SAVE, DELETE] };

/** What a development build on Hermes answers. */
const DEV: PerfResult = {
  seconds: 3,
  frames: 171,
  fps: 57,
  fpsLowest: 41,
  drops: 3,
  busyMs: 180,
  heapMb: 48,
  heapPeakMb: 52,
  renders: [
    { name: "TripList", ms: 48, count: 3 },
    { name: "DayCard", ms: 12, count: 1 },
  ],
};
/** What a release build without Hermes answers: no heap, no renders. */
const RELEASE: PerfResult = { seconds: 3, frames: 180, fps: 60, fpsLowest: 58, drops: 0, busyMs: 20 };

function appFor(result: PerfResult, extra?: (req: IncomingRequest) => Reply | undefined) {
  return (req: IncomingRequest): Reply => {
    const special = extra?.(req);
    if (special !== undefined) return special;
    switch (req.method) {
      case "tree":
        return { ok: true, result: TREE };
      case "press":
        return { ok: true, result: { element: (req.params as { target?: { testID?: string } }).target?.testID === "delete-trip" ? DELETE : SAVE } };
      case "perfStart":
        return { ok: true, result: { started: true } };
      case "perfStop":
        return { ok: true, result };
      default:
        return { ok: true, result: {} };
    }
  };
}

async function setup(handler: (req: IncomingRequest) => Reply, options: ConstructorParameters<typeof TaplineTools>[1] extends infer O ? Partial<O> : never = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, reloadWaitMs: 2000, ...options });
  return { host, port, app, tools };
}

const methodsOf = (app: FakeApp): string[] => app.requests.map((r) => r.method).filter((m) => m !== "tree" && m !== "screenshot");

describe("the answer's lines", () => {
  it("a development build on Hermes: the first line, the numbers, the slowest renders, what wasn't measured", () => {
    expect([perfFirstLine({ result: DEV }), ...formatPerfLines(DEV)]).toEqual([
      "Measured 3.0 s.",
      "JS heap 48 MB (peak 52). JS frames 57 fps (lowest 41); 3 drops over 50 ms; JS thread busy at most 180 ms.",
      "Slowest renders: TripList 48 ms (3 times), DayCard 12 ms.",
      "Not measured here: CPU, process memory.",
    ]);
  });

  it("leaves out what the app couldn't get: no heap without Hermes, no renders outside development", () => {
    expect(formatPerfLines(RELEASE)).toEqual([
      "JS frames 60 fps (lowest 58); 0 drops over 50 ms; JS thread busy at most 20 ms.",
      "Not measured here: CPU, process memory.",
    ]);
  });

  it("says so when development timing found nothing slow, and writes 1 drop in the singular", () => {
    const lines = formatPerfLines({ ...RELEASE, drops: 1, renders: [] });
    expect(lines[0]).toContain("1 drop over 50 ms");
    expect(lines[1]).toBe("Slowest renders: none over 1 ms.");
  });

  it("the launch line names a JavaScript reload, not a cold start", () => {
    expect(perfFirstLine({ result: DEV, launchS: 1.1234 })).toBe(
      "Reloaded in 1.12 s (to the first settled screen; JavaScript only, not a cold start).",
    );
  });

  it("with a tap, the first line says the measuring began just before it", () => {
    expect(perfFirstLine({ result: DEV }, "id=save")).toBe("Measured 3.0 s, from just before the tap on id=save.");
  });
});

describe("under", () => {
  const m = { result: { ...DEV, drops: 4 }, launchS: 2.6 };

  it("lists every limit that isn't kept, in a fixed order: launch_s a maximum, fps_min a minimum", () => {
    const checked = checkUnder({ drops: 0, fps_min: 50, launch_s: 2, busy_ms: 100, js_heap_mb: 40 }, m);
    expect(checked.missed).toEqual([
      "reloaded in 2.6 s, over 2.0 s",
      "JS heap peaked at 52 MB, over 40 MB",
      "lowest 41 fps, under 50",
      "4 drops, over 0",
      "JS thread busy 180 ms, over 100 ms",
    ]);
    expect(checked.notes).toEqual([]);
  });

  it("keeps limits that hold; the lowest sample may equal fps_min", () => {
    expect(checkUnder({ fps_min: 41, drops: 4, busy_ms: 180, js_heap_mb: 52, launch_s: 2.6 }, m).missed).toEqual([]);
  });

  it("ignores memory_mb and cpu_percent with one note each", () => {
    expect(checkUnder({ memory_mb: 100, cpu_percent: 50 }, m)).toEqual({
      missed: [],
      notes: ["memory_mb isn't measured by Tapline; not checked.", "cpu_percent isn't measured by Tapline; not checked."],
    });
  });

  it("notes a heap limit it couldn't check, and a launch limit on a step that isn't a launch", () => {
    const checked = checkUnder({ js_heap_mb: 10, launch_s: 1 }, { result: RELEASE });
    expect(checked.missed).toEqual([]);
    expect(checked.notes).toHaveLength(2);
    expect(checked.notes[0]).toContain("launch_s only applies to a launch step");
    expect(checked.notes[1]).toContain("js_heap_mb couldn't be read");
  });

  it("expect takes under alone, or text, id or label", () => {
    expect(expectSchema.safeParse({ under: { drops: 0 } }).success).toBe(true);
    expect(expectSchema.safeParse({ under: { drops: 0 }, text: "x" }).success).toBe(false);
    expect(expectSchema.safeParse({ text: "x" }).success).toBe(true);
    expect(expectSchema.safeParse({}).success).toBe(false);
  });

  it("a performance step reads as performance launch, or by its seconds", () => {
    expect(describeRunStep({ tool: "performance", launch: true })).toBe("performance launch");
    expect(describeRunStep({ tool: "performance" })).toBe("performance 3 s");
    expect(describeRunStep({ tool: "performance", seconds: 0.5 })).toBe("performance 0.5 s");
  });
});

describe("the performance tool", () => {
  it("is a tool with launch, seconds and tap, described from the shared text", () => {
    expect(Object.keys(toolShapes.performance).sort()).toEqual(["launch", "seconds", "tap"]);
    expect(toolDescription("performance")).toContain("How the app performs");
  });

  it("measures for `seconds` and answers the shared lines, in order", async () => {
    const { app, tools } = await setup(appFor(DEV));
    const answer = await tools.performance({ seconds: 0.5 });
    expect(answer.isError).toBeUndefined();
    expect(textOf(answer)).toBe(
      [
        "Measured 3.0 s.",
        "JS heap 48 MB (peak 52). JS frames 57 fps (lowest 41); 3 drops over 50 ms; JS thread busy at most 180 ms.",
        "Slowest renders: TripList 48 ms (3 times), DayCard 12 ms.",
        "Not measured here: CPU, process memory.",
      ].join("\n"),
    );
    expect(methodsOf(app)).toEqual(["perfStart", "perfStop"]);
  });

  it("waits out the seconds between starting and stopping", async () => {
    const { tools } = await setup(appFor(RELEASE));
    const started = Date.now();
    await tools.performance({ seconds: 0.5 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(480);
  });

  it("a release build answers without the heap and renders lines", async () => {
    const { tools } = await setup(appFor(RELEASE));
    const answer = await tools.performance({ seconds: 0.5 });
    expect(textOf(answer)).toBe(
      ["Measured 3.0 s.", "JS frames 60 fps (lowest 58); 0 drops over 50 ms; JS thread busy at most 20 ms.", "Not measured here: CPU, process memory."].join("\n"),
    );
  });

  it("with a tap: the app starts measuring, then the tap, then the numbers", async () => {
    const { app, tools } = await setup(appFor(DEV));
    const answer = await tools.performance({ seconds: 0.5, tap: { id: "save" } });
    expect(methodsOf(app)).toEqual(["perfStart", "press", "perfStop"]);
    expect(textOf(answer).split("\n")[0]).toBe("Measured 3.0 s, from just before the tap on id=save.");
  });

  it("the tap goes through the policy: a Delete button needs a person's OK and nothing is measured", async () => {
    const { app, tools } = await setup(appFor(DEV));
    const answer = await tools.performance({ seconds: 0.5, tap: { id: "delete-trip" } });
    expect(textOf(answer)).toMatch(/^Error not_allowed: needs_confirmation: button "Delete trip"/);
    expect(methodsOf(app)).toEqual([]);
  });

  it("launch and tap don't go together", async () => {
    const { app, tools } = await setup(appFor(DEV));
    const answer = await tools.performance({ launch: true, tap: { id: "save" } });
    expect(textOf(answer)).toMatch(/^Error bad_params: /);
    expect(methodsOf(app)).toEqual([]);
  });

  it("an app too old for it says to update", async () => {
    const { tools } = await setup(appFor(DEV, (req) => (req.method === "perfStart" ? { ok: false, error: { code: "unsupported", message: "Unknown method perfStart" } } : undefined)));
    const answer = await tools.performance({ seconds: 0.5 });
    expect(textOf(answer)).toBe("Error unsupported: this app's Tapline is too old for performance; update react-native-tapline.");
  });

  it("a measurement the app can't finish stops the window and gives the app's error", async () => {
    const { app, tools } = await setup(appFor(DEV, (req) => (req.method === "press" && (req.params as { dryRun?: boolean }).dryRun !== true ? { ok: false, error: { code: "not_found", message: 'nothing on screen has id "save"' } } : undefined)));
    const answer = await tools.performance({ seconds: 0.5, tap: { id: "save" } });
    expect(textOf(answer)).toMatch(/^Error not_found: /);
    expect(methodsOf(app)).toEqual(["perfStart", "press", "perfStop"]);
  });
});

describe("launch", () => {
  /** A development build: asking it to reload ends this connection and a new session begins. */
  function reloading(result: PerfResult) {
    let port = 0;
    const state: { apps: FakeApp[] } = { apps: [] };
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "reload") {
        setTimeout(() => {
          state.apps[state.apps.length - 1]?.ws.close();
          void FakeApp.connect(port, {}, handler).then(({ app }) => {
            apps.push(app);
            state.apps.push(app);
          });
        }, 40);
        return { ok: true, result: {} };
      }
      return appFor(result)(req);
    };
    return {
      handler,
      async start() {
        const s = await startHost();
        hosts.push(s.host);
        port = s.port;
        const { app } = await FakeApp.connect(s.port, {}, handler);
        apps.push(app);
        state.apps.push(app);
        return { tools: new TaplineTools(s.host, { connect: { url: "", name: "Dev PC" }, reloadWaitMs: 3000 }), state };
      },
    };
  }

  it("reloads, times it to the first settled screen, then measures the new session", async () => {
    const { tools, state } = await reloading(DEV).start();
    const answer = await tools.performance({ launch: true, seconds: 0.5 });
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toMatch(/^Reloaded in \d+\.\d\d s \(to the first settled screen; JavaScript only, not a cold start\)\.$/);
    expect(lines.slice(1)).toEqual([
      "JS heap 48 MB (peak 52). JS frames 57 fps (lowest 41); 3 drops over 50 ms; JS thread busy at most 180 ms.",
      "Slowest renders: TripList 48 ms (3 times), DayCard 12 ms.",
      "Not measured here: CPU, process memory.",
    ]);
    const [first, second] = state.apps;
    expect(first?.requests.map((r) => r.method)).toEqual(["reload"]);
    expect(second?.requests.map((r) => r.method)).toEqual(["perfSettle", "perfStart", "perfStop"]);
  });

  it("a release build answers unsupported", async () => {
    const { tools } = await setup(appFor(RELEASE, (req) => (req.method === "reload" ? { ok: false, error: { code: "unsupported", message: "reload is only available in development builds" } } : undefined)));
    const answer = await tools.performance({ launch: true });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error unsupported: launch is a JavaScript reload/);
  });

  it("an app that doesn't come back says timeout", async () => {
    const { tools } = await setup(appFor(DEV, (req) => (req.method === "reload" ? { ok: true, result: {} } : undefined)), { reloadWaitMs: 150 });
    const answer = await tools.performance({ launch: true });
    expect(textOf(answer)).toMatch(/^Error timeout: /);
  });
});

describe("in run", () => {
  it("a performance step that keeps its limits passes", async () => {
    const { app, tools } = await setup(appFor(RELEASE));
    const answer = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { drops: 0, fps_min: 55, busy_ms: 100 } } }] });
    expect(answer.isError).toBeUndefined();
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps in /);
    expect(methodsOf(app)).toEqual(["perfStart", "perfStop"]);
  });

  it("stops with expect_failed and lists every limit that isn't kept", async () => {
    const { tools } = await setup(appFor({ ...DEV, drops: 4 }));
    const answer = await tools.run({
      steps: [{ tool: "wait", seconds: 0.1 }, { tool: "performance", seconds: 0.5, expect: { under: { drops: 0, fps_min: 50 } } }, { tool: "back" }],
    });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe(
      "Error expect_failed: Ran 1 of 3 steps; stopped at step 2 (performance 0.5 s): lowest 41 fps, under 50; 4 drops, over 0.",
    );
  });

  it("ignores memory_mb and cpu_percent with a note each, step by step", async () => {
    const { tools } = await setup(appFor(RELEASE));
    const answer = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { memory_mb: 100, cpu_percent: 50, drops: 0 } } }] });
    expect(answer.isError).toBeUndefined();
    const text = textOf(answer);
    expect(text).toContain("Note (step 1): memory_mb isn't measured by Tapline; not checked.");
    expect(text).toContain("Note (step 1): cpu_percent isn't measured by Tapline; not checked.");
  });

  it("any other key is bad_params, and nothing runs", async () => {
    const { app, tools } = await setup(appFor(RELEASE));
    const answer = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { fps: 30 } } }] });
    expect(textOf(answer)).toMatch(/^Error bad_params: step 1 \(performance 0\.5 s\): under has "fps"; the limits are launch_s, memory_mb, js_heap_mb, cpu_percent, fps_min, drops, busy_ms\./);
    expect(methodsOf(app)).toEqual([]);
  });

  it("under on any step but a performance step is bad_params", async () => {
    const { app, tools } = await setup(appFor(RELEASE));
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, expect: { under: { drops: 0 } } }] });
    expect(textOf(answer)).toBe('Error bad_params: step 1 (tap id=save): under goes only on a performance step.');
    expect(methodsOf(app)).toEqual([]);
  });

  it("launch_s on a step that isn't a launch, a negative limit and an empty under are bad_params, and nothing runs", async () => {
    const { app, tools } = await setup(appFor(RELEASE));
    const notLaunch = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { launch_s: 2 } } }] });
    expect(textOf(notLaunch)).toMatch(/^Error bad_params: step 1 \(performance 0\.5 s\): launch_s goes only on a launch step/);
    const negative = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { drops: -1 } } }] });
    expect(textOf(negative)).toMatch(/^Error bad_params: step 1 \(performance 0\.5 s\): under limits can't be negative \(drops\)/);
    const empty = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: {} } }] });
    expect(textOf(empty)).toMatch(/^Error bad_params: step 1 \(performance 0\.5 s\): under is empty/);
    expect(methodsOf(app)).toEqual([]);
  });

  it("a performance step that produced no measurement fails with expect_failed instead of passing", async () => {
    const { tools } = await setup(appFor(RELEASE));
    tools.performance = async () => ({ content: [{ type: "text", text: "Measured nothing." }] });
    const answer = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { drops: 0 } } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe("Error expect_failed: Ran 0 of 1 steps; stopped at step 1 (performance 0.5 s): no measurement to check.");
  });

  it("a step's own look and screenshot are ignored; other unknown parameters are bad_params", async () => {
    const { tools } = await setup(appFor(RELEASE));
    const fine = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, look: true, screenshot: true }] });
    expect(fine.isError).toBeUndefined();
    const bad = await tools.run({ steps: [{ tool: "performance", frames: 3 }] });
    expect(textOf(bad)).toMatch(/^Error bad_params: step 1: performance doesn't take frames; it takes /);
  });

  it("dry_run: a performance step with a tap resolves the tap and measures nothing", async () => {
    const { app, tools } = await setup(appFor(RELEASE));
    const answer = await tools.run({ steps: [{ tool: "performance", seconds: 0.5, tap: { id: "save" } }], dry_run: true });
    expect(answer.isError).toBeUndefined();
    expect(textOf(answer)).toMatch(/^Would run 1 step; step 1 would tap .*Save/);
    expect(methodsOf(app)).toEqual([]);
    expect(app.dryRuns.map((r) => r.method)).toEqual(["press"]);
  });

  it("dry_run: a tap that would fail says so; a step without a tap says what it would measure", async () => {
    const { app, tools } = await setup(
      appFor(RELEASE, (req) => ((req.params as { dryRun?: boolean }).dryRun === true ? { ok: false, error: { code: "not_found", message: 'nothing on screen has id "nope"' } } : undefined)),
    );
    const failing = await tools.run({ steps: [{ tool: "performance", tap: { id: "nope" } }], dry_run: true });
    expect(textOf(failing)).toMatch(/^Error not_found: Would run 1 step; step 1 \(performance 3 s\) would fail: /);
    const plain = await tools.run({ steps: [{ tool: "performance", seconds: 5 }, { tool: "back" }], dry_run: true });
    expect(textOf(plain)).toBe("Would run 2 steps; step 1 would measure 5 s.");
    const launch = await tools.run({ steps: [{ tool: "performance", launch: true }], dry_run: true });
    expect(textOf(launch)).toBe("Would run 1 step; step 1 would reload the app and time it to the first settled screen.");
    expect(methodsOf(app)).toEqual([]);
  });
});

describe("in run, launch", () => {
  it("a launch step over its time stops the batch: reloaded in 0.1 s, over 0.0 s", async () => {
    let port = 0;
    const live: FakeApp[] = [];
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "reload") {
        setTimeout(() => {
          live[live.length - 1]?.ws.close();
          void FakeApp.connect(port, {}, handler).then(({ app }) => {
            apps.push(app);
            live.push(app);
          });
        }, 40);
        return { ok: true, result: {} };
      }
      return appFor({ ...DEV, drops: 4 })(req);
    };
    const s = await startHost();
    hosts.push(s.host);
    port = s.port;
    const { app } = await FakeApp.connect(s.port, {}, handler);
    apps.push(app);
    live.push(app);
    const tools = new TaplineTools(s.host, { connect: { url: "", name: "Dev PC" }, reloadWaitMs: 3000 });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }, { tool: "performance", launch: true, seconds: 0.5, expect: { under: { launch_s: 0.001, drops: 0 } } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toMatch(
      /^Error expect_failed: Ran 1 of 2 steps; stopped at step 2 \(performance launch\): reloaded in \d+\.\d s, over 0\.0 s; 4 drops, over 0\.$/,
    );
  });
});

describe("record", () => {
  it("keeps a performance call as a step, without under", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-perf-"));
    dirs.push(dir);
    const { tools } = await setup(appFor(RELEASE), { scriptsDir: dir });
    await tools.record({ start: true, name: "perf" });
    await tools.run({ steps: [{ tool: "performance", seconds: 0.5, expect: { under: { drops: 0 } } }] });
    await tools.performance({ seconds: 0.5, tap: { id: "save" } });
    await tools.performance({ launch: true }).catch(() => undefined);
    const stopped = textOf(await tools.record({ stop: true }));
    expect(stopped).toMatch(/^Saved 2 steps to /);
    const script = JSON.parse(readFileSync(join(dir, "perf.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
    expect(script.steps).toEqual([
      { tool: "performance", seconds: 0.5 },
      { tool: "performance", seconds: 0.5, tap: { id: "save" } },
    ]);
  });

  it("a script's performance step keeps its under when replayed, and a ref in its tap can't be saved", () => {
    expect(refStep([{ tool: "performance", tap: { ref: "e3" } }, { tool: "tap", target: { id: "x" } }])).toBe(0);
    expect(refStep([{ tool: "performance", tap: { id: "save" } }])).toBeNull();
  });
});
