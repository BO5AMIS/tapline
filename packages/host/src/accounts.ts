import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { z } from "zod";
import { stable } from "./mapfile.js";
import { openProtected, peekFile, plainWarning, realVaultDeps, VaultOpenError, type VaultDeps } from "./vault.js";

/**
 * The vault (AGENT-TOOLS 1.14 §20, which grew out of the test accounts of 1.13 §18.6). The file holds real test credentials
 * and personal data, so this module is built to keep them from the agent: a plain file is refused inside a git work tree that
 * doesn't ignore it, a value is typed only as the whole text of a step, and `redact` scrubs every value from what the app sends
 * back. A version 1 accounts file still loads; each of its entries is an `account`.
 */

/** The name a version 1 account may have (kept as it was); version 2 names are ASCII letters, digits and `_`. */
const ACCOUNT_NAME = /^[\w.-]{1,60}$/;
const ENTRY_NAME = /^[A-Za-z0-9_]{1,60}$/;

// Fail closed: a secret field (password, username, card number, expiry, cvc, a note's text, an identity's phone, email and
// birthday) shorter than 3 characters is refused at load, because a value that short is not scrubbed. The message quotes no value.
const SHORT = "must be at least 3 characters, because a shorter secret can't be scrubbed from answers without garbling other text";
/**
 * A value shorter than this is held and typed, but not scrubbed: a country code such as `QA` would garble every answer. Only
 * non-secret fields (an address's street, city, postcode and country, an identity's name) may be that short; every secret
 * field is refused below this length at load.
 */
const MIN_SCRUB = 3;

// -- kinds and fields (§20.1)

export const VAULT_KINDS = ["account", "card", "address", "identity", "note", "phone"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/** The fields each kind has. `phone` is Tapwright's: Tapline holds it and never types it. */
export const KIND_FIELDS: Record<VaultKind, readonly string[]> = {
  account: ["username", "password"],
  card: ["number", "expiry", "cvc"],
  address: ["street", "city", "postcode", "country"],
  identity: ["name", "phone", "email", "birthday"],
  note: ["text"],
  phone: ["passcode"],
};

const secret = z.string().min(3, SHORT);
const plain = z.string().min(1);
const apps = z.array(z.string().min(1)).optional();

const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), username: secret.optional(), password: secret.optional(), apps }),
  z.object({ kind: z.literal("card"), number: secret.optional(), expiry: secret.optional(), cvc: secret.optional(), apps }),
  z.object({ kind: z.literal("address"), street: plain.optional(), city: plain.optional(), postcode: plain.optional(), country: plain.optional(), apps }),
  z.object({ kind: z.literal("identity"), name: plain.optional(), phone: secret.optional(), email: secret.optional(), birthday: secret.optional(), apps }),
  z.object({ kind: z.literal("note"), text: secret.optional(), apps }),
  z.object({ kind: z.literal("phone"), passcode: plain.optional(), apps }),
]);

/** Version 2 (§20.1). A top-level `otp` key is Tapwright's and is ignored here. */
export const vaultFileSchema = z.object({
  version: z.literal(2),
  vault: z.record(z.string().regex(ENTRY_NAME, "entry names use ASCII letters, digits and '_'"), entrySchema),
});
export type VaultFile = z.infer<typeof vaultFileSchema>;

const accountSchema = z.object({
  username: secret.optional(),
  password: secret.optional(),
  /** Tapwright's: the phone's passcode. Tapline loads it without complaint and never types it. */
  passcode: z.string().min(1).optional(),
  apps,
});

/** Version 1 (§18.6). */
export const accountsFileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string().regex(ACCOUNT_NAME, "account names use letters, digits, '.', '_' and '-'"), accountSchema),
});
export type AccountsFile = z.infer<typeof accountsFileSchema>;

/** An entry as the store holds it, whatever file version it came from. */
export interface VaultEntry {
  kind: VaultKind;
  values: Record<string, string>;
  apps?: string[];
}

/** Where `value=` and the other answers name a value: `<home's street>`. */
export function placeholderOf(name: string, field: string): string {
  return `<${name}'s ${field}>`;
}

export type AccountField = "username" | "password";

export type AccountResolved = { ok: true; value: string } | { ok: false; code: "not_found" | "bad_params"; message: string };

export interface AccountStore {
  /** The entries' names, never their values. */
  names(): string[];
  /** What kind an entry is. */
  kindOf(name: string): VaultKind | undefined;
  /** One value of an account, for an app (`${account.<field>}`: the call's `account` names the entry, and it is an `account`). */
  resolve(name: string, field: string, appId: string): AccountResolved;
  /** One value of any entry, for an app (`${vault.<name>.<field>}`). */
  resolveEntry(name: string, field: string, appId: string): AccountResolved;
  /** Replaces every vault value with its placeholder, such as `<tester2's username>` or `<home's street>`. */
  redact(text: string): string;
}

/** What the vault file gave: its entries (and the plain file's warning), or why none were loaded. */
export type AccountsLoad =
  | {
      store: AccountStore;
      note?: string;
      /**
       * HMAC-SHA256 under `key` of the vault's canonical JSON as it was decrypted (every value and every per-app permission), so two
       * loads of the same vault agree and a changed one differs, while nothing in it can be guessed from the hash alone.
       */
      fingerprint?: (key: string) => string;
    }
  | { store: null; blocked: string };

export interface GitProbe {
  /** Whether the folder is inside a git work tree. */
  insideWorkTree(dir: string): Promise<boolean>;
  /** Whether git ignores the file (a tracked file counts as not ignored). */
  ignored(file: string): Promise<boolean>;
}

function git(args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: 10_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error === null) return done({ code: 0, stdout });
      const code = (error as NodeJS.ErrnoException).code;
      done({ code: typeof code === "number" ? code : null, stdout: "" });
    });
  });
}

/** Whether a folder or one above it holds a `.git`: the answer when git itself can't be run. */
function hasGitAbove(dir: string): boolean {
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, ".git"))) return true;
    const up = dirname(at);
    if (up === at || parse(at).root === at) return false;
    at = up;
  }
}

/** The real probe: the user's own git, run without a shell. When git can't run, a `.git` above the file counts as a work tree. */
export const realGitProbe: GitProbe = {
  async insideWorkTree(dir) {
    const out = await git(["rev-parse", "--is-inside-work-tree"], dir);
    return out.code === 0 ? out.stdout.trim() === "true" : hasGitAbove(dir);
  },
  async ignored(file) {
    return (await git(["check-ignore", "-q", "--", file], dirname(file))).code === 0;
  },
};

/** What the user is told wherever the accounts option is described (the parameter text, `--help`, `doctor`). */
export const ACCOUNTS_WARNING =
  "A password stays out of pictures only while its field is secure; a \"show password\" toggle shows it. Keep the vault file outside the folders the agent may read.";

/** The refusal's words, for the first answer, `doctor` and every use. */
export function blockedMessage(file: string): string {
  return `accounts file is inside the git repo at ${file} and not ignored; move it or add it to .gitignore.`;
}

// -- redaction (§20.3)

/** Invisible direction marks (§3.3) and zero-width characters: the app strips the first, and text can carry the second. */
const INVISIBLE_CLASS = "\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "g");
const INVISIBLE_ANY = new RegExp(`[${INVISIBLE_CLASS}]`);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JSON escaping as a serializer that writes only ASCII produces it (`é`). */
function asciiJson(text: string): string {
  return JSON.stringify(text)
    .slice(1, -1)
    .replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const CUT = 200;

/**
 * The shapes a value can take on its way back: as it is, with direction marks and zero-width characters stripped, with
 * whitespace collapsed (as the app's `normalizeText` leaves it), each of those inside a JSON string (also twice, and with
 * non-ASCII escaped), and in a URL (percent or form encoded, either case of hex). A value the app cuts at 200 characters
 * leaves its first 200.
 */
export function variantsOf(value: string): string[] {
  const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
  const stripped = value.replace(INVISIBLE, "");
  const bases = new Set<string>([value, stripped, collapse(value), collapse(stripped)]);
  for (const base of [...bases]) if (base.length > CUT) bases.add(base.slice(0, CUT));
  const forms = new Set<string>();
  for (const base of bases) {
    const jsons = [base, JSON.stringify(base).slice(1, -1), asciiJson(base), JSON.stringify(JSON.stringify(base)).slice(1, -1)];
    for (const form of jsons) {
      forms.add(form);
      const percent = encodeURIComponent(form);
      forms.add(percent);
      forms.add(percent.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
      forms.add(percent.replace(/%20/g, "+"));
      // URLSearchParams encodes more than encodeURIComponent does (`~` becomes %7E).
      forms.add(new URLSearchParams({ k: form }).toString().slice(2));
    }
  }
  return [...forms].filter((form) => form !== "");
}

/** The value with any whitespace run matching any whitespace and invisible characters allowed between its characters. */
function fuzzySource(value: string): string {
  const gap = `[${INVISIBLE_CLASS}]*`;
  const parts: string[] = [];
  for (const piece of value.split(/(\s+)/)) {
    if (piece === "") continue;
    if (/^\s+$/.test(piece)) parts.push(`[\\s${INVISIBLE_CLASS}]+`);
    else parts.push([...piece].map((c) => escapeRegExp(c)).join(gap));
  }
  return parts.join(gap);
}

/** A hex number as a pattern that takes either case of its letters (`e9` matches `E9`). */
function hexSource(digits: string): string {
  return [...digits].map((d) => (/[a-f]/i.test(d) ? `[${d.toLowerCase()}${d.toUpperCase()}]` : d)).join("");
}

/** What a run of whitespace can come back as: itself, a percent or plus sign, a numeric entity, or a JSON escape. */
const SPACE_SOURCE = `(?:[\\s${INVISIBLE_CLASS}]|%(?:09|0[aA]|0[dD]|20)|\\+|&#0*(?:9|10|13|32);|&#[xX]0*(?:9|a|A|d|D|20);|\\\\{1,2}(?:[nrt]|u00(?:0[9aAdD]|20)))+`;

/** Every way one character can be written: raw, JSON `\uXXXX` (either case, once or twice escaped), percent-encoded, an HTML numeric entity. */
function charSource(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  const alts = [escapeRegExp(ch)];
  const units = [...ch].flatMap((c) => {
    const out: string[] = [];
    for (let i = 0; i < c.length; i++) out.push(c.charCodeAt(i).toString(16).padStart(4, "0"));
    return out;
  });
  alts.push(units.map((u) => `\\\\{1,2}u${hexSource(u)}`).join(""));
  alts.push([...Buffer.from(ch, "utf8")].map((b) => `%${hexSource(b.toString(16).padStart(2, "0"))}`).join(""));
  alts.push(`&#0*${cp};`, `&#[xX]0*${hexSource(cp.toString(16))};`);
  return `(?:${alts.join("|")})`;
}

/** The value in any of its escape forms, character by character, with invisible characters allowed between (§20.3). */
function escapedSource(value: string): string {
  const gap = `[${INVISIBLE_CLASS}]*`;
  const parts: string[] = [];
  for (const piece of value.split(/(\s+)/)) {
    if (piece === "") continue;
    parts.push(/^\s+$/.test(piece) ? SPACE_SOURCE : [...piece].map(charSource).join(gap));
  }
  return parts.join(gap);
}

/** The shortest prefix of a value that is scrubbed alone: what an app's cut leaves of it (§20.3, a fragment of 12 or more). */
const PREFIX_MIN = 12;

/** A text as a run of UTF-16 units, each with the span of the original text it came from (decoding keeps the way back). */
interface View {
  text: string;
  start: number[];
  end: number[];
}

function plainView(text: string): View {
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length; i++) {
    start.push(i);
    end.push(i + 1);
  }
  return { text, start, end };
}

const HEX2 = /^[0-9a-fA-F]{2}$/;

function isHexCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** The direction marks and zero-width characters of INVISIBLE_CLASS, by code. */
function isInvisibleCode(code: number): boolean {
  return code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || (code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff;
}

/** How many bytes the UTF-8 sequence opened by `lead` has (1 for a byte that opens none). */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0 && lead < 0xf8) return 4;
  if (lead >= 0xe0 && lead < 0xf0) return 3;
  if (lead >= 0xc2 && lead < 0xe0) return 2;
  return 1;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", '"': '"', "/": "/", "'": "'" };
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", sol: "/", bsol: "\\", num: "#", percnt: "%", plus: "+", equals: "=" };
const ENTITY = /^&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/;

/**
 * One pass over a view that decodes every escape in it at once, each in a single left-to-right sweep (so the work is linear):
 * a percent run (`%XX` bytes as UTF-8, a byte that is no sequence of its own stays escaped), JSON escapes (`\uXXXX` either hex
 * case, `\n`, `\\`, `\"` ...), HTML entities (numeric of any padding, and the common named ones) and invisible characters (dropped).
 * Every decoded character keeps the span of the bytes it was written with, and only those. `+` is not touched: it can be a form
 * space or a plus, and the matcher accepts either. Null when nothing changed.
 */
function decodePass(view: View): View | null {
  const src = view.text;
  const n = src.length;
  const parts: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let changed = false;
  const put = (piece: string, from: number, to: number): void => {
    parts.push(piece);
    for (let k = 0; k < piece.length; k++) {
      start.push(from);
      end.push(to);
    }
  };
  let i = 0;
  while (i < n) {
    const code = src.charCodeAt(i);
    if (isInvisibleCode(code)) {
      changed = true;
      i += 1;
    } else if (code === 37) {
      // a run of %XX is read once, whole: a byte that decodes to nothing is kept and the sweep goes on past it
      let j = i;
      const bytes: number[] = [];
      while (src.charCodeAt(j) === 37 && isHexCode(src.charCodeAt(j + 1)) && isHexCode(src.charCodeAt(j + 2))) {
        bytes.push(parseInt(src.slice(j + 1, j + 3), 16));
        j += 3;
      }
      if (bytes.length === 0) {
        put("%", view.start[i] as number, view.end[i] as number);
        i += 1;
        continue;
      }
      let b = 0;
      while (b < bytes.length) {
        const at = i + b * 3;
        const lead = bytes[b] as number;
        const need = sequenceLength(lead);
        let piece: string | null = null;
        if (need === 1 && lead < 0x80) piece = String.fromCharCode(lead);
        else if (need > 1 && b + need <= bytes.length) {
          const decoded = Buffer.from(bytes.slice(b, b + need)).toString("utf8");
          if (!decoded.includes("�")) piece = decoded;
        }
        if (piece === null) {
          for (let k = 0; k < 3; k++) put(src[at + k] as string, view.start[at + k] as number, view.end[at + k] as number);
          b += 1;
        } else {
          put(piece, view.start[at] as number, view.end[at + need * 3 - 1] as number);
          changed = true;
          b += need;
        }
      }
      i = j;
    } else if (code === 92) {
      const next = src[i + 1];
      let piece: string | null = null;
      let used = 0;
      if (next === "u" && i + 6 <= n && isHexCode(src.charCodeAt(i + 2)) && isHexCode(src.charCodeAt(i + 3)) && isHexCode(src.charCodeAt(i + 4)) && isHexCode(src.charCodeAt(i + 5))) {
        piece = String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
        used = 6;
      } else if (next !== undefined && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)) {
        piece = SIMPLE_ESCAPES[next] as string;
        used = 2;
      }
      if (piece === null) {
        put("\\", view.start[i] as number, view.end[i] as number);
        i += 1;
      } else {
        put(piece, view.start[i] as number, view.end[i + used - 1] as number);
        changed = true;
        i += used;
      }
    } else if (code === 38) {
      const m = ENTITY.exec(src.slice(i, i + 16));
      let piece: string | undefined;
      if (m !== null) {
        if (m[1] !== undefined || m[2] !== undefined) {
          const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2] as string, 16);
          piece = cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
        } else {
          const name = (m[3] as string).toLowerCase();
          piece = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : undefined;
        }
      }
      if (m === null || piece === undefined) {
        put("&", view.start[i] as number, view.end[i] as number);
        i += 1;
      } else {
        put(piece, view.start[i] as number, view.end[i + m[0].length - 1] as number);
        changed = true;
        i += m[0].length;
      }
    } else {
      parts.push(src[i] as string);
      start.push(view.start[i] as number);
      end.push(view.end[i] as number);
      i += 1;
    }
  }
  return changed ? { text: parts.join(""), start, end } : null;
}

/** How many decoding passes at most: each layer of encoding takes one, and a text with more is not one a person wrote. */
const MAX_LAYERS = 8;
const ESCAPE_HINT = new RegExp(`[%\\\\&${INVISIBLE_CLASS}]`);

/**
 * The text and what it decodes to, pass after pass, until nothing more decodes (at most MAX_LAYERS passes, each linear in the
 * text). Every layer in any nesting order (HTML, JSON, percent) is undone by the passes together; the stages are all kept, so
 * a text that was only partly encoded is read as it stands at each stage too.
 */
function viewsOf(text: string): View[] {
  const views: View[] = [plainView(text)];
  if (!ESCAPE_HINT.test(text)) return views;
  for (let layer = 0; layer < MAX_LAYERS; layer++) {
    const next = decodePass(views[views.length - 1] as View);
    if (next === null || next.text === (views[views.length - 1] as View).text) break;
    views.push(next);
  }
  return views;
}

/** The view without invisible characters, each whitespace run as one space. */
function normalizedView(view: View): View {
  const parts: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let inSpace = false;
  for (let i = 0; i < view.text.length; i++) {
    const c = view.text[i] as string;
    if (isInvisibleCode(view.text.charCodeAt(i))) continue;
    const space = /\s/.test(c);
    if (space && inSpace) {
      end[end.length - 1] = view.end[i] as number;
      continue;
    }
    inSpace = space;
    parts.push(space ? " " : c);
    start.push(view.start[i] as number);
    end.push(view.end[i] as number);
  }
  return { text: parts.join(""), start, end };
}

/** How much of a half-written escape (a cut in the middle of `%C3%A`, `\u00`, `&#x`) follows `at`: it belongs to the fragment. */
function dangling(text: string, at: number): number {
  const rest = text.slice(at, at + 64);
  const percent = /^%(?:[0-9a-fA-F](?![0-9a-fA-F]))?/.exec(rest);
  if (percent !== null && !HEX2.test(rest.slice(1, 3))) return percent[0].length;
  const json = /^\\{1,2}u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/.exec(rest);
  if (json !== null) return json[0].length;
  const entity = /^&#?[xX]?[0-9a-fA-F]*(?![0-9a-fA-F;])/.exec(rest);
  if (entity !== null && entity[0].length > 1 && /^&#/.test(rest)) return entity[0].length;
  const run = /^(?:%[0-9a-fA-F]{2})+/.exec(rest);
  if (run !== null) {
    const bytes: number[] = [];
    for (let k = 0; k < run[0].length; k += 3) bytes.push(parseInt(run[0].slice(k + 1, k + 3), 16));
    let b = 0;
    while (b < bytes.length) {
      const need = sequenceLength(bytes[b] as number);
      if (b + need > bytes.length) return (bytes.length - b) * 3;
      b += need;
    }
  }
  return 0;
}

interface Span {
  start: number;
  end: number;
  token: string;
}

/** A value as the decoded views search for it: its first 12 characters (all of it when shorter), a space also matching a form plus. */
interface Probe {
  base: string;
  token: string;
  head: RegExp;
}

function probeOf(base: string, token: string): Probe {
  const head = base.slice(0, PREFIX_MIN);
  return { base, token, head: new RegExp([...head].map((c) => (c === " " ? "[ +]" : escapeRegExp(c))).join(""), "g") };
}

const sameChar = (seen: string | undefined, wanted: string | undefined): boolean => seen === wanted || (wanted === " " && seen === "+");

/**
 * Every place a decoded view holds a value (all of it, when it is shorter than 12 characters) or a prefix of 12 or more of its
 * characters: the first 12 and as many more as the text goes on to match. The span is the original text of those characters.
 */
function probeSpans(views: readonly View[], probe: Probe, out: Span[]): void {
  const { base, head, token } = probe;
  const need = Math.min(PREFIX_MIN, base.length);
  for (const view of views) {
    if (view.text.length < need) continue;
    head.lastIndex = 0;
    for (let m = head.exec(view.text); m !== null; m = head.exec(view.text)) {
      const from = m.index;
      head.lastIndex = from + 1;
      let len = need;
      while (len < base.length && sameChar(view.text[from + len], base[len])) len++;
      const last = from + len - 1;
      const extra = dangling(view.text, last + 1);
      out.push({ start: view.start[from] as number, end: view.end[last + extra] as number, token });
    }
  }
}

/**
 * Every value's every form, found in one pass and cut into spans. Where spans overlap the leftmost wins (the longest of those
 * that start together), and one that runs past its end is scrubbed beyond it too, so no fragment of a longer value survives a
 * shorter one. A placeholder is never scrubbed again.
 */
function scrubber(entries: Record<string, VaultEntry>, tokenOf: (name: string, field: string) => string = placeholderOf): (text: string) => string {
  const literals = new Map<string, string>();
  const patterns = new Map<string, string>();
  const bases = new Map<string, string>();
  for (const [name, entry] of Object.entries(entries)) {
    for (const [field, value] of Object.entries(entry.values)) {
      if (value.length < MIN_SCRUB) continue;
      const token = tokenOf(name, field);
      for (const form of variantsOf(value)) if (!literals.has(form)) literals.set(form, token);
      const collapsed = value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
      const addPattern = (source: string): void => {
        if (!patterns.has(source)) patterns.set(source, token);
      };
      if (value.length <= 500) for (const base of new Set([value, collapsed])) if (base.length >= MIN_SCRUB) addPattern(fuzzySource(base));
      if (value.length <= 2000) for (const base of new Set([value, collapsed])) if (base.length >= MIN_SCRUB) addPattern(escapedSource(base));
      // The value whole, and what an app's cut leaves of it (a prefix of 12 or more characters), in every layer of encoding.
      if (collapsed.length >= MIN_SCRUB && !bases.has(collapsed)) bases.set(collapsed, token);
    }
  }
  const regexes = [...patterns].map(([source, token]) => ({ re: new RegExp(`(?=(${source}))`, "g"), token }));
  const forms = [...literals];
  const probes = [...bases].map(([base, token]) => probeOf(base, token));
  if (forms.length === 0 && regexes.length === 0 && probes.length === 0) return (text) => text;
  return (text) => {
    if (text.length < MIN_SCRUB) return text;
    const spans: Span[] = [];
    for (const [form, token] of forms) {
      let at = text.indexOf(form);
      while (at !== -1) {
        spans.push({ start: at, end: at + form.length, token });
        at = text.indexOf(form, at + 1);
      }
    }
    for (const { re, token } of regexes) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const got = (m[1] as string).length;
        if (got > 0) spans.push({ start: m.index, end: m.index + got, token });
      }
    }
    if (probes.length > 0) {
      const views = viewsOf(text).map(normalizedView);
      for (const probe of probes) probeSpans(views, probe, spans);
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let cursor = 0;
    let last = "";
    for (const span of spans) {
      if (span.end <= cursor) continue;
      if (span.start >= cursor) out += text.slice(cursor, span.start) + span.token;
      else if (span.token !== last) out += span.token;
      last = span.token;
      cursor = span.end;
    }
    return out + text.slice(cursor);
  };
}

/**
 * A scrubber for loose values that are not vault entries (a one-time code, AGENT-TOOLS 1.14 §20.4): each shows as `token`.
 * The same forms and the same minimum length as a vault value.
 */
export function looseScrubber(values: readonly string[], token: string): (text: string) => string {
  const entries: Record<string, VaultEntry> = {};
  values.forEach((value, i) => {
    entries[`v${i}`] = { kind: "note", values: { text: value } };
  });
  return scrubber(entries, () => token);
}

function normalizedEntries(file: AccountsFile | VaultFile): Record<string, VaultEntry> {
  const out: Record<string, VaultEntry> = {};
  if (file.version === 1) {
    for (const [name, account] of Object.entries(file.accounts)) {
      const values: Record<string, string> = {};
      for (const field of ["username", "password", "passcode"] as const) {
        const value = account[field];
        if (value !== undefined) values[field] = value;
      }
      const onlyPasscode = values["passcode"] !== undefined && values["username"] === undefined && values["password"] === undefined;
      out[name] = { kind: onlyPasscode ? "phone" : "account", values, ...(account.apps !== undefined ? { apps: account.apps } : {}) };
    }
    return out;
  }
  for (const [name, entry] of Object.entries(file.vault)) {
    const { kind, apps: appList, ...fields } = entry;
    const values: Record<string, string> = {};
    for (const [field, value] of Object.entries(fields)) if (typeof value === "string") values[field] = value;
    out[name] = { kind, values, ...(appList !== undefined ? { apps: appList } : {}) };
  }
  return out;
}

function has(entries: Record<string, VaultEntry>, name: string): VaultEntry | undefined {
  return Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : undefined;
}

const PASSCODE_NOTE = "an account's passcode is typed only by Tapwright on a locked phone's keypad; Tapline never types it.";

function storeOf(entries: Record<string, VaultEntry>): AccountStore {
  const scrub = scrubber(entries);
  const names = Object.keys(entries);
  const list = (word: string): string => (names.length === 0 ? "the vault file has none" : `the ${word} are ${names.join(", ")}`);
  const forApp = (entry: VaultEntry, appId: string): string | null =>
    entry.apps !== undefined && !entry.apps.includes(appId) ? `isn't for this app (${appId}); it is for ${entry.apps.join(", ")}.` : null;
  return {
    names: () => [...names],
    kindOf: (name) => has(entries, name)?.kind,
    redact: scrub,
    resolve(name, field, appId) {
      const entry = has(entries, name);
      if (entry === undefined) return { ok: false, code: "not_found", message: `no account "${name}"; ${list("accounts")}.` };
      if (entry.kind !== "account" && entry.kind !== "phone") {
        return { ok: false, code: "bad_params", message: `"account": "${name}" names ${entry.kind === "address" ? "an" : "a"} ${entry.kind} entry; "account" names account entries only (use \${vault.${name}.<field>}).` };
      }
      const wrong = forApp(entry, appId);
      if (wrong !== null) return { ok: false, code: "bad_params", message: `account "${name}" ${wrong}` };
      const value = entry.values[field];
      if (value === undefined) return { ok: false, code: "bad_params", message: `account "${name}" has no ${field}.` };
      return { ok: true, value };
    },
    resolveEntry(name, field, appId) {
      const entry = has(entries, name);
      if (entry === undefined) return { ok: false, code: "not_found", message: `no vault entry "${name}"; ${list("entries")}.` };
      if (entry.kind === "phone") return { ok: false, code: "bad_params", message: PASSCODE_NOTE };
      if (!KIND_FIELDS[entry.kind].includes(field)) {
        return { ok: false, code: "bad_params", message: `vault entry "${name}" is ${entry.kind === "address" ? "an" : "a"} ${entry.kind}; its fields are ${KIND_FIELDS[entry.kind].join(", ")}.` };
      }
      const wrong = forApp(entry, appId);
      if (wrong !== null) return { ok: false, code: "bad_params", message: `vault entry "${name}" ${wrong}` };
      const value = entry.values[field];
      if (value === undefined) return { ok: false, code: "bad_params", message: `vault entry "${name}" has no ${field}.` };
      return { ok: true, value };
    },
  };
}

/** The store of a version 1 file (the accounts of §18.6). */
export function accountStore(file: AccountsFile): AccountStore {
  return storeOf(normalizedEntries(file));
}

/** The store of a version 2 file (§20.1). */
export function vaultStore(file: VaultFile): AccountStore {
  return storeOf(normalizedEntries(file));
}

/**
 * Reads the vault file. A plain file inside a git work tree that doesn't ignore it is not loaded (a protected file holds no
 * value, so that rule doesn't apply to it). A protected file that can't be opened loads nothing and says why. A file that
 * can't be read or isn't the format throws a plain message that never quotes the file (it holds secrets).
 */
export async function loadAccounts(file: string, probe: GitProbe = realGitProbe, deps: VaultDeps = realVaultDeps()): Promise<AccountsLoad> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`the vault file ${path} doesn't exist`);
  // Through a symlink or a junction the file may really sit in a repo: ask about where it is.
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // the path stands
  }
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    throw new Error(`the vault file ${path} can't be read`);
  }
  const peek = peekFile(text);
  let json: unknown;
  if (peek?.protected !== undefined) {
    try {
      json = JSON.parse(await openProtected(real, peek, deps));
    } catch (error) {
      if (error instanceof VaultOpenError) return { store: null, blocked: `the vault file can't be opened: ${error.message.replace(/[.\s]+$/, "")}.` };
      throw new Error(`the vault file ${path} was opened, but what it holds isn't valid JSON`);
    }
  } else {
    // A `.git` folder in the path is a repo's own files, which no .gitignore covers.
    const inGitDir = real.split(/[\\/]/).includes(".git");
    if (inGitDir || ((await probe.insideWorkTree(dirname(real))) && !(await probe.ignored(real)))) {
      return { store: null, blocked: blockedMessage(path) };
    }
    try {
      json = JSON.parse(text);
    } catch {
      // Node's own message quotes part of the text, and this file holds passwords.
      throw new Error(`the vault file ${path} isn't valid JSON`);
    }
  }
  const version = typeof json === "object" && json !== null ? (json as { version?: unknown }).version : undefined;
  const parsed = version === 2 ? vaultFileSchema.safeParse(json) : accountsFileSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ");
    throw new Error(`the vault file ${path} isn't the right format: ${why}`);
  }
  const entries = normalizedEntries(parsed.data);
  const store = storeOf(entries);
  const fingerprint = (key: string): string => createHmac("sha256", key).update(stable(entries)).digest("hex");
  return peek?.protected === undefined ? { store, note: plainWarning(path), fingerprint } : { store, fingerprint };
}

/**
 * Scrubs every string in a JSON value (an app's answer), keeping its shape. Property names are scrubbed too; two names
 * that come out the same stay apart with a numbered suffix.
 */
export function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const base = redact(key);
      let name = base;
      for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n++) name = `${base} #${n}`;
      // defineProperty keeps a name like "__proto__" an ordinary key.
      Object.defineProperty(out, name, { value: redactValue(item, redact), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/**
 * The backstop at a writer of files (§20.3): scrubs the content values of a JSON value, never its keys, so a script keeps
 * its tool names and its `${vault.home.street}` placeholders.
 */
export function redactContent(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") {
    // `${…}` is syntax (a placeholder, a variable): only the text between is content.
    return value
      .split(/(\$\{[^}]*\})/)
      .map((piece) => (piece.startsWith("${") && piece.endsWith("}") ? piece : redact(piece)))
      .join("");
  }
  if (Array.isArray(value)) return value.map((item) => redactContent(item, redact));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, CONTENT_FREE.has(key) ? item : redactContent(item, redact)]));
  }
  return value;
}

/** Keys whose values are the tool's own words (a tool or method name, a time, a format), never a typed or shown value. */
const CONTENT_FREE = new Set(["t", "tool", "source", "method", "format", "version", "kind", "app", "name", "start", "end", "route", "variables"]);

const WHOLE_ACCOUNT = /^\$\{account\.(\w+)\}$/;
const WHOLE_VAULT = /^\$\{vault\.(\w+)\.(\w+)\}$/;
const VAULT_ANY = /^\$\{vault\.[^}]*\}$/;

/** Whether a text refers to the vault (`${account.…}`, `${vault.…}`) or to a one-time code (`${otp.<app>}`, §20.4). */
export function mentionsVault(text: string): boolean {
  return text.includes("${account.") || text.includes("${vault.") || text.includes("${otp.");
}

/** What a reference named: which entry and field, and its kind. */
export interface VaultUse {
  name: string;
  kind: VaultKind;
  field: string;
}

export type AccountText =
  | { ok: true; text: string; field: string | null; use?: VaultUse }
  | { ok: false; code: "not_found" | "bad_params"; message: string };

/**
 * `${account.username}`, `${account.password}` or `${vault.<name>.<field>}` becomes the value, but only when it is the whole
 * text: joined with other text it could get a password past the secure-field rule. Text without a reference passes unchanged
 * (field null).
 */
export function substituteAccount(text: string, store: AccountStore, name: string | undefined, appId: string): AccountText {
  // A one-time code is fetched and typed by the tool itself (otpclient.ts); text that reaches here isn't one it can type.
  if (text.includes("${otp.")) {
    const alone = /^\$\{otp\.[^}]+\}$/.test(text);
    return { ok: false, code: "bad_params", message: alone ? "a one-time code takes no account; write ${otp.<app>} alone." : "a one-time code is the whole text of a step, not part of one." };
  }
  const vault = WHOLE_VAULT.exec(text);
  if (vault !== null) {
    const entry = vault[1] ?? "";
    const field = vault[2] ?? "";
    const resolved = store.resolveEntry(entry, field, appId);
    if (!resolved.ok) return resolved;
    const kind = store.kindOf(entry);
    if (kind === undefined) return { ok: false, code: "not_found", message: `no vault entry "${entry}".` };
    return { ok: true, text: resolved.value, field, use: { name: entry, kind, field } };
  }
  if (VAULT_ANY.test(text)) {
    return { ok: false, code: "bad_params", message: "a vault value is written \${vault.<name>.<field>}, for example \${vault.home.street}." };
  }
  const whole = WHOLE_ACCOUNT.exec(text);
  if (whole === null) {
    if (text.includes("${vault.")) return { ok: false, code: "bad_params", message: "a vault value is the whole text of a step, not part of one." };
    if (text.includes("${account.")) return { ok: false, code: "bad_params", message: "an account value is the whole text of a step, not part of one." };
    return { ok: true, text, field: null };
  }
  const field = whole[1];
  if (field === "passcode") return { ok: false, code: "bad_params", message: PASSCODE_NOTE };
  if (field !== "username" && field !== "password") {
    return { ok: false, code: "bad_params", message: `\${account.${field ?? ""}} isn't a value an account has; use \${account.username} or \${account.password}.` };
  }
  if (name === undefined) {
    return { ok: false, code: "bad_params", message: `name the account: add "account": "<name>" (${store.names().length === 0 ? "the vault file has none" : `the entries are ${store.names().join(", ")}`}).` };
  }
  const resolved = store.resolve(name, field, appId);
  return resolved.ok ? { ok: true, text: resolved.value, field } : resolved;
}
