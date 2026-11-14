import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { ControlQueue } from "../src/control.js";
import { SKIPPED_IN_USE, exitCodeOf, exploreArgs, runExplore, type ExploreCliDeps, type ExploreCliHost, type ExploreCliResult } from "../src/explorecmd.js";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// `tapline explore` (AGENT-TOOLS 1.15 §25.2): the exit codes, with a fake host and with the real tools over the fake app.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Out {
  out: string[];
  err: string[];
  slept: number[];
  closed: number;
  asked: Array<Record<string, unknown>>;
}

function fakeHost(result: ExploreCliResult, options: { open?: boolean; busyFor?: number } = {}): { host: ExploreCliHost; log: Out; deps: ExploreCliDeps } {
  const log: Out = { out: [], err: [], slept: [], closed: 0, asked: [] };
  let busy = options.busyFor ?? 0;
  let now = 0;
  const host: ExploreCliHost = {
    via: "a fake host",
    appOpen: async () => options.open !== false,
    inUse: () => {
      if (busy > 0) {
        busy -= 1;
        return true;
      }
      return false;
    },
    explore: async (args) => {
      log.asked.push({ ...args });
      return result;
    },
    close: async () => {
      log.closed += 1;
    },
  };
  const deps: ExploreCliDeps = {
    connect: async () => host,
    clock: () => now,
    sleep: async (ms) => {
      log.slept.push(ms);
      now += ms;
    },
    out: (text) => log.out.push(text),
    err: (text) => log.err.push(text),
  };
  return { host, log, deps };
}

const done = (over: Partial<ExploreCliResult> = {}): ExploreCliResult => ({ text: "Explored 6 places in 1 min (40 steps), 0 findings. Stopped: the frontier is empty.", refused: false, findings: 0, stopped: "frontier_empty", ...over });

describe("tapline explore: flags", () => {
  it("is a command with the flags of the call", () => {
    const { values, positionals } = parseCli(["explore", "--minutes", "5", "--steps", "50", "--depth", "3", "--from", "home", "--focus", "settings", "--fill", "test-data", "--continue", "--account", "tester2", "--policy", "p.json", "--accounts", "a.json", "--maps", "m"]);
    expect(positionals).toEqual(["explore"]);
    expect(values).toMatchObject({ minutes: "5", steps: "50", depth: "3", from: "home", focus: "settings", fill: "test-data", continue: true, account: "tester2", policy: "p.json", accounts: "a.json", maps: "m" });
  });

  it("turns the flags into the call's arguments, and refuses a bad one", () => {
    expect(exploreArgs({})).toEqual({ args: {} });
    expect(exploreArgs({ minutes: "5", steps: "50", depth: "3", from: "home", focus: "settings", fill: "test-data", continue: true, account: "tester2" })).toEqual({
      args: { minutes: 5, steps: 50, depth: 3, from: "home", focus: "settings", fill: "test-data", continue: true, account: "tester2" },
    });
    expect(exploreArgs({ minutes: "soon" })).toEqual({ error: '--minutes is a number, not "soon"' });
    expect(exploreArgs({ steps: "" })).toEqual({ error: '--steps is a number, not ""' });
    expect(exploreArgs({ fill: "everything" })).toEqual({ error: '--fill is "none", "test-data" or "fixture:<name>.<field>", not "everything"' });
    expect(exploreArgs({ from: " " })).toEqual({ error: "--from needs a name" });
  });
});

describe("tapline explore: exit codes", () => {
  it("0: it ended and found nothing, a budget stop included", async () => {
    for (const stopped of ["frontier_empty", "budget_minutes", "budget_steps"] as const) {
      const { deps, log } = fakeHost(done({ stopped }));
      expect(await runExplore({ minutes: "3" }, deps)).toBe(0);
      expect(log.asked).toEqual([{ minutes: 3 }]);
      expect(log.out.join("\n")).toContain("Explored 6 places");
      expect(log.closed).toBe(1);
    }
  });

  it("1: it ended with findings, a crash included, or on a trouble the report names", async () => {
    for (const result of [done({ findings: 3 }), done({ findings: 1, stopped: "crash" }), done({ stopped: "crash" }), done({ stopped: "toggle_not_restored" }), done({ stopped: "cant_get_back" }), done({ stopped: "app_closed" })]) {
      const { deps, log } = fakeHost(result);
      expect(await runExplore({}, deps)).toBe(1);
      expect(log.out.join("\n")).toContain("Explored");
    }
  });

  it("2: it couldn't start (a bad flag, no app, no connection, a refused call)", async () => {
    const bad = fakeHost(done());
    expect(await runExplore({ minutes: "x" }, bad.deps)).toBe(2);
    expect(bad.log.err.join("\n")).toContain("--minutes is a number");
    expect(bad.log.asked).toEqual([]);
    for (const wait of ["Infinity", "-Infinity", "1e999", "NaN"]) expect(await runExplore({ wait }, bad.deps)).toBe(2);
    expect(bad.log.asked).toEqual([]);
    expect(await runExplore({ wait: "0" }, bad.deps)).toBe(2);
    const closed = fakeHost(done(), { open: false });
    expect(await runExplore({}, closed.deps)).toBe(2);
    expect(closed.log.err.join("\n")).toContain("The app didn't connect");
    expect(closed.log.closed).toBe(1);
    const nope = fakeHost(done());
    expect(await runExplore({}, { ...nope.deps, connect: async () => Promise.reject(new Error("no port")) })).toBe(2);
    expect(nope.log.err.join("\n")).toBe("explore couldn't start: no port");
    const refused = fakeHost(done({ text: "Error bad_params: minutes is a number from 1 to 60, not 99.", refused: true, stopped: null }));
    expect(await runExplore({ minutes: "99" }, refused.deps)).toBe(2);
    expect(refused.log.err.join("\n")).toContain("Error bad_params: minutes");
  });

  it("2: a person or a pause stopped it before the end (the report is still written)", async () => {
    for (const stopped of ["paused", "busy", "locked"] as const) {
      const { deps, log } = fakeHost(done({ text: `Error ${stopped}: stopped. Done: 3 steps, 2 places. Left at: home. Report: ~/r/report.md`, stopped, findings: 1 }));
      expect(await runExplore({}, deps)).toBe(2);
      expect(log.err.join("\n")).toContain("Report: ~/r/report.md");
    }
  });

  it("waits for a busy phone, up to 10 minutes, then answers `skipped: the phone was in use` with code 2", async () => {
    const waits = fakeHost(done(), { busyFor: 3 });
    expect(await runExplore({}, waits.deps)).toBe(0);
    expect(waits.log.slept).toEqual([5000, 5000, 5000]);
    const never = fakeHost(done(), { busyFor: 1_000_000 });
    expect(await runExplore({}, { ...never.deps, busyWaitMs: 12_000 })).toBe(2);
    expect(never.log.err).toEqual([SKIPPED_IN_USE]);
    expect(never.log.asked).toEqual([]);
    expect(never.log.slept).toEqual([5000, 5000, 2000]);
  });

  it("maps a result to its code", () => {
    expect(exitCodeOf(done())).toBe(0);
    expect(exitCodeOf(done({ findings: 1 }))).toBe(1);
    expect(exitCodeOf(done({ refused: true, stopped: null }))).toBe(2);
    expect(exitCodeOf(done({ stopped: "paused", findings: 4 }))).toBe(2);
  });
});

/** The command line over the real tools and the fake app. */
function overTools(s: ExploreSetup): ExploreCliHost {
  return {
    via: "the tools",
    appOpen: async () => true,
    inUse: () => false,
    explore: async (args) => {
      const ran = await s.tools.exploreRun(args);
      const text = ran.answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      return { text, refused: ran.outcome === undefined, findings: ran.outcome?.report.findings.length ?? 0, stopped: ran.outcome?.report.stopped ?? null };
    },
    close: async () => undefined,
  };
}

describe("tapline explore: over the fake app", () => {
  const run = async (s: ExploreSetup, flags: Parameters<typeof runExplore>[0] = {}): Promise<{ code: number; log: Out }> => {
    const log: Out = { out: [], err: [], slept: [], closed: 0, asked: [] };
    const code = await runExplore(flags, { connect: async () => overTools(s), clock: Date.now, sleep: async () => undefined, out: (t) => log.out.push(t), err: (t) => log.err.push(t) });
    return { code, log };
  };
  const make = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);

  it("exits 0 for a run that found nothing and writes the report", async () => {
    const s = await make();
    const { code, log } = await run(s);
    expect(code).toBe(0);
    expect(log.out.join("\n")).toMatch(/Explored 6 places .* Stopped: the frontier is empty\./);
    expect(log.out.join("\n")).toMatch(/Report: .*report\.md/);
  });

  it("exits 1 for a run with findings", async () => {
    const s = await make({
      world: (w) => {
        w.errorOn["open-form"] = "TypeError: form failed";
      },
    });
    expect((await run(s)).code).toBe(1);
  });

  it("exits 1 for a crash", async () => {
    const s = await make({
      world: (w) => {
        w.screens["home"]?.elements.unshift(btn("boom", "Boom"));
        w.crashOn.add("boom");
      },
    });
    const { code, log } = await run(s);
    expect(code).toBe(1);
    expect(log.out.join("\n")).toContain("Stopped: the app crashed.");
  });

  it("exits 2 for a pause, and 2 for a value out of range", async () => {
    const control = new ControlQueue();
    const s = await make({
      tools: { control },
      world: (w) => {
        w.onPress = () => control.setPaused(true);
      },
    });
    const paused = await run(s);
    expect(paused.code).toBe(2);
    expect(paused.log.err.join("\n")).toMatch(/^Error paused:/);
    const t = await make();
    const bad = await run(t, { minutes: "99" });
    expect(bad.code).toBe(2);
    expect(bad.log.err.join("\n")).toMatch(/^Error bad_params: minutes is a number from 1 to 60, not 99\./);
  });
});
