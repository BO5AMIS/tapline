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
  version: z.literal(1),
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
  if (!parsed.success) throw new Error(`${path} isn't a policy (version 1, with confirm, block and apps lists)`);
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

/** Percent escapes undone, as the router does before it matches a segment; a bad escape stays as written. Twice-encoded text too. */
export function decodePath(text: string): string {
  let now = text;
  for (let round = 0; round < 3; round++) {
    const next = now.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
    if (next === now) break;
    now = next;
  }
  return now;
}

/** The words a policy could match in a link: its path only (no scheme, query or fragment), decoded, as words. */
export function linkWords(url: string): string {
  // The query is cut first: decoding first would turn %3F into a `?` and cut the path short.
  return asWords(decodePath(url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "")));
}

/** What a person's OK is tied to: the same tool on the same element (its id, else its role, label and text). */
export function elementKey(element: { testID?: string | null; role?: string | null; label?: string | null; text?: string | null }): string {
  return element.testID ? `id:${element.testID}` : `el:${element.role ?? ""}|${element.label ?? ""}|${element.text ?? ""}`;
}
