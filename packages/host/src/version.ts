import { createRequire } from "node:module";

/** The host's own version, read from its package.json (one folder up from src/ and from dist/). */
function readVersion(): string {
  try {
    const pkg: unknown = createRequire(import.meta.url)("../package.json");
    if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

export const HOST_VERSION: string = readVersion();
