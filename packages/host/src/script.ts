import { z } from "zod";
import { stepSchema, type Step } from "./run.js";
import type { Seen } from "./seen.js";

/**
 * AGENT-TOOLS 1.8 §9.4: the shared script file, a saved batch both tools write and replay.
 *   {"format": "agent-tools-script", "version": 1, "name", "app", "fresh", "steps": [ {tool, …, expect?} ]}
 * Tapline records the app's methods as they run (press, type, …); this turns them into tool steps, and
 * still reads Tapline's own scripts from before 1.1.
 */

const scriptBase = {
  format: z.literal("agent-tools-script"),
  name: z.string(),
  app: z.string().optional(),
  fresh: z.boolean().optional(),
  steps: z.array(stepSchema),
};

export const sharedScriptV1Schema = z.object({ ...scriptBase, version: z.literal(1) });

/** A route's variable: a name, or `account` (the test account a route types, §18.6). Never a value. */
export const variableNameSchema = z.string().regex(/^[A-Za-z_]\w*$/, "a variable's name is letters, digits and '_'");

/** AGENT-TOOLS 1.13 §18.5: version 2 adds where a route starts and ends, and the variables its steps use. */
export const sharedScriptV2Schema = z.object({
  ...scriptBase,
  version: z.literal(2),
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  variables: z.array(variableNameSchema).optional(),
  /** AGENT-TOOLS 1.14 §18.5, §21.3: every touch on a word that reaches other people stops at a draft shown to a person. */
  draftsOnly: z.boolean().optional(),
});

export const sharedScriptSchema = z.union([sharedScriptV1Schema, sharedScriptV2Schema]);
export type SharedScriptV1 = z.infer<typeof sharedScriptV1Schema>;
export type SharedScriptV2 = z.infer<typeof sharedScriptV2Schema>;
export type SharedScript = SharedScriptV1 | SharedScriptV2;

/** Tapline's script before 1.1: the app's methods and their parameters. */
export const legacyScriptSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  app: z.object({ name: z.string(), id: z.string().optional() }),
  recordedAt: z.string(),
  steps: z.array(
    z.object({
      method: z.string(),
      params: z.record(z.string(), z.unknown()),
      route: z.array(z.string()).optional(),
      fragile: z.boolean().optional(),
    }),
  ),
});
export type LegacyScript = z.infer<typeof legacyScriptSchema>;
export interface MethodStep {
  method: string;
  params: Record<string, unknown>;
  /** Tapline: the screen's route when the step was recorded, checked on replay (a step field, not a parameter). */
  route?: string[];
  /** The place where the step ran (AGENT-TOOLS 1.15 §26.6), a step field and not a parameter. */
  place?: string;
  /** The element's facts when the step was recorded (AGENT-TOOLS 1.16 §9.4): a step field, never a parameter, never text. */
  seen?: Seen;
}

const TOOL_OF: Record<string, string> = {
  press: "tap",
  longPress: "long_press",
  type: "type_text",
  scroll: "scroll",
  toggle: "toggle",
  back: "back",
  swipe: "swipe",
  openURL: "open_url",
  compareScreen: "compare_screen",
  command: "app_command",
  waitFor: "wait_for",
  sleep: "wait",
  performance: "performance",
};

/** ASCII letters folded to lower case, and nothing else: names are ASCII, and `K` (Kelvin) is not a `k`. */
function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * The existing name that differs from `name` only in case, else null (AGENT-TOOLS 1.13.1 item 5). `home` and `HOME` are
 * one file on Windows and macOS, so the second is refused before anything is written. It compares names, never the
 * file system, so it means the same on every OS.
 */
export function caseTwin(name: string, existing: Iterable<string>): string | null {
  const others = [...existing];
  // The exact name exists: it is the one meant, even when a twin from another OS sits next to it.
  if (others.includes(name)) return null;
  const folded = asciiLower(name);
  return others.find((other) => asciiLower(other) === folded) ?? null;
}

/** The app's target (`testID`) as a tool target (`id`). */
function toolTarget(target: unknown): unknown {
  if (typeof target !== "object" || target === null) return target;
  const { testID, ...rest } = target as Record<string, unknown>;
  return typeof testID === "string" ? { id: testID, ...rest } : rest;
}

/** One recorded app call as a script step; null for calls a script doesn't keep. */
export function toToolStep(step: MethodStep): Step | null {
  const tool = TOOL_OF[step.method];
  if (tool === undefined) return null;
  const params: Record<string, unknown> = { ...step.params };
  if ("target" in params) params["target"] = toolTarget(params["target"]);
  if (tool === "wait_for" && typeof params["testID"] === "string") {
    params["id"] = params["testID"];
    delete params["testID"];
  }
  return { tool, ...params, ...(step.route !== undefined && step.route.length > 0 ? { route: step.route } : {}), ...(step.place !== undefined && step.place !== "" ? { place: step.place } : {}), ...(step.seen !== undefined ? { seen: step.seen } : {}) } as Step;
}

/**
 * Steps from recorded calls. A `wait_for` right after an action becomes that step's `expect` (text, id or
 * label, with gone and timeout), so the script reads as "do this, then this must show".
 */
export function scriptSteps(calls: MethodStep[]): Step[] {
  const steps: Step[] = [];
  for (const call of calls) {
    const step = toToolStep(call);
    if (step === null) continue;
    const previous = steps[steps.length - 1];
    // AGENT-TOOLS 1.9 §14.2: a compare_screen right after an action is that step's `matches` (a width other than the default stays a step).
    if (
      step.tool === "compare_screen" &&
      previous !== undefined &&
      !["wait_for", "wait", "compare_screen"].includes(previous.tool) &&
      previous.expect === undefined &&
      (step as Record<string, unknown>)["width"] === undefined
    ) {
      const c = step as Record<string, unknown>;
      previous.expect = {
        matches: c["name"] as string,
        ...(typeof c["threshold"] === "number" ? { threshold: c["threshold"] } : {}),
        ...(Array.isArray(c["ignore"]) ? { ignore: c["ignore"] as Array<Record<string, unknown>> } : {}),
      };
      continue;
    }
    if (step.tool === "wait_for" && previous !== undefined && previous.tool !== "wait_for" && previous.tool !== "wait" && previous.expect === undefined) {
      const w = step as Record<string, unknown>;
      const which = ["text", "id", "label"].find((key) => typeof w[key] === "string");
      if (which !== undefined && w["network_idle"] !== true) {
        previous.expect = {
          [which]: w[which] as string,
          ...(w["gone"] === true ? { gone: true } : {}),
          ...(typeof w["timeout"] === "number" ? { timeout: w["timeout"] } : {}),
        };
        continue;
      }
    }
    steps.push(step);
  }
  return steps;
}

export function fromLegacy(script: LegacyScript): SharedScriptV1 {
  return {
    format: "agent-tools-script",
    version: 1,
    name: script.name,
    app: script.app.id ?? script.app.name,
    fresh: true,
    steps: scriptSteps(script.steps),
  };
}

/** A script from a file's text, either format; null when it is neither. */
export function readScript(text: string): SharedScript | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const shared = sharedScriptSchema.safeParse(json);
  if (shared.success) return shared.data;
  const legacy = legacyScriptSchema.safeParse(json);
  return legacy.success ? fromLegacy(legacy.data) : null;
}

/** A step a script can't keep: a ref (it doesn't survive a session). */
export function refStep(steps: Step[]): number | null {
  const at = steps.findIndex((step) => {
    // A performance step's tap is a target too.
    const target = (step as Record<string, unknown>)[step.tool === "performance" ? "tap" : "target"];
    return typeof target === "object" && target !== null && "ref" in target;
  });
  return at >= 0 ? at : null;
}

/**
 * A replay's failure text for JUnit (AGENT-TOOLS 1.9 §14.3): when a picture check wrote its difference, the first
 * line (the failure message) ends with ` (diff: <path>)`.
 */
export function failureWithDiff(failure: string): string {
  const lines = failure.split("\n");
  const note = lines.map((line) => /^Note: the difference is saved at (.+)\.$/.exec(line)).find((m) => m !== null && m !== undefined);
  if (note === null || note === undefined) return failure;
  lines[0] = `${lines[0] ?? ""} (diff: ${note[1] ?? ""})`;
  return lines.join("\n");
}

/**
 * A failed replay's failure text for JUnit with a repair suggestion (AGENT-TOOLS 1.15 §26.5): the failure message (the first line)
 * ends with the suggestion's lines, so a CI report shows what to change without opening the log.
 */
export function failureWithRepair(failure: string): string {
  const lines = failure.split("\n");
  const at = lines.findIndex((line) => /^Repair \(suggest/.test(line));
  if (at < 0) return failure;
  const end = lines.findIndex((line, i) => i > at && (/^To check it:/.test(line) || /^Finding/.test(line)));
  const piece = lines.slice(at, end < 0 ? lines.length : end).map((line) => line.trim()).filter((line) => line !== "").join(" ");
  lines[0] = `${lines[0] ?? ""} [${piece}]`;
  return lines.join("\n");
}

/**
 * What a failed replay's answer says about the app (AGENT-TOOLS 1.10 §15.4), for JUnit's `<system-out>`: the
 * `Logs (since step <n>):` block and the crash note.
 */
export function failureDiagnostics(failure: string): string | null {
  const lines = failure.split("\n");
  const out: string[] = [];
  const start = lines.findIndex((line) => /^Logs \(since step \d+\):$/.test(line));
  if (start >= 0) {
    out.push(lines[start] ?? "");
    for (const line of lines.slice(start + 1)) {
      if (!/^\d\d:\d\d:\d\d\.\d{3} (error|warning|info) /.test(line)) break;
      out.push(line);
    }
  }
  out.push(...lines.filter((line) => /^Note: the app (crashed|disconnected)\b/.test(line)));
  return out.length > 0 ? out.join("\n") : null;
}

/** JUnit XML for `tapline replay --junit`: one test case per script, the stop message as the failure. */
export function junitXml(results: Array<{ name: string; seconds: number; failure: string | null }>): string {
  // XML 1.0 forbids control characters other than tab, newline and carriage return (an ANSI colour code's ESC too).
  // eslint-disable-next-line no-control-regex
  const esc = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const diagnosticsOut = (failure: string): string[] => {
    const said = failureDiagnostics(failure);
    return said === null ? [] : [`      <system-out>${esc(said)}</system-out>`];
  };
  const failures = results.filter((r) => r.failure !== null).length;
  const total = results.reduce((sum, r) => sum + r.seconds, 0);
  const cases = results.map((r) =>
    r.failure === null
      ? `    <testcase classname="tapline" name="${esc(r.name)}" time="${r.seconds.toFixed(3)}"/>`
      : [
          `    <testcase classname="tapline" name="${esc(r.name)}" time="${r.seconds.toFixed(3)}">`,
          `      <failure message="${esc(r.failure.split("\n")[0] ?? "")}">${esc(r.failure)}</failure>`,
          ...diagnosticsOut(r.failure),
          "    </testcase>",
        ].join("\n"),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${results.length}" failures="${failures}" time="${total.toFixed(3)}">`,
    `  <testsuite name="tapline replay" tests="${results.length}" failures="${failures}" time="${total.toFixed(3)}">`,
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
