import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { formatElement } from "./format.js";
import { elementSchema } from "./protocol.js";

/**
 * `inspect` (Tapline 1.1): from the screen to the code. The app finds the components and the source line
 * (React's `_debugStack`, mapped by Metro); the host turns the path into one relative to the app's project
 * and, when the file is on this computer, shows the line itself.
 */

export const inspectResultSchema = z.object({
  element: elementSchema,
  source: z.object({
    components: z.array(z.string()),
    location: z
      .object({ file: z.string(), line: z.number(), column: z.number(), component: z.string().nullish() })
      .nullable(),
    props: z.record(z.string(), z.string()),
  }),
});
export type InspectResult = z.infer<typeof inspectResultSchema>;

export interface FileAccess {
  exists(path: string): boolean;
  read(path: string): string;
}

const realFiles: FileAccess = { exists: existsSync, read: (p) => readFileSync(p, "utf8") };

/** The app's project folder for a source file: the nearest folder above it with a package.json. */
export function projectRoot(file: string, files: FileAccess = realFiles): string | null {
  let dir = dirname(file);
  for (let i = 0; i < 40; i++) {
    if (!dir.split(/[\\/]/).includes("node_modules") && files.exists(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** A path for people and agents: relative to the app's project, with forward slashes; never absolute. */
export function shownPath(file: string, files: FileAccess = realFiles): string {
  const root = projectRoot(file, files);
  const rel = root !== null ? relative(root, file) : file.split(/[\\/]/).slice(-3).join(sep);
  return rel.split(sep).join("/").replace(/\\/g, "/");
}

/** The source line, trimmed and cut to 120 characters; null when the file isn't on this computer. */
export function sourceLine(file: string, line: number, files: FileAccess = realFiles): string | null {
  try {
    if (!files.exists(file)) return null;
    const text = files.read(file).split(/\r?\n/)[line - 1];
    if (text === undefined) return null;
    const trimmed = text.trim();
    return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
  } catch {
    return null;
  }
}

export function formatInspect(result: InspectResult, files: FileAccess = realFiles): string {
  const lines = [formatElement(result.element)];
  const { components, location, props } = result.source;
  if (components.length > 0) lines.push(`Components: ${components.join(" › ")}`);
  if (location !== null) {
    const where = `${shownPath(location.file, files)}:${location.line}`;
    lines.push(`Written at: ${where}${location.component ? ` (in ${location.component})` : ""}`);
    const code = sourceLine(location.file, location.line, files);
    if (code !== null) lines.push(`  ${location.line} | ${code}`);
  } else {
    lines.push("Written at: unknown (Metro didn't map it; the app may be a release build or loaded without Metro).");
  }
  const shown = Object.entries(props).map(([k, v]) => `${k}=${v}`);
  if (shown.length > 0) lines.push(`Props: ${shown.join(", ")}`);
  return lines.join("\n");
}
