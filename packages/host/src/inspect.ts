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
      .object({ file: z.string(), line: z.number(), column: z.number(), component: z.string().nullish(), direct: z.boolean().optional() })
      .nullable(),
    usedAt: z
      .union([
        z.array(z.object({ file: z.string(), line: z.number(), column: z.number(), component: z.string().nullish() })),
        z.object({ file: z.string(), line: z.number(), column: z.number(), component: z.string().nullish() }).transform((one) => [one]),
      ])
      .optional(),
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
export function sourceLine(file: string, line: number, files: FileAccess = realFiles, redact: (text: string) => string = (t) => t): string | null {
  try {
    if (!files.exists(file)) return null;
    const text = files.read(file).split(/\r?\n/)[line - 1];
    if (text === undefined) return null;
    // Redacted before the cut (AGENT-TOOLS §20.3): a value must not be left half shown by it.
    const trimmed = redact(text.trim());
    return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
  } catch {
    return null;
  }
}

/** The first line of a file that writes this id as a string literal ("id", 'id' or `id`); null when none. */
export function literalLine(file: string, id: string, files: FileAccess = realFiles): number | null {
  try {
    if (!files.exists(file)) return null;
    const lines = files.read(file).split(/\r?\n/);
    const quoted = [`"${id}"`, `'${id}'`, `\`${id}\``];
    const at = lines.findIndex((line) => quoted.some((q) => line.includes(q)));
    return at >= 0 ? at + 1 : null;
  } catch {
    return null;
  }
}

export function formatInspect(result: InspectResult, files: FileAccess = realFiles, redact: (text: string) => string = (t) => t): string {
  const lines = [formatElement(result.element)];
  const { components, location, props } = result.source;
  if (components.length > 0) lines.push(`Components: ${components.join(" › ")}`);
  if (location !== null) {
    const where = `${shownPath(location.file, files)}:${location.line}`;
    const inComponent = location.component ? ` (in ${location.component})` : "";
    lines.push(
      location.direct === false
        ? `Drawn by a library, inside: ${where}${inComponent}`
        : `Written at: ${where}${inComponent}`,
    );
    const code = sourceLine(location.file, location.line, files, redact);
    if (code !== null) lines.push(`  ${location.line} | ${code}`);
    // Inside the app's own shared component: where the screen uses it. Of the call sites up the chain, the
    // first whose line names the element (its label, text or id, or the id's last part), else the nearest.
    const sites = result.source.usedAt ?? [];
    const el = result.element;
    const elementId = el.testID ?? "";
    const words = [el.label, el.text, elementId, elementId.split(/[-_.:]/).pop()].filter((w): w is string => typeof w === "string" && w.length >= 2);
    const names = (site: { file: string; line: number }): boolean => {
      const code = sourceLine(site.file, site.line, files, redact) ?? "";
      return words.some((w) => code.includes(`"${w}"`) || code.includes(`'${w}'`) || code.includes(`>${w}<`));
    };
    const used = sites.find(names) ?? sites[0];
    if (used !== undefined) {
      lines.push(`Used at: ${shownPath(used.file, files)}:${used.line}${used.component ? ` (in ${used.component})` : ""}`);
      const usedCode = sourceLine(used.file, used.line, files, redact);
      if (usedCode !== null) lines.push(`  ${used.line} | ${usedCode}`);
    }
    // A library drew it: the app still wrote the element's id somewhere in that file (a tab's options).
    const id = result.element.testID;
    if (location.direct === false && typeof id === "string" && id !== "") {
      const at = literalLine(location.file, id, files);
      if (at !== null) {
        lines.push(`Its id is set at: ${shownPath(location.file, files)}:${at}`);
        const set = sourceLine(location.file, at, files, redact);
        if (set !== null) lines.push(`  ${at} | ${set}`);
      }
    }
  } else {
    lines.push("Written at: unknown (Metro didn't map it; the app may be a release build or loaded without Metro).");
  }
  // A prop arrives whole and is redacted first; only then is it cut for display, so a cut can't leave half a value.
  const shown = Object.entries(props).map(([k, v]) => `${k}=${displayProp(redact(v))}`);
  if (shown.length > 0) lines.push(`Props: ${shown.join(", ")}`);
  return lines.join("\n");
}

/** A quoted string prop cut to 40 characters for display (the app sends it whole; redaction came first). */
function displayProp(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  if (inner.length <= 40) return value;
  const last = inner.charCodeAt(39);
  return `"${inner.slice(0, last >= 0xd800 && last <= 0xdbff ? 39 : 40)}…"`;
}
