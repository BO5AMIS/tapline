import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, readAuditLines } from "../src/auditlog.js";
import { BUSY_WAIT_MS, dropLock, runSchedule, takeLock, type CallAnswer, type RunDeps, type ScheduleHost } from "../src/runschedule.js";
import { schedulePath, schedulesDir, type Schedule } from "../src/schedule.js";

// AGENT-TOOLS 1.14 §22.2, §22.3, §23: `tapline run-schedule`, with a fake host, an injected clock and no phone.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-runsched-"));
  dirs.push(dir);
  return dir;
};

const OK: CallAnswer = { text: "Ran 3 of 3 steps in 2.1 s.\nSame screen. Changes:\n~ text \"Posted\"", isError: false };

interface FakeHost extends ScheduleHost {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  closed: number;
  open: boolean;
  busyFor: () => boolean;
  answers: CallAnswer[];
  onCall?: () => Promise<void> | void;
}

function fakeHost(over: Partial<FakeHost> = {}): FakeHost {
  const host: FakeHost = {
    via: "its own host",
    calls: [],
    closed: 0,
    open: true,
    busyFor: () => false,
    answers: [OK],
    appOpen: async () => host.open,
    inUse: () => host.busyFor(),
    call: async (tool, args) => {
      host.calls.push({ tool, args });
      await host.onCall?.();
      return host.answers.length > 1 ? (host.answers.shift() as CallAnswer) : (host.answers[0] as CallAnswer);
    },
    close: async () => {
      host.closed += 1;
    },
    ...over,
  };
  return host;
}

interface Rig {
  dir: string;
  deps: RunDeps;
  host: FakeHost;
  slept: number[];
  time: { ms: number };
  connects: number;
  audit(): Array<{ kind?: string; name?: string; detail?: string }>;
  runs(): string[];
  report(): Record<string, unknown>;
}

function rig(schedule: Partial<Schedule> & { route?: string } = {}, hostOver: Partial<FakeHost> = {}, depsOver: Partial<RunDeps> = {}): Rig {
  const dir = tmp();
  mkdirSync(schedulesDir(dir), { recursive: true });
  const file = { version: 1, tool: "tapline", route: "post_update", with: {}, at: "09:00 daily", trigger: null, policy: null, accounts: null, maps: null, ...schedule };
  writeFileSync(schedulePath(dir, "daily"), JSON.stringify(file));
  const host = fakeHost(hostOver);
  const time = { ms: 0 };
  const slept: number[] = [];
  const state = { connects: 0 };
  const wall = new Date(Date.UTC(2026, 10, 14, 6, 0, 12, 481));
  const deps: RunDeps = {
    configDir: dir,
    now: () => new Date(wall.getTime() + time.ms),
    clock: () => time.ms,
    sleep: async (ms) => {
      slept.push(ms);
      time.ms += ms;
    },
    connect: async () => {
      state.connects += 1;
      return host;
    },
    audit: new AuditLog(join(dir, "audit"), () => new Date(wall.getTime() + time.ms)),
    redactFor: async () => (text) => text,
    pid: 4242,
    alive: () => false,
    ...depsOver,
  };
  return {
    dir,
    deps,
    host,
    slept,
    time,
    get connects() {
      return state.connects;
    },
    audit: () => readAuditLines(join(dir, "audit")).map((l) => l.entry ?? {}),
    runs: () => (existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")) : []),
    report: () => {
      const names = readdirSync(join(dir, "runs"));
      return JSON.parse(readFileSync(join(dir, "runs", names[names.length - 1] as string), "utf8")) as Record<string, unknown>;
    },
  };
}

const scheduleLines = (r: Rig): string[] => r.audit().filter((e) => e.kind === "schedule").map((e) => e.detail ?? "");

describe("a run", () => {
  it("replays the route, writes the report and the started and done lines", async () => {
    const r = rig();
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(0);
    expect(r.host.calls).toEqual([{ tool: "replay", args: { name: "post_update" } }]);
    expect(out.text.split("\n")[0]).toBe('Ran "daily" in 0 s: done.');
    expect(out.text).toContain("Ran 3 of 3 steps in 2.1 s.");
    expect(out.text).toContain("Grants used: none");
    expect(out.text).toContain("Vault names used: none");
    expect(scheduleLines(r)).toEqual(["started", "done"]);
    expect(r.audit().filter((e) => e.kind === "schedule").every((e) => e.name === "daily")).toBe(true);
    expect(r.runs()).toEqual(["daily-20261114T060012Z.json"]);
    expect(r.report()).toMatchObject({ schedule: "daily", tool: "tapline", route: "post_update", status: "done", via: "its own host", "Grants used": "none", "Vault names used": "none" });
    expect(r.host.closed).toBe(1);
    expect(existsSync(join(schedulesDir(r.dir), "daily.lock"))).toBe(false);
  });

  it("fills the route's variables from `with` (an @file's text read now) and drives it", async () => {
    const r = rig({ with: { caption: "@captions.txt", tag: "morning" } });
    writeFileSync(join(schedulesDir(r.dir), "captions.txt"), "Hello from Doha\n");
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(0);
    expect(r.host.calls).toEqual([{ tool: "drive", args: { route: "post_update", with: { caption: "Hello from Doha", tag: "morning" } } }]);
    // the report names the variables, never their values
    expect(r.report()["with"]).toEqual(["caption", "tag"]);
    expect(JSON.stringify(r.report())).not.toContain("Hello from Doha");
  });

  it("counts the grants and names the vault entries used during the run, never a value", async () => {
    const r = rig();
    r.host.onCall = (): void => {
      r.deps.audit.write({ kind: "grant", app: "com.instagram.ios", name: "instagram_posting", detail: 'tap "Post" (1 of 3 today)' });
      r.deps.audit.write({ kind: "grant", app: "com.instagram.ios", name: "instagram_posting", detail: 'tap "Post" (2 of 3 today)' });
      r.deps.audit.write({ kind: "vault", app: "com.instagram.ios", name: "tester2", detail: "password into secure field" });
    };
    // a grant used before the run doesn't count for it
    r.deps.audit.write({ kind: "grant", name: "earlier_one", detail: "x" });
    r.time.ms += 1000;
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.text).toContain("Grants used: instagram_posting (2)");
    expect(out.text).toContain("Vault names used: tester2");
    expect(out.text).not.toContain("earlier_one");
    expect(r.report()).toMatchObject({ "Grants used": "instagram_posting (2)", "Vault names used": "tester2", grants_used: [{ name: "instagram_posting", count: 2 }], vault_names_used: ["tester2"] });
  });

  it("scrubs vault values from the answer and the report", async () => {
    const r = rig({}, { answers: [{ text: "Ran 1 of 1 steps in 1 s.\nTyped hunter2 into the field", isError: false }] }, { redactFor: async () => (t) => t.split("hunter2").join("<tester2's password>") });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.text).toContain("<tester2's password>");
    expect(out.text).not.toContain("hunter2");
    expect(JSON.stringify(r.report())).not.toContain("hunter2");
  });

  it("a failed expect stops the run: failed at step 3 (expect), exit 1", async () => {
    const text = 'Error expect_failed: Ran 2 of 5 steps; stopped at step 3 (tap "Save"): its action ran, but text "Saved" didn\'t appear within 2 s.';
    const r = rig({}, { answers: [{ text, isError: true }] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(1);
    expect(out.text.split("\n")[0]).toBe('Schedule "daily" failed at step 3 (expect)');
    expect(scheduleLines(r)).toEqual(["started", "failed at step 3 (expect)"]);
    expect(r.report()).toMatchObject({ status: "failed", message: "failed at step 3 (expect)" });
  });

  it("an off_route stops it the same way", async () => {
    const r = rig({}, { answers: [{ text: "Error off_route: Ran 1 of 4 steps; stopped at step 2 (tap \"Next\"): it isn't on this screen.", isError: true }] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(1);
    expect(scheduleLines(r)).toContain("failed at step 2 (off_route)");
  });

  it("a route that doesn't exist couldn't start: exit 2, as in replay", async () => {
    const r = rig({}, { answers: [{ text: 'Error not_found: no script "post_update".', isError: true }] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(2);
  });

  it("a missing schedule, a schedule of another tool and an unreadable @file never reach a host", async () => {
    const r = rig({ with: { caption: "@missing.txt" } });
    expect((await runSchedule("nope", {}, r.deps)).code).toBe(2);
    expect((await runSchedule(undefined, {}, r.deps)).code).toBe(2);
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(2);
    expect(out.text).toContain("couldn't start");
    expect(r.connects).toBe(0);
    writeFileSync(schedulePath(r.dir, "other"), JSON.stringify({ version: 1, tool: "tapwright", route: "r", at: "09:00 daily" }));
    expect((await runSchedule("other", {}, r.deps)).text).toContain("only its own");
  });

  it("a host that can't start is a failed start, exit 2, and the lock is released", async () => {
    const r = rig({}, {}, { connect: async () => Promise.reject(new Error("every port is taken")) });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(2);
    expect(out.text).toContain("every port is taken");
    expect(existsSync(join(schedulesDir(r.dir), "daily.lock"))).toBe(false);
  });
});

describe("when a run can't start (§22.3)", () => {
  it("skipped: the app is not open", async () => {
    const r = rig({}, { open: false });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(2);
    expect(out.text.split("\n")[0]).toBe('Schedule "daily" skipped: the app is not open');
    expect(r.host.calls).toHaveLength(0);
    expect(scheduleLines(r)).toEqual(["skipped: the app is not open"]);
    expect(r.report()).toMatchObject({ status: "skipped", message: "skipped: the app is not open" });
    expect(r.host.closed).toBe(1);
  });

  it("a phone in use waits, runs when it frees up within 10 minutes, and says nothing of the wait", async () => {
    const r = rig();
    const host = r.host;
    host.busyFor = () => r.time.ms < 3 * 60 * 1000;
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(0);
    expect(host.calls).toHaveLength(1);
    expect(r.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3 * 60 * 1000);
    expect(r.slept.reduce((a, b) => a + b, 0)).toBeLessThan(BUSY_WAIT_MS);
    expect(scheduleLines(r)).toEqual(["started", "done"]);
  });

  it("skipped: the phone was in use, after waiting 10 minutes and doing nothing", async () => {
    const r = rig({}, { busyFor: () => true });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(2);
    expect(out.text.split("\n")[0]).toBe('Schedule "daily" skipped: the phone was in use');
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(BUSY_WAIT_MS);
    expect(r.time.ms).toBe(BUSY_WAIT_MS);
    expect(r.host.calls).toHaveLength(0);
    expect(scheduleLines(r)).toEqual(["skipped: the phone was in use"]);
  });

  it("a call answered `busy` before any step ran waits the same way and runs when the person is done", async () => {
    const r = rig({}, { answers: [{ text: "Error busy: A person is using the app in the live viewer.", isError: true }, OK] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(0);
    expect(r.host.calls).toHaveLength(2);
    expect(r.slept.length).toBeGreaterThan(0);
    expect(scheduleLines(r)).toEqual(["started", "done"]); // one started line, however many tries
  });

  it("a run kept busy by answers alone also skips after 10 minutes", async () => {
    const r = rig({}, { answers: [{ text: "Error paused: The user paused the agent in the live viewer.", isError: true }] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.text).toContain("skipped: the phone was in use");
    expect(r.slept.reduce((a, b) => a + b, 0)).toBe(BUSY_WAIT_MS);
  });

  it("a busy answer after steps ran is a failure, not a wait", async () => {
    const r = rig({}, { answers: [{ text: "Error busy: Ran 2 of 5 steps; stopped at step 3 (tap \"Save\"): a person is using the app.", isError: true }] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(1);
    expect(r.host.calls).toHaveLength(1);
  });

  it("skipped: the previous run is still going, while another run of it waits or runs; nothing is done twice", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({}, {});
    r.host.onCall = (): Promise<void> => gate;
    r.deps.alive = (): boolean => true;
    const first = runSchedule("daily", {}, r.deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await runSchedule("daily", {}, r.deps);
    expect(second.code).toBe(2);
    expect(second.text.split("\n")[0]).toBe('Schedule "daily" skipped: the previous run is still going');
    expect(r.connects).toBe(1);
    release();
    const done = await first;
    expect(done.code).toBe(0);
    expect(r.host.calls).toHaveLength(1);
    expect(scheduleLines(r)).toEqual(["started", "skipped: the previous run is still going", "done"]);
    // the lock is free again afterwards
    const third = await runSchedule("daily", {}, r.deps);
    expect(third.code).toBe(0);
  });

  it("a lock left by a run that died (its process is gone, or it is very old) doesn't block", async () => {
    const r = rig();
    writeFileSync(join(schedulesDir(r.dir), "daily.lock"), JSON.stringify({ pid: 999, t: r.deps.now().getTime() }));
    expect((await runSchedule("daily", {}, r.deps)).code).toBe(0); // alive() says no
    writeFileSync(join(schedulesDir(r.dir), "daily.lock"), JSON.stringify({ pid: 999, t: r.deps.now().getTime() - 7 * 3600 * 1000 }));
    r.deps.alive = (): boolean => true;
    expect((await runSchedule("daily", {}, r.deps)).code).toBe(0); // alive but older than any run
    writeFileSync(join(schedulesDir(r.dir), "daily.lock"), "garbage");
    expect((await runSchedule("daily", {}, r.deps)).code).toBe(0);
  });

  it("stopped: a draft is waiting for a person.", async () => {
    const text = 'Error not_allowed: Ran 4 of 6 steps; stopped at step 5 (tap "Post"): needs_confirmation: a draft is waiting for a person (button "Post", policy word "Post"). Open the live view.';
    const r = rig({}, { answers: [{ text, isError: true }] });
    const out = await runSchedule("daily", {}, r.deps);
    expect(out.code).toBe(1);
    expect(out.text.split("\n")[0]).toBe('Schedule "daily" stopped: a draft is waiting for a person.');
    expect(scheduleLines(r)).toEqual(["started", "stopped: a draft is waiting for a person."]);
    expect(r.report()).toMatchObject({ status: "stopped", message: "stopped: a draft is waiting for a person." });
  });
});

describe("a file trigger's check", () => {
  function fileRig(): { r: Rig; inbox: string } {
    const dir = tmp();
    const inbox = join(dir, "inbox");
    mkdirSync(inbox);
    const r = rig({ at: null, trigger: { file: inbox } });
    return { r, inbox };
  }

  it("does nothing, and says nothing, until a new file appears; then runs once", async () => {
    const { r, inbox } = fileRig();
    const wall = new Date(r.deps.now().getTime());
    writeFileSync(join(schedulesDir(r.dir), "daily.seen"), String(wall.getTime() - 60_000));
    const quiet = await runSchedule("daily", { checkTrigger: true }, r.deps);
    expect(quiet).toEqual({ text: "", code: 0 });
    expect(r.connects).toBe(0);
    expect(r.audit()).toEqual([]);
    writeFileSync(join(inbox, "photo.jpg"), "x");
    utimesSync(join(inbox, "photo.jpg"), wall, wall);
    const ran = await runSchedule("daily", { checkTrigger: true }, r.deps);
    expect(ran.code).toBe(0);
    expect(r.host.calls).toHaveLength(1);
    const again = await runSchedule("daily", { checkTrigger: true }, r.deps);
    expect(again).toEqual({ text: "", code: 0 });
    expect(r.host.calls).toHaveLength(1);
  });

  it("refuses --check-trigger on a schedule that starts on a time", async () => {
    const r = rig();
    expect((await runSchedule("daily", { checkTrigger: true }, r.deps)).code).toBe(2);
  });
});

describe("the run lock is owned (PR 12 review)", () => {
  const lockFile = (r: Rig): string => join(schedulesDir(r.dir), "daily.lock");
  const staleLock = (r: Rig): string => {
    writeFileSync(lockFile(r), JSON.stringify({ pid: 999, t: r.deps.now().getTime() - 7 * 3600 * 1000 }));
    return lockFile(r);
  };

  it("two runs that find the same leftover lock: one takes it, the other never deletes the new lock, so no run is duplicated", () => {
    const r = rig();
    staleLock(r);
    const alive = (): boolean => true;
    const first: RunDeps = { ...r.deps, pid: 1111, alive };
    let firstToken: string | null = null;
    // the second run has read the leftover; before it takes it over, the first run gets in
    const second: RunDeps = {
      ...r.deps,
      pid: 2222,
      alive,
      beforeReclaim: () => {
        firstToken = takeLock(first, "daily");
      },
    };
    const secondToken = takeLock(second, "daily");
    expect(firstToken).not.toBeNull();
    expect(secondToken).toBeNull();
    const held = JSON.parse(readFileSync(lockFile(r), "utf8")) as { pid: number; owner: string };
    expect(held.pid).toBe(1111);
    expect(held.owner).toBe(firstToken);
  });

  it("a run that stalled past the takeover can't release its successor's lock", () => {
    const r = rig();
    const alive = (): boolean => true;
    const old: RunDeps = { ...r.deps, pid: 1111, alive };
    const oldToken = takeLock(old, "daily");
    expect(oldToken).not.toBeNull();
    // the old run stalls for hours; its lock is taken over by a new run
    r.time.ms += 7 * 3600 * 1000;
    const successor: RunDeps = { ...r.deps, pid: 2222, alive };
    const newToken = takeLock(successor, "daily");
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(oldToken);
    // the old run wakes and finishes: its release leaves the new lock in place, and nobody else can take it
    dropLock(old, "daily", oldToken as string);
    expect((JSON.parse(readFileSync(lockFile(r), "utf8")) as { owner: string }).owner).toBe(newToken);
    expect(takeLock({ ...r.deps, pid: 3333, alive }, "daily")).toBeNull();
    dropLock(successor, "daily", newToken as string);
    expect(existsSync(lockFile(r))).toBe(false);
  });

  it("a run's own release removes its lock and leaves no tombstone", async () => {
    const r = rig();
    expect((await runSchedule("daily", {}, r.deps)).code).toBe(0);
    expect(readdirSync(schedulesDir(r.dir)).filter((f) => f.includes("daily.lock"))).toEqual([]);
  });
});
