import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUSY_WAIT_MS, runSchedule, type CallAnswer, type RunDeps, type ScheduleHost } from "../src/runschedule.js";
import { AuditLog } from "../src/auditlog.js";
import type { Schedule } from "../src/schedule.js";
import { schedulePath, schedulesDir } from "../src/schedule.js";
import { canonicalPath, HOST_FACTS_TOOL, LEASE_TOOL, type HostFacts } from "../src/runtime.js";
import { connectScheduleHost, factsMismatch, type ThinCaller } from "../src/schedulehost.js";

// AGENT-TOOLS 1.14 §22.2, §22.3 (PR 12 finding 6): a running host is used only when it carries the schedule's own policy, accounts and maps.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-schedhost-"));
  dirs.push(dir);
  return dir;
};

interface World {
  home: string;
  env: NodeJS.ProcessEnv;
  policy: string;
  accounts: string;
  maps: string;
}

function world(): World {
  const home = tmp();
  const policy = join(home, "policy.json");
  const accounts = join(home, "accounts.json");
  const maps = join(home, "my-maps");
  writeFileSync(policy, "{}");
  writeFileSync(accounts, "{}");
  mkdirSync(maps);
  return { home, env: { TAPLINE_HOME: home }, policy, accounts, maps };
}

const scheduleOf = (w: World, over: Partial<Schedule> = {}): Schedule => ({
  version: 1,
  tool: "tapline",
  route: "post_update",
  with: {},
  at: "09:00 daily",
  trigger: null,
  policy: w.policy,
  accounts: w.accounts,
  maps: w.maps,
  ...over,
});

const factsOf = (w: World, over: Partial<HostFacts> = {}): HostFacts => ({
  version: 1,
  policy: canonicalPath(w.policy),
  noPolicy: false,
  accounts: canonicalPath(w.accounts),
  maps: canonicalPath(w.maps),
  ...over,
});

describe("factsMismatch (fail closed)", () => {
  it("a host with the schedule's policy, accounts and maps matches", () => {
    const w = world();
    expect(factsMismatch(scheduleOf(w), factsOf(w), w.env)).toBeNull();
  });

  it("a host started with --no-policy never matches, whatever else it says", () => {
    const w = world();
    expect(factsMismatch(scheduleOf(w), factsOf(w, { noPolicy: true }), w.env)).toMatch(/--no-policy/);
    expect(factsMismatch(scheduleOf(w, { policy: null }), factsOf(w, { noPolicy: true, policy: null }), w.env)).toMatch(/--no-policy/);
  });

  it("another policy file, no policy file, another accounts file, another maps folder", () => {
    const w = world();
    const other = join(w.home, "other.json");
    writeFileSync(other, "{}");
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policy: canonicalPath(other) }), w.env)).toMatch(/another policy/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policy: null }), w.env)).toMatch(/another policy/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { accounts: null }), w.env)).toMatch(/other accounts/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { accounts: canonicalPath(other) }), w.env)).toMatch(/other accounts/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { maps: canonicalPath(join(w.home, "elsewhere")) }), w.env)).toMatch(/maps/);
  });

  it("a schedule with no policy needs a host on the built-in policy, not one with a file of its own", () => {
    const w = world();
    expect(factsMismatch(scheduleOf(w, { policy: null }), factsOf(w, { policy: null }), w.env)).toBeNull();
    expect(factsMismatch(scheduleOf(w, { policy: null }), factsOf(w), w.env)).toMatch(/another policy/);
  });

  it("no maps in the schedule means the default folder of this config directory", () => {
    const w = world();
    const fallback = canonicalPath(join(w.home, "maps"));
    expect(factsMismatch(scheduleOf(w, { maps: null }), factsOf(w, { maps: fallback }), w.env)).toBeNull();
    expect(factsMismatch(scheduleOf(w, { maps: null }), factsOf(w), w.env)).toMatch(/maps/);
  });

  it("facts that can't be read are a mismatch", () => {
    const w = world();
    expect(factsMismatch(scheduleOf(w), null, w.env)).toMatch(/can't be read/);
  });

  it("the same file through a different spelling matches", () => {
    const w = world();
    const spelled = join(w.home, ".", "policy.json");
    expect(factsMismatch(scheduleOf(w, { policy: spelled }), factsOf(w), w.env)).toBeNull();
  });
});

interface Thin {
  call: ThinCaller;
  seen: Array<{ tool: string; client: string; args: Record<string, unknown> }>;
}

/** A running host that answers `apps`, its facts and the lease the way the real one does. */
function fakeRunning(facts: HostFacts | string | null | "no host", opts: { leaseFree?: () => boolean; answers?: CallAnswer[] } = {}): Thin {
  const seen: Thin["seen"] = [];
  let held = false;
  const call: ThinCaller = async (_env, client, tool, args) => {
    seen.push({ tool, client, args });
    if (facts === "no host") return null;
    if (tool === "apps") return { text: "Connected apps:\n- Demo", isError: false };
    if (tool === HOST_FACTS_TOOL) return typeof facts === "string" ? { text: facts, isError: false } : facts === null ? { text: "Error bad_params: the host refused the call.", isError: true } : { text: JSON.stringify(facts), isError: false };
    if (tool === LEASE_TOOL) {
      const action = args["action"];
      if (action === "acquire") {
        held = opts.leaseFree?.() ?? true;
        return { text: JSON.stringify(held ? { ok: true } : { ok: false, by: "agent" }), isError: false };
      }
      if (action === "release") {
        const was = held;
        held = false;
        return { text: JSON.stringify({ ok: was }), isError: false };
      }
      return { text: JSON.stringify({ ok: held }), isError: false };
    }
    return opts.answers?.shift() ?? { text: "Ran 3 of 3 steps in 1.0 s.", isError: false };
  };
  return { call, seen };
}

function fakeOwn(): { own: (schedule: Schedule, name: string, env: NodeJS.ProcessEnv, note?: string) => Promise<ScheduleHost>; made: Array<{ note: string | undefined }> } {
  const made: Array<{ note: string | undefined }> = [];
  return {
    made,
    own: async (_s, _n, _e, note) => {
      made.push({ note });
      return {
        via: "its own host",
        ...(note !== undefined ? { closedNote: note } : {}),
        appOpen: async () => true,
        inUse: () => false,
        call: async () => ({ text: "Ran 3 of 3 steps in 1.0 s.", isError: false }),
        close: async () => undefined,
      };
    },
  };
}

describe("connectScheduleHost", () => {
  it("reuses a running host whose facts match, and asks nothing of its files", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w));
    const own = fakeOwn();
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: own.own });
    expect(host.via).toBe("a running host");
    expect(own.made).toEqual([]);
    expect(thin.seen.map((s) => s.tool)).toEqual(["apps", HOST_FACTS_TOOL]);
  });

  it("a running host with --no-policy is not reused: the run starts its own host with the schedule's files and says why when the app isn't there", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w, { noPolicy: true }));
    const own = fakeOwn();
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: own.own });
    expect(host.via).toBe("its own host");
    expect(own.made).toHaveLength(1);
    expect(own.made[0]?.note).toMatch(/the running host differs from the schedule: it runs with --no-policy/);
    expect(thin.seen.some((s) => s.tool !== "apps" && s.tool !== HOST_FACTS_TOOL)).toBe(false);
  });

  it.each([
    ["another policy", (w: World) => factsOf(w, { policy: null })],
    ["other accounts", (w: World) => factsOf(w, { accounts: null })],
    ["another maps folder", (w: World) => factsOf(w, { maps: canonicalPath(join(w.home, "else")) })],
    ["unreadable facts", () => "not json"],
    ["a host that doesn't know the facts query", () => null],
  ])("%s: no reuse", async (_name, make) => {
    const w = world();
    const thin = fakeRunning(make(w));
    const own = fakeOwn();
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: own.own });
    expect(host.via).toBe("its own host");
    expect(own.made[0]?.note).toBeDefined();
  });

  it("no host running: an own host and no note", async () => {
    const w = world();
    const own = fakeOwn();
    await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: fakeRunning("no host").call, own: own.own });
    expect(own.made).toEqual([{ note: undefined }]);
  });

  it("a mismatched host and an app that doesn't connect to the own host: the run skips and names the difference, and nothing was driven", async () => {
    const w = world();
    mkdirSync(schedulesDir(w.home), { recursive: true });
    writeFileSync(schedulePath(w.home, "daily"), JSON.stringify({ ...scheduleOf(w) }));
    const thin = fakeRunning(factsOf(w, { noPolicy: true }));
    const calls: string[] = [];
    const time = { ms: 0 };
    const wall = new Date(Date.UTC(2026, 10, 14, 6, 0, 0));
    const deps: RunDeps = {
      configDir: w.home,
      now: () => new Date(wall.getTime() + time.ms),
      clock: () => time.ms,
      sleep: async (ms) => void (time.ms += ms),
      connect: async (schedule, name) => {
        const base = await connectScheduleHost(schedule, name, w.env, {
          thin: thin.call,
          own: async (_s, _n, _e, note) => ({
            via: "its own host",
            ...(note !== undefined ? { closedNote: note } : {}),
            appOpen: async () => false,
            inUse: () => false,
            call: async (tool) => {
              calls.push(tool);
              return { text: "Ran 1 of 1 steps", isError: false };
            },
            close: async () => undefined,
          }),
        });
        return base;
      },
      audit: new AuditLog(join(w.home, "audit")),
      redactFor: async () => (text) => text,
      pid: 4242,
      alive: () => false,
    };
    const out = await runSchedule("daily", {}, deps);
    expect(out.code).toBe(2);
    expect(out.text.split("\n")[0]).toBe('Schedule "daily" skipped: the app is not open (the running host differs from the schedule: it runs with --no-policy)');
    expect(calls).toEqual([]);
    expect(thin.seen.map((s) => s.tool).filter((t) => t !== "apps" && t !== HOST_FACTS_TOOL)).toEqual([]);
  });
});

describe("a reused host's lease", () => {
  const acquires = (thin: Thin): string[] => thin.seen.filter((s) => s.tool === LEASE_TOOL).map((s) => String(s.args["action"]));

  it("inUse takes the lease, the second ask does not take it again, and close gives it back", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w));
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: fakeOwn().own });
    expect(await host.inUse()).toBe(false);
    expect(await host.inUse()).toBe(false);
    expect(acquires(thin)).toEqual(["acquire"]);
    expect(thin.seen.find((s) => s.tool === LEASE_TOOL)?.client).toBe("schedule-daily");
    await host.close();
    expect(acquires(thin)).toEqual(["acquire", "release"]);
  });

  it("a host another agent is using is in use; nothing is released that was never held", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w), { leaseFree: () => false });
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: fakeOwn().own });
    expect(await host.inUse()).toBe(true);
    await host.close();
    expect(acquires(thin)).toEqual(["acquire"]);
  });

  it("a busy answer gives the phone back while the run waits, and the next try takes it again", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w), { answers: [{ text: "Error busy: A person is using the app in the live viewer.", isError: true }] });
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: fakeOwn().own });
    expect(await host.inUse()).toBe(false);
    const answer = await host.call("drive", { route: "post_update" });
    expect(answer.isError).toBe(true);
    expect(await host.inUse()).toBe(false);
    expect(acquires(thin)).toEqual(["acquire", "release", "acquire"]);
    await host.close();
  });

  it("run-schedule waits up to 10 minutes for a lease another agent holds, then skips with the phone-in-use line and drives nothing", async () => {
    const w = world();
    mkdirSync(schedulesDir(w.home), { recursive: true });
    writeFileSync(schedulePath(w.home, "daily"), JSON.stringify(scheduleOf(w)));
    const thin = fakeRunning(factsOf(w), { leaseFree: () => false });
    const time = { ms: 0 };
    const slept: number[] = [];
    const wall = new Date(Date.UTC(2026, 10, 14, 6, 0, 0));
    const deps: RunDeps = {
      configDir: w.home,
      now: () => new Date(wall.getTime() + time.ms),
      clock: () => time.ms,
      sleep: async (ms) => {
        slept.push(ms);
        time.ms += ms;
      },
      connect: (schedule, name) => connectScheduleHost(schedule, name, w.env, { thin: thin.call, own: fakeOwn().own }),
      audit: new AuditLog(join(w.home, "audit")),
      redactFor: async () => (text) => text,
      pid: 4242,
      alive: () => false,
    };
    const out = await runSchedule("daily", {}, deps);
    expect(out.text.split("\n")[0]).toBe('Schedule "daily" skipped: the phone was in use');
    expect(slept.reduce((a, b) => a + b, 0)).toBe(BUSY_WAIT_MS);
    expect(thin.seen.some((s) => s.tool === "replay" || s.tool === "drive")).toBe(false);
  });

  it("run-schedule takes the lease once the other agent lets go within the 10 minutes, then runs", async () => {
    const w = world();
    mkdirSync(schedulesDir(w.home), { recursive: true });
    writeFileSync(schedulePath(w.home, "daily"), JSON.stringify(scheduleOf(w)));
    const time = { ms: 0 };
    const thin = fakeRunning(factsOf(w), { leaseFree: () => time.ms >= 3 * 60 * 1000 });
    const wall = new Date(Date.UTC(2026, 10, 14, 6, 0, 0));
    const deps: RunDeps = {
      configDir: w.home,
      now: () => new Date(wall.getTime() + time.ms),
      clock: () => time.ms,
      sleep: async (ms) => void (time.ms += ms),
      connect: (schedule, name) => connectScheduleHost(schedule, name, w.env, { thin: thin.call, own: fakeOwn().own }),
      audit: new AuditLog(join(w.home, "audit")),
      redactFor: async () => (text) => text,
      pid: 4242,
      alive: () => false,
    };
    const out = await runSchedule("daily", {}, deps);
    expect(out.code).toBe(0);
    expect(thin.seen.some((s) => s.tool === "replay")).toBe(true);
    expect(time.ms).toBeGreaterThanOrEqual(3 * 60 * 1000);
    expect(time.ms).toBeLessThan(BUSY_WAIT_MS);
    // The lease is given back when the run ends.
    expect(acquires(thin).at(-1)).toBe("release");
  });
});
