import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog, readAuditLines } from "../src/auditlog.js";
import { formatDoctor, runDoctor, type DoctorDeps } from "../src/doctor.js";
import { grantKey, parseGrants, policyEditLockPath, usesFolder } from "../src/grants.js";
import type { PidLockDeps } from "../src/pidlock.js";
import { grantsUnlock, quote, scheduleLockPath, scheduleUnlock } from "../src/unlockcmd.js";

const LIVE = 4242;
const DEAD = 999_999;
const deps: PidLockDeps = { pid: 1, alive: (pid) => pid === LIVE, startOf: (pid) => (pid === LIVE ? "T1" : null) };
const holder = (pid: number, started: string | null = "T1"): string => `${JSON.stringify({ owner: "tok", pid, started })}\n`;

let dir: string;
let audit: AuditLog;
const auditLines = () => readAuditLines(join(dir, "audit")).map((l) => l.entry);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tapline-unlock-"));
  mkdirSync(join(dir, "schedules"), { recursive: true });
  audit = new AuditLog(join(dir, "audit"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tapline schedule unlock", () => {
  const lock = () => scheduleLockPath(dir, "daily");
  const run = () => scheduleUnlock("daily", { configDir: dir, audit, deps });

  it("removes an empty lock", () => {
    writeFileSync(lock(), "");
    const out = run();
    expect(out.code).toBe(0);
    expect(out.text).toContain(`Removed ${lock()} (empty).`);
    expect(existsSync(lock())).toBe(false);
  });

  it("removes an unreadable (garbage) lock and its .takeover", () => {
    writeFileSync(lock(), '{"owner":"to');
    writeFileSync(`${lock()}.takeover`, "");
    const out = run();
    expect(out.code).toBe(0);
    expect(out.text).toContain("(unreadable)");
    expect(out.text).toContain(`${lock()}.takeover`);
    expect(existsSync(lock())).toBe(false);
    expect(existsSync(`${lock()}.takeover`)).toBe(false);
  });

  it("removes a lock held by a dead pid, and one whose pid now has another start time", () => {
    writeFileSync(lock(), holder(DEAD));
    expect(run().text).toContain(`held by a process that is gone (pid ${DEAD})`);
    expect(existsSync(lock())).toBe(false);
    writeFileSync(lock(), holder(LIVE, "OLD"));
    expect(run().code).toBe(0);
    expect(existsSync(lock())).toBe(false);
  });

  it("refuses a live holder, names its pid and removes nothing", () => {
    writeFileSync(lock(), holder(LIVE));
    const out = run();
    expect(out.code).toBe(1);
    expect(out.text).toContain(`pid ${LIVE}`);
    expect(existsSync(lock())).toBe(true);
    expect(auditLines()).toEqual([]);
  });

  it("refuses when only the .takeover has a live holder, and leaves a stuck lock alone", () => {
    writeFileSync(lock(), "");
    writeFileSync(`${lock()}.takeover`, holder(LIVE));
    expect(run().code).toBe(1);
    expect(existsSync(lock())).toBe(true);
  });

  it("says so when there is no lock, and writes no audit line", () => {
    const out = run();
    expect(out.code).toBe(0);
    expect(out.text).toContain("no lock");
    expect(auditLines()).toEqual([]);
  });

  it("writes a schedule audit line naming the schedule and why", () => {
    writeFileSync(lock(), "");
    run();
    expect(auditLines()).toEqual([expect.objectContaining({ kind: "schedule", name: "daily", detail: "unlocked (empty)", tool: "tapline" })]);
  });

  it("needs a valid name", () => {
    expect(scheduleUnlock(undefined, { configDir: dir, audit, deps }).code).toBe(2);
    expect(scheduleUnlock("../x", { configDir: dir, audit, deps }).code).toBe(2);
  });
});

describe("tapline grants unlock", () => {
  const policy = () => join(dir, "policy.json");
  const lock = () => policyEditLockPath(policy());
  const run = () => grantsUnlock(policy(), { audit, deps });

  it("removes an empty, an unreadable and a dead-held edit lock", () => {
    for (const [text, why] of [
      ["", "empty"],
      ["not json", "unreadable"],
      [holder(DEAD), "gone"],
    ] as const) {
      writeFileSync(lock(), text);
      const out = run();
      expect(out.code).toBe(0);
      expect(out.text).toContain(why);
      expect(existsSync(lock())).toBe(false);
    }
  });

  it("refuses a live holder with its pid", () => {
    writeFileSync(lock(), holder(LIVE));
    const out = run();
    expect(out.code).toBe(1);
    expect(out.text).toContain(`pid ${LIVE}`);
    expect(readFileSync(lock(), "utf8")).toBe(holder(LIVE));
  });

  it("needs --policy", () => {
    expect(grantsUnlock(undefined, { audit, deps }).code).toBe(2);
  });

  it("writes an approval audit line", () => {
    writeFileSync(lock(), "");
    run();
    expect(auditLines()).toEqual([expect.objectContaining({ kind: "approval", name: "policy edit lock", detail: "unlocked (empty)" })]);
  });
});

describe("tapline doctor and stuck locks", () => {
  const base = (over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> => ({
    run: async () => ({ code: -1, stdout: "", stderr: "" }),
    platform: "linux",
    nodeVersion: "20.11.0",
    env: { TAPLINE_HOME: dir },
    fileExists: () => true,
    portFree: async () => true,
    lanIps: () => ["192.168.1.20"],
    hostDir: null,
    gitStatus: async () => null,
    lockDeps: deps,
    ...over,
  });
  const locks = async (over: Partial<DoctorDeps> = {}) => (await runDoctor(base(over))).find((r) => r.name === "Locks");

  it("says nothing when no lock is stuck (a live lock is fine)", async () => {
    writeFileSync(scheduleLockPath(dir, "live"), holder(LIVE));
    expect(await locks()).toBeUndefined();
  });

  it("names every stuck schedule lock with its full path and the command", async () => {
    writeFileSync(scheduleLockPath(dir, "a"), "");
    writeFileSync(scheduleLockPath(dir, "b"), "junk");
    writeFileSync(scheduleLockPath(dir, "c"), holder(DEAD));
    writeFileSync(`${scheduleLockPath(dir, "d")}.takeover`, "");
    writeFileSync(scheduleLockPath(dir, "ok"), holder(LIVE));
    const result = await locks();
    expect(result?.status).toBe("warn");
    for (const name of ["a", "b", "c", "d"]) {
      expect(result?.detail).toContain(scheduleLockPath(dir, name));
      expect(result?.fix).toContain(`tapline schedule unlock ${name}`);
    }
    expect(result?.detail).toContain("empty");
    expect(result?.detail).toContain("unreadable");
    expect(result?.detail).toContain(`pid ${DEAD}`);
    expect(result?.detail).not.toContain(scheduleLockPath(dir, "ok"));
    expect(formatDoctor(result === undefined ? [] : [result])).toContain("tapline schedule unlock a");
  });

  it("checks the policy edit lock only when --policy is given", async () => {
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({ version: 2, grants: [] }));
    writeFileSync(policyEditLockPath(policy), "");
    expect(await locks()).toBeUndefined();
    const result = await locks({ policyFile: policy });
    expect(result?.detail).toContain(policyEditLockPath(policy));
    expect(result?.fix).toBe(`tapline grants unlock --policy ${quote(policy)}`); // quoted when the path has e.g. ~ (CI: RUNNER~1)
  });
});

describe("grant-name aliases (ASCII case only)", () => {
  const base = { app: "x", words: ["Remove"], until: "2026-11-20" };

  it("alias refusal is unchanged for valid names", () => {
    const { grants, refused } = parseGrants([{ name: "Post", ...base }, { name: "post", ...base }, { name: "POST", ...base }], "2026-11-14", () => []);
    expect(grants.map((g) => g.name)).toEqual(["Post"]);
    expect(refused.map((r) => r.name)).toEqual(["post", "POST"]);
    expect(refused[0]?.reason).toMatch(/only in case/);
  });

  it("the uses folder is the ASCII-lower-cased name", () => {
    expect(usesFolder("Mixed_Case-1.x")).toBe("mixed_case-1.x");
    expect(grantKey("A_b")).toBe("a_b");
  });
});

describe("the command line a person pastes", () => {
  it("quotes a path with ~ or a space, and leaves a plain one alone", () => {
    expect(quote("C:\Users\RUNNER~1\Temp\policy.json")).toBe('"C:\Users\RUNNER~1\Temp\policy.json"');
    expect(quote("C:\My Files\policy.json")).toBe('"C:\My Files\policy.json"');
    expect(quote("/tmp/policy.json")).toBe("/tmp/policy.json");
  });
});
