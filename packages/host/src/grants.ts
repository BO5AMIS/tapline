import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AuditSink } from "./auditlog.js";
import { plainText } from "./elicit.js";
import { dropPidLock, ownLockDeps, takePidLock, type PidLockDeps } from "./pidlock.js";
import { listsFor, matchWord, policySchema } from "./policy.js";

/**
 * AGENT-TOOLS 1.14 §19: grants. A person's standing OK for a kind of touch, with limits, given ahead of time. A grant lives
 * in the policy file (version 2), is counted as slot files under `<policy file>.uses/` (no lock, no state file), and every use is a
 * line of the audit log (§23). Only a person makes a grant; nothing here creates, edits or lifts one.
 */

/** The most days away a grant's `until` may be, counted from the day the file is loaded (§19.1). */
export const GRANT_MAX_DAYS = 30;

export interface Grant {
  name: string;
  /** The app's id (or, when it has none, its name). */
  app: string;
  words: string[];
  route?: string;
  perDay: number;
  perHour?: number;
  /** A local date, `YYYY-MM-DD`: the grant covers touches up to the end of that day. */
  until: string;
  quiet?: { from: string; to: string };
  /** The effective value (§19.1): absent in the file, it is true for a word that reaches other people. */
  draftsOnly: boolean;
  /** A local date: the day a person or `--revoke-all` revoked it. */
  revoked?: string;
}

export interface GrantRefusal {
  /** The grant's name, or `#3` (its place in the list) when it has none. */
  name: string;
  /** The reason, a sentence ending in a full stop. */
  reason: string;
}

/** The note a refused grant gets (§19.1). */
export const refusalLine = (refusal: GrantRefusal): string => `Note: grant ${refusal.name.startsWith("#") ? refusal.name : JSON.stringify(refusal.name)} is refused: ${refusal.reason}`;

// -- never grantable (§19.2)

/** Words the tool treats as a payment or a purchase. */
export const PAYMENT_WORDS = ["Buy", "Purchase", "Pay", "Subscribe", "Checkout", "Place order", "Donate"];
/** Words that delete an account. (Privacy and security settings and Wallet are recognised by screen: Tapwright's to enforce.) */
export const ACCOUNT_WORDS = ["Delete account", "Delete my account", "Close account", "Deactivate account"];
/** Words that reach other people: a grant that names one is draftsOnly unless a person lifted it (§19.1, §21.3). */
export const REACH_WORDS = ["Send", "Post", "Publish", "Reply", "Comment"];

/** Why a word can never be granted, or null. `block` is the policy's block list for the grant's app. */
export function neverReason(word: string, block: string[]): string | null {
  const as = { label: word };
  const pay = matchWord(PAYMENT_WORDS, as);
  if (pay !== null) return `payments and purchases are never grantable (${JSON.stringify(pay)}).`;
  const account = matchWord(ACCOUNT_WORDS, as);
  if (account !== null) return `deleting an account is never grantable (${JSON.stringify(account)}).`;
  const blocked = matchWord(block, as);
  if (blocked !== null) return `a blocked word is never grantable (${JSON.stringify(blocked)}).`;
  return null;
}

// -- dates and times (local)

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** The local calendar day, `YYYY-MM-DD`. */
export function localDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 8601 in local time with its offset, as a slot file keeps it (§19.4). */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Whole days from one `YYYY-MM-DD` to another; null when either isn't a real date. */
function daysBetween(from: string, to: string): number | null {
  const a = dateMs(from);
  const b = dateMs(to);
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

function dateMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

function minutesOf(clock: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
}

// -- loading (§19.1)

const rawGrant = z.looseObject({
  name: z.unknown().optional(),
  app: z.unknown().optional(),
  words: z.unknown().optional(),
  route: z.unknown().optional(),
  perDay: z.unknown().optional(),
  perHour: z.unknown().optional(),
  until: z.unknown().optional(),
  quiet: z.unknown().optional(),
  draftsOnly: z.unknown().optional(),
  revoked: z.unknown().optional(),
});

const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100_000;

/**
 * Reads a policy file's `grants`. A grant that is invalid, longer than 30 days or never grantable is refused alone: the
 * others load, and the reason is kept (§19.1). `today` is the local day the file is loaded; `block` is the policy's block list for an app.
 */
export function parseGrants(raw: unknown, today: string, block: (app: string) => string[]): { grants: Grant[]; refused: GrantRefusal[] } {
  const grants: Grant[] = [];
  const refused: GrantRefusal[] = [];
  if (raw === undefined) return { grants, refused };
  if (!Array.isArray(raw)) return { grants, refused: [{ name: "#1", reason: "grants must be a list." }] };
  const seen = new Set<string>();
  const keys = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const parsed = rawGrant.safeParse(item);
    const label = parsed.success && typeof parsed.data.name === "string" && parsed.data.name.trim() !== "" ? parsed.data.name : `#${index + 1}`;
    const refuse = (reason: string): void => {
      refused.push({ name: label, reason });
    };
    if (!parsed.success) return refuse("it isn't an object.");
    const g = parsed.data;
    if (label.startsWith("#")) return refuse("name is missing.");
    if (!safeGrantName(label)) return refuse("name may only use letters, digits, _, . and - (it names a folder), and not be . or .. or end in a dot.");
    if (seen.has(label)) return refuse("name is already used by an earlier grant.");
    // Two names that are equal ignoring ASCII case share a uses folder on a case-insensitive file system: the later is refused, active or revoked.
    if (keys.has(grantKey(label))) return refuse("name differs from an earlier grant's only in case (they would share one uses folder).");
    seen.add(label);
    keys.add(grantKey(label));
    if (typeof g.app !== "string" || g.app.trim() === "") return refuse("app is missing.");
    if (!Array.isArray(g.words) || g.words.length === 0 || !g.words.every((w): w is string => typeof w === "string" && w.trim() !== "")) {
      return refuse("words must be a list of words, at least one.");
    }
    const words = g.words.map((w: string) => w.trim());
    if (typeof g.until !== "string" || dateMs(g.until) === null) return refuse("until must be a date, like 2026-11-21.");
    const away = daysBetween(today, g.until);
    if (away !== null && away > GRANT_MAX_DAYS) return refuse(`until is ${away} days away; the most is ${GRANT_MAX_DAYS}.`);
    if (g.route !== undefined && (typeof g.route !== "string" || g.route.trim() === "")) return refuse("route must be the name of a saved route.");
    if (g.perDay !== undefined && !wholeNumber(g.perDay)) return refuse("perDay must be a whole number, 1 or more.");
    if (g.perHour !== undefined && !wholeNumber(g.perHour)) return refuse("perHour must be a whole number, 1 or more.");
    if (g.draftsOnly !== undefined && typeof g.draftsOnly !== "boolean") return refuse("draftsOnly must be true or false.");
    let quiet: { from: string; to: string } | undefined;
    if (g.quiet !== undefined) {
      const q = g.quiet;
      const from = typeof q === "object" && q !== null ? (q as { from?: unknown }).from : undefined;
      const to = typeof q === "object" && q !== null ? (q as { to?: unknown }).to : undefined;
      if (typeof from !== "string" || typeof to !== "string" || minutesOf(from) === null || minutesOf(to) === null) return refuse("quiet needs from and to as HH:MM.");
      if (from === to) return refuse("quiet's from and to must differ.");
      quiet = { from, to };
    }
    if (g.revoked !== undefined && (typeof g.revoked !== "string" || dateMs(g.revoked) === null)) return refuse("revoked must be a date, like 2026-11-14.");
    for (const word of words) {
      const never = neverReason(word, block(g.app));
      if (never !== null) return refuse(never);
    }
    const draftsOnly = typeof g.draftsOnly === "boolean" ? g.draftsOnly : words.some((w) => matchWord(REACH_WORDS, { label: w }) !== null);
    grants.push({
      name: label,
      app: g.app,
      words,
      ...(typeof g.route === "string" ? { route: g.route.trim() } : {}),
      perDay: typeof g.perDay === "number" ? g.perDay : 1,
      ...(typeof g.perHour === "number" ? { perHour: g.perHour } : {}),
      until: g.until,
      ...(quiet !== undefined ? { quiet } : {}),
      draftsOnly,
      ...(typeof g.revoked === "string" ? { revoked: g.revoked } : {}),
    });
  });
  return { grants, refused };
}

// -- the uses: slot files (§19.4, 1.14.1)

/**
 * A grant's uses are files, with no state file, no lock, no takeover and no generation. A use is a file created exclusively
 * (`wx`), so the file system decides who got it:
 *   a day slot:  `<policy file>.uses/<grant name>/<YYYY-MM-DD>/<k>`   for k = 1..perDay
 *   an hour slot: `<policy file>.uses/<grant name>/<YYYY-MM-DDTHH>/h<k>` for k = 1..perHour (the clock hour, not a rolling 60 minutes)
 * all in local time. A count is the number of entries in the folder, whatever their names or content: an unreadable or garbage
 * file counts, which fails closed. A stalled writer can only ever fill a slot nobody else has taken, so none can approve a use
 * another one already made.
 */

/** A name with its ASCII capitals lower-cased (nothing else changes). */
function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** What two grant names are compared by: equal ignoring ASCII case (names are limited to `[A-Za-z0-9._-]`). Names that agree here are one name. */
export function grantKey(name: string): string {
  return asciiLower(name);
}

/**
 * The folder a grant's uses live in: its name lower-cased (a safe name is ASCII only, so this is exactly its case-folded form). A
 * name's case therefore never picks another folder, and `g` and `G` are one folder on every file system.
 */
export function usesFolder(name: string): string {
  return asciiLower(name);
}

/** The policy file's edit lock (§19.5). */
export function policyEditLockPath(policyPath: string): string {
  return `${policyPath}.edit.lock`;
}

/** Whether a grant's name is safe as a folder name: letters, digits, `_`, `.` and `-`; never `.`, `..` or one that ends in a dot (Windows drops it). */
export function safeGrantName(name: string): boolean {
  return /^[\w.-]+$/.test(name) && name !== "." && name !== ".." && !name.endsWith(".");
}

const hourFolder = (at: Date): string => `${localDate(at)}T${pad(at.getHours())}`;

/** The one key a grant scope is compared with: the app's id, or its name when it has none (the Grant.app contract). */
function appKey(app: { id?: string; name: string }): string {
  return app.id ?? app.name;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

/** A folder's entries; `[]` when it doesn't exist yet; null when it can't be read (a file in the way, no permission): fail closed. */
async function listDir(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? [] : null;
  }
}

/** What a touch is, for a grant to match: the app, the element's own label and text, and the saved routes running now. */
export interface GrantTouch {
  app: { id?: string; name: string };
  element: { label?: string | null; text?: string | null };
  routes: string[];
}

/** What `release` and `stillCovers` need to know of a use: who made it and which slot files (relative to the uses folder, `/`-separated) hold it. */
export interface GrantUseRef {
  name: string;
  owner: string;
  slots: string[];
}

export type GrantDecision =
  /** `owner` and `slots` name the recorded use, so `release` can take it back when the touch wasn't made (`peek` has none). */
  | { kind: "covered"; name: string; line: string; /** `2 of 3`, for a dry run's words. */ counts: string; counted: boolean; owner: string; slots: string[] }
  /**
   * A draftsOnly grant covers the touch (§19.3): the touch stops before it is made and shows a draft to a person (§21.3). Nothing is
   * counted: a draft a person sends isn't a use of the grant, the person's OK let it through.
   */
  | { kind: "draft"; name: string }
  /** The touch asks a person; `notes` say why a grant that matched didn't cover it (§19.3). */
  | { kind: "ask"; notes: string[]; /** Why each matching grant didn't cover it, in the report's words: `limit reached`, `quiet hours`, `ended`, `revoked`. */ asked: string[] };

/** What a look at the policy file and the uses folder found, for `doctor` and the first answer (§19.1, §19.4). */
export interface GrantReport {
  /** False when the policy file can't be read or parsed any more: no grant covers anything. */
  fileOk: boolean;
  grants: Grant[];
  refused: GrantRefusal[];
  /** The uses folder (or a grant's folder in it) can't be read: that grant counts as used up. */
  usesBroken: boolean;
}

export interface GrantBookOptions {
  policyPath: string;
  /** The audit log. Without one no grant covers a touch: a grant needs its line (§23). */
  audit: AuditSink | null;
  /** The clock. A claim reads it again when it claims, so the day and the hour it counts against are the ones it claims in. */
  now?: () => Date;
  /** For tests: runs before each exclusive create of a slot file (a writer that pauses at any point). */
  beforeCreate?: (path: string) => Promise<void>;
  /** For tests: runs after a use's slot files exist and before the policy is read again and the audit line written. */
  afterClaim?: () => Promise<void>;
  /** For tests: runs in `stillCovers` after the use's slot files were read and before the clock is read for the final check. */
  afterSlotReads?: () => Promise<void>;
  /** For tests: runs inside the edit lock, after the policy was read and checked and before the new file is written. */
  beforePolicyWrite?: () => Promise<void>;
  /** The process facts the policy file's edit lock uses (pid, liveness, start time). Default: this process. */
  editLock?: PidLockDeps;
  /** How long a change waits for the edit lock before it gives up and changes nothing. Default 5000 ms. */
  editLockWaitMs?: number;
  /** How often a change that waits for the edit lock tries again. Default 25 ms. */
  editLockPollMs?: number;
}

const RENAME_TRIES = 5;
/** How many times a claim that the clock overtook (midnight, the next hour) is made again. */
const CLAIM_TRIES = 4;
const RENAME_WAIT_MS = 20;

/** A claimed use: the day's count including this use, who made it, and its slot files. */
type Claimed = { today: number; perDay: number; owner: string; slots: string[] };

type SlotResult = { file: string; count: number } | { full: number } | null;

export class GrantBook {
  private readonly now: () => Date;
  private readonly usesRoot: string;

  constructor(private readonly options: GrantBookOptions) {
    this.now = options.now ?? (() => new Date());
    this.usesRoot = `${options.policyPath}.uses`;
  }

  get policyPath(): string {
    return this.options.policyPath;
  }

  /** The policy file read again, on every call: a revocation by hand or by the other tool is seen at the next touch (§19.5). */
  private async readPolicy(): Promise<{ grants: Grant[]; refused: GrantRefusal[] } | null> {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.options.policyPath, "utf8"));
    } catch {
      return null;
    }
    const file = policySchema.safeParse(json);
    if (!file.success) return null;
    // A version 1 file has no grants (§19.1).
    if (file.data.version !== 2) return { grants: [], refused: [] };
    return parseGrants(file.data.grants, localDate(this.now()), (app) => listsFor(file.data, { id: app, name: app }).block);
  }

  /** The uses of a grant in the day and the hour of `at`, by listing the folders; null when one can't be read (fails closed). */
  private async countsAt(grant: Grant, at: Date): Promise<{ today: number; hour: number } | null> {
    if (!safeGrantName(grant.name)) return null;
    if ((await listDir(this.usesRoot)) === null) return null;
    const base = join(this.usesRoot, usesFolder(grant.name));
    const day = await listDir(join(base, localDate(at)));
    const hour = await listDir(join(base, hourFolder(at)));
    return day === null || hour === null ? null : { today: day.length, hour: hour.length };
  }

  /** Every grant, what was refused, and whether a uses folder can't be read: for `doctor` and the session's first answer. */
  async inspect(): Promise<GrantReport> {
    const policy = await this.readPolicy();
    let usesBroken = (await listDir(this.usesRoot)) === null;
    const at = this.now();
    for (const grant of policy?.grants ?? []) {
      if (usesBroken) break;
      if (!safeGrantName(grant.name) || (await listDir(join(this.usesRoot, usesFolder(grant.name)))) === null || (await this.countsAt(grant, at)) === null) usesBroken = true;
    }
    return { fileOk: policy !== null, grants: policy?.grants ?? [], refused: policy?.refused ?? [], usesBroken };
  }

  /** The date, `YYYY-MM-DD`, that is `days` from today (at most 30), for the dialog's question and a new grant's `until`. */
  untilFor(days: number): string {
    const at = this.now();
    return localDate(new Date(at.getFullYear(), at.getMonth(), at.getDate() + Math.min(GRANT_MAX_DAYS, Math.max(0, days))));
  }

  /** Every grant with today's and this hour's counts (null when its uses can't be read), for `tapline grants` (§19.7). */
  async listing(): Promise<{ report: GrantReport; usage: Map<string, { today: number; hour: number } | null> }> {
    const report = await this.inspect();
    const at = this.now();
    const usage = new Map<string, { today: number; hour: number } | null>();
    for (const grant of report.grants) usage.set(grant.name, await this.countsAt(grant, at));
    return { report, usage };
  }

  /**
   * Prune (at start, §19.4): the uses of a grant that has ended (today is after its `until`) or was revoked are deleted. Nothing else
   * is ever counted from an earlier day or hour, so nothing else is needed. Returns the names it cleared.
   */
  async prune(): Promise<string[]> {
    const policy = await this.readPolicy();
    if (policy === null) return [];
    const today = localDate(this.now());
    const cleared: string[] = [];
    // A folder whose grant is active is never touched, whatever another entry's name says.
    const active = new Set(policy.grants.filter((g) => g.revoked === undefined && today <= g.until).map((g) => usesFolder(g.name)));
    for (const grant of policy.grants) {
      if (grant.revoked === undefined && today <= grant.until) continue;
      if (active.has(usesFolder(grant.name))) continue;
      if (await this.removeUses(grant.name)) cleared.push(grant.name);
    }
    return cleared;
  }

  /** Deletes a grant's whole uses folder; false for a name that isn't safe as a folder name or when it can't be deleted. */
  private async removeUses(name: string): Promise<boolean> {
    if (!safeGrantName(name)) return false;
    try {
      await rm(join(this.usesRoot, usesFolder(name)), { recursive: true, force: true, maxRetries: 3, retryDelay: RENAME_WAIT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `grants --revoke-all` (§19.5): marks every grant in the policy file `"revoked": "<today>"` and writes one `revoke` audit
   * line each, and deletes the revoked grants' uses. A grant that is already revoked keeps its date. The file is changed with a
   * temporary file and a rename, and every running tool sees it at its very next touch, because each touch reads the file again.
   */
  async revokeAll(detail = "grants --revoke-all"): Promise<{ revoked: string[]; already: string[] } | { error: string }> {
    const today = localDate(this.now());
    const revoked: Array<{ name: string; app?: string }> = [];
    const already: string[] = [];
    const done = await this.editPolicy((file) => {
      const list = file["grants"];
      if (!Array.isArray(list)) return false;
      let changed = false;
      list.forEach((item: unknown, index) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return;
        const grant = item as Record<string, unknown>;
        const name = typeof grant["name"] === "string" && grant["name"].trim() !== "" ? grant["name"] : `#${index + 1}`;
        if (typeof grant["revoked"] === "string" && dateMs(grant["revoked"]) !== null) {
          already.push(name);
          return;
        }
        grant["revoked"] = today;
        revoked.push({ name, ...(typeof grant["app"] === "string" ? { app: grant["app"] } : {}) });
        changed = true;
      });
      return changed;
    });
    if (typeof done === "string") return { error: done };
    // The kill switch never waits for its record: a line that can't be written doesn't undo the revocation.
    for (const grant of revoked) this.options.audit?.write({ kind: "revoke", ...(grant.app !== undefined ? { app: grant.app } : {}), name: grant.name, detail });
    for (const grant of revoked) await this.removeUses(grant.name);
    return { revoked: revoked.map((g) => g.name), already };
  }

  /**
   * Writes a grant a person made through the dialog (§19.6) into the policy file: a temporary file and a rename, a name not used
   * yet, `until` at most 30 days away, a version 1 file becoming version 2. The creation is logged (§23, `approval`). Only the
   * host's dialog calls this, with what the person answered; nothing a model sends reaches it.
   */
  async create(spec: GrantSpec): Promise<{ grant: Grant } | { error: string }> {
    const at = this.now();
    const today = localDate(at);
    let made: Grant | undefined;
    let refusal: string | undefined;
    const done = await this.editPolicy((file) => {
      if (file["version"] !== 1 && file["version"] !== 2) {
        refusal = "the policy file has no version 1 or 2.";
        return false;
      }
      const list = Array.isArray(file["grants"]) ? (file["grants"] as unknown[]) : [];
      const taken = new Set(list.map((item) => (typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string" ? grantKey((item as { name: string }).name) : undefined)));
      let name = spec.nameBase;
      for (let n = 2; taken.has(grantKey(name)); n++) name = `${spec.nameBase}_${n}`;
      const raw = {
        name,
        app: spec.app,
        words: spec.words,
        ...(spec.route !== undefined ? { route: spec.route } : {}),
        perDay: spec.perDay,
        ...(spec.perHour !== undefined ? { perHour: spec.perHour } : {}),
        until: this.untilFor(spec.days),
        ...(spec.quiet !== undefined ? { quiet: spec.quiet } : {}),
        ...(spec.draftsOnly === false ? { draftsOnly: false } : {}),
      };
      const parsed = parseGrants([raw], today, (app) => listsFor(policySchema.parse({ ...file, version: 2 }), { id: app, name: app }).block);
      const grant = parsed.grants[0];
      if (grant === undefined) {
        refusal = parsed.refused[0]?.reason ?? "it can't be a grant.";
        return false;
      }
      file["version"] = 2;
      file["grants"] = [...list, raw];
      made = grant;
      return true;
    });
    if (typeof done === "string") return { error: done };
    if (made === undefined) return { error: refusal ?? "nothing was written." };
    this.options.audit?.write({ kind: "approval", app: made.app, name: made.words[0] ?? made.name, detail: "grant created" });
    return { grant: made };
  }

  /**
   * Every change to the policy file (create, renew, lifting draftsOnly, revoke-all) runs under `<policy file>.edit.lock`: the shared
   * pid-liveness lock (pidlock.ts), which no one can displace while its holder lives. Under it the file is read again and the change is
   * applied to that fresh content, never to an earlier copy; the result is written with a temporary file and a rename. A change that
   * can't get the lock within `editLockWaitMs` fails closed: nothing is written. A string is why it couldn't.
   */
  private async editPolicy(change: (file: Record<string, unknown>) => boolean): Promise<true | string> {
    const lockPath = policyEditLockPath(this.options.policyPath);
    const deps = this.options.editLock ?? ownLockDeps();
    const waitMs = this.options.editLockWaitMs ?? 5000;
    const pollMs = this.options.editLockPollMs ?? 25;
    const until = Date.now() + waitMs;
    let token: string | null = null;
    for (;;) {
      token = takePidLock(deps, lockPath);
      if (token !== null || Date.now() >= until) break;
      await new Promise<void>((done) => setTimeout(done, pollMs));
    }
    if (token === null) return "couldn't take the policy file's edit lock (another change is under way); nothing was changed, try again.";
    try {
      return await this.editPolicyLocked(change);
    } finally {
      dropPidLock(lockPath, token);
    }
  }

  /** The change itself, run under the edit lock: reads the file as it is now, lets `change` edit it, writes it back when it says it did. */
  private async editPolicyLocked(change: (file: Record<string, unknown>) => boolean): Promise<true | string> {
    const path = this.options.policyPath;
    let before: { mtimeMs: number; size: number };
    let file: unknown;
    try {
      const info = await stat(path);
      before = { mtimeMs: info.mtimeMs, size: info.size };
      file = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      return `couldn't read the policy file: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (typeof file !== "object" || file === null || Array.isArray(file)) return "the policy file isn't a policy.";
    if (!change(file as Record<string, unknown>)) return true;
    try {
      const now = await stat(path);
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) return "the policy file changed while it was being edited; try again.";
      await this.options.beforePolicyWrite?.();
      await this.writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
    } catch (error) {
      return `couldn't write the policy file: ${error instanceof Error ? error.message : String(error)}`;
    }
    return true;
  }

  /** The `Note:` lines of an inspection: each refused grant, and a uses folder that can't be read. */
  static noticeLines(report: GrantReport): string[] {
    const lines = report.refused.map(refusalLine);
    if (!report.fileOk) lines.push("Note: the policy file can't be read now, so no grant covers anything; every touch asks a person.");
    if (report.usesBroken) lines.push("Note: the grants' uses folder can't be read, so a grant whose uses can't be counted counts as used up and its touch asks a person.");
    return lines;
  }

  /**
   * Whether a grant covers this touch (§19.3). Called where the host has decided the touch needs a person: a covered touch goes
   * through, and anything else asks as before, with the notes. `use` claims the use's slot files and writes the audit line;
   * `peek` claims and writes nothing (a dry run, and the check before a dialog). `detail` is what the audit line says.
   */
  async decide(touch: GrantTouch, mode: "use" | "peek", detail: string): Promise<GrantDecision> {
    const policy = await this.readPolicy();
    if (policy === null) return { kind: "ask", notes: [], asked: [] };
    // Never grantable, whatever the file says: a touch on a payment or an account deletion always asks (§19.2).
    if (matchWord([...PAYMENT_WORDS, ...ACCOUNT_WORDS], touch.element) !== null) return { kind: "ask", notes: [], asked: [] };
    const at = this.now();
    const today = localDate(at);
    const minutes = at.getHours() * 60 + at.getMinutes();
    const notes: string[] = [];
    const asked: string[] = [];
    for (const grant of policy.grants) {
      if (grant.app !== appKey(touch.app)) continue;
      if (matchWord(grant.words, touch.element) === null) continue;
      if (grant.route !== undefined && !touch.routes.includes(grant.route)) continue;
      const name = JSON.stringify(grant.name);
      const doesnt = (why: string): string => `Note: grant ${name} doesn't cover this (${why}); asking a person.`;
      if (grant.revoked !== undefined) {
        notes.push(doesnt(`it was revoked on ${grant.revoked}`));
        asked.push("revoked");
        continue;
      }
      if (today > grant.until) {
        notes.push(doesnt(`it ended on ${grant.until}`));
        asked.push("ended");
        continue;
      }
      if (grant.quiet !== undefined && inQuiet(grant.quiet, minutes)) {
        notes.push(doesnt(`quiet hours ${grant.quiet.from} to ${grant.quiet.to}`));
        asked.push("quiet hours");
        continue;
      }
      // A draftsOnly grant only looks: its touch stops at a draft, and a draft a person sends counts no use (§19.3, §21.3).
      const counted = mode === "use" && !grant.draftsOnly ? await this.use(grant, detail, touch) : await this.peek(grant, at);
      if (counted === null) continue;
      if (typeof counted === "string") {
        notes.push(doesnt(counted));
        asked.push("limit reached");
        continue;
      }
      if (grant.draftsOnly) return { kind: "draft", name: grant.name };
      return {
        kind: "covered",
        name: grant.name,
        counts: `${counted.today} of ${counted.perDay}`,
        counted: mode === "use",
        owner: counted.owner,
        slots: counted.slots,
        line: `Note: allowed by grant ${name} (${counted.today} of ${counted.perDay} today).`,
      };
    }
    return { kind: "ask", notes, asked };
  }

  /**
   * Whether the grant a use was taken under still covers this touch, right now (§19.3): the policy file is read again, and the clock
   * too, so a revocation, a `draftsOnly`, quiet hours, `until`, the word and the route condition are current. Takes no use and writes
   * nothing; the use's slot files must all still be there and still be this use's. Any doubt (an unreadable file) answers false: the
   * touch then asks a person.
   */
  async stillCovers(touch: GrantTouch, use: GrantUseRef): Promise<boolean> {
    // A use whose slots are in an earlier day or hour than now is released and claimed again in the current buckets (the reference is
    // updated in place), at most a few times; where that fails the touch asks a person.
    for (let round = 0; round < CLAIM_TRIES; round++) {
      const policy = await this.readPolicy();
      if (policy === null) return false;
      if (matchWord([...PAYMENT_WORDS, ...ACCOUNT_WORDS], touch.element) !== null) return false;
      const grant = policy.grants.find((g) => g.name === use.name);
      if (grant === undefined) return false;
      if (!this.holds(grant, touch, this.now())) return false;
      if (use.owner === "" || use.slots.length === 0) return false;
      for (const slot of use.slots) {
        const path = this.slotPath(slot, use.name);
        if (path === null || (await slotOwner(path)) !== use.owner) return false;
      }
      await this.options.afterSlotReads?.();
      // The clock is read AFTER every await, as the last thing before answering true: time restrictions and the bucket are those of
      // this very moment (no await between this read and the return).
      const at = this.now();
      if (!this.holds(grant, touch, at)) return false;
      if (this.inCurrentBuckets(use.slots, at) && this.fits(grant, use.slots)) return true;
      await this.dropSlots(use.name, use.owner, use.slots);
      const claimed = await this.claimBuckets(grant, grant.route ?? touch.routes[0]);
      if (claimed === null || typeof claimed === "string") return false;
      use.owner = claimed.owner;
      use.slots = claimed.slots;
    }
    return false;
  }

  /**
   * Whether a claim still fits the grant as the policy file has it now: its day slot number is within perDay, and, when the grant has a
   * perHour, it holds an hour slot whose number is within perHour. A policy that was changed between the claim and the touch (a quota
   * cut, a perHour added) makes an old claim fall outside the new limits; it is then given back and claimed again, or the touch asks.
   */
  private fits(grant: Grant, slots: string[]): boolean {
    let days = 0;
    let hours = 0;
    for (const slot of slots) {
      const file = slot.split("/")[2] ?? "";
      const hour = /^h([0-9]+)$/.exec(file);
      if (hour !== null) {
        hours += 1;
        if (grant.perHour === undefined || Number(hour[1]) > grant.perHour) return false;
        continue;
      }
      const day = /^([0-9]+)$/.exec(file);
      if (day === null || Number(day[1]) > grant.perDay) return false;
      days += 1;
    }
    return days === 1 && (grant.perHour === undefined ? hours === 0 : hours === 1);
  }

  /** Whether every slot of a use is in the day (or hour) folder of `at`: a use from an earlier day or hour is not counted against the current one. */
  private inCurrentBuckets(slots: string[], at: Date): boolean {
    return slots.every((slot) => {
      const folder = slot.split("/")[1];
      return folder === localDate(at) || folder === hourFolder(at);
    });
  }

  /** Whether this grant, as the policy file has it now, covers the touch at this time: app, word, route, revocation, end, quiet hours, drafts. */
  private holds(grant: Grant, touch: GrantTouch, at: Date): boolean {
    if (grant.app !== appKey(touch.app)) return false;
    if (matchWord([...PAYMENT_WORDS, ...ACCOUNT_WORDS], touch.element) !== null) return false;
    if (matchWord(grant.words, touch.element) === null) return false;
    if (grant.route !== undefined && !touch.routes.includes(grant.route)) return false;
    if (grant.revoked !== undefined || grant.draftsOnly || localDate(at) > grant.until) return false;
    return grant.quiet === undefined || !inQuiet(grant.quiet, at.getHours() * 60 + at.getMinutes());
  }

  /** The absolute path of a slot a use names, or null when it isn't a slot of that grant (never a path outside the uses folder). */
  private slotPath(slot: string, name: string): string | null {
    const parts = slot.split("/");
    const [grant, folder, file] = parts;
    if (parts.length !== 3 || grant !== usesFolder(name) || !safeGrantName(name) || folder === undefined || file === undefined) return null;
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(folder) || !/^h?\d+$/.test(file)) return null;
    return join(this.usesRoot, grant, folder, file);
  }

  /** A use taken back: the touch wasn't made after all (§19.4: a use is counted when the touch is made). Deletes only this use's own slot files. */
  async release(use: GrantUseRef): Promise<void> {
    await this.dropSlots(use.name, use.owner, use.slots);
  }

  /** Deletes the slot files of a use, each only after its content says this owner made it. A file that can't be read or deleted stays: the use stays counted. */
  private async dropSlots(name: string, owner: string, slots: string[]): Promise<void> {
    if (owner === "") return;
    for (const slot of slots) {
      const path = this.slotPath(slot, name);
      if (path === null) continue;
      try {
        if ((await slotOwner(path)) === owner) await rm(path, { force: true });
      } catch {
        // stays counted: the safe side
      }
    }
  }

  /** The limit that stops a use as words for the note, or null when there is room. */
  private limit(grant: Grant, counts: { today: number; hour: number }): string | null {
    if (counts.today >= grant.perDay) return `${counts.today} of ${grant.perDay} today`;
    if (grant.perHour !== undefined && counts.hour >= grant.perHour) return `${counts.hour} of ${grant.perHour} this hour`;
    return null;
  }

  /** A string: the limit that stopped it. null: it can't be counted (an unreadable uses folder), nothing to say. */
  private async peek(grant: Grant, at: Date): Promise<Claimed | string | null> {
    const counts = await this.countsAt(grant, at);
    if (counts === null) return null;
    return this.limit(grant, counts) ?? { today: counts.today + 1, perDay: grant.perDay, owner: "", slots: [] };
  }

  /**
   * Claims a slot file in `dir` (k = 1..limit, exclusive create, the folder made as needed): the first k nobody has taken. A full
   * folder answers how many entries it holds; a folder that can't be read or written answers null. Every entry counts, so a garbage
   * file takes a place: a folder holding more entries than `limit` after the claim gives the claim back.
   */
  private async claimSlot(dir: string, prefix: string, limit: number, content: string): Promise<SlotResult> {
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      return null;
    }
    const names = await listDir(dir);
    if (names === null) return null;
    if (names.length >= limit) return { full: names.length };
    const taken = new Set(names);
    for (let k = 1; k <= limit; k++) {
      const file = join(dir, `${prefix}${k}`);
      if (taken.has(`${prefix}${k}`)) continue;
      await this.options.beforeCreate?.(file);
      try {
        await writeFile(file, content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        // Taken a moment ago (Windows says EPERM or EBUSY while a delete is under way): the next one.
        const code = errorCode(error);
        if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") continue;
        return null;
      }
      const after = await listDir(dir);
      if (after === null) {
        await rm(file, { force: true }).catch(() => undefined);
        return null;
      }
      if (after.length > limit) {
        await rm(file, { force: true }).catch(() => undefined);
        return { full: Math.max(limit, after.length - 1) };
      }
      return { file, count: after.length };
    }
    return { full: limit };
  }

  /**
   * Claims the slot files of one use in the buckets of a fresh clock: the hour slot first (when there is a perHour), then the day slot;
   * a day claim that fails gives the hour slot back. The clock is read again after the claim: when the day (or the hour, with a perHour)
   * moved on meanwhile, the slots just made are in an earlier bucket, so they are deleted and the claim is made again in the current
   * one (a claimer that paused across midnight never counts against yesterday). A string is the limit that stopped it; null, that it
   * can't be counted.
   */
  private async claimBuckets(grant: Grant, route: string | undefined): Promise<Claimed | string | null> {
    const folder = usesFolder(grant.name);
    for (let attempt = 0; attempt < CLAIM_TRIES; attempt++) {
      const at = this.now();
      const counts = await this.countsAt(grant, at);
      if (counts === null) return null;
      const stopped = this.limit(grant, counts);
      if (stopped !== null) return stopped;
      const owner = randomBytes(8).toString("hex");
      const content = `${JSON.stringify({ t: localIso(at), tool: "tapline", owner, ...(route !== undefined ? { route } : {}) })}\n`;
      const slots: string[] = [];
      const giveBack = (): Promise<void> => this.dropSlots(grant.name, owner, slots);
      try {
        if (grant.perHour !== undefined) {
          const hourDir = hourFolder(at);
          const hour = await this.claimSlot(join(this.usesRoot, folder, hourDir), "h", grant.perHour, content);
          if (hour === null) return null;
          if ("full" in hour) return `${hour.full} of ${grant.perHour} this hour`;
          slots.push(`${folder}/${hourDir}/${basename(hour.file)}`);
        }
        const dayDir = localDate(at);
        const day = await this.claimSlot(join(this.usesRoot, folder, dayDir), "", grant.perDay, content);
        if (day === null) {
          await giveBack();
          return null;
        }
        if ("full" in day) {
          await giveBack();
          return `${day.full} of ${grant.perDay} today`;
        }
        slots.push(`${folder}/${dayDir}/${basename(day.file)}`);
        const later = this.now();
        if (localDate(later) !== dayDir || (grant.perHour !== undefined && hourFolder(later) !== hourFolder(at))) {
          await giveBack();
          continue;
        }
        return { today: day.count, perDay: grant.perDay, owner, slots };
      } catch {
        await giveBack();
        return null;
      }
    }
    return null;
  }

  /**
   * Claims a use (see claimBuckets), then the policy and the clock are read again (a revocation, an end or quiet hours that came
   * meanwhile win) and the audit line is written; a grant needs its line, so a use whose line can't be written is given back (§23).
   * A string is the limit that stopped it; null, that it can't be counted.
   */
  private async use(grant: Grant, detail: string, touch: GrantTouch): Promise<Claimed | string | null> {
    const audit = this.options.audit;
    if (audit === null || !safeGrantName(grant.name)) return null;
    // After the awaits below the clock is read again, as the last thing before the audit line and the answer: a claim that midnight (or
    // the next hour) overtook meanwhile is given back and made again in the current buckets, at most CLAIM_TRIES times.
    let current = grant;
    for (let attempt = 0; attempt < CLAIM_TRIES; attempt++) {
      const claimed = await this.claimBuckets(current, current.route ?? touch.routes[0]);
      if (claimed === null || typeof claimed === "string") return claimed;
      const giveBack = (): Promise<void> => this.dropSlots(grant.name, claimed.owner, claimed.slots);
      try {
        await this.options.afterClaim?.();
        const policy = await this.readPolicy();
        const fresh = policy?.grants.find((g) => g.name === grant.name);
        const at = this.now();
        if (fresh === undefined || !this.holds(fresh, touch, at)) {
          await giveBack();
          return null;
        }
        // The claim is checked against the refreshed grant: after a quota cut or a changed perHour it is given back, and claimed once more
        // under the new limits (the loop), which asks a person when they leave no room.
        if (!this.inCurrentBuckets(claimed.slots, at) || !this.fits(fresh, claimed.slots)) {
          await giveBack();
          current = fresh;
          continue;
        }
        if (!audit.write({ kind: "grant", app: appKey(touch.app), name: grant.name, detail: `${detail} (${claimed.today} of ${fresh.perDay} today)` })) {
          await giveBack();
          return null;
        }
        return claimed;
      } catch {
        await giveBack();
        return null;
      }
    }
    return null;
  }

  /** A temporary file and a rename, with retries on Windows. */
  private async writeAtomic(path: string, content: string): Promise<void> {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, path);
          return;
        } catch (error) {
          const code = errorCode(error);
          if ((code !== "EPERM" && code !== "EBUSY") || attempt >= RENAME_TRIES) throw error;
          await new Promise<void>((done) => setTimeout(done, RENAME_WAIT_MS));
        }
      }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** The `owner` a slot file's content names; undefined when the file can't be read or isn't in the format (it is not provably anyone's own). */
async function slotOwner(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && typeof (parsed as { owner?: unknown }).owner === "string" ? (parsed as { owner: string }).owner : undefined;
  } catch {
    return undefined;
  }
}


/** What the person said yes to in the dialog (§19.6). `days` counts from today, at most 30. */
export interface GrantSpec {
  /** A name to start from; a number is added when it is taken. */
  nameBase: string;
  app: string;
  words: string[];
  route?: string;
  perDay: number;
  perHour?: number;
  days: number;
  quiet?: { from: string; to: string };
  /** Only `false` is written (the person said Yes to sending without drafts); otherwise the file says nothing (§19.1). */
  draftsOnly?: false;
}

/** Whether the element touched is a payment or an account deletion: no grant covers it, whatever its word (§19.2). */
export const elementNeverGrantable = (element: { label?: string | null; text?: string | null }): boolean => matchWord([...PAYMENT_WORDS, ...ACCOUNT_WORDS], element) !== null;

/** Whether a word reaches other people, so a grant for it shows drafts first unless a person lifts that (§19.1). */
export const reachesPeople = (word: string): boolean => matchWord(REACH_WORDS, { label: word }) !== null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-11-21` as `21 Nov`. */
function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m === null ? date : `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/**
 * The dialog's question, saying everything the grant allows (§19.6):
 * `Allow tapping "Post" in Instagram up to 3 times a day, only in route post_update, until 21 Nov (drafts shown to you first)?`
 * `app` is the app's name as the dialog may show it (already cut and cleaned); words are cleaned here.
 */
export function grantCaption(grant: Pick<Grant, "words" | "perDay" | "perHour" | "until" | "route" | "quiet" | "draftsOnly">, app: string): string {
  const words = grant.words.map((w) => JSON.stringify(plainText(w)));
  const spoken = words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
  const counts = `up to ${grant.perDay} ${grant.perDay === 1 ? "time" : "times"} a day${grant.perHour !== undefined ? ` and ${grant.perHour} an hour` : ""}`;
  const quiet = grant.quiet !== undefined ? `, not between ${grant.quiet.from} and ${grant.quiet.to}` : "";
  const route = grant.route !== undefined ? `, only in route ${plainText(grant.route)}` : "";
  const drafts = grant.draftsOnly ? " (drafts shown to you first)" : "";
  return `Allow tapping ${spoken} in ${app} ${counts}${quiet}${route}, until ${shortDate(grant.until)}${drafts}?`;
}

/** A grant's name from the app's name and the word, as `instagram_post`: ASCII letters, digits and `_`. */
export function grantNameBase(app: string, word: string): string {
  const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [slug(app), slug(word)].filter((part) => part !== "").join("_") || "grant";
}

/** Whether a whole-word match for a word is a payment or an account deletion: never grantable, so never offered (§19.2). */
export const neverGrantable = (word: string, block: string[]): boolean => neverReason(word, block) !== null;

/** Whether a local time of day (minutes since midnight) falls in the quiet window, which may cross midnight. */
function inQuiet(quiet: { from: string; to: string }, minutes: number): boolean {
  const from = minutesOf(quiet.from) ?? 0;
  const to = minutesOf(quiet.to) ?? 0;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
