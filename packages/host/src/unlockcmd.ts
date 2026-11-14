import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditSink } from "./auditlog.js";
import { policyEditLockPath } from "./grants.js";
import { inspectPidLock, stuckWords, unlockPidLock, type PidLockDeps, type UnlockResult } from "./pidlock.js";
import { SCHEDULE_NAME, schedulesDir } from "./schedule.js";

/**
 * AGENT-TOOLS 1.14.2 §22.3 and §19.5: the way out of a stuck lock. The pid-liveness lock never takes over an empty or unreadable
 * lock (that can only be a holder that crashed mid-write where hard links aren't available), so a person looks and removes it:
 * `tapline schedule unlock NAME` and `tapline grants unlock --policy FILE`. Both remove a lock (and its `.takeover`) only when no
 * holder is proven alive, and write an audit line (§23).
 */

type Outcome = { text: string; code: number };

/** A schedule's run lock: `<config>/schedules/<name>.lock`. */
export function scheduleLockPath(configDir: string, name: string): string {
  return join(schedulesDir(configDir), `${name}.lock`);
}

function describe(what: string, result: UnlockResult): Outcome {
  if (result.status === "none") return { text: `${what} has no lock; nothing to remove.`, code: 0 };
  if (result.status === "live") {
    return {
      text: `${what}'s lock is held by a live process (pid ${result.pid}); nothing was removed. Wait for it to finish, or stop that process first.`,
      code: 1,
    };
  }
  if (result.status === "failed") {
    const done = result.removed.map((r) => `Removed ${r.path} (${r.why}).`);
    return { text: [...done, `Couldn't remove ${result.path ?? "the lock"}: it changed or can't be deleted. Look at it and try again.`].join("\n"), code: 1 };
  }
  return { text: result.removed.map((r) => `Removed ${r.path} (${r.why}).`).join("\n"), code: 0 };
}

/** `tapline schedule unlock NAME`. Audit: a `schedule` line (§23). */
export function scheduleUnlock(name: string | undefined, options: { configDir: string; audit: AuditSink; deps: PidLockDeps }): Outcome {
  if (name === undefined) return { text: "Usage: tapline schedule unlock NAME", code: 2 };
  if (!SCHEDULE_NAME.test(name)) return { text: `"${name}" isn't a schedule's name.`, code: 2 };
  const result = unlockPidLock(options.deps, scheduleLockPath(options.configDir, name));
  if (result.status === "removed" || result.status === "failed") {
    if (result.removed.length > 0) options.audit.write({ kind: "schedule", name, detail: `unlocked (${result.removed.map((r) => r.why).join("; ")})` });
  }
  return describe(`Schedule "${name}"`, result);
}

/**
 * `tapline grants unlock --policy FILE`. Audit: an `approval` line. It is a person's own decision about the policy file, not a
 * grant's use and not a revocation of any grant (§23's `revoke` is a grant revoked), so `approval` fits best.
 */
export function grantsUnlock(policy: string | undefined, options: { audit: AuditSink; deps: PidLockDeps }): Outcome {
  if (policy === undefined) return { text: "grants unlock needs the policy file: tapline grants unlock --policy FILE", code: 2 };
  const result = unlockPidLock(options.deps, policyEditLockPath(policy));
  if (result.removed.length > 0) options.audit.write({ kind: "approval", name: "policy edit lock", detail: `unlocked (${result.removed.map((r) => r.why).join("; ")})` });
  return describe("The policy file", result);
}

export interface StuckLock {
  /** The lock file (or `.takeover`) that is stuck. */
  path: string;
  /** Why: empty, unreadable, or held by a dead process. */
  why: string;
  /** The command that removes it. */
  command: string;
}

export const quote = (text: string): string => (/^[\w./\\:@=+-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`);

/** Every stuck lock doctor can see: the schedule run locks always, the policy edit lock when a policy file is given. */
export function findStuckLocks(options: { configDir: string; policyFile?: string; deps: PidLockDeps }): StuckLock[] {
  const found: StuckLock[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(schedulesDir(options.configDir)).sort();
  } catch {
    // no schedules folder: no run locks
  }
  for (const file of files) {
    const match = /^(.+)\.lock(\.takeover)?$/.exec(file);
    const name = match?.[1];
    if (name === undefined || !SCHEDULE_NAME.test(name)) continue;
    const path = join(schedulesDir(options.configDir), file);
    const state = inspectPidLock(options.deps, path);
    if (state.state === "stuck") found.push({ path, why: stuckWords(state), command: `tapline schedule unlock ${name}` });
  }
  if (options.policyFile !== undefined) {
    for (const path of [policyEditLockPath(options.policyFile), `${policyEditLockPath(options.policyFile)}.takeover`]) {
      const state = inspectPidLock(options.deps, path);
      if (state.state === "stuck") found.push({ path, why: stuckWords(state), command: `tapline grants unlock --policy ${quote(options.policyFile)}` });
    }
  }
  return found;
}
