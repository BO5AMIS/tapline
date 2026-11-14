import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuditLines, type AuditLog } from "./auditlog.js";
import { newFilesSince, readScheduleFile, readSeen, resolveWith, schedulePath, schedulesDir, writeSeen, type Schedule } from "./schedule.js";

/**
 * AGENT-TOOLS 1.14 §22.2 and §22.3: `tapline run-schedule NAME`. One run of a saved route with no model: a replay with the grants,
 * the vault and drafts-only in force, which stops at the first failed `expect` or `off_route`, writes the run report and a
 * `schedule` line in the audit log. The host, the clock and the sleeping are injected so a test runs every case without a phone.
 */

/** How long a run waits for a busy phone (§22.3). */
export const BUSY_WAIT_MS = 10 * 60 * 1000;
/** How often the wait looks again. */
export const BUSY_POLL_MS = 5000;
/** How long a run waits for the app to connect when it starts its own host. */
export const APP_WAIT_MS = 60_000;

export interface CallAnswer {
  text: string;
  isError: boolean;
}

/** What a run needs from a host the app is connected to. */
export interface ScheduleHost {
  /** Says what ran the route: `a running host`, or `its own host`. */
  via: string;
  /** True when the app is connected, waiting up to `waitMs` for it. */
  appOpen(waitMs: number): Promise<boolean>;
  /** Why the app being closed is not the whole story (a running host that differs from the schedule was passed over). */
  closedNote?: string;
  /** True while an agent or a person is driving the phone (this host knows only its own queue). */
  inUse(): boolean | Promise<boolean>;
  call(tool: string, args: Record<string, unknown>): Promise<CallAnswer>;
  close(): Promise<void>;
}

export interface RunDeps {
  configDir: string;
  /** Wall clock: names the report and times the audit lines. */
  now: () => Date;
  /** Monotonic milliseconds for the waits. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  /** A host with the app connected: a running one, else one of its own that takes the schedule's policy, accounts and maps. */
  connect: (schedule: Schedule, name: string) => Promise<ScheduleHost>;
  audit: AuditLog;
  /** Scrubs vault values from the report (§20.3): the scrubber for this schedule's accounts file. */
  redactFor: (schedule: Schedule) => Promise<(text: string) => string>;
  pid: number;
  alive: (pid: number) => boolean;
  /** When a process started, as text that is the same each time for one process (null: unknown). A lock keeps it so a reused process id is not taken for the holder. */
  startOf?: (pid: number) => string | null;
  appWaitMs?: number;
  busyWaitMs?: number;
  /** For tests: runs after a run found a leftover lock and before it takes the lock over (another run may get in between). */
  beforeReclaim?: () => void;
}

export interface RunOptions {
  /** `--check-trigger`: the file trigger's poll; runs only when a new file has appeared in the folder. */
  checkTrigger?: boolean;
}

export type RunStatus = "done" | "failed" | "stopped" | "skipped";

export interface RunReport {
  schedule: string;
  tool: "tapline";
  route: string;
  /** The variables the run filled, never their values. */
  with: string[];
  status: RunStatus;
  message: string;
  started: string;
  finished: string;
  seconds: number;
  via: string | null;
  report: string;
  "Grants used": string;
  "Vault names used": string;
  grants_used: Array<{ name: string; count: number }>;
  vault_names_used: string[];
  pictures: string[];
}

type Outcome = { text: string; code: number };

const SKIP_USE = "skipped: the phone was in use";
const SKIP_PREVIOUS = "skipped: the previous run is still going";
const SKIP_CLOSED = "skipped: the app is not open";
const STOP_DRAFT = "stopped: a draft is waiting for a person.";

/** `YYYYMMDDTHHMMSSZ`, UTC. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

export function isBusyAnswer(answer: CallAnswer): boolean {
  return answer.isError && /^Error (busy|paused):/.test(answer.text) && !/Ran [1-9]\d* of/.test(answer.text);
}

/** The step a failed batch stopped at and a short word for why (§23's `failed at step 3 (expect)`). */
export function failureOf(text: string): { step: number | null; why: string } {
  const code = /^Error (\w+):/.exec(text)?.[1] ?? "error";
  const step = /stopped at step (\d+)/.exec(text)?.[1];
  const why = code === "expect_failed" ? "expect" : code;
  return { step: step === undefined ? null : Number(step), why };
}

function lockPath(configDir: string, name: string): string {
  return join(schedulesDir(configDir), `${name}.lock`);
}

/** What a lock file holds: the run's owner token, its process id and the process's start time (null when it can't be told). */
interface LockHolder {
  owner?: unknown;
  pid?: unknown;
  started?: unknown;
}

function parseHolder(text: string): LockHolder {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as LockHolder) : {};
  } catch {
    return {};
  }
}

/** What runs a program and answers its output; throws when it fails. Injectable, so the start time of a process can be tested. */
export type RunProgram = (file: string, args: string[]) => string;

const runProgram: RunProgram = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

/**
 * When a process started, as text that is the same each time it is asked for the same process; null when it can't be told. A lock
 * keeps it beside the process id, so a process id that was reused by another program is not mistaken for the holder. Windows asks
 * PowerShell (`Get-Process -Id N`, about half a second, asked only for a run's own start and when a lock is found), elsewhere `ps`.
 */
export function processStartTime(pid: number, platform: string = process.platform, run: RunProgram = runProgram): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out =
      platform === "win32"
        ? run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`])
        : run("ps", ["-o", "lstart=", "-p", String(pid)]);
    const text = out.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/** A lock that can't be read as a holder (empty, cut short, garbage) is a run that is still writing it until it is this old; then a leftover. */
const UNREADABLE_LOCK_MS = 10_000;

/** Whether the run a lock names is gone: its process doesn't run, or the process that has that id started at another time. */
function holderIsDead(deps: RunDeps, holder: LockHolder): boolean {
  if (typeof holder.pid !== "number" || !Number.isInteger(holder.pid)) return false;
  if (!deps.alive(holder.pid)) return true;
  if (typeof holder.started === "string" && deps.startOf !== undefined) {
    const now = deps.startOf(holder.pid);
    return now !== null && now !== holder.started;
  }
  return false;
}

/** Whether a lock's text is a leftover: its holder is gone, or it is not a holder at all and old enough that no run is still writing it. */
function isLeftover(deps: RunDeps, path: string, text: string): boolean {
  const holder = parseHolder(text);
  if (typeof holder.pid === "number" && typeof holder.owner === "string") return holderIsDead(deps, holder);
  try {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_LOCK_MS;
  } catch {
    return false; // gone meanwhile: the next round creates it
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A unique name for a file moved aside: only the one who moved it ever touches it. */
function tombstone(path: string): string {
  return `${path}.${randomBytes(6).toString("hex")}.tomb`;
}

/**
 * Removes the file at `path` only when it still holds `seen`: it is moved to a name of its own (one move, so only one remover gets
 * it), and what was moved is checked; a file that changed hands in between is put back, never deleted.
 */
function removeIfUnchanged(path: string, seen: string): boolean {
  const tomb = tombstone(path);
  try {
    renameSync(path, tomb);
  } catch {
    return false;
  }
  try {
    const moved = readFileSync(tomb, "utf8");
    if (moved === seen) return true;
    writeFileSync(path, moved, { flag: "wx" });
  } catch {
    // put back by someone else already, or unreadable: the next round decides
  } finally {
    rmSync(tomb, { force: true });
  }
  return false;
}

/**
 * One run of a schedule at a time. The lock only answers "is a run of this schedule still going": it counts nothing, and a live
 * holder is never displaced, however long it takes. It is a file created exclusively (`wx`) that holds the run's owner token, its
 * process id and the process's start time. It is a leftover only when its process no longer runs, or a process with that id started at
 * another time. A leftover is taken over under `<lock>.takeover`, also created exclusively: under it the lock is read again, and
 * only if it is unchanged and its holder is dead is it deleted and a lock of the taker's own created (`wx`); then `.takeover` goes.
 * A `.takeover` whose own process is dead is cleared the same way. Returns the owner token, or null when a run holds the lock.
 */
export function takeLock(deps: RunDeps, name: string): string | null {
  const path = lockPath(deps.configDir, name);
  const takeoverPath = `${path}.takeover`;
  mkdirSync(schedulesDir(deps.configDir), { recursive: true });
  const token = `${randomBytes(8).toString("hex")}-${deps.pid}`;
  const mine = `${JSON.stringify({ owner: token, pid: deps.pid, started: deps.startOf?.(deps.pid) ?? null })}\n`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      writeFileSync(path, mine, { flag: "wx" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    const seen = readText(path);
    if (seen === null) continue; // released between our create and our read: try to create again
    if (!isLeftover(deps, path, seen)) return null;
    deps.beforeReclaim?.();
    // Under .takeover only one contender at a time looks at a leftover.
    try {
      writeFileSync(takeoverPath, mine, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      const other = readText(takeoverPath);
      // Someone else is taking it over now (or was, and died): a dead taker's .takeover is cleared, a live one's is waited out.
      if (other !== null && isLeftover(deps, takeoverPath, other)) removeIfUnchanged(takeoverPath, other);
      continue;
    }
    try {
      const now = readText(path);
      if (now === seen && isLeftover(deps, path, now)) {
        try {
          unlinkSync(path);
        } catch {
          continue;
        }
        try {
          writeFileSync(path, mine, { flag: "wx" });
          return token;
        } catch {
          continue; // a run that came in first holds it now
        }
      }
    } finally {
      // only our own .takeover is removed
      const held = readText(takeoverPath);
      if (held === mine) removeIfUnchanged(takeoverPath, mine);
    }
  }
  return null;
}

/** Releases the lock only while its content is still this run's; another run's lock is never removed. */
export function dropLock(deps: RunDeps, name: string, token: string): void {
  const path = lockPath(deps.configDir, name);
  const text = readText(path);
  if (text === null || parseHolder(text).owner !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function writeReport(deps: RunDeps, redact: (text: string) => string, name: string, startedAt: Date, report: RunReport): string | null {
  const dir = join(deps.configDir, "runs");
  try {
    mkdirSync(dir, { recursive: true });
    const redacted = JSON.parse(redact(JSON.stringify(report, null, 2))) as RunReport;
    for (let n = 0; n < 100; n++) {
      const path = join(dir, `${name}-${utcStamp(startedAt)}${n === 0 ? "" : `-${n + 1}`}.json`);
      try {
        writeFileSync(path, `${JSON.stringify(redacted, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      }
    }
  } catch {
    // a report that can't be written never changes what the run did; the audit line stays
  }
  return null;
}

/** The pictures a replay's failure left (a red diff, a `.jpg` path in its answer). */
function picturesIn(text: string): string[] {
  return [...new Set(text.match(/[^\s"'()]+\.(?:jpg|png|gif)/g) ?? [])];
}

const countsLine = (counts: Array<{ name: string; count: number }>): string =>
  counts.length === 0 ? "none" : counts.map((c) => `${c.name} (${c.count})`).join(", ");

export async function runSchedule(name: string | undefined, options: RunOptions, deps: RunDeps): Promise<Outcome> {
  if (name === undefined) return { text: "Usage: tapline run-schedule NAME", code: 2 };
  const path = schedulePath(deps.configDir, name);
  const read = readScheduleFile(path);
  if (!read.ok) return { text: `Can't run "${name}": ${read.message}`, code: 2 };
  const schedule = read.schedule;

  // The file trigger's poll: nothing new, nothing to say (no run, no skip, no audit line).
  let newest: number | null = null;
  if (options.checkTrigger === true) {
    if (schedule.trigger === null) return { text: `"${name}" starts on a time, not on a file; --check-trigger is for file triggers.`, code: 2 };
    const since = readSeen(deps.configDir, name) ?? deps.now().getTime();
    const found = newFilesSince(schedule.trigger.file, since);
    if (found.files.length === 0) return { text: "", code: 0 };
    newest = found.newest;
  }

  const startedAt = deps.now();
  const redact = await deps.redactFor(schedule);
  const base = { schedule: name, tool: "tapline" as const, route: schedule.route, with: Object.keys(schedule.with) };
  const finishWith = (
    status: RunStatus,
    message: string,
    detail: string,
    code: number,
    extra: { report?: string; via?: string | null; sinceMs?: number; seconds?: number } = {},
  ): Outcome => {
    const finished = deps.now();
    const used = new Map<string, number>();
    const vault = new Set<string>();
    if (extra.sinceMs !== undefined) {
      for (const { entry } of readAuditLines(deps.audit.folder, extra.sinceMs)) {
        if (entry?.name === undefined) continue;
        if (entry.kind === "grant") used.set(entry.name, (used.get(entry.name) ?? 0) + 1);
        else if (entry.kind === "vault") vault.add(entry.name);
      }
    }
    const grants = [...used].map(([n, count]) => ({ name: n, count }));
    const vaultNames = [...vault];
    const grantsLine = `Grants used: ${countsLine(grants)}`;
    const vaultLine = `Vault names used: ${vaultNames.length === 0 ? "none" : vaultNames.join(", ")}`;
    const seconds = extra.seconds ?? (finished.getTime() - startedAt.getTime()) / 1000;
    const answer = extra.report ?? "";
    const report: RunReport = {
      ...base,
      status,
      message,
      started: startedAt.toISOString(),
      finished: finished.toISOString(),
      seconds: Math.round(seconds * 10) / 10,
      via: extra.via ?? null,
      report: [answer, grantsLine, vaultLine].filter((line) => line !== "").join("\n"),
      "Grants used": countsLine(grants),
      "Vault names used": vaultNames.length === 0 ? "none" : vaultNames.join(", "),
      grants_used: grants,
      vault_names_used: vaultNames,
      pictures: picturesIn(answer),
    };
    const written = writeReport(deps, redact, name, startedAt, report);
    deps.audit.write({ kind: "schedule", name, detail });
    const head = status === "done" ? `Ran "${name}" in ${report.seconds} s: done.` : `Schedule "${name}" ${message}`;
    const text = [head, ...(answer !== "" ? [redact(answer)] : []), grantsLine, vaultLine, ...(written !== null ? [`Report: ${written}`] : [])].join("\n");
    return { text, code };
  };
  const skip = (line: string, via?: string | null): Outcome => finishWith("skipped", line, line, 2, { via: via ?? null });

  const values = resolveWith(schedule.with, schedulesDir(deps.configDir));
  if (!values.ok) return finishWith("failed", `couldn't start: ${values.message}`, `failed at step 0 (start)`, 2);

  const lockToken = takeLock(deps, name);
  if (lockToken === null) return skip(SKIP_PREVIOUS);
  let host: ScheduleHost | undefined;
  try {
    try {
      host = await deps.connect(schedule, name);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return finishWith("failed", `couldn't start: ${why}`, `failed at step 0 (start)`, 2);
    }
    if (!(await host.appOpen(deps.appWaitMs ?? APP_WAIT_MS))) return skip(host.closedNote === undefined ? SKIP_CLOSED : `${SKIP_CLOSED} (${host.closedNote})`, host.via);

    // The phone is busy while a person or an agent drives it: wait up to 10 minutes, then do nothing (§22.3).
    const busyMs = deps.busyWaitMs ?? BUSY_WAIT_MS;
    const deadline = deps.clock() + busyMs;
    const tool = Object.keys(values.values).length > 0 ? "drive" : "replay";
    const args: Record<string, unknown> = tool === "drive" ? { route: schedule.route, with: values.values } : { name: schedule.route };
    let answer: CallAnswer;
    let sinceMs = 0;
    let t0 = 0;
    let started = false;
    for (;;) {
      if (!(await host.inUse())) {
        if (!started) {
          started = true;
          sinceMs = deps.now().getTime();
          t0 = deps.clock();
          deps.audit.write({ kind: "schedule", name, detail: "started" });
        }
        try {
          answer = await host.call(tool, args);
        } catch (error) {
          answer = { text: `Error internal: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
        if (!isBusyAnswer(answer)) {
          // The file's time is saved only once the route has begun (or its outcome is unknown, which counts as begun): a skip (the app is
          // closed, the phone is busy or paused through the whole wait) or a failure to connect leaves the file for the next check.
          if (newest !== null) writeSeen(deps.configDir, name, newest);
          break;
        }
      }
      const left = deadline - deps.clock();
      if (left <= 0) return skip(SKIP_USE, host.via);
      await deps.sleep(Math.min(BUSY_POLL_MS, left));
    }
    const seconds = (deps.clock() - t0) / 1000;
    const extra = { report: answer.text, via: host.via, sinceMs, seconds };
    if (!answer.isError) return finishWith("done", "done", "done", 0, extra);
    if (/a draft is waiting for a person|the draft wasn't sent/.test(answer.text)) return finishWith("stopped", STOP_DRAFT, STOP_DRAFT, 1, extra);
    const failure = failureOf(answer.text);
    const detail = failure.step === null ? `failed (${failure.why})` : `failed at step ${failure.step} (${failure.why})`;
    // A route that could not start (no such route, a variable with no value) is "couldn't start", as in replay.
    const couldntStart = /^Error (not_found|bad_params|not_connected|internal):/.test(answer.text) && !/Ran \d+ of/.test(answer.text);
    return finishWith("failed", detail, detail, couldntStart ? 2 : 1, extra);
  } finally {
    dropLock(deps, name, lockToken);
    await host?.close().catch(() => undefined);
  }
}
