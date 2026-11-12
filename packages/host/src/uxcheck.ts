import { readFileSync } from "node:fs";
import { z } from "zod";
import { whereWords } from "./audit.js";
import { formatElement } from "./format.js";
import { shownPath } from "./inspect.js";
import { elementSchema } from "./protocol.js";

/** AGENT-TOOLS 1.12 §17.3: `ux_check`, the screen against the basics, and the user's house rules. */

/** An action seen on a screen: its label, and its testID when it has one. */
export interface UxAction {
  label: string;
  id?: string;
}

/** What a journey keeps and hands to `ux_check`. The journey module sets `tools.uxJourney` to one of these. */
export interface UxJourneyHook {
  /**
   * The named actions of the screens seen earlier in the running journey (not this screen's own), or null when
   * no journey is running: naming is then not checked, and the answer says so.
   */
  earlier(): UxAction[] | null;
  /** Called after each `ux_check`, with the screen's title, its named actions and what was found. */
  seen?(screen: string, actions: UxAction[], findings: UxFindingSummary[]): void;
}

export interface UxFindingSummary {
  kind: string;
  problem: string;
  basis: string;
  /** The element's ref, when the finding concerns one. */
  ref?: string;
  /** The element's frame in points, for the report's red box. */
  frame?: { x: number; y: number; width: number; height: number };
}

export const uxResultSchema = z.object({
  issues: z.array(
    z.object({
      kind: z.string(),
      element: elementSchema.nullish(),
      where: z
        .object({
          frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
          text: z.string().optional(),
          label: z.string().optional(),
        })
        .optional(),
      problem: z.string(),
      basis: z.string(),
      at: z.object({ file: z.string(), line: z.number(), direct: z.boolean().optional() }).optional(),
    }),
  ),
  checked: z.array(z.string()),
  choices: z.number().optional(),
  actions: z.array(z.object({ label: z.string(), id: z.string().optional() })).default([]),
});
export type UxResult = z.infer<typeof uxResultSchema>;

export const MAX_UX_FINDINGS = 30;
export const JUDGMENT_LINE = "Add your own judgment from the screenshot, and label it as judgment.";

const CHECK_WORDS: Readonly<Record<string, string>> = {
  choices: "competing choices",
  main_action: "main action",
  thumb_reach: "thumb reach",
  icon_only: "icon-only buttons",
  cut_off_text: "cut-off text",
  contrast: "contrast",
  target_size: "target size",
  naming: "naming across screens",
  dead_end: "error and empty states",
  way_back: "way back (house rule)",
};
/** The checks in the order the tail lists them. */
const CHECK_ORDER = Object.keys(CHECK_WORDS);

/** The report: header, numbered findings (each `at` on its own line), house rules to judge, what was checked, the ask. */
export function formatUxCheck(
  title: string,
  result: UxResult,
  options: { textRules?: readonly string[]; journeyRunning: boolean; eyes?: boolean },
  pathOf: (file: string) => string = shownPath,
): string {
  const n = result.issues.length;
  const eyes = options.eyes === true;
  const lines = [`UX check of ${JSON.stringify(title)}: ${n} finding${n === 1 ? "" : "s"}.`];
  result.issues.slice(0, MAX_UX_FINDINGS).forEach((issue, i) => {
    const what = issue.element ? formatElement(issue.element, { actions: false, eyes }) : whereWords(issue.where);
    lines.push(`${i + 1}. ${issue.kind}: ${what}: ${issue.problem} (${issue.basis})`);
    // In a user's eyes (AGENT-TOOLS 1.12 §17.1) the code behind the screen isn't shown: no file and line.
    if (issue.at !== undefined && !eyes) {
      const library = issue.at.direct === false ? " (a library draws it; this is the app's line around it)" : "";
      lines.push(`   at ${pathOf(issue.at.file)}:${issue.at.line}${library}`);
    }
  });
  if (n > MAX_UX_FINDINGS) lines.push(`(+${n - MAX_UX_FINDINGS} more findings.)`);
  const rules = options.textRules ?? [];
  if (rules.length > 0) lines.push(`House rules to judge: ${rules.map((r) => JSON.stringify(r)).join("; ")}.`);
  const done = CHECK_ORDER.filter((k) => result.checked.includes(k));
  const notes: string[] = [];
  if (!result.checked.includes("naming")) {
    notes.push(`${CHECK_WORDS["naming"]} (${options.journeyRunning ? "no earlier screens yet" : "no journey is running"})`);
  }
  lines.push(`Checked: ${done.map((k) => CHECK_WORDS[k]).join(", ")}.${notes.length > 0 ? ` Not checked here: ${notes.join(", ")}.` : ""}`);
  lines.push(JUDGMENT_LINE);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* House rules: --ux-rules FILE                                                */
/* -------------------------------------------------------------------------- */

export interface UxRules {
  /** Rules written as text: handed to the agent to judge. */
  text: string[];
  /** `{"way_back": true}`: every screen has a visible way back (checked by `ux_check`). */
  wayBack: boolean;
  /** `{"max_taps_to_goal": N}`: a journey that reaches its goal in more taps breaks it (checked by the journey at stop). */
  maxTapsToGoal?: number;
}

export const NO_UX_RULES: UxRules = { text: [], wayBack: false };

const KNOWN_KEYS = ["max_taps_to_goal", "way_back"];

/** Checks a parsed `--ux-rules` file; throws with a plain message when it isn't one. */
export function parseUxRules(json: unknown, label: string): UxRules {
  const bad = (why: string): Error => new Error(`${label} isn't a set of UX rules: ${why}`);
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw bad('expected {"version": 1, "rules": [...]}');
  const file = json as Record<string, unknown>;
  for (const key of Object.keys(file)) if (key !== "version" && key !== "rules") throw bad(`unknown key ${JSON.stringify(key)}`);
  if (file["version"] !== 1) throw bad("version must be 1");
  const list = file["rules"];
  if (!Array.isArray(list)) throw bad("rules must be a list");
  const rules: UxRules = { text: [], wayBack: false };
  list.forEach((rule: unknown, i) => {
    const at = `rule ${i + 1}`;
    if (typeof rule === "string") {
      if (rule.trim() === "") throw bad(`${at} is empty`);
      rules.text.push(rule.trim());
      return;
    }
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) throw bad(`${at} must be text or an object`);
    const keys = Object.keys(rule);
    const key = keys[0];
    if (keys.length !== 1 || key === undefined) throw bad(`${at} must have exactly one key`);
    if (!KNOWN_KEYS.includes(key)) throw bad(`unknown key ${JSON.stringify(key)} in ${at} (known: ${KNOWN_KEYS.join(", ")})`);
    const value = (rule as Record<string, unknown>)[key];
    if (key === "way_back") {
      if (typeof value !== "boolean") throw bad(`way_back in ${at} must be true or false`);
      rules.wayBack = value;
    } else {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw bad(`max_taps_to_goal in ${at} must be a whole number of 1 or more`);
      rules.maxTapsToGoal = value;
    }
  });
  return rules;
}

/** Reads `--ux-rules FILE`; throws with a plain message when it isn't readable or isn't one. */
export function loadUxRules(path: string): UxRules {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`couldn't read the UX rules ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseUxRules(json, path);
}
