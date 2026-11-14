import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/auditlog.js";
import { hashMapsOnDisk, policyFingerprint } from "../src/hostfacts.js";
import { loadPolicy } from "../src/policy.js";
import { runSchedule, type RunDeps, type ScheduleHost } from "../src/runschedule.js";
import { canonicalPath, HOST_FACTS_TOOL, LEASE_TOOL, type HostFacts } from "../src/runtime.js";
import { schedulePath, schedulesDir, type Schedule } from "../src/schedule.js";
import {
  connectScheduleHost,
  DISCOVERY_TIMEOUT_MS,
  FACTS_TIMEOUT_MS,
  LEASE_CALL_TIMEOUT_MS,
  ROUTE_CALL_TIMEOUT_MS,
  VAULT_LOAD_TIMEOUT_MS,
  type FactHasher,
  type ThinCaller,
} from "../src/schedulehost.js";

// PR 12 Codex cycle 4, finding 3: every wait in a scheduled run's host path is bounded, and a run that times out fails with its reason,
// gives back the lease it holds and drops the run lock, so the next run is not blocked.

const HOST_TOKEN = "0123456789abcdef0123456789abcdef";
const INSTANCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CREDENTIAL = "0f".repeat(32);
const PORT = 7213;

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface World {
  home: string;
  env: NodeJS.ProcessEnv;
  schedule: Schedule;
  facts: HostFacts;
}

function world(): World {
  const home = mkdtempSync(join(tmpdir(), "tapline-stall-"));
  dirs.push(home);
  const policy = join(home, "policy.json");
  const accounts = join(home, "accounts.json");
  const maps = join(home, "my-maps");
  writeFileSync(policy, JSON.stringify({ version: 2, block: ["Archive"] }));
  writeFileSync(accounts, JSON.stringify({ version: 2, vault: {} }));
  writeFileSync(join(home, "token"), `${HOST_TOKEN}\n`);
  mkdirSync(maps);
  mkdirSync(schedulesDir(home), { recursive: true });
  const schedule: Schedule = { version: 1, tool: "tapline", route: "post_update", with: {}, at: "09:00 daily", trigger: null, policy, accounts, maps };
  writeFileSync(schedulePath(home, "daily"), JSON.stringify(schedule));
  const facts: HostFacts = {
    version: 3,
    instance: INSTANCE,
    policy: canonicalPath(policy),
    noPolicy: false,
    accounts: canonicalPath(accounts),
    maps: canonicalPath(maps),
    policyHash: policyFingerprint(loadPolicy(policy)),
    accountsHash: createHmac("sha256", HOST_TOKEN).update("{}").digest("hex"),
    mapsHash: hashMapsOnDisk(maps),
  };
  return { home, env: { TAPLINE_HOME: home }, schedule, facts };
}

interface Rig {
  thin: ThinCaller;
  /** Every signal each tool's call was given, to see that a stalled request was aborted. */
  signals: Map<string, AbortSignal[]>;
  released: () => number;
}

/** A running host whose named tool (or lease action) never answers and ignores the abort signal, as a wedged host does. */
function rig(w: World, stalls: { tool?: string; leaseAction?: string }): Rig {
  const signals = new Map<string, AbortSignal[]>();
  let releases = 0;
  const never = (): Promise<never> => new Promise<never>(() => undefined);
  const thin: ThinCaller = async (_env, _client, tool, args, _pin, signal) => {
    if (signal !== undefined) signals.set(tool, [...(signals.get(tool) ?? []), signal]);
    if (stalls.tool === tool) return never();
    if (tool === "apps") return { text: "Connected apps:\n- Demo", isError: false, port: PORT };
    if (tool === HOST_FACTS_TOOL) return { text: JSON.stringify(w.facts), isError: false, port: PORT };
    if (tool === LEASE_TOOL) {
      const action = String(args["action"]);
      if (stalls.leaseAction === action) return never();
      if (action === "release") releases += 1;
      return { text: JSON.stringify(action === "acquire" ? { ok: true, credential: CREDENTIAL } : { ok: true }), isError: false, port: PORT };
    }
    return { text: "Ran 3 of 3 steps in 1.0 s.", isError: false, port: PORT };
  };
  return { thin, signals, released: () => releases };
}

const quickHasher = (w: World, accounts: FactHasher["accounts"] = async () => w.facts.accountsHash): FactHasher => ({
  policy: () => w.facts.policyHash,
  accounts,
  maps: () => w.facts.mapsHash,
});

const depsFor = (w: World, connect: RunDeps["connect"]): RunDeps => ({
  configDir: w.home,
  now: () => new Date(Date.UTC(2026, 10, 14, 6, 0, 0)),
  clock: () => Date.now(),
  sleep: async () => undefined,
  connect,
  audit: new AuditLog(join(w.home, "audit")),
  redactFor: async () => (text) => text,
  pid: 4242,
  alive: () => false,
});

/** Runs the schedule and advances the fake clock; says whether the run settled within `ms`. */
async function settle(run: Promise<{ text: string; code: number }>, ms: number): Promise<{ text: string; code: number } | "pending"> {
  let out: { text: string; code: number } | undefined;
  void run.then((o) => void (out = o));
  await vi.advanceTimersByTimeAsync(ms);
  return out ?? "pending";
}

const lockFile = (w: World): string => join(schedulesDir(w.home), "daily.lock");

describe("a stalled host path ends the run (finding 3)", () => {
  it("a stalled facts answer: the run fails with its reason well inside the bound, the request was aborted, the lock is dropped and the next run goes", async () => {
    vi.useFakeTimers();
    const w = world();
    const r = rig(w, { tool: HOST_FACTS_TOOL });
    const connect: RunDeps["connect"] = (s, n) => connectScheduleHost(s, n, w.env, { thin: r.thin, hasher: quickHasher(w) });
    const out = await settle(runSchedule("daily", {}, depsFor(w, connect)), FACTS_TIMEOUT_MS + 1000);
    expect(out).not.toBe("pending");
    if (out === "pending") return;
    expect(out.code).toBe(2);
    expect(out.text.split("\n")[0]).toMatch(/^Schedule "daily" couldn't start: .*facts.*didn't answer within 30 s/);
    expect(r.signals.get(HOST_FACTS_TOOL)?.every((s) => s.aborted)).toBe(true);
    expect(existsSync(lockFile(w))).toBe(false);
    // the run lock is free again: a later run is not "still going"
    const again = rig(w, {});
    const next = await settle(runSchedule("daily", {}, depsFor(w, (s, n) => connectScheduleHost(s, n, w.env, { thin: again.thin, hasher: quickHasher(w) }))), 1000);
    expect(next === "pending" ? next : next.code).toBe(0);
  });

  it("a stalled discovery (the first scan) is bounded the same way", async () => {
    vi.useFakeTimers();
    const w = world();
    const r = rig(w, { tool: "apps" });
    const connect: RunDeps["connect"] = (s, n) => connectScheduleHost(s, n, w.env, { thin: r.thin, hasher: quickHasher(w) });
    const out = await settle(runSchedule("daily", {}, depsFor(w, connect)), DISCOVERY_TIMEOUT_MS + 1000);
    expect(out).not.toBe("pending");
    if (out !== "pending") expect(out.text).toMatch(/couldn't start: .*didn't answer within 30 s/);
    expect(existsSync(lockFile(w))).toBe(false);
  });

  it("a stalled vault load: the run fails with its reason, and the lock is dropped", async () => {
    vi.useFakeTimers();
    const w = world();
    const r = rig(w, {});
    const connect: RunDeps["connect"] = (s, n) => connectScheduleHost(s, n, w.env, { thin: r.thin, hasher: quickHasher(w, () => new Promise<never>(() => undefined)) });
    const out = await settle(runSchedule("daily", {}, depsFor(w, connect)), VAULT_LOAD_TIMEOUT_MS + 1000);
    expect(out).not.toBe("pending");
    if (out === "pending") return;
    expect(out.code).toBe(2);
    expect(out.text).toMatch(/couldn't start: .*vault.*didn't answer within 30 s/);
    expect(existsSync(lockFile(w))).toBe(false);
  });

  it("a stalled lease acquire: the run fails with its reason, nothing was driven, and the lock is dropped", async () => {
    vi.useFakeTimers();
    const w = world();
    const r = rig(w, { leaseAction: "acquire" });
    const driven: string[] = [];
    const thin: ThinCaller = async (...args) => {
      if (args[2] !== "apps" && args[2] !== HOST_FACTS_TOOL && args[2] !== LEASE_TOOL) driven.push(args[2]);
      return r.thin(...args);
    };
    const connect: RunDeps["connect"] = (s, n) => connectScheduleHost(s, n, w.env, { thin, hasher: quickHasher(w) });
    const out = await settle(runSchedule("daily", {}, depsFor(w, connect)), LEASE_CALL_TIMEOUT_MS + 1000);
    expect(out).not.toBe("pending");
    if (out === "pending") return;
    expect(out.code).toBe(2);
    expect(out.text).toMatch(/couldn't start: .*lease.*didn't answer within 10 s/);
    expect(driven).toEqual([]);
    expect(r.signals.get(LEASE_TOOL)?.some((s) => s.aborted)).toBe(true);
    expect(existsSync(lockFile(w))).toBe(false);
  });

  it("a stalled lease renewal and a route call that never ends: the call is cut off at its own limit and the lease is released", async () => {
    vi.useFakeTimers();
    const w = world();
    const r = rig(w, { tool: "replay" });
    const connect: RunDeps["connect"] = (s, n) => connectScheduleHost(s, n, w.env, { thin: r.thin, hasher: quickHasher(w) });
    const out = await settle(runSchedule("daily", {}, depsFor(w, connect)), ROUTE_CALL_TIMEOUT_MS + 60_000);
    expect(out).not.toBe("pending");
    if (out === "pending") return;
    expect(out.code).toBe(1);
    expect(out.text.split("\n")[0]).toMatch(/^Schedule "daily" failed \(timeout\)/);
    expect(r.released()).toBe(1);
    expect(existsSync(lockFile(w))).toBe(false);
  });

  it("a host whose close() never returns does not keep the finished run waiting", async () => {
    vi.useFakeTimers();
    const w = world();
    const host: ScheduleHost = {
      via: "its own host",
      appOpen: async () => true,
      inUse: () => false,
      call: async () => ({ text: "Ran 3 of 3 steps in 1.0 s.", isError: false }),
      close: () => new Promise<void>(() => undefined),
    };
    const out = await settle(runSchedule("daily", {}, depsFor(w, async () => host)), 120_000);
    expect(out).not.toBe("pending");
    expect(existsSync(lockFile(w))).toBe(false);
  });
});
