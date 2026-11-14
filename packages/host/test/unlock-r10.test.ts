import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/auditlog.js";
import { takePidLock, unlockPidLock, type PidLockDeps } from "../src/pidlock.js";
import { grantsUnlock, scheduleLockPath, scheduleUnlock } from "../src/unlockcmd.js";

// PR 12 Codex cycle 4, finding 1: an unlock never removes a lock that a new live holder took while it was looking.

const A_DEAD = 999_001;
const B_LIVE = 4243;
const UNLOCKER = 4244;
const alive = (pid: number): boolean => pid === B_LIVE || pid === UNLOCKER;
const startOf = (pid: number): string | null => (pid === A_DEAD ? null : "T");
const holder = (pid: number, owner: string): string => `${JSON.stringify({ owner, pid, started: "T" })}\n`;

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tapline-unlock10-"));
  mkdirSync(join(dir, "schedules"), { recursive: true });
  lock = scheduleLockPath(dir, "daily");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bDeps = (): PidLockDeps => ({ pid: B_LIVE, alive, startOf });
const leftovers = (): string[] => readdirSync(join(dir, "schedules")).filter((f) => /\.(tomb|pub)$/.test(f));

describe("unlock under .takeover (finding 1)", () => {
  it("a new holder that tries to take the lock while the unlock looks at the dead owner is kept out, and is never deleted", () => {
    writeFileSync(lock, holder(A_DEAD, "a"));
    let bToken: string | null | undefined;
    let looked = false;
    const deps: PidLockDeps = {
      pid: UNLOCKER,
      startOf,
      // the unlock asks whether A runs: B takes the lock over at exactly that moment
      alive: (pid) => {
        if (pid === A_DEAD && !looked) {
          looked = true;
          bToken = takePidLock(bDeps(), lock);
        }
        return alive(pid);
      },
    };
    const result = unlockPidLock(deps, lock);
    expect(looked).toBe(true);
    // either B was kept out (the unlock holds .takeover), or B got in and the unlock did not touch it
    if (bToken !== null && bToken !== undefined) {
      expect(readFileSync(lock, "utf8")).toContain(bToken);
      expect(result.status).not.toBe("removed");
    } else {
      expect(bToken).toBeNull();
      expect(result.status).toBe("removed");
      expect(existsSync(lock)).toBe(false);
    }
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("a lock that changes hands between the judging and the removal is refused and left as it is (the unlock's own compare)", () => {
    writeFileSync(lock, holder(A_DEAD, "a"));
    const deps: PidLockDeps = {
      pid: UNLOCKER,
      alive,
      startOf,
      beforeRemove: (path) => {
        if (path === lock) writeFileSync(lock, holder(B_LIVE, "b-token"));
      },
    };
    const result = unlockPidLock(deps, lock);
    expect(result.status).toBe("live");
    expect(result.pid).toBe(B_LIVE);
    expect(readFileSync(lock, "utf8")).toBe(holder(B_LIVE, "b-token"));
    expect(existsSync(`${lock}.takeover`)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("an empty lock that a writer fills in before the removal is put back, whole", () => {
    writeFileSync(lock, "");
    const deps: PidLockDeps = {
      pid: UNLOCKER,
      alive,
      startOf,
      beforeRemove: () => writeFileSync(lock, holder(B_LIVE, "b-token")),
    };
    const result = unlockPidLock(deps, lock);
    expect(result.status).toBe("live");
    expect(readFileSync(lock, "utf8")).toBe(holder(B_LIVE, "b-token"));
    expect(leftovers()).toEqual([]);
  });

  it("a live holder in the lock refuses, and the unlock's .takeover is gone again", () => {
    writeFileSync(lock, holder(B_LIVE, "b"));
    const result = unlockPidLock({ pid: UNLOCKER, alive, startOf }, lock);
    expect(result.status).toBe("live");
    expect(existsSync(`${lock}.takeover`)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(holder(B_LIVE, "b"));
  });

  it("while an unlock (a live .takeover) is going, no run creates the lock", () => {
    writeFileSync(`${lock}.takeover`, holder(UNLOCKER, "u"));
    expect(takePidLock(bDeps(), lock)).toBeNull();
    expect(existsSync(lock)).toBe(false);
  });

  it("a stuck .takeover is cleared and the stuck lock goes with it", () => {
    writeFileSync(lock, "");
    writeFileSync(`${lock}.takeover`, holder(A_DEAD, "t"));
    const result = unlockPidLock({ pid: UNLOCKER, alive, startOf }, lock);
    expect(result.status).toBe("removed");
    expect(result.removed.map((r) => r.path).sort()).toEqual([lock, `${lock}.takeover`].sort());
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it("both commands go through it: a policy edit lock taken over by a live holder meanwhile is not removed", () => {
    const policy = join(dir, "policy.json");
    const editLock = `${policy}.edit.lock`;
    writeFileSync(editLock, holder(A_DEAD, "a"));
    let bToken: string | null | undefined;
    let looked = false;
    const audit = new AuditLog(join(dir, "audit"));
    const out = grantsUnlock(policy, {
      audit,
      deps: {
        pid: UNLOCKER,
        startOf,
        alive: (pid) => {
          if (pid === A_DEAD && !looked) {
            looked = true;
            bToken = takePidLock(bDeps(), editLock);
          }
          return alive(pid);
        },
      },
    });
    expect(looked).toBe(true);
    if (bToken !== null && bToken !== undefined) expect(readFileSync(editLock, "utf8")).toContain(bToken);
    else expect(out.code).toBe(0);
    expect(scheduleUnlock("daily", { configDir: dir, audit, deps: { pid: UNLOCKER, alive, startOf } }).code).toBe(0);
  });
});
