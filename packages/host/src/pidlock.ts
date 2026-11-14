import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

/**
 * AGENT-TOOLS 1.14.1 §22.3 and §19.5: the pid-liveness lock shared by the run lock (`<schedule>.lock`) and the policy file's edit lock
 * (`<policy file>.edit.lock`). A lock is a file that holds its holder's owner token, process id and the process's start time. It
 * is published whole and atomically: the full JSON goes to a unique temp file, which is hard-linked to the lock's name (`link` is an
 * exclusive create on NTFS, APFS and ext4: EEXIST when the lock exists), then the temp file is unlinked. A lock is therefore never
 * seen empty or half written. Where hard links aren't available the lock is created with `wx` and written in place; a lock that can't
 * be read as a holder is then a run that is still writing it.
 *
 * A lock is a leftover only on PROOF of its holder's death: its process doesn't run, or the process with that id started at another
 * time. An empty, cut-short or garbage lock is never a leftover (there is no age rule): it is waited out, which fails closed.
 * A leftover is taken over under `<lock>.takeover`, published the same way.
 */

/** What the lock needs from the process and the system. Everything is injectable so a test can pause at any point. */
export interface PidLockDeps {
  pid: number;
  alive: (pid: number) => boolean;
  /** When a process started, as text that is the same each time for one process (null: unknown). A lock keeps it so a reused process id is not taken for the holder. */
  startOf?: (pid: number) => string | null;
  /** For tests: runs after a run found a leftover lock and before it takes the lock over (another run may get in between). */
  beforeReclaim?: () => void;
  /** For tests: runs after the temp file is written and before it is linked to the lock's name. */
  beforePublish?: (path: string) => void;
  /** For tests: the hard link (default `fs.linkSync`); a throw of EPERM stands for a file system without hard links. */
  link?: (existing: string, path: string) => void;
  /** For tests: runs in the no-hard-link fallback, after the exclusive create and before the content is written. */
  afterCreate?: (path: string) => void;
  /** For tests: runs in an unlock after a file was judged stuck and before it is removed (a new holder may get in between). */
  beforeRemove?: (path: string) => void;
}

/** What a lock file holds: the owner token, the process id and the process's start time (null when it can't be told). */
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
 * PowerShell (`Get-Process -Id N`, about half a second, asked only for a lock's own holder and when a lock is found), elsewhere `ps`.
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

/** Whether a process runs (signal 0); a process we may not signal still runs. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let ownStart: string | null | undefined;
/** The deps of this process for a lock of its own (this process's start time is asked once and kept). */
export function ownLockDeps(): PidLockDeps {
  return {
    pid: process.pid,
    alive: processAlive,
    startOf: (pid) => {
      if (pid !== process.pid) return processStartTime(pid);
      if (ownStart === undefined) ownStart = processStartTime(pid);
      return ownStart;
    },
  };
}

/** Whether the holder a lock names is provably gone: its process doesn't run, or the process that has that id started at another time. */
function holderIsDead(deps: PidLockDeps, holder: LockHolder): boolean {
  if (typeof holder.pid !== "number" || !Number.isInteger(holder.pid)) return false;
  if (!deps.alive(holder.pid)) return true;
  if (typeof holder.started === "string" && deps.startOf !== undefined) {
    const now = deps.startOf(holder.pid);
    return now !== null && now !== holder.started;
  }
  return false;
}

/** A lock's text is a leftover only when it names a holder that is provably dead. Empty, cut-short or garbage text never is (no age rule). */
function isLeftover(deps: PidLockDeps, text: string): boolean {
  const holder = parseHolder(text);
  return typeof holder.pid === "number" && typeof holder.owner === "string" && holderIsDead(deps, holder);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Errors that mean this file system can't hard-link (so the fallback is used), as opposed to "the name is taken". */
const NO_LINK = new Set(["EPERM", "ENOSYS", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "EACCES"]);

/**
 * Creates `path` with `text`, whole, only if it doesn't exist: "published", or "exists" (someone's file stands there), or "error".
 * The text is written to a unique temp file first and hard-linked into place, so `path` is never seen empty.
 */
export function publishNew(deps: PidLockDeps, path: string, text: string): "published" | "exists" | "error" {
  const temp = `${path}.${randomBytes(6).toString("hex")}.pub`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  } catch {
    return "error";
  }
  try {
    deps.beforePublish?.(path);
    try {
      (deps.link ?? linkSync)(temp, path);
      return "published";
    } catch (error) {
      const code = codeOf(error);
      if (code === "EEXIST") return "exists";
      if (code === undefined || !NO_LINK.has(code)) return "error";
    }
    // No hard links here: an exclusive create, then the content. Readers treat what can't be read as a holder as a writer in progress.
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      return codeOf(error) === "EEXIST" ? "exists" : "error";
    }
    try {
      deps.afterCreate?.(path);
      writeSync(fd, text);
      return "published";
    } catch {
      return "error";
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(temp, { force: true });
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
function removeIfUnchanged(deps: PidLockDeps, path: string, seen: string): boolean {
  const tomb = tombstone(path);
  try {
    renameSync(path, tomb);
  } catch {
    return false;
  }
  try {
    const moved = readFileSync(tomb, "utf8");
    if (moved === seen) return true;
    publishNew(deps, path, moved);
  } catch {
    // put back by someone else already, or unreadable: the next round decides
  } finally {
    rmSync(tomb, { force: true });
  }
  return false;
}

/**
 * Takes the lock at `path` (its folder must exist): the owner token, or null when a live holder has it. A live holder is never
 * displaced, however long it takes. A leftover (holder provably dead) is taken over under `<path>.takeover`, published the same way:
 * under it the lock is read again, and only if it is unchanged and its holder is still dead is it deleted and replaced by the taker's.
 * A `.takeover` whose own process is dead is cleared the same way.
 */
export function takePidLock(deps: PidLockDeps, path: string): string | null {
  const takeoverPath = `${path}.takeover`;
  const token = `${randomBytes(8).toString("hex")}-${deps.pid}`;
  const mine = `${JSON.stringify({ owner: token, pid: deps.pid, started: deps.startOf?.(deps.pid) ?? null })}\n`;
  for (let attempt = 0; attempt < 6; attempt++) {
    // Acquisition honours `.takeover`: while a takeover or an unlock holds it (a live holder), nobody creates the lock.
    const gate = readText(takeoverPath);
    if (gate !== null && typeof parseHolder(gate).pid === "number" && !isLeftover(deps, gate)) return null;
    const first = publishNew(deps, path, mine);
    if (first === "published") return token;
    if (first === "error") return null;
    const seen = readText(path);
    if (seen === null) continue; // released between our create and our read: try to create again
    if (!isLeftover(deps, seen)) return null;
    deps.beforeReclaim?.();
    // Under .takeover only one contender at a time looks at a leftover.
    const claimed = publishNew(deps, takeoverPath, mine);
    if (claimed === "error") return null;
    if (claimed === "exists") {
      const other = readText(takeoverPath);
      // Someone else is taking it over now (or was, and died): a dead taker's .takeover is cleared, a live one's is waited out.
      if (other !== null && isLeftover(deps, other)) removeIfUnchanged(deps, takeoverPath, other);
      continue;
    }
    try {
      const now = readText(path);
      if (now === seen && isLeftover(deps, now)) {
        try {
          unlinkSync(path);
        } catch {
          continue;
        }
        if (publishNew(deps, path, mine) === "published") return token;
        continue; // a run that came in first holds it now
      }
    } finally {
      // only our own .takeover is removed
      const held = readText(takeoverPath);
      if (held === mine) removeIfUnchanged(deps, takeoverPath, mine);
    }
  }
  return null;
}

/** Releases the lock only while its content is still the holder's own (`token`); another's lock is never removed. */
export function dropPidLock(path: string, token: string): void {
  const text = readText(path);
  if (text === null || parseHolder(text).owner !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Whether the lock's holder is `token` right now (for a holder that wants to know it still has it). */
export function holdsPidLock(path: string, token: string): boolean {
  const text = readText(path);
  return text !== null && parseHolder(text).owner === token;
}

/**
 * What a lock file is right now. `stuck` is a lock no run will ever clear by itself and a person has to see: empty, unreadable, or
 * held by a process that is provably dead. `live` is a holder that is proven alive (never displaced).
 */
export type StuckState = { state: "stuck"; why: "empty" | "unreadable" | "dead"; pid?: number };
export type PidLockState = { state: "absent" } | { state: "live"; pid: number } | StuckState;

/** Judges the exact bytes of a lock file (a snapshot): the holder is looked at in THIS text, never in a later read of the file. */
function judgeText(deps: PidLockDeps, text: string): Exclude<PidLockState, { state: "absent" }> {
  if (text.trim() === "") return { state: "stuck", why: "empty" };
  const holder = parseHolder(text);
  if (typeof holder.pid !== "number" || !Number.isInteger(holder.pid) || typeof holder.owner !== "string") return { state: "stuck", why: "unreadable" };
  return holderIsDead(deps, holder) ? { state: "stuck", why: "dead", pid: holder.pid } : { state: "live", pid: holder.pid };
}

/** What reading a file gave: its exact text, nothing there, or something that can't be read as text. */
type Snapshot = { kind: "absent" } | { kind: "unreadable" } | { kind: "text"; text: string };

function snapshotOf(path: string): Snapshot {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (error) {
    return codeOf(error) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
}

function judgeSnapshot(deps: PidLockDeps, snap: Snapshot): PidLockState {
  if (snap.kind === "absent") return { state: "absent" };
  return snap.kind === "unreadable" ? { state: "stuck", why: "unreadable" } : judgeText(deps, snap.text);
}

/** Looks at the lock at `path` without changing it. */
export function inspectPidLock(deps: PidLockDeps, path: string): PidLockState {
  return judgeSnapshot(deps, snapshotOf(path));
}

/** The words for a stuck lock's cause. */
export function stuckWords(state: StuckState): string {
  if (state.why === "empty") return "empty";
  if (state.why === "unreadable") return "unreadable";
  return `held by a process that is gone (pid ${state.pid ?? "?"})`;
}

export interface UnlockResult {
  /** `none`: no lock file; `live`: a live holder is proven, nothing removed; `removed`: stuck files removed; `failed`: a stuck file couldn't be removed. */
  status: "none" | "live" | "removed" | "failed";
  /** The live holder's process id when `status` is `live`. */
  pid?: number;
  /** Every file removed, with why. */
  removed: Array<{ path: string; why: string }>;
  /** The file of a `live` or `failed` answer. */
  path?: string;
}

/**
 * Removes the file at `path` that was judged stuck from `snap`, only if it still is what was judged: it is moved to a name of its
 * own, and what was moved is compared with the snapshot (an unreadable snapshot is judged again on what was moved). A file that
 * turns out to be another, live holder's is linked back and never deleted. Answers `removed`, `live` (with the pid of the holder
 * put back) or `failed`.
 */
function removeJudged(deps: PidLockDeps, path: string, snap: Snapshot): "removed" | { live: number } | "failed" {
  if (snap.kind === "absent") return "removed";
  const tomb = tombstone(path);
  try {
    renameSync(path, tomb);
  } catch {
    return "failed";
  }
  const moved = snapshotOf(tomb);
  const same = snap.kind === "text" ? moved.kind === "text" && moved.text === snap.text : judgeSnapshot(deps, moved).state !== "live";
  if (same) {
    try {
      rmSync(tomb, { force: true });
      return "removed";
    } catch {
      // can't be deleted (a folder, say): it is put back where it was
    }
  }
  const state = judgeSnapshot(deps, moved);
  const live = state.state === "live" ? { live: state.pid } : "failed";
  if (moved.kind !== "text") {
    try {
      renameSync(tomb, path);
    } catch {
      // the name was taken meanwhile: what was moved stays under its tombstone for a person to look at
    }
    return live;
  }
  // Link it back (published whole); a live holder is never unlinked. If the name was taken meanwhile, the tombstone stays for a person.
  if (publishNew(deps, path, moved.text) === "published") rmSync(tomb, { force: true });
  return live;
}

/**
 * Removes the lock at `path` and its `.takeover`, but only when no holder is proven alive: an empty or unreadable file, or one whose
 * holder is dead (its process is gone, or has another start time). A live holder in either file refuses and removes nothing.
 *
 * It runs under the lock's own `.takeover` (published whole, as a takeover is), so it never overlaps a takeover, and acquisition
 * honours `.takeover` too. Under it the exact bytes of the lock are read once, THAT snapshot's holder is judged, and the file is
 * removed only if it still holds exactly those bytes (moved to a tombstone and compared; a different file is linked back).
 * A `.takeover` that is itself stuck is cleared the same way first.
 */
export function unlockPidLock(deps: PidLockDeps, path: string): UnlockResult {
  const takeoverPath = `${path}.takeover`;
  const mine = `${JSON.stringify({ owner: `${randomBytes(8).toString("hex")}-${deps.pid}`, pid: deps.pid, started: deps.startOf?.(deps.pid) ?? null })}\n`;
  const removed: Array<{ path: string; why: string }> = [];
  const failed = (file: string): UnlockResult => ({ status: "failed", removed, path: file });
  let held = false;
  for (let attempt = 0; attempt < 6 && !held; attempt++) {
    const got = publishNew(deps, takeoverPath, mine);
    if (got === "published") {
      held = true;
      break;
    }
    if (got === "error") return failed(takeoverPath);
    const snap = snapshotOf(takeoverPath);
    const state = judgeSnapshot(deps, snap);
    if (state.state === "live") return { status: "live", pid: state.pid, removed, path: takeoverPath };
    if (state.state === "absent") continue;
    deps.beforeRemove?.(takeoverPath);
    const outcome = removeJudged(deps, takeoverPath, snap);
    if (outcome === "removed") removed.push({ path: takeoverPath, why: stuckWords(state) });
    else if (outcome === "failed") return failed(takeoverPath);
    else return { status: "live", pid: outcome.live, removed, path: takeoverPath };
  }
  if (!held) return failed(takeoverPath);
  try {
    const snap = snapshotOf(path);
    const state = judgeSnapshot(deps, snap);
    if (state.state === "live") return { status: "live", pid: state.pid, removed, path };
    if (state.state === "absent") return removed.length === 0 ? { status: "none", removed } : { status: "removed", removed };
    deps.beforeRemove?.(path);
    const outcome = removeJudged(deps, path, snap);
    if (outcome === "removed") removed.push({ path, why: stuckWords(state) });
    else if (outcome === "failed") return failed(path);
    else return { status: "live", pid: outcome.live, removed, path };
    return { status: "removed", removed };
  } finally {
    // only our own .takeover is released
    if (readText(takeoverPath) === mine) removeIfUnchanged(deps, takeoverPath, mine);
  }
}
