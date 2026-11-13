import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * AGENT-TOOLS 1.8 §11: the safety policy. Words that need a person's OK before a touch, words that are
 * blocked outright, per app. A word matches the touched element's own label or text, whole words,
 * ignoring case ("Delete trip" matches "Delete"; "Deleted" doesn't). testIDs are never matched.
 */

export const DEFAULT_CONFIRM = [
  "Buy",
  "Purchase",
  "Subscribe",
  "Pay",
  "Delete",
  "Remove",
  "Send",
  "Post",
  "Publish",
  "Sign out",
  "Log out",
  "Erase",
];

const listsSchema = z.object({ confirm: z.array(z.string()).optional(), block: z.array(z.string()).optional() });
export const policySchema = z.object({
  // Version 2 (AGENT-TOOLS 1.14 §19.1) adds `grants`; grants.ts validates each grant alone, so one bad grant
  // never stops the file, and a version 1 file loads as before.
  version: z.union([z.literal(1), z.literal(2)]),
  grants: z.unknown().optional(),
  confirm: z.array(z.string()).optional(),
  block: z.array(z.string()).optional(),
  apps: z.record(z.string(), listsSchema).optional(),
});
export type PolicyFile = z.infer<typeof policySchema>;
export interface Lists {
  confirm: string[];
  block: string[];
}

export const DEFAULT_POLICY: PolicyFile = { version: 1, confirm: DEFAULT_CONFIRM, block: [] };
export const NO_POLICY: PolicyFile = { version: 1, confirm: [], block: [] };

/** Reads `--policy FILE`; throws with a plain message when it isn't one. */
export function loadPolicy(path: string): PolicyFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`couldn't read the policy ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = policySchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} isn't a policy (version 1 or 2, with confirm, block and apps lists)`);
  // A file that names only words to block keeps the built-in words to confirm; `"confirm": []` turns them off.
  return { ...parsed.data, confirm: parsed.data.confirm ?? DEFAULT_CONFIRM };
}

/** The lists for one app: its own lists replace the global ones where it has them. */
export function listsFor(policy: PolicyFile, app: { id?: string; name: string } | undefined): Lists {
  const own = app === undefined ? undefined : (policy.apps?.[app.id ?? ""] ?? policy.apps?.[app.name]);
  return {
    confirm: own?.confirm ?? policy.confirm ?? [],
    block: own?.block ?? policy.block ?? [],
  };
}

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first word of the list that the element's own label or text names, whole words, ignoring case. */
export function matchWord(words: string[], element: { label?: string | null; text?: string | null }): string | null {
  const said = [element.label ?? "", element.text ?? ""].filter((s) => s !== "");
  for (const word of words) {
    const w = word.trim();
    if (w === "") continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}($|[^\\p{L}\\p{N}])`, "iu");
    if (said.some((s) => re.test(s))) return w;
  }
  return null;
}

/** An id or a path as words: `deleteAccountButton` and `delete-account` both read "delete account". */
export const asWords = (piece: string): string => piece.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_./]+/g, " ");

/** How many times a link may be percent-encoded and still be read. */
const DECODE_ROUNDS = 3;

/** One escape run undone. Invalid UTF-8 keeps its plain-ASCII escapes decoded (best effort) and says it failed. */
function decodeRun(run: string): { text: string; ok: boolean } {
  try {
    return { text: decodeURIComponent(run), ok: true };
  } catch {
    return { text: run.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), ok: false };
  }
}

/**
 * Percent escapes undone, as the router does before it matches a segment, twice-encoded text too. `complete` is false when an
 * escape isn't valid UTF-8 or when escapes are still there after the round limit: then what a router would make of it is unknown.
 */
export function decodeComplete(text: string): { text: string; complete: boolean } {
  let now = text;
  let complete = true;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = now.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      const done = decodeRun(run);
      if (!done.ok) complete = false;
      return done.text;
    });
    if (next === now) break;
    now = next;
  }
  // Escapes still there after the round limit (or an undecodable one): the link is not fully read.
  if (/%[0-9a-f]{2}/i.test(now)) complete = false;
  return { text: now, complete };
}

/** Percent escapes undone as far as they can be; see decodeComplete for whether that was all of them. */
export function decodePath(text: string): string {
  return decodeComplete(text).text;
}

/** A link's path (no scheme, query or fragment). The query is cut first: decoding first would turn %3F into a `?` and cut the path short. */
const pathOf = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "");

/** Whether a link's path decodes fully. A link that doesn't can't be read for policy words, so it is never trusted. */
export function linkReadable(url: string): boolean {
  return decodeComplete(pathOf(url)).complete;
}

/** The words a policy could match in a link: its path only (no scheme, query or fragment), decoded, as words. */
export function linkWords(url: string): string {
  return asWords(decodePath(pathOf(url)));
}

/** What the policy says about a link it couldn't decode: a person decides. It is the word and the element's label. */
export const UNREADABLE_LINK = "link that can't be decoded";

/** What a person's OK is tied to: the same tool on the same element (its id, else its role, label and text). */
export function elementKey(element: { testID?: string | null; role?: string | null; label?: string | null; text?: string | null }): string {
  return element.testID ? `id:${element.testID}` : `el:${element.role ?? ""}|${element.label ?? ""}|${element.text ?? ""}`;
}
