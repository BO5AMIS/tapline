import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Content hashes for what a running host holds (PR 12 Codex cycle 2): a host loads its policy and accounts once, so the same path
 * is not the same policy. The host reports the hash of what it LOADED; a scheduled run hashes the files as they are now and
 * reuses the host only when they agree. Hashes only: never the content.
 */

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The hash of a file's bytes; null when it can't be read. */
export function hashFile(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * The hash of a maps folder: each app's `map.json` (the file a host loads and saves), by folder name, in order. A folder that doesn't
 * exist hashes as empty; a map that can't be read counts as unreadable, so it never equals one that can.
 */
export function hashMapsDir(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  const parts: string[] = [];
  for (const name of names) {
    let text: Buffer;
    try {
      text = readFileSync(join(dir, name, "map.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      parts.push(`${name}\n?`);
      continue;
    }
    parts.push(`${name}\n${sha256(text)}`);
  }
  return sha256(parts.join("\n"));
}
