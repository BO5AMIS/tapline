import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/auditlog.js";
import { loadAccounts } from "../src/accounts.js";
import { runSchedule, VAULT_LOAD_TIMEOUT_MS, type RunDeps } from "../src/runschedule.js";
import { schedulePath, schedulesDir, type Schedule } from "../src/schedule.js";
import { spawnRunner, type Keychain, type VaultDeps } from "../src/vault.js";

// PR 12 Codex cycle 5, finding 2: the first load of a schedule's vault is bounded, the stalled subprocess is told to stop, the run
// fails with `couldn't start:` and the run lock is never left behind. Nothing here touches a real keychain: all runners are fakes.

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function home(): { home: string; schedule: Schedule } {
  const dir = mkdtempSync(join(tmpdir(), "tapline-vstall-"));
  dirs.push(dir);
  mkdirSync(schedulesDir(dir), { recursive: true });
  const schedule: Schedule = { version: 1, tool: "tapline", route: "post_update", with: {}, at: "09:00 daily", trigger: null, policy: null, accounts: join(dir, "accounts.json"), maps: null };
  writeFileSync(schedule.accounts as string, JSON.stringify({ version: 2, protected: "keychain" }));
  writeFileSync(schedulePath(dir, "daily"), JSON.stringify(schedule));
  return { home: dir, schedule };
}

describe("a stalled first vault load (finding 2)", () => {
  it("fails the run with `couldn't start:`, kills the load through its signal, and holds no lock", async () => {
    vi.useFakeTimers();
    const w = home();
    let seen: AbortSignal | undefined;
    let connected = 0;
    const deps: RunDeps = {
      configDir: w.home,
      now: () => new Date(Date.UTC(2026, 10, 14, 6, 0, 0)),
      clock: () => Date.now(),
      sleep: async () => undefined,
      connect: async () => {
        connected += 1;
        throw new Error("must not be reached");
      },
      audit: new AuditLog(join(w.home, "audit")),
      redactFor: (_schedule, signal) => {
        seen = signal;
        return new Promise<never>(() => undefined);
      },
      pid: 4242,
      alive: () => false,
    };
    let out: { text: string; code: number } | undefined;
    void runSchedule("daily", {}, deps).then((o) => void (out = o));
    await vi.advanceTimersByTimeAsync(VAULT_LOAD_TIMEOUT_MS + 1000);
    expect(out).toBeDefined();
    expect(out?.code).toBe(2);
    expect(out?.text).toMatch(/couldn't start: .*vault.*didn't answer within 30 s/);
    expect(seen?.aborted).toBe(true);
    expect(connected).toBe(0);
    expect(existsSync(join(schedulesDir(w.home), "daily.lock"))).toBe(false);
  });

  it("a stalled keychain read through loadAccounts is handed the signal", async () => {
    const w = home();
    const controller = new AbortController();
    let given: AbortSignal | undefined;
    const keychain: Keychain = {
      read(_account, signal) {
        given = signal;
        return new Promise<never>(() => undefined);
      },
      async write() {},
    };
    const vaultDeps: VaultDeps = { platform: "darwin", dpapi: { protect: async (d) => d, unprotect: async (d) => d }, keychain };
    void loadAccounts(w.schedule.accounts as string, undefined, vaultDeps, controller.signal).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(given).toBe(controller.signal);
  });

  it("the real subprocess runner kills a stalled program when its signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = spawnRunner(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], "", controller.signal);
    setTimeout(() => controller.abort(), 200);
    const result = await run;
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    // already aborted: nothing is started at all
    const again = await spawnRunner(process.execPath, ["-e", "process.exit(0)"], "", controller.signal);
    expect(again.stderr).toBe("aborted");
  });
});
