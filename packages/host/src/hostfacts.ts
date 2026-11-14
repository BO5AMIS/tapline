import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadMap, mapDir, stable } from "./mapfile.js";
import type { PolicyFile } from "./policy.js";

/**
 * Hashes of what a running host has LOADED (PR 12 Codex cycle 3): a host asked for its facts first reloads its policy, vault and maps
 * from disk into its live state and reports these hashes of that state; a scheduled run computes the same over what it would load
 * itself and reuses the host only when they agree. Hashes only: never the content. The vault's hash is an HMAC under the host's
 * token (accounts.ts, `fingerprint`), so nothing in it can be guessed from the hash alone.
 */

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The hash of a policy's content (canonical JSON, so spacing and key order don't count). */
export function policyFingerprint(policy: PolicyFile): string {
  return sha256(stable(policy));
}

/** One app's map as loaded: how it loaded and its content. */
export interface LoadedMap {
  status: string;
  data: unknown;
}

/**
 * The hash of the maps a folder holds, each app's `map.json` as `load` gives it (the live registry for a host, a fresh read of
 * the disk for a schedule), by folder name, in order, over the canonical JSON of each map. A folder that doesn't exist hashes as
 * empty; a map file that can't be read or names no app counts as unreadable, so it never equals one that can.
 */
export function hashMapsLoaded(dir: string, load: (app: string) => LoadedMap | null): string {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  const parts: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name, "map.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      parts.push(`${name}\n?`);
      continue;
    }
    let app: unknown;
    try {
      app = (JSON.parse(text) as { app?: unknown }).app;
    } catch {
      app = undefined;
    }
    const loaded = typeof app === "string" ? load(app) : null;
    parts.push(loaded === null ? `${name}\n?` : `${name}\n${loaded.status}\n${sha256(stable(loaded.data))}`);
  }
  return sha256(parts.join("\n"));
}

/** The maps as a fresh read of the disk loads them (what a schedule would load). */
export function hashMapsOnDisk(dir: string): string {
  return hashMapsLoaded(dir, (app) => {
    // The registry keeps no map for an app without an id of its own.
    if (app === "" || app === "unknown") return null;
    const loaded = loadMap(mapDir(app, { mapsDir: dir }), app);
    return { status: loaded.status, data: loaded.map };
  });
}
