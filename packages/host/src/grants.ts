import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AuditSink } from "./auditlog.js";
import { listsFor, matchWord, policySchema } from "./policy.js";

/**
 * AGENT-TOOLS 1.14 §19: grants. A person's standing OK for a kind of touch, with limits, given ahead of time. A grant lives
 * in the policy file (version 2), is counted in `<policy file>.state.json` under `<policy file>.state.lock`, and every use is a
 * line of the audit log (§23). Only a person makes a grant; nothing here creates, edits or lifts one.
 */

/** The most days away a grant's `until` may be, counted from the day the file is loaded (§19.1). */
export const GRANT_MAX_DAYS = 30;
/** A lock older than this is taken over (§19.4). */
export const LOCK_STALE_MS = 30_000;

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

/** ISO 8601 in local time with its offset, as §19.4's state file keeps it. */
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
  raw.forEach((item: unknown, index) => {
    const parsed = rawGrant.safeParse(item);
    const label = parsed.success && typeof parsed.data.name === "string" && parsed.data.name.trim() !== "" ? parsed.data.name : `#${index + 1}`;
    const refuse = (reason: string): void => {
      refused.push({ name: label, reason });
    };
    if (!parsed.success) return refuse("it isn't an object.");
    const g = parsed.data;
    if (label.startsWith("#")) return refuse("name is missing.");
    if (seen.has(label)) return refuse("name is already used by an earlier grant.");
    seen.add(label);
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

// -- the state file (§19.4)

const stateSchema = z.object({ version: z.literal(1), uses: z.record(z.string(), z.record(z.string(), z.array(z.string()))) });
type Uses = Record<string, Record<string, string[]>>;

/** What the touch is, for a grant to match: the app, the element's own label and text, and the saved routes running now. */
export interface GrantTouch {
  app: { id?: string; name: string };
  element: { label?: string | null; text?: string | null };
  routes: string[];
}

export type GrantDecision =
  /** `stamp` and `date` name the recorded use, so `release` can take it back when the touch wasn't made. */
  | { kind: "covered"; name: string; line: string; /** `2 of 3`, for a dry run's words. */ counts: string; counted: boolean; stamp: string; date: string }
  /** The touch asks a person; `notes` say why a grant that matched didn't cover it (§19.3). */
  | { kind: "ask"; notes: string[] };

/** What a look at the policy file and the state file found, for `doctor` and the first answer (§19.1, §19.4). */
export interface GrantReport {
  /** False when the policy file can't be read or parsed any more: no grant covers anything. */
  fileOk: boolean;
  grants: Grant[];
  refused: GrantRefusal[];
  /** The state file doesn't parse: every grant counts as used up. */
  stateBroken: boolean;
}

export interface GrantBookOptions {
  policyPath: string;
  /** The audit log. Without one no grant covers a touch: a grant needs its line (§23). */
  audit: AuditSink | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  staleMs?: number;
}

const LOCK_TRIES = 300;
const LOCK_WAIT_MS = 20;
const RENAME_TRIES = 5;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

export class GrantBook {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly staleMs: number;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(private readonly options: GrantBookOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    this.staleMs = options.staleMs ?? LOCK_STALE_MS;
    this.statePath = `${options.policyPath}.state.json`;
    this.lockPath = `${options.policyPath}.state.lock`;
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

  /** The state file's uses; null when it doesn't parse (it is left alone, §19.4). A missing file is no uses. */
  private async readState(): Promise<Uses | null> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      return errorCode(error) === "ENOENT" ? {} : null;
    }
    try {
      const parsed = stateSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.uses : null;
    } catch {
      return null;
    }
  }

  /** Every grant, what was refused, and whether the state file is broken: for `doctor` and the session's first answer. */
  async inspect(): Promise<GrantReport> {
    const policy = await this.readPolicy();
    const state = await this.readState();
    return { fileOk: policy !== null, grants: policy?.grants ?? [], refused: policy?.refused ?? [], stateBroken: state === null };
  }

  /** The `Note:` lines of an inspection: each refused grant, and a state file that doesn't parse. */
  static noticeLines(report: GrantReport): string[] {
    const lines = report.refused.map(refusalLine);
    if (!report.fileOk) lines.push("Note: the policy file can't be read now, so no grant covers anything; every touch asks a person.");
    if (report.stateBroken) lines.push("Note: the grants' state file doesn't parse, so every grant counts as used up and every touch asks a person.");
    return lines;
  }

  /**
   * Whether a grant covers this touch (§19.3). Called where the host has decided the touch needs a person: a covered touch goes
   * through, and anything else asks as before, with the notes. `use` records the use under the lock and writes the audit line
   * first; `peek` records and writes nothing (a dry run, and the check before a dialog). `detail` is what the audit line says.
   */
  async decide(touch: GrantTouch, mode: "use" | "peek", detail: string): Promise<GrantDecision> {
    const policy = await this.readPolicy();
    if (policy === null) return { kind: "ask", notes: [] };
    // Never grantable, whatever the file says: a touch on a payment or an account deletion always asks (§19.2).
    if (matchWord([...PAYMENT_WORDS, ...ACCOUNT_WORDS], touch.element) !== null) return { kind: "ask", notes: [] };
    const at = this.now();
    const today = localDate(at);
    const minutes = at.getHours() * 60 + at.getMinutes();
    const notes: string[] = [];
    for (const grant of policy.grants) {
      if (grant.app !== touch.app.id && grant.app !== touch.app.name) continue;
      if (matchWord(grant.words, touch.element) === null) continue;
      if (grant.route !== undefined && !touch.routes.includes(grant.route)) continue;
      // A draftsOnly grant stops before the touch and shows a draft (§21.3, task A2): until that is built it covers nothing.
      if (grant.draftsOnly) continue;
      const name = JSON.stringify(grant.name);
      const doesnt = (why: string): string => `Note: grant ${name} doesn't cover this (${why}); asking a person.`;
      if (grant.revoked !== undefined) {
        notes.push(doesnt(`it was revoked on ${grant.revoked}`));
        continue;
      }
      if (today > grant.until) {
        notes.push(doesnt(`it ended on ${grant.until}`));
        continue;
      }
      if (grant.quiet !== undefined && inQuiet(grant.quiet, minutes)) {
        notes.push(doesnt(`quiet hours ${grant.quiet.from} to ${grant.quiet.to}`));
        continue;
      }
      const counted = mode === "use" ? await this.use(grant, at, detail, touch.app, policy.grants) : await this.peek(grant, at);
      if (counted === null) continue;
      if (typeof counted === "string") {
        notes.push(doesnt(counted));
        continue;
      }
      return { kind: "covered", name: grant.name, counts: `${counted.today} of ${grant.perDay}`, counted: mode === "use", stamp: counted.stamp, date: counted.date, line: `Note: allowed by grant ${name} (${counted.today} of ${grant.perDay} today).` };
    }
    return { kind: "ask", notes };
  }

  /** A use taken back: the touch wasn't made after all (§19.4: a use is counted when the touch is made). */
  async release(use: { name: string; stamp: string; date: string }): Promise<void> {
    await this.withLock(async () => {
      const uses = await this.readState();
      if (uses === null) return;
      const list = uses[use.name]?.[use.date];
      const at = list?.indexOf(use.stamp) ?? -1;
      if (list === undefined || at < 0) return;
      list.splice(at, 1);
      if (list.length === 0 && uses[use.name] !== undefined) delete uses[use.name]?.[use.date];
      await this.writeState(uses);
    });
  }

  /** Counts as the state file has them: today's, and the last hour's (a rolling 60 minutes). */
  private counts(uses: Uses, grant: Grant, at: Date): { today: number; hour: number } {
    const mine = uses[grant.name] ?? {};
    const today = (mine[localDate(at)] ?? []).length;
    const since = at.getTime() - 3_600_000;
    const yesterday = localDate(new Date(at.getTime() - 86_400_000));
    const recent = [...(mine[yesterday] ?? []), ...(mine[localDate(at)] ?? [])].filter((stamp) => {
      const ms = Date.parse(stamp);
      return !Number.isNaN(ms) && ms > since && ms <= at.getTime();
    });
    return { today, hour: recent.length };
  }

  /** The limit that stops a use as words for the note, or null when there is room. */
  private limit(grant: Grant, counts: { today: number; hour: number }): string | null {
    if (counts.today >= grant.perDay) return `${counts.today} of ${grant.perDay} today`;
    if (grant.perHour !== undefined && counts.hour >= grant.perHour) return `${counts.hour} of ${grant.perHour} this hour`;
    return null;
  }

  /** A string: the limit that stopped it. null: it can't be counted (a broken state file), nothing to say. */
  private async peek(grant: Grant, at: Date): Promise<{ today: number; stamp: string; date: string } | string | null> {
    const uses = await this.readState();
    if (uses === null) return null;
    const counts = this.counts(uses, grant, at);
    return this.limit(grant, counts) ?? { today: counts.today + 1, stamp: "", date: localDate(at) };
  }

  /** Takes the lock, reads the file, checks the counts, writes the audit line, records the use, writes the file: one step (§19.4). */
  private async use(grant: Grant, at: Date, detail: string, app: { id?: string; name: string }, all: Grant[]): Promise<{ today: number; stamp: string; date: string } | string | null> {
    const audit = this.options.audit;
    if (audit === null) return null;
    const done = await this.withLock(async () => {
      const uses = await this.readState();
      // A state file that doesn't parse is left alone; every grant is used up (§19.4).
      if (uses === null) return null;
      const counts = this.counts(uses, grant, at);
      const stopped = this.limit(grant, counts);
      if (stopped !== null) return stopped;
      const stamp = localIso(at);
      const date = localDate(at);
      const count = counts.today + 1;
      // A grant needs its line: when it can't be written, the grant doesn't cover the touch (§23).
      if (!audit.write({ kind: "grant", app: app.id ?? app.name, name: grant.name, detail: `${detail} (${count} of ${grant.perDay} today)` })) return null;
      const mine = (uses[grant.name] ??= {});
      (mine[date] ??= []).push(stamp);
      this.prune(uses, date, all);
      try {
        await this.writeState(uses);
      } catch {
        return null;
      }
      return { today: count, stamp, date };
    });
    return done ?? null;
  }

  /** Entries are pruned after the grant's `until` (§19.4). */
  private prune(uses: Uses, today: string, grants: Grant[]): void {
    for (const grant of grants) {
      if (today > grant.until) delete uses[grant.name];
    }
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T | null> {
    if (!(await this.acquire())) return null;
    try {
      return await run();
    } finally {
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async acquire(): Promise<boolean> {
    for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
      let handle;
      try {
        handle = await open(this.lockPath, "wx");
      } catch (error) {
        const code = errorCode(error);
        // Windows says EPERM or EBUSY while a rival's delete of the lock is under way: it is held.
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") return false;
        if (await this.stale()) await this.reclaim();
        else await this.sleep(LOCK_WAIT_MS);
        continue;
      }
      try {
        await handle.writeFile(`${process.pid} ${this.now().toISOString()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    }
    return false;
  }

  private async stale(): Promise<boolean> {
    try {
      return this.now().getTime() - (await stat(this.lockPath)).mtimeMs > this.staleMs;
    } catch {
      return false;
    }
  }

  /** Takes a lock that looked stale by renaming it away, so only one reclaimer wins. */
  private async reclaim(): Promise<void> {
    const grabbed = `${this.lockPath}.${randomBytes(4).toString("hex")}.stale`;
    try {
      await rename(this.lockPath, grabbed);
    } catch {
      return; // someone else reclaimed it first, or its holder released it
    }
    try {
      const madeAt = (await stat(grabbed)).mtimeMs;
      if (this.now().getTime() - madeAt <= this.staleMs) {
        // It was fresh after all (it changed hands between our look and our rename): give it back.
        const text = await readFile(grabbed, "utf8").catch(() => "");
        await writeFile(this.lockPath, text, { flag: "wx" }).catch(() => undefined);
      }
    } finally {
      await rm(grabbed, { force: true }).catch(() => undefined);
    }
  }

  /** A temporary file and a rename, with retries on Windows (§19.4). */
  private async writeState(uses: Uses): Promise<void> {
    const temp = `${this.statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, uses }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, this.statePath);
          return;
        } catch (error) {
          const code = errorCode(error);
          if ((code !== "EPERM" && code !== "EBUSY") || attempt >= RENAME_TRIES) throw error;
          await this.sleep(LOCK_WAIT_MS);
        }
      }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Whether a local time of day (minutes since midnight) falls in the quiet window, which may cross midnight. */
function inQuiet(quiet: { from: string; to: string }, minutes: number): boolean {
  const from = minutesOf(quiet.from) ?? 0;
  const to = minutesOf(quiet.to) ?? 0;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
