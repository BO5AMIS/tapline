import { createHash } from "node:crypto";

/**
 * An id that is already one plain, portable folder name: it is used as it is. Lowercase only, because Windows and macOS
 * fold case: `com.example.Demo` and `com.example.demo` would otherwise be one folder there.
 */
const SAFE = /^[a-z0-9][a-z0-9._-]*$/;
/** Names Windows keeps for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
const MAX = 100;

/**
 * The folder an app's bugs and explore runs live in, locally (`~/.tapline/bugs/<this>/`) and on an export's `qa-reports`
 * branch (AGENT-TOOLS 1.16.2 §29.7). Two different ids always get two different folders, also where the file system
 * folds case:
 * - a lowercase id that is already a safe name (a bundle id, as a rule) is kept as it is, so folders made by 1.8.5 still
 *   match;
 * - any other id gets `_`, a readable cleaned lowercase part, and 16 hex of the SHA-256 of its UTF-16 code units (lossless,
 *   also for malformed Unicode). A kept id never starts with `_`, so the two kinds never meet.
 */
export function appFolderName(appId: string): string {
  if (SAFE.test(appId) && appId.length <= MAX && !appId.endsWith(".") && !RESERVED.test(appId)) return appId;
  const readable = appId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, MAX - 18)
    .replace(/[._-]+$/, "");
  const hash = createHash("sha256").update(Buffer.from(appId, "utf16le")).digest("hex").slice(0, 16);
  return readable === "" ? `_${hash}` : `_${readable}-${hash}`;
}
