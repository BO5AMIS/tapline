import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { z } from "zod";

/**
 * Test accounts (AGENT-TOOLS 1.13 §18.6). The file holds real test credentials, so this module is built to keep them
 * from the agent: the file is refused inside a git work tree that doesn't ignore it, a value is typed only as the
 * whole text of a step, and `redact` scrubs every value from what the app sends back.
 */

const ACCOUNT_NAME = /^[\w.-]{1,60}$/;

// A shorter value would be scrubbed out of unrelated text. The message quotes no value.
const SHORT = "must be at least 3 characters, so scrubbing it can't garble other text";

const accountSchema = z.object({
  username: z.string().min(3, SHORT).optional(),
  password: z.string().min(3, SHORT).optional(),
  /** Tapwright's: the phone's passcode. Tapline loads it without complaint and never types it. */
  passcode: z.string().min(1).optional(),
  apps: z.array(z.string().min(1)).optional(),
});

export const accountsFileSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string().regex(ACCOUNT_NAME, "account names use letters, digits, '.', '_' and '-'"), accountSchema),
});
export type AccountsFile = z.infer<typeof accountsFileSchema>;

export type AccountField = "username" | "password";

export type AccountResolved = { ok: true; value: string } | { ok: false; code: "not_found" | "bad_params"; message: string };

export interface AccountStore {
  /** The accounts' names, never their values. */
  names(): string[];
  /** One value of an account, for an app. */
  resolve(name: string, field: AccountField, appId: string): AccountResolved;
  /** Replaces every username with `<tester2's username>` and every password with `<tester2's password>`. */
  redact(text: string): string;
}

/** What the accounts file gave: its accounts, or why none were loaded (the git message). */
export type AccountsLoad = { store: AccountStore } | { store: null; blocked: string };

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
  "A password stays out of pictures only while its field is secure; a \"show password\" toggle shows it. Keep the accounts file outside the folders the agent may read.";

/** The refusal's words, for the first answer, `doctor` and every use. */
export function blockedMessage(file: string): string {
  return `accounts file is inside the git repo at ${file} and not ignored; move it or add it to .gitignore.`;
}

/** The invisible direction marks the app strips from text (react-native-tapline's `displayText`). */
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/**
 * The shapes a value can take on its way back: as it is, inside a JSON string, in a URL (percent or form encoded), and
 * as the app's `normalizeText` leaves it (direction marks gone, whitespace collapsed and trimmed).
 */
function variantsOf(value: string): string[] {
  const normalized = value.replace(DIRECTION_MARKS, "").replace(/\s+/g, " ").trim();
  const forms = new Set<string>();
  for (const base of [value, normalized]) {
    forms.add(base);
    forms.add(JSON.stringify(base).slice(1, -1));
    const percent = encodeURIComponent(base);
    forms.add(percent);
    forms.add(percent.replace(/%20/g, "+"));
    // URLSearchParams encodes more than encodeURIComponent does (`~` becomes %7E).
    forms.add(new URLSearchParams({ k: base }).toString().slice(2));
  }
  return [...forms].filter((form) => form !== "");
}

/** Longest variants first, so a value that holds another is scrubbed whole. */
function scrubber(accounts: AccountsFile["accounts"]): (text: string) => string {
  const pairs: Array<[string, string]> = [];
  for (const [name, account] of Object.entries(accounts)) {
    if (account.username !== undefined) for (const form of variantsOf(account.username)) pairs.push([form, `<${name}'s username>`]);
    if (account.password !== undefined) for (const form of variantsOf(account.password)) pairs.push([form, `<${name}'s password>`]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [value, token] of pairs) if (out.includes(value)) out = out.split(value).join(token);
    return out;
  };
}

export function accountStore(file: AccountsFile): AccountStore {
  const accounts = file.accounts;
  const scrub = scrubber(accounts);
  const names = Object.keys(accounts);
  const list = (): string => (names.length === 0 ? "the accounts file has none" : `the accounts are ${names.join(", ")}`);
  return {
    names: () => [...names],
    redact: scrub,
    resolve(name, field, appId) {
      const account = Object.prototype.hasOwnProperty.call(accounts, name) ? accounts[name] : undefined;
      if (account === undefined) return { ok: false, code: "not_found", message: `no account "${name}"; ${list()}.` };
      if (account.apps !== undefined && !account.apps.includes(appId)) {
        return { ok: false, code: "bad_params", message: `account "${name}" isn't for this app (${appId}); it is for ${account.apps.join(", ")}.` };
      }
      const value = account[field];
      if (value === undefined) return { ok: false, code: "bad_params", message: `account "${name}" has no ${field}.` };
      return { ok: true, value };
    },
  };
}

/**
 * Reads the accounts file. Inside a git work tree that doesn't ignore it, nothing is read or loaded. A file that can't
 * be read or isn't the format throws a plain message that never quotes the file (it holds secrets).
 */
export async function loadAccounts(file: string, probe: GitProbe = realGitProbe): Promise<AccountsLoad> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`the accounts file ${path} doesn't exist`);
  // Through a symlink or a junction the file may really sit in a repo: ask about where it is.
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // the path stands
  }
  // A `.git` folder in the path is a repo's own files, which no .gitignore covers.
  const inGitDir = real.split(/[\\/]/).includes(".git");
  if (inGitDir || ((await probe.insideWorkTree(dirname(real))) && !(await probe.ignored(real)))) {
    return { store: null, blocked: blockedMessage(path) };
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    // Node's own message quotes part of the text, and this file holds passwords.
    throw new Error(`the accounts file ${path} isn't valid JSON`);
  }
  const parsed = accountsFileSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ");
    throw new Error(`the accounts file ${path} isn't the right format: ${why}`);
  }
  return { store: accountStore(parsed.data) };
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

const WHOLE = /^\$\{account\.(\w+)\}$/;

export type AccountText =
  | { ok: true; text: string; field: AccountField | null }
  | { ok: false; code: "not_found" | "bad_params"; message: string };

/**
 * `${account.username}` or `${account.password}` becomes the value, but only when it is the whole text: joined with
 * other text it could get a password past the secure-field rule. Text without a placeholder passes unchanged (field null).
 */
export function substituteAccount(text: string, store: AccountStore, name: string | undefined, appId: string): AccountText {
  const whole = WHOLE.exec(text);
  if (whole === null) {
    if (text.includes("${account.")) return { ok: false, code: "bad_params", message: "an account value is the whole text of a step, not part of one." };
    return { ok: true, text, field: null };
  }
  const field = whole[1];
  if (field === "passcode") {
    return { ok: false, code: "bad_params", message: "an account's passcode is typed only by Tapwright on a locked phone's keypad; Tapline never types it." };
  }
  if (field !== "username" && field !== "password") {
    return { ok: false, code: "bad_params", message: `\${account.${field ?? ""}} isn't a value an account has; use \${account.username} or \${account.password}.` };
  }
  if (name === undefined) {
    return { ok: false, code: "bad_params", message: `name the account: add "account": "<name>" (${store.names().length === 0 ? "the accounts file has none" : `the accounts are ${store.names().join(", ")}`}).` };
  }
  const resolved = store.resolve(name, field, appId);
  return resolved.ok ? { ok: true, text: resolved.value, field } : resolved;
}
