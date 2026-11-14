import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_WAIT_MS, runSchedule, type CallAnswer, type RunDeps, type ScheduleHost } from "../src/runschedule.js";
import { AuditLog } from "../src/auditlog.js";
import type { Schedule } from "../src/schedule.js";
import { schedulePath, schedulesDir } from "../src/schedule.js";
import { canonicalPath, HOST_FACTS_TOOL, LEASE_TOOL, type HostFacts } from "../src/runtime.js";
import { connectScheduleHost, factsMismatch, LOST_TEXT, type ThinCaller, type ThinPin } from "../src/schedulehost.js";
import { hashFile, hashMapsDir } from "../src/hostfacts.js";

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

const INSTANCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CREDENTIAL = "0f".repeat(32);

/** What a host started on these files reports: paths, and the hashes of the files as it loaded them (now). */
const factsOf = (w: World, over: Partial<HostFacts> = {}): HostFacts => ({
  version: 2,
  instance: INSTANCE,
  policy: canonicalPath(w.policy),
  noPolicy: false,
  accounts: canonicalPath(w.accounts),
  maps: canonicalPath(w.maps),
  policyHash: hashFile(w.policy),
  accountsHash: hashFile(w.accounts),
  mapsHash: hashMapsDir(w.maps),
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
  seen: Array<{ tool: string; client: string; args: Record<string, unknown>; pin: ThinPin | undefined }>;
  /** Another host takes over the port: its instance id differs from the one that was checked. */
  swap(): void;
  /** Renewals and every lease call that follows are refused, as when the host dropped the lease. */
  failRenewals(): void;
  /** The next call of a tool waits until the caller aborts it (a long replay). */
  hang(tool: string): void;
}

/** A running host that answers `apps`, its facts and the lease the way the real one does. */
function fakeRunning(facts: HostFacts | string | null | "no host", opts: { leaseFree?: () => boolean; answers?: CallAnswer[] } = {}): Thin {
  const seen: Thin["seen"] = [];
  let held = false;
  let instance = typeof facts === "object" && facts !== null ? facts.instance : INSTANCE;
  let renewalsFail = false;
  const hanging = new Set<string>();
  const PORT = 7213;
  const call: ThinCaller = async (_env, client, tool, args, pin, signal) => {
    seen.push({ tool, client, args, pin });
    if (facts === "no host") return null;
    // A pinned call goes to its port only, and the host refuses another instance's id.
    if (pin !== undefined && pin.port !== PORT) return null;
    if (pin?.instance !== undefined && pin.instance !== instance) return { text: "Error wrong_host: this is not the host the schedule checked.", isError: true, port: PORT };
    if (tool === "apps") return { text: "Connected apps:\n- Demo", isError: false, port: PORT };
    if (tool === HOST_FACTS_TOOL) return typeof facts === "string" ? { text: facts, isError: false, port: PORT } : facts === null ? { text: "Error bad_params: the host refused the call.", isError: true, port: PORT } : { text: JSON.stringify(facts), isError: false, port: PORT };
    if (tool === LEASE_TOOL) {
      const action = args["action"];
      if (action === "acquire") {
        held = opts.leaseFree?.() ?? true;
        return { text: JSON.stringify(held ? { ok: true, credential: CREDENTIAL } : { ok: false, by: "agent" }), isError: false, port: PORT };
      }
      if (action === "release") {
        const was = held && pin?.lease === CREDENTIAL;
        held = false;
        return { text: JSON.stringify({ ok: was }), isError: false, port: PORT };
      }
      return { text: JSON.stringify({ ok: held && !renewalsFail && pin?.lease === CREDENTIAL }), isError: false, port: PORT };
    }
    if (hanging.delete(tool)) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { text: "Error unknown_outcome: the call was sent but no answer came back.", isError: true, port: PORT };
    }
    return { ...(opts.answers?.shift() ?? { text: "Ran 3 of 3 steps in 1.0 s.", isError: false }), port: PORT };
  };
  return {
    call,
    seen,
    swap: () => void (instance = "ffffffffffffffffffffffffffffffff"),
    failRenewals: () => void (renewalsFail = true),
    hang: (tool) => void hanging.add(tool),
  };
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

describe("matching paths are not matching policy (PR 12 Codex cycle 2, finding 2)", () => {
  it("the policy file edited after the host loaded it (a block word added) is not reused, and nothing is driven through the old snapshot", async () => {
    const w = world();
    const facts = factsOf(w); // the host loaded the file as it was
    writeFileSync(w.policy, JSON.stringify({ version: 2, block: ["Delete"] }));
    const thin = fakeRunning(facts);
    const own = fakeOwn();
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: own.own });
    expect(host.via).toBe("its own host");
    expect(own.made[0]?.note).toMatch(/the policy file has changed since the host loaded it/);
    expect(thin.seen.some((s) => s.tool !== "apps" && s.tool !== HOST_FACTS_TOOL)).toBe(false);
  });

  it("the accounts file edited after the host loaded it is not reused", async () => {
    const w = world();
    const facts = factsOf(w);
    writeFileSync(w.accounts, JSON.stringify({ version: 2, vault: {} }));
    const own = fakeOwn();
    await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: fakeRunning(facts).call, own: own.own });
    expect(own.made[0]?.note).toMatch(/the accounts file has changed since the host loaded it/);
  });

  it("a map changed after the host loaded it is not reused", async () => {
    const w = world();
    const facts = factsOf(w);
    mkdirSync(join(w.maps, "com.example.app"));
    writeFileSync(join(w.maps, "com.example.app", "map.json"), "{}");
    const own = fakeOwn();
    await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: fakeRunning(facts).call, own: own.own });
    expect(own.made[0]?.note).toMatch(/the maps have changed since the host loaded them/);
  });

  it("a host that couldn't read its policy (a null hash) never matches a schedule that names one", () => {
    const w = world();
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policyHash: null }), w.env)).toMatch(/policy file has changed/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { accountsHash: null }), w.env)).toMatch(/accounts file has changed/);
  });

  it("identical files, hashed by the injected hasher, match; any difference in any one of the three refuses", () => {
    const w = world();
    const same = { file: () => "h", maps: () => "m" };
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policyHash: "h", accountsHash: "h", mapsHash: "m" }), w.env, same)).toBeNull();
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policyHash: "x", accountsHash: "h", mapsHash: "m" }), w.env, same)).toMatch(/policy/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policyHash: "h", accountsHash: "x", mapsHash: "m" }), w.env, same)).toMatch(/accounts/);
    expect(factsMismatch(scheduleOf(w), factsOf(w, { policyHash: "h", accountsHash: "h", mapsHash: "x" }), w.env, same)).toMatch(/maps/);
  });

  it("facts without an instance id or hashes (an older host) can't be read: no reuse", async () => {
    const w = world();
    const old = { version: 1, policy: canonicalPath(w.policy), noPolicy: false, accounts: canonicalPath(w.accounts), maps: canonicalPath(w.maps) };
    const own = fakeOwn();
    await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: fakeRunning(JSON.stringify(old)).call, own: own.own });
    expect(own.made[0]?.note).toMatch(/can't be read/);
  });
});

describe("the run is bound to the host it checked (PR 12 Codex cycle 2, finding 3)", () => {
  it("after the first scan every call goes to that port with the host's instance id, and the lease calls carry the credential", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w));
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: fakeOwn().own });
    await host.appOpen(1000);
    await host.inUse();
    await host.call("replay", { name: "post_update" });
    await host.close();
    // the first call scans; the facts call is pinned to the port the scan found; the rest carry the instance too
    expect(thin.seen[0]?.pin).toBeUndefined();
    expect(thin.seen[1]?.pin).toEqual({ port: 7213 });
    for (const call of thin.seen.slice(2)) {
      expect(call.pin?.port, call.tool).toBe(7213);
      expect(call.pin?.instance, call.tool).toBe(INSTANCE);
    }
    const leaseCalls = thin.seen.filter((s) => s.tool === LEASE_TOOL);
    expect(leaseCalls[0]?.pin?.lease).toBeUndefined(); // nothing to show until the host gives it
    for (const call of [...thin.seen.filter((s) => s.tool === "replay"), ...leaseCalls.slice(1)]) expect(call.pin?.lease, call.tool).toBe(CREDENTIAL);
  });

  it("host A vanishes and host B answers on the same port with other settings: the call is refused, the run stops, and nothing falls back to another port", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w));
    const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: fakeOwn().own });
    expect(await host.inUse()).toBe(false);
    thin.swap();
    const answer = await host.call("replay", { name: "post_update" });
    expect(answer).toEqual({ text: LOST_TEXT, isError: true });
    // later calls don't go out at all
    const before = thin.seen.length;
    expect(await host.call("replay", { name: "post_update" })).toEqual({ text: LOST_TEXT, isError: true });
    expect(thin.seen.length).toBe(before);
    await host.close();
    expect(thin.seen.every((s) => s.pin === undefined || s.pin.port === 7213)).toBe(true);
  });

  it("a pinned thin call to a port with no host answers null (never scans for another)", async () => {
    const w = world();
    const thin = fakeRunning(factsOf(w));
    expect(await thin.call(w.env, "c", "apps", {}, { port: 7219, instance: INSTANCE })).toBeNull();
  });
});

describe("a lost lease stops the run (PR 12 CodeRabbit)", () => {
  it("a renewal that fails cuts the call in flight off and every later call answers that the run lost the phone", async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const thin = fakeRunning(factsOf(w));
      const host = await connectScheduleHost(scheduleOf(w), "daily", w.env, { thin: thin.call, own: fakeOwn().own });
      expect(await host.inUse()).toBe(false);
      thin.hang("replay");
      const running = host.call("replay", { name: "post_update" });
      thin.failRenewals();
      await vi.advanceTimersByTimeAsync(16_000);
      const answer = await running;
      expect(answer).toEqual({ text: LOST_TEXT, isError: true });
      const sent = thin.seen.length;
      expect(await host.call("replay", { name: "again" })).toEqual({ text: LOST_TEXT, isError: true });
      expect(thin.seen.length).toBe(sent);
      await host.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("run-schedule reports it as a failed run: stopped: the run lost the phone", async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      mkdirSync(schedulesDir(w.home), { recursive: true });
      writeFileSync(schedulePath(w.home, "daily"), JSON.stringify(scheduleOf(w)));
      const thin = fakeRunning(factsOf(w));
      thin.hang("replay");
      const deps: RunDeps = {
        configDir: w.home,
        now: () => new Date(Date.UTC(2026, 10, 14, 6, 0, 0)),
        clock: () => Date.now(),
        sleep: async () => undefined,
        connect: (schedule, name) => connectScheduleHost(schedule, name, w.env, { thin: thin.call, own: fakeOwn().own }),
        audit: new AuditLog(join(w.home, "audit")),
        redactFor: async () => (text) => text,
        pid: 4242,
        alive: () => false,
      };
      const run = runSchedule("daily", {}, deps);
      await vi.advanceTimersByTimeAsync(1000);
      thin.failRenewals();
      await vi.advanceTimersByTimeAsync(16_000);
      const out = await run;
      expect(out.code).toBe(1);
      expect(out.text.split("\n")[0]).toBe('Schedule "daily" stopped: the run lost the phone.');
    } finally {
      vi.useRealTimers();
    }
  });
});
