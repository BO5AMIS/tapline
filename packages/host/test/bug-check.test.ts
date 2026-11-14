import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { bugSignature, type BugFinding, type BugKind, type BugMeta } from "../src/bug.js";
import { runCheck, type CheckBug, type CheckHost, type Seen, type StepResult } from "../src/bugcheck.js";
import { runBug, type BugCliDeps } from "../src/bugcmd.js";
import { callTool } from "../src/dispatch.js";
import type { PathStep } from "../src/findings.js";
import type { PlaceKey } from "../src/mapfile.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { EXPLORE_CAPS, btn, flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.16 §29.4, §29.9: the reproduction check. The engine on a fake host, then the tool on the fake app.

const HOME: PlaceKey = { route: ["home"] };
const SETTINGS: PlaceKey = { route: ["settings"] };

function bugOf(kind: BugKind, got: string, extra: Partial<BugFinding> = {}, key: PlaceKey | null = HOME): CheckBug["finding"] & { signature: string; key: PlaceKey | null } {
  const finding = { id: "f1", kind, app: APP.id, got, expected: "x", place: "home", path: [], logs: [], picture: null, ...extra } as unknown as BugFinding;
  return { ...finding, signature: bugSignature({ kind, placeKey: key, got, ...(finding.crash !== undefined ? { crash: finding.crash } : {}) }), key };
}

function checkBug(kind: BugKind, got: string, steps: PathStep[], extra: Partial<BugFinding> = {}, start: string | null = "home", key: PlaceKey | null = HOME): CheckBug {
  const b = bugOf(kind, got, extra, key);
  const meta = { id: `bug_${b.signature}`, signature: b.signature, place_key: key } as unknown as BugMeta;
  return { finding: b, meta, script: { start, steps } };
}

const tapStep = (id: string): PathStep => ({ tool: "tap", target: { id } });

interface FakeOptions {
  seen?: (run: number) => Partial<Seen>;
  step?: (step: PathStep, typed: string | null, run: number, index: number) => StepResult;
  place?: (run: number, phase: "before" | "after") => PlaceKey | null;
  reset?: (run: number) => boolean;
  start?: (run: number) => boolean;
  issues?: (run: number) => string[] | null;
  build?: string | null;
}

/** A host that does what a test says; `log` holds every call in order. */
function fakeHost(options: FakeOptions = {}): { host: CheckHost; log: string[]; typed: Array<string | null> } {
  const log: string[] = [];
  const typed: Array<string | null> = [];
  let run = 0;
  let index = 0;
  let clock = 0;
  const host: CheckHost = {
    clock: () => clock,
    wall: () => new Date(Date.UTC(2026, 10, 14, 11, 20, 2)),
    build: () => (options.build === undefined ? "1.5.0 (220)" : options.build),
    reset: async () => {
      run += 1;
      index = 0;
      log.push(`reset ${run}`);
      return options.reset?.(run) === false ? { ok: false } : { ok: true, words: "reload only, data kept" };
    },
    start: async (place) => {
      log.push(`start ${place}`);
      return options.start?.(run) !== false;
    },
    step: async (step, value) => {
      typed.push(value);
      log.push(`step ${String(step.target?.id ?? step.tool)}`);
      clock += 100;
      return options.step?.(step, value, run, index++) ?? { kind: "ok" };
    },
    mark: () => run,
    since: async () => ({ crash: null, disconnected: false, errors: [], ...options.seen?.(run) }),
    placeKey: async () => options.place?.(run, "before") ?? HOME,
    issues: async () => (options.issues === undefined ? null : options.issues(run)),
    inFront: () => true,
    redact: (t) => t,
  };
  return { host, log, typed };
}

describe("the check engine on a fake host (§29.4)", () => {
  const steps = [tapStep("open-form")];
  const js = checkBug("js_error", "TypeError: form failed", steps);

  it("counts the runs that show the same bug: n of N, with the build, the time and the reset", async () => {
    const f = fakeHost({ seen: () => ({ errors: ["TypeError: form failed"] }) });
    const got = await runCheck(f.host, js, 3, { reset: "own" });
    expect(got).toEqual({ n: 3, of: 3, build: "1.5.0 (220)", when: "2026-11-14T11:20:02.000Z", reset: "reload only, data kept" });
    // each run: a fresh start, the drive to the start place, then the steps
    expect(f.log).toEqual(["reset 1", "start home", "step open-form", "reset 2", "start home", "step open-form", "reset 3", "start home", "step open-form"]);
  });

  it("the same signature recurs when only a number or an id in the text changes; another text is another bug", async () => {
    const withNumber = checkBug("js_error", "Order 7b9e3c1a-0d52-4f10-9a77-1c2b3d4e5f60 failed at 2026-11-14T09:21:07Z", steps);
    const f = fakeHost({ seen: (run) => ({ errors: [run === 1 ? "Order 11111111-2222-3333-4444-555555555555 failed at 2027-01-01T00:00:00Z" : "Order failed differently"] }) });
    expect(await runCheck(f.host, withNumber, 2, { reset: "own" })).toMatchObject({ n: 1, of: 2 });
  });

  it("a bug that shows in 1 of 3 runs is flaky; one that never shows is 0 of 3, kept as a result and not dropped", async () => {
    const flaky = fakeHost({ seen: (run) => (run === 2 ? { errors: ["TypeError: form failed"] } : {}) });
    expect(await runCheck(flaky.host, js, 3, { reset: "own" })).toMatchObject({ n: 1, of: 3 });
    const never = fakeHost();
    expect(await runCheck(never.host, js, 3, { reset: "own" })).toMatchObject({ n: 0, of: 3 });
  });

  it("the place must be the same key; a bug with no key has none to compare", async () => {
    const elsewhere = fakeHost({ seen: () => ({ errors: ["TypeError: form failed"] }), place: () => SETTINGS });
    expect(await runCheck(elsewhere.host, js, 2, { reset: "own" })).toMatchObject({ n: 0, of: 2 });
    const noKey = checkBug("js_error", "TypeError: form failed", steps, {}, "home", null);
    expect(await runCheck(elsewhere.host, noKey, 2, { reset: "own" })).toMatchObject({ n: 2, of: 2 });
  });

  it("a crash needs the same exception type and top app symbol", async () => {
    const crash = { reason: "TypeError: undefined is not an object", frames: ["*TripDetail.tsx:48 TripDetail", "x.js:1 renderWithHooks"] };
    const bug = checkBug("crash", "the app crashed: TypeError: undefined is not an object (evaluating 'trip.days.map')", steps, { crash });
    const same = fakeHost({ seen: () => ({ crash: { line: "TypeError: undefined is not an object (evaluating 'trip.days.map')", crash: { ...crash, frames: ["*TripDetail.tsx:90 TripDetail"] } } }) });
    expect(await runCheck(same.host, bug, 2, { reset: "own" })).toMatchObject({ n: 2, of: 2 });
    const other = fakeHost({ seen: () => ({ crash: { line: "TypeError: undefined is not an object (evaluating 'trip.days.map')", crash: { ...crash, frames: ["*TripList.tsx:9 TripList"] } } }) });
    expect(await runCheck(other.host, bug, 2, { reset: "own" })).toMatchObject({ n: 0, of: 2 });
    // a bare disconnect is the other crash the explorer records
    const bare = checkBug("crash", "the app disconnected (it may have crashed)", steps, { crash: { reason: "the app disconnected (it may have crashed)", frames: [] } });
    const gone = fakeHost({ seen: () => ({ disconnected: true }) });
    expect(await runCheck(gone.host, bare, 1, { reset: "own" })).toMatchObject({ n: 1, of: 1 });
  });

  it("expect_failed: the same expect fails at the same step", async () => {
    const bug = checkBug("expect_failed", "its action ran, but id \"x\" didn't appear within 2 s", steps, { expected: 'the step\'s expect holds ({"id":"x"})' });
    const ran: PathStep[] = [];
    const f = fakeHost({
      step: (step, _t, run) => {
        ran.push(step);
        return run === 1 ? { kind: "error", code: "expect_failed", message: "its action ran, but id \"x\" didn't appear within 2 s" } : { kind: "ok" };
      },
    });
    expect(await runCheck(f.host, bug, 2, { reset: "own" })).toMatchObject({ n: 1, of: 2 });
    // the expect comes back from the finding's text and rides on the last step
    expect(ran[0]).toEqual({ tool: "tap", target: { id: "open-form" }, expect: { id: "x" } });
    // without it the step can't be run again
    const noExpect = checkBug("expect_failed", "x", steps, { expected: "the step's expect holds" });
    expect(await runCheck(f.host, noExpect, 2, { reset: "own" })).toEqual({ checked: false, why: "the step's expect isn't in the bug, so it can't be run again" });
  });

  it("a11y and ux: the same first issue on the same place; observed: every step ran and the app ended on the same key", async () => {
    const a11y = checkBug("a11y", "contrast: e3 button \"Save\": too light\nlabel: e4: no name", []);
    const same = fakeHost({ issues: () => ["contrast: e3 button \"Save\": too light", "label: e4: no name"] });
    expect(await runCheck(same.host, a11y, 2, { reset: "own" })).toMatchObject({ n: 2, of: 2 });
    const fixed = fakeHost({ issues: () => [] });
    expect(await runCheck(fixed.host, a11y, 2, { reset: "own" })).toMatchObject({ n: 0, of: 2 });
    const observed = checkBug("observed", "the total is wrong", [tapStep("open-settings")], {}, null, SETTINGS);
    const there = fakeHost({ place: () => SETTINGS });
    expect(await runCheck(there.host, observed, 3, { reset: "own" })).toMatchObject({ n: 3, of: 3 });
    const failed = fakeHost({ place: () => SETTINGS, step: () => ({ kind: "error", code: "not_found", message: "no" }) });
    expect(await runCheck(failed.host, checkBug("observed", "x", [tapStep("a"), tapStep("b")], {}, null, SETTINGS), 2, { reset: "own" })).toMatchObject({ n: 0, of: 2 });
  });

  it("slow, refused and dead_end are matched by what the last step did", async () => {
    const slow = checkBug("slow", "3.5 s to settle", steps);
    expect(await runCheck(fakeHost({ step: () => ({ kind: "ok", settledMs: 4200 }) }).host, slow, 1, { reset: "own" })).toMatchObject({ n: 1 });
    expect(await runCheck(fakeHost({ step: () => ({ kind: "ok", settledMs: 400 }) }).host, slow, 1, { reset: "own" })).toMatchObject({ n: 0 });
    const refused = checkBug("refused", "not_actionable: covered: it is behind a sheet", steps);
    expect(await runCheck(fakeHost({ step: () => ({ kind: "error", code: "not_actionable", message: "covered: it is behind a sheet" }) }).host, refused, 1, { reset: "own" })).toMatchObject({ n: 1 });
    const gone = checkBug("dead_end", "the app went away (in_background)", steps);
    expect(await runCheck(fakeHost({ step: () => ({ kind: "error", code: "in_background", message: "x" }) }).host, gone, 1, { reset: "own" })).toMatchObject({ n: 1 });
  });

  it("an unreachable place and a missing way back have no steps: not checked", async () => {
    expect(await runCheck(fakeHost().host, checkBug("unreachable", "no road reached x", []), 3, { reset: "own" })).toEqual({ checked: false, why: "an unreachable place has no steps" });
    expect(await runCheck(fakeHost().host, checkBug("dead_end", "no way back to home except a reset", []), 3, { reset: "own" })).toMatchObject({ checked: false });
    expect(await runCheck(fakeHost({ build: null }).host, js, 3, { reset: "own" })).toEqual({ checked: false, why: "no phone connected" });
  });

  it("stops at the first step that needs a person, and makes no move of it", async () => {
    const path = [tapStep("open-settings"), tapStep("delete-all"), tapStep("open-form")];
    const f = fakeHost({ step: (step) => (step.target?.id === "delete-all" ? { kind: "person", why: 'the policy word "delete"' } : { kind: "ok" }) });
    const got = await runCheck(f.host, checkBug("js_error", "x", path), 3, { reset: "own" });
    expect(got).toEqual({ checked: false, why: 'step 2 needs a person (the policy word "delete")' });
    // run 1 only: no second run, and nothing after the stop
    expect(f.log).toEqual(["reset 1", "start home", "step open-settings", "step delete-all"]);
  });

  it("a person using the phone stops the check as not checked: stopped (busy)", async () => {
    const f = fakeHost({ step: () => ({ kind: "stop", code: "busy" }) });
    expect(await runCheck(f.host, js, 3, { reset: "own" })).toEqual({ checked: false, why: "stopped (busy)" });
    const later = fakeHost({ seen: () => ({ errors: ["TypeError: form failed"] }), step: (_s, _t, run) => (run === 2 ? { kind: "stop", code: "paused" } : { kind: "ok" }) });
    // a run that finished before the stop still counts
    expect(await runCheck(later.host, js, 3, { reset: "own" })).toMatchObject({ n: 1, of: 1 });
  });

  it("a `${typed}` step takes a value only from the prompt it is given, once a run, and the result says only that a value was given", async () => {
    const path = [tapStep("open-form"), { tool: "type_text", target: { id: "name-test-safe" }, text: "${typed}" }];
    const bug = checkBug("observed", "the name is lost", path, {}, null, HOME);
    const none = fakeHost();
    expect(await runCheck(none.host, bug, 2, { reset: "own" })).toEqual({ checked: false, why: "step 2 needs a person (a typed value)" });
    expect(none.typed).toEqual([null]);
    const asked: string[] = [];
    const f = fakeHost();
    const got = await runCheck(f.host, bug, 2, { reset: "own", typed: async (name) => (asked.push(name), "Zq-secret-value-9") });
    expect(asked).toEqual(["typed", "typed"]);
    expect(f.typed.filter((v) => v !== null)).toEqual(["Zq-secret-value-9", "Zq-secret-value-9"]);
    expect(got).toMatchObject({ n: 2, of: 2, reset: "reload only, data kept; a value was given" });
    expect(JSON.stringify(got)).not.toContain("Zq-secret-value-9");
    // a prompt with no terminal answers null: the check stops
    expect(await runCheck(fakeHost().host, bug, 2, { reset: "own", typed: async () => null })).toMatchObject({ checked: false });
  });

  it("no reset that brings the app to a known place: not checked; a run that can't start isn't made", async () => {
    expect(await runCheck(fakeHost({ reset: () => false }).host, js, 3, { reset: "own" })).toEqual({ checked: false, why: "no reset reached a known place" });
    expect(await runCheck(fakeHost({ start: (run) => run !== 2, seen: () => ({ errors: ["TypeError: form failed"] }) }).host, js, 3, { reset: "own" })).toMatchObject({ n: 2, of: 2 });
    expect(await runCheck(fakeHost({ start: () => false }).host, js, 3, { reset: "own" })).toEqual({ checked: false, why: "no run could start" });
  });

  it("a run lasts at most 60 seconds", async () => {
    const slow = checkBug("js_error", "TypeError: form failed", Array.from({ length: 10 }, (_, i) => tapStep(`s${i}`)));
    let clock = 0;
    const f = fakeHost({ seen: () => ({ errors: ["TypeError: form failed"] }) });
    const host: CheckHost = { ...f.host, clock: () => clock, step: async () => ((clock += 8000), { kind: "ok" as const }) };
    // the 8th step starts after 64 s: the run is made, and isn't the same bug
    expect(await runCheck(host, slow, 1, { reset: "own" })).toMatchObject({ n: 0, of: 1 });
  });
});

// -- the tool on the fake app

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

interface Rig {
  s: ExploreSetup;
  bugsDir: string;
  bugDir: (id: string) => string;
  /** The js_error bug of the form, made without a check. */
  make: () => Promise<string>;
}

async function rig(options: ExploreSetupOptions = {}): Promise<Rig> {
  const bugsDir = tmp("tapline-check-bugs-");
  const s = await setupExplore(hosts, apps, dirs, {
    ...options,
    world: (w) => {
      w.errorOn["open-form"] = "TypeError: form failed";
      w.known = [{ route: ["home"] }, { route: ["settings"] }, { route: ["trips"] }, { route: ["form"] }];
      options.world?.(w);
    },
    tools: { bugsDir, logDir: tmp("tapline-check-log-"), journeysDir: tmp("tapline-check-j-"), ...options.tools },
  });
  const make = async (): Promise<string> => {
    await s.tools.explore({});
    const appDir = join(s.exploreDir, APP.id);
    const run = join(appDir, readdirSync(appDir).sort().at(-1) as string);
    const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8")) as { findings: Array<{ id: string; kind: string }> };
    const id = report.findings.find((f) => f.kind === "js_error")?.id as string;
    const answer = textOf(await s.tools.bugReport({ finding: id, verify: false }));
    return /bug_[0-9a-f]{16}/.exec(answer)?.[0] as string;
  };
  return { s, bugsDir, bugDir: (id) => join(bugsDir, APP.id, id), make };
}

const reproOf = (r: Rig, id: string): { start?: string; steps: PathStep[] } => JSON.parse(readFileSync(join(r.bugDir(id), "repro.json"), "utf8")) as { start?: string; steps: PathStep[] };
const meta = (r: Rig, id: string): BugMeta => (JSON.parse(readFileSync(join(r.bugDir(id), "finding.json"), "utf8")) as { bug: BugMeta }).bug;

describe("verify on the fake app: n of N (§29.4, §29.9)", () => {
  it("a bug planted to always fail is N of N: the page, finding.json and the answer say it, from a fresh start each time", async () => {
    const r = await rig();
    const id = await r.make();
    const before = r.s.world.reloads;
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 3 }));
    expect(answer).toContain("Reproduced: 3 of 3 runs.");
    // a reload for each run (a fresh start), and the data was kept
    expect(r.s.world.reloads - before).toBe(3);
    expect(r.s.world.resets).toBe(0);
    expect(meta(r, id).reproduced).toMatchObject({ n: 3, of: 3, build: "1.5.0 (220)", reset: "reload only, data kept" });
    const md = readFileSync(join(r.bugDir(id), "report.md"), "utf8");
    expect(md).toContain("3 of 3 runs. Script: repro.json");
    expect(md).toContain("- Reset before each run: reload only, data kept");
    expect(readFileSync(join(r.bugDir(id), "report.html"), "utf8")).toContain("3 of 3 runs");
  });

  it("a bug planted to fail 1 of 3 is flaky, and its page says so", async () => {
    const r = await rig();
    const id = await r.make();
    let presses = 0;
    r.s.world.onPress = (pressed) => {
      if (pressed !== "open-form") return;
      presses += 1;
      r.s.world.errorOn["open-form"] = presses === 2 ? "TypeError: form failed" : [];
    };
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 3 }));
    expect(answer).toContain("Reproduced: 1 of 3 runs (flaky).");
    expect(readFileSync(join(r.bugDir(id), "report.md"), "utf8")).toContain("1 of 3 runs (flaky). Script: repro.json");
  });

  it("one planted to never fail is 0 of 3, `not reproduced`, and kept: on disk, in list and in a later sighting", async () => {
    const r = await rig();
    const id = await r.make();
    delete r.s.world.errorOn["open-form"];
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 3 }));
    expect(answer).toContain("Reproduced: 0 of 3 runs: not reproduced.");
    expect(existsSync(r.bugDir(id))).toBe(true);
    expect(readFileSync(join(r.bugDir(id), "report.md"), "utf8")).toContain("0 of 3 runs: not reproduced");
    const { BugStore } = await import("../src/bugstore.js");
    expect(new BugStore(r.bugsDir).list().map((row) => `${row.id} ${row.reproduced}`)).toEqual([`${id} 0 of 3`]);
    // a later check replaces the result and keeps the first finding
    r.s.world.errorOn["open-form"] = "TypeError: form failed";
    expect(textOf(await r.s.tools.bugReport({ bug: id, verify: 2 }))).toContain("Reproduced: 2 of 2 runs.");
    expect(meta(r, id).reproduced).toMatchObject({ n: 2, of: 2 });
    expect(meta(r, id).seen.count).toBe(1);
  });

  it("with no verify a bug from a finding is checked 3 times", async () => {
    const r = await rig();
    await r.s.tools.explore({});
    const appDir = join(r.s.exploreDir, APP.id);
    const run = join(appDir, readdirSync(appDir).sort().at(-1) as string);
    const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8")) as { findings: Array<{ id: string; kind: string }> };
    const f = report.findings.find((x) => x.kind === "js_error")?.id as string;
    expect(textOf(await r.s.tools.bugReport({ finding: f }))).toContain("Reproduced: 3 of 3 runs.");
  });

  it("from now isn't checked unless asked; a note can't be matched, so a run counts when every step ran and the app ended on the same screen", async () => {
    const r = await rig();
    await r.s.tools.look({ screenshot: false });
    await r.s.tools.tap({ target: { id: "open-settings" }, screenshot: false });
    const first = textOf(await r.s.tools.bugReport({ from: "now", note: "the settings look odd" }));
    expect(first).toContain("Reproduced: not checked.");
    const id = /bug_[0-9a-f]{16}/.exec(first)?.[0] as string;
    expect(textOf(await r.s.tools.bugReport({ bug: id, verify: 2 }))).toContain("Reproduced: 2 of 2 runs");
    expect(readFileSync(join(r.bugDir(id), "report.md"), "utf8")).toContain("2 of 2 runs reached the same screen. A note can't be checked by the tool; look at it.");
  });

  it("no phone: the bug is made and says not checked (no phone connected)", async () => {
    const r = await rig();
    const id = await r.make();
    r.s.current().ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const check = await r.s.tools.runBugCheck({ app: APP.id, id, dir: r.bugDir(id), finding: {} as never, meta: {} as never }, 3, { reset: "own" });
    expect(check).toEqual({ checked: false, why: "no phone connected" });
  });
});

describe("the check goes through the one gate (§29.4, §25.5)", () => {
  const put = (r: Rig, id: string, steps: PathStep[]): void => {
    const repro = reproOf(r, id);
    writeFileSync(join(r.bugDir(id), "repro.json"), JSON.stringify({ ...repro, steps }));
  };

  it("stops at a step on a floor element, makes no move of it, opens no dialog, and says which step", async () => {
    const r = await rig({ world: (w) => w.screens["settings"]?.elements.push(btn("sign-out-2", "Sign out")) });
    const id = await r.make();
    const repro = reproOf(r, id);
    writeFileSync(join(r.bugDir(id), "repro.json"), JSON.stringify({ ...repro, start: "settings", steps: [{ tool: "toggle", target: { id: "notify-switch" } }, { tool: "tap", target: { id: "sign-out-2" } }, { tool: "tap", target: { id: "open-language" } }] }));
    r.s.world.pressed.length = 0;
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 3 }));
    expect(answer).toMatch(/Reproduced: not checked \(step 2 needs a person \(the policy word "[^"]+"\)\)\./);
    // the drive to the start and the move before the stop were made (once: the first run is the only one), the one at it never was, and nothing after it
    expect(r.s.world.pressed).toEqual(["open-settings", "notify-switch"]);
    expect(meta(r, id).reproduced).toMatchObject({ checked: false });
  });

  it("holds the real recipient, not the name: a tap that lands on Delete is stopped", async () => {
    const r = await rig();
    const id = await r.make();
    r.s.world.recipient["open-form"] = btn("delete-all", "Delete all");
    r.s.world.pressed.length = 0;
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 2 }));
    expect(answer).toMatch(/Reproduced: not checked \(step 1 needs a person/);
    expect(r.s.world.pressed).toEqual([]);
  });

  it("stops at a policy word of the user's own policy, and a `confirm: []` doesn't lower the floor", async () => {
    const r = await rig({ policy: { version: 1, confirm: ["Settings"], block: [] } });
    const id = await r.make();
    put(r, id, [{ tool: "tap", target: { id: "open-settings" } }]);
    expect(textOf(await r.s.tools.bugReport({ bug: id, verify: 2 }))).toContain('step 1 needs a person (the policy word "Settings")');
    const open = await rig({ policy: { version: 1, confirm: [], block: [] } });
    const id2 = await open.make();
    put(open, id2, [{ tool: "tap", target: { id: "pay-now" } }]);
    expect(textOf(await open.s.tools.bugReport({ bug: id2, verify: 2 }))).toMatch(/not checked \(step 1 needs a person/);
    expect(open.s.world.pressed).not.toContain("pay-now");
  });
});

describe("`${typed}` in a call and at the command line (§29.4)", () => {
  const OWN = "Zq-secret-value-9";

  async function typedBug(): Promise<{ r: Rig; id: string }> {
    const r = await rig({ capabilities: [...EXPLORE_CAPS, "typeKind"] });
    await r.s.tools.look({ screenshot: false });
    await r.s.tools.tap({ target: { id: "open-form" }, screenshot: false });
    await r.s.tools.typeText({ target: { id: "name-test-safe" }, text: "Anything-123", screenshot: false });
    const id = /bug_[0-9a-f]{16}/.exec(textOf(await r.s.tools.bugReport({ from: "now", note: "the name is lost", verify: false })))?.[0] as string;
    return { r, id };
  }

  it("in a call the check stops at the typing step: no value can be given, nothing is typed", async () => {
    const { r, id } = await typedBug();
    expect(reproOf(r, id).steps.map((s) => s.text)).toEqual([undefined, "${typed}"]);
    r.s.world.typed.length = 0;
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 2 }));
    expect(answer).toContain("Reproduced: not checked (step 2 needs a person (a typed value)).");
    expect(r.s.world.typed).toEqual([]);
    // a call has no argument that holds a value
    expect(textOf(await callTool(r.s.tools, "bug_report", { bug: id, verify: 2, typed: OWN }))).toMatch(/^Error bad_params/);
  });

  it("at the command line the value comes from a prompt, is typed for the run, and reaches no file, answer or page", async () => {
    const { r, id } = await typedBug();
    r.s.world.typed.length = 0;
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const deps: BugCliDeps = {
      bugsDir: r.bugsDir,
      redact: (t) => t,
      map: () => undefined,
      policy: DEFAULT_POLICY,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      check: (bug, n, options) => r.s.tools.runBugCheck(bug, n, options),
      askValue: async (question) => (asked.push(question), OWN),
    };
    expect(await runBug(["verify", id], { verify: "2" }, deps)).toBe(0);
    expect(asked).toEqual(['Value for "typed" (not shown):', 'Value for "typed" (not shown):']);
    expect(r.s.world.typed.map((t) => t.text)).toEqual([OWN, OWN]);
    expect(out.join("\n")).toBe("Reproduced: 2 of 2 runs.");
    expect(meta(r, id).reproduced).toMatchObject({ n: 2, of: 2, reset: "reload only, data kept; a value was given" });
    for (const name of readdirSync(r.bugDir(id))) expect(readFileSync(join(r.bugDir(id), name), "utf8")).not.toContain(OWN);
    expect(out.join("\n") + err.join("\n")).not.toContain(OWN);
    expect(readFileSync(join(r.bugDir(id), "report.md"), "utf8")).toContain("a value was given");
  });

  it("with no terminal the prompt gives nothing and the command line stops like a call", async () => {
    const { r, id } = await typedBug();
    const out: string[] = [];
    const deps: BugCliDeps = {
      bugsDir: r.bugsDir,
      redact: (t) => t,
      map: () => undefined,
      policy: DEFAULT_POLICY,
      out: (t) => out.push(t),
      err: () => undefined,
      check: (bug, n, options) => r.s.tools.runBugCheck(bug, n, options),
      askValue: async () => null,
    };
    expect(await runBug(["verify", id], {}, deps)).toBe(0);
    expect(out[0]).toBe("Reproduced: not checked (step 2 needs a person (a typed value)).");
  });
});

describe("the reset (§29.4, §25.8)", () => {
  it("the standard `app_command reset` clears the app's data, so it runs only with reset: \"app\"", async () => {
    const r = await rig({ world: (w) => (w.commands = ["reset"]) });
    const id = await r.make();
    await r.s.tools.bugReport({ bug: id, verify: 2 });
    expect(r.s.world.resets).toBe(0);
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 2, reset: "app" }));
    expect(r.s.world.resets).toBe(2);
    expect(answer).toContain("Reproduced: 2 of 2 runs.");
    expect(meta(r, id).reproduced).toMatchObject({ reset: "reload and the app's reset command, data cleared" });
    expect(readFileSync(join(r.bugDir(id), "report.md"), "utf8")).toContain("Reset before each run: reload and the app's reset command, data cleared");
  });

  it("a release build has no reload: not checked (no reset reached a known place), unless reset: \"app\" has its command", async () => {
    const r = await rig({ world: (w) => (w.reloads = -1) });
    const id = await r.make();
    expect(textOf(await r.s.tools.bugReport({ bug: id, verify: 2 }))).toContain("Reproduced: not checked (no reset reached a known place).");
    expect(r.s.world.resets).toBe(0);
    // reset "app" without the command is no better
    expect(textOf(await r.s.tools.bugReport({ bug: id, verify: 2, reset: "app" }))).toContain("not checked (no reset reached a known place)");
    r.s.world.commands = ["reset"];
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 2, reset: "app" }));
    expect(answer).toContain("Reproduced: 2 of 2 runs.");
    expect(meta(r, id).reproduced).toMatchObject({ reset: "the app's reset command, data cleared" });
  });
});
