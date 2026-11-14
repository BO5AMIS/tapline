import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import { ControlQueue } from "../src/control.js";
import type { ExploreReport } from "../src/explorereport.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { btn, flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);
const lastRun = (s: ExploreSetup): string => {
  const appDir = join(s.exploreDir, APP.id);
  return join(appDir, readdirSync(appDir).sort().at(-1) as string);
};
const reportOf = (s: ExploreSetup): ExploreReport => JSON.parse(readFileSync(join(lastRun(s), "report.json"), "utf8")) as ExploreReport;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15)));

describe("explore: budget and stop (§25.9)", () => {
  it("stops at the minutes budget on the clock, and says which budget", async () => {
    const s = await setup({ msPerRequest: 30_000 });
    const answer = await s.tools.explore({ minutes: 1 });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toMatch(/Stopped: the budget \(minutes\) is used up\./);
    const report = reportOf(s);
    expect(report.stopped).toBe("budget_minutes");
    expect(report.used.minutes).toBeGreaterThanOrEqual(1);
    expect(report.used.steps).toBeLessThan(10);
  });

  it("stops at the steps budget: each touch, scroll, back and reset is a step", async () => {
    const s = await setup();
    const answer = await s.tools.explore({ steps: 6 });
    expect(textOf(answer)).toMatch(/Explored \d+ places in 0 min \(\d+ steps\), 0 findings\. Stopped: the budget \(steps\) is used up\./);
    const report = reportOf(s);
    expect(report.stopped).toBe("budget_steps");
    expect(report.used.steps).toBeGreaterThanOrEqual(6);
    expect(report.used.steps).toBeLessThanOrEqual(8);
    // A short run leaves a frontier, and says how much.
    expect(report.coverage.frontier_left).toBeGreaterThan(0);
  });

  it("stops at the first crash by default, and never tries that action again on the same build", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["home"]?.elements.unshift(btn("boom", "Boom"));
        w.crashOn.add("boom");
      },
    });
    const answer = await s.tools.explore({});
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toMatch(/Stopped: the app crashed\./);
    expect(textOf(answer)).toContain("Findings: 1 crash.");
    expect(reportOf(s).stopped).toBe("crash");
    await s.registry.flushAll();
    expect(s.file().places["home"]?.explored?.actions.find((a) => a.sig === "id:boom")?.result).toBe("crash");
    // The person opens the app again; the next run goes on from the map and leaves the crashing control alone.
    await s.reopen();
    s.world.pressed.length = 0;
    const next = await s.tools.explore({});
    expect(textOf(next)).toContain("Stopped: the frontier is empty.");
    expect(s.world.pressed).not.toContain("boom");
    expect(s.world.pressed).toContain("open-trips");
  });

  it("goes on after a crash with continue, when the app is open again", async () => {
    const s = await setup({
      tools: { sleep: realSleep, exploreGraceMs: 3000 },
      world: (w) => {
        w.screens["home"]?.elements.unshift(btn("boom", "Boom"));
        w.crashOn.add("boom");
        w.reopenAfterCrashMs = 60;
      },
    });
    const answer = await s.tools.explore({ continue: true });
    expect(textOf(answer)).toMatch(/Stopped: the frontier is empty\./);
    expect(textOf(answer)).toContain("Findings: 1 crash.");
    expect(s.world.pressed).toContain("open-trips");
    expect(s.world.pressed).toContain("trip-row-1");
    expect(reportOf(s).coverage.places).toBe(6);
  });

  it("ends with `the app is closed` when it crashed and nobody opens the app again", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["home"]?.elements.unshift(btn("boom", "Boom"));
        w.crashOn.add("boom");
      },
    });
    const answer = await s.tools.explore({ continue: true });
    expect(textOf(answer)).toContain("Stopped: the app is closed.");
    expect(reportOf(s).stopped).toBe("app_closed");
    expect(reportOf(s).findings.map((f) => f.kind)).toEqual(["crash"]);
  });
});

describe("explore: a person goes first (§25.9, §6)", () => {
  it("is stopped between steps by Pause with `Error paused:`, and writes the report first", async () => {
    const control = new ControlQueue();
    let presses = 0;
    const s = await setup({
      tools: { control },
      world: (w) => {
        w.onPress = () => {
          presses += 1;
          if (presses === 3) control.setPaused(true);
        };
      },
    });
    const answer = await s.tools.explore({});
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error paused: The user paused the agent in the live viewer\. Done: \d+ steps, \d+ places\. Left at: \w+\. Report: .*report\.md$/);
    expect(reportOf(s).stopped).toBe("paused");
    expect(readFileSync(join(lastRun(s), "report.md"), "utf8")).toContain("Stopped: the user paused it.");
  });

  it("sets a toggle back even when Pause comes between the flip and the flip back: one move for a pause (§25.7)", async () => {
    const control = new ControlQueue();
    let paused = false;
    const s = await setup({
      tools: { control },
      world: (w) => {
        w.onPress = (id) => {
          if (id === "notify-switch" && !paused) {
            paused = true;
            control.setPaused(true);
          }
        };
      },
    });
    const answer = await s.tools.explore({});
    expect(s.world.pressed.filter((id) => id === "notify-switch")).toHaveLength(2);
    expect(s.world.toggles["notify-switch"]).toBe(false);
    expect(textOf(answer)).toMatch(/^Error paused:/);
  });

  it("stops with `Error busy:` after a person's input goes on, and writes the report first", async () => {
    const control = new ControlQueue({ idleMs: 60_000, giveUpMs: 60, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))) });
    const s = await setup({ tools: { control } });
    await control.runPerson(async () => undefined);
    const answer = await s.tools.explore({});
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error busy: A person is using the app in the live viewer\. Done: \d+ steps, \d+ places\./);
    expect(reportOf(s).stopped).toBe("busy");
  });

  it("does not count the time it waited for a person toward minutes (§25.9)", async () => {
    const holder: { s?: ExploreSetup } = {};
    const control = new ControlQueue({
      idleMs: 3000,
      now: () => holder.s?.clock.now ?? 0,
      sleep: (ms) => {
        if (holder.s !== undefined) holder.s.clock.now += ms;
        return Promise.resolve();
      },
    });
    holder.s = await setup({ tools: { control } });
    await control.runPerson(async () => undefined);
    const before = holder.s.clock.now;
    const answer = await holder.s.tools.explore({ minutes: 1 });
    expect(holder.s.clock.now - before).toBeGreaterThanOrEqual(3000);
    expect(control.waitedMs()).toBeGreaterThanOrEqual(3000);
    expect(textOf(answer)).toContain("Stopped: the frontier is empty.");
    expect(reportOf(holder.s).used.minutes).toBe(0);
  });
});

describe("explore: one call at a time", () => {
  it("stops between moves when its call is cancelled, and still writes the report", async () => {
    const abort = new AbortController();
    let presses = 0;
    const s = await setup({
      world: (w) => {
        w.onPress = () => {
          presses += 1;
          if (presses === 3) abort.abort();
        };
      },
    });
    const answer = await s.tools.withCall(abort.signal, () => s.tools.explore({}));
    expect(textOf(answer)).toMatch(/^Error paused:/);
    expect(reportOf(s).stopped).toBe("paused");
    expect(s.world.pressed.length).toBeLessThanOrEqual(4);
  });

  it("refuses a second explore while one runs", async () => {
    const s = await setup();
    const first = s.tools.explore({});
    const second = await s.tools.explore({});
    expect(textOf(second)).toBe("Error busy: an explore is already running here; wait for it to end.");
    expect(textOf(await first)).toContain("Stopped: the frontier is empty.");
    expect((await s.tools.explore({})).isError).not.toBe(true);
  });
});

describe("explore: reset (§25.8)", () => {
  it("resets by reload when it can't get back, keeps data, and goes on to the place", async () => {
    const s = await setup({
      world: (w) => {
        w.backBroken.add("language");
      },
    });
    const answer = await s.tools.explore({});
    expect(textOf(answer)).toContain("Stopped: the frontier is empty.");
    expect(s.world.reloads).toBeGreaterThanOrEqual(1);
    const report = reportOf(s);
    expect(report.resets[0]).toEqual({ how: "reload", data_kept: true, at_step: expect.any(Number) });
    const stuck = report.findings.find((f) => f.kind === "dead_end");
    expect(stuck?.got).toBe("no way back to settings except a reset");
    expect(stuck?.expected).toBe("a way back to settings");
    // The branch went on after the reset: the place after it was explored.
    expect(s.world.pressed).toContain("open-trips");
  });

  it("uses the app's standard `reset` command when it has no reload, and says data was cleared", async () => {
    const s = await setup({
      world: (w) => {
        w.backBroken.add("language");
        w.reloads = -1;
        w.commands = ["language", "reset"];
      },
    });
    await s.tools.explore({});
    expect(s.world.resets).toBeGreaterThanOrEqual(1);
    const report = reportOf(s);
    expect(report.resets[0]).toEqual({ how: "app_command", data_kept: false, at_step: expect.any(Number) });
    expect(readFileSync(join(lastRun(s), "report.md"), "utf8")).toContain("app_command reset, data cleared");
  });

  it("ends the branch with a reason when neither reset exists, and stops after three that bring it nowhere known", async () => {
    const s = await setup({
      world: (w) => {
        w.backBroken.add("language");
        w.backBroken.add("trip");
        w.backBroken.add("form");
        w.reloads = -1;
      },
    });
    const answer = await s.tools.explore({});
    expect(textOf(answer)).toContain("Stopped: it can't get back to a known place.");
    const report = reportOf(s);
    expect(report.stopped).toBe("cant_get_back");
    expect(report.notes.join("\n")).toMatch(/couldn't get back to \w+: reload is not available here and the app offers no reset command/);
  });

  it("takes an account for the way back only when the vault entry is marked explore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-explore-acct-"));
    dirs.push(dir);
    const file = join(dir, "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { tester: { kind: "account", username: "explore-user-1", password: "explore-pass-9", explore: true }, other: { kind: "account", username: "other-user-22", password: "other-pass-77" }, home: { kind: "address", street: "1 Test Rd", explore: true } } }));
    const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
    const loaded = await loadAccounts(file, OUTSIDE);
    const s = await setup({ tools: { accounts: loaded } });
    expect(textOf(await s.tools.explore({ account: "other" }))).toMatch(/^Error bad_params: account "other" isn't marked "explore": true in the vault file/);
    expect(textOf(await s.tools.explore({ account: "home" }))).toMatch(/^Error bad_params: account "home" isn't marked/);
    const ok = await s.tools.explore({ account: "tester" });
    expect(ok.isError).not.toBe(true);
    expect(textOf(ok)).toContain("Stopped: the frontier is empty.");
  });
});
