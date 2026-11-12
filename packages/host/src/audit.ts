import { z } from "zod";
import { formatElement } from "./format.js";
import { shownPath } from "./inspect.js";
import { elementSchema } from "./protocol.js";

/** AGENT-TOOLS 1.8 §10: the accessibility audit's shared types and its one report format. */

export const AUDIT_TYPES = [
  "contrast",
  "hit_region",
  "description",
  "dynamic_type",
  "clipped_text",
  "trait",
  "element_detection",
  "overlap",
  "duplicate_id",
] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

export const MAX_ISSUES = 30;

export const auditResultSchema = z.object({
  issues: z.array(
    z.object({
      type: z.string(),
      element: elementSchema.nullish(),
      /** Set when `element` is missing but something is known: its frame in points, its text or label. */
      where: z
        .object({
          frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
          text: z.string().optional(),
          label: z.string().optional(),
        })
        .optional(),
      problem: z.string(),
      fix: z.string(),
      at: z.object({ file: z.string(), line: z.number(), direct: z.boolean().optional() }).optional(),
    }),
  ),
  checked: z.array(z.string()),
});
export type AuditResult = z.infer<typeof auditResultSchema>;

/** An issue without an element: what is known of it, else "the screen" (only when nothing at all is). */
function whereWords(where: AuditResult["issues"][number]["where"]): string {
  if (where === undefined) return "the screen";
  const name = where.label ?? where.text;
  const f = where.frame;
  const at = f !== undefined ? ` at @${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)}` : "";
  const called = name !== undefined && name !== "" ? ` ${JSON.stringify(name)}` : "";
  return at === "" && called === "" ? "the screen" : `an element${called}${at}`;
}

/** The report: header, numbered issues (each `at` on its own line when known), then what was checked. */
export function formatAudit(
  title: string,
  result: AuditResult,
  asked: readonly string[] | undefined,
  pathOf: (file: string) => string = shownPath,
): string {
  const wanted = asked ?? AUDIT_TYPES;
  const checked = AUDIT_TYPES.filter((t) => result.checked.includes(t) && wanted.includes(t));
  const notChecked = wanted.filter((t) => !checked.includes(t as AuditType));
  const tail = `Checked: ${checked.join(", ")}.${notChecked.length > 0 ? ` Not checked here: ${notChecked.join(", ")}.` : ""}`;
  const issues = result.issues;
  if (issues.length === 0) return [`Audit of ${JSON.stringify(title)}: no issues found.`, tail].join("\n");
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  const summary = [...counts].map(([type, n]) => `${type} ${n}`).join(", ");
  const lines = [`Audit of ${JSON.stringify(title)}: ${issues.length} issue${issues.length === 1 ? "" : "s"} (${summary}).`];
  issues.slice(0, MAX_ISSUES).forEach((issue, i) => {
    const what = issue.element ? formatElement(issue.element, { actions: false }) : whereWords(issue.where);
    lines.push(`${i + 1}. ${issue.type}: ${what}: ${issue.problem}. Fix: ${issue.fix}.`);
    if (issue.at !== undefined) {
      const library = issue.at.direct === false ? " (a library draws it; this is the app's line around it)" : "";
      lines.push(`   at ${pathOf(issue.at.file)}:${issue.at.line}${library}`);
    }
  });
  if (issues.length > MAX_ISSUES) lines.push(`(+${issues.length - MAX_ISSUES} more issues; pass types to narrow it.)`);
  lines.push(tail);
  return lines.join("\n");
}

/** The screen's name for the header: the focused route's, else the app's. */
export function auditTitle(route: string[] | null, appName: string): string {
  const last = route?.[route.length - 1];
  return last !== undefined && last !== "" && !/^[_(]/.test(last) && last !== "index" ? last : appName;
}
