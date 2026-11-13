import { z } from "zod";

/**
 * AGENT-TOOLS 1.8 §9: `run`, a batch of ordinary tool calls that is also a script. Runs the steps in order,
 * stops at the first failed call or expectation, and answers once. Tapline's executor is the host: each step
 * goes to the app as it would alone (no screen list in between), and the one change block at the end covers
 * the whole batch.
 */

export const RUN_TOOLS = ["tap", "long_press", "type_text", "scroll", "toggle", "back", "swipe", "open_url", "wait", "wait_for", "app_command", "compare_screen", "performance", "drive"] as const;
export type RunTool = (typeof RUN_TOOLS)[number];

/** Tools a step may not be (they read or manage, rather than act): `bad_params`. */
export const NOT_IN_RUN = ["look", "run", "audit", "ux_check", "media", "apps", "viewer", "record", "replay", "inspect", "check_layout", "pair", "open_app", "logs", "crash", "reload", "filmstrip", "session_report", "journey", "map"];

/** AGENT-TOOLS §15.3: the limits a `performance` step may carry in `expect.under`. */
export const UNDER_KEYS = ["launch_s", "memory_mb", "js_heap_mb", "cpu_percent", "fps_min", "drops", "busy_ms"] as const;
/** Limits Tapline can't measure: ignored with a note, one per key. */
export const UNDER_NOT_MEASURED = ["memory_mb", "cpu_percent"] as const;

export const expectSchema = z
  .object({
    text: z.string().optional(),
    id: z.string().optional(),
    label: z.string().optional(),
    gone: z.boolean().optional(),
    value: z.string().optional(),
    // A reference name: no slash or dot first, so it can never reach outside the references folder (checked before any step runs).
    matches: z.string().regex(/^[A-Za-z0-9][\w.-]{0,60}$/, "matches names a reference with letters, digits, '.', '_' and '-'").optional(),
    threshold: z.number().min(0).max(100).optional(),
    /** Targets or rects painted out before the picture check (the shape of compare_screen's ignore); checked by the executor. */
    ignore: z.array(z.record(z.string(), z.unknown())).optional(),
    timeout: z.number().min(0.5).max(30).optional(),
    /** On a `performance` step only; the keys are checked when the batch runs (`bad_params`). */
    under: z.record(z.string(), z.number()).optional(),
  })
  .refine(
    (e) => {
      const named = [e.text, e.id, e.label].filter((v) => v !== undefined).length;
      // `under` (a performance step) stands alone.
      if (e.under !== undefined) return named === 0 && e.matches === undefined;
      return named === 1 || (e.matches !== undefined && named === 0);
    },
    { message: "expect needs exactly one of text, id or label, or matches (alone, or with one of them); on a performance step, under alone" },
  )
  .refine((e) => e.threshold === undefined || e.matches !== undefined, { message: "expect.threshold goes with matches" })
  .refine((e) => e.ignore === undefined || e.matches !== undefined, { message: "expect.ignore goes with matches" })
  .refine((e) => e.value === undefined || e.text === undefined, { message: "expect.value goes with id or label" });
export type Expect = z.infer<typeof expectSchema>;

/** AGENT-TOOLS 1.13 §9.1: a step's `if`, one of text, id or label (as in `expect`), `gone: true` for when it isn't there. */
export const ifSchema = z
  .object({
    text: z.string().min(1, "if text can't be empty").optional(),
    id: z.string().min(1, "if id can't be empty").optional(),
    label: z.string().min(1, "if label can't be empty").optional(),
    gone: z.boolean().optional(),
  })
  .strict()
  .refine((c) => [c.text, c.id, c.label].filter((v) => v !== undefined).length === 1, { message: "if needs exactly one of text, id or label" });
export type If = z.infer<typeof ifSchema>;

export const stepSchema = z
  .object({ tool: z.string(), expect: expectSchema.optional(), if: ifSchema.optional(), optional: z.boolean().optional() })
  .passthrough();
export type Step = z.infer<typeof stepSchema>;

/** How a probe reads in the skipped line: `"Not now"` for a text or a label, `id=save`, or a ref as it is. */
export function describeProbe(probe: { text: string } | { testID: string } | { label: string } | { ref: string }): string {
  if ("text" in probe) return JSON.stringify(probe.text);
  if ("testID" in probe) return `id=${probe.testID}`;
  if ("label" in probe) return JSON.stringify(probe.label);
  return probe.ref;
}

/** The line that says a step didn't run (AGENT-TOOLS 1.13 §9.1): `  3. skipped (if: "Not now" isn't on screen).` */
export function skippedLine(index: number, kind: "if" | "optional", what: string, gone?: boolean): string {
  return `  ${index}. skipped (${kind}: ${what} ${gone === true ? "is still on screen" : "isn't on screen"}).`;
}

export const MAX_STEPS = 50;
export const RUN_TIMEOUT_MS = 120_000;
export const EXPECT_TIMEOUT_S = 2;

/** How the answer names a step: its tool and its target as the agent wrote it (`tap "Save"`, `tap id=save`). */
export function describeRunStep(step: Step): string {
  const p = step as Record<string, unknown>;
  const target = p["target"];
  let where = "";
  if (typeof target === "object" && target !== null) {
    const t = target as Record<string, unknown>;
    if (typeof t["id"] === "string") where = `id=${t["id"]}`;
    else if (typeof t["text"] === "string") where = JSON.stringify(t["text"]);
    else if (typeof t["label"] === "string") where = JSON.stringify(t["label"]);
    else if (typeof t["ref"] === "string") where = String(t["ref"]);
    else if (typeof t["x"] === "number") where = `${String(t["x"])},${String(t["y"])}`;
  }
  switch (step.tool) {
    case "scroll":
      return `scroll ${typeof p["to"] === "string" ? `to ${p["to"]}` : typeof p["direction"] === "string" ? p["direction"] : "down"}${where ? ` ${where}` : ""}`;
    case "wait":
      return `wait ${Number(p["seconds"] ?? 0).toFixed(1)}`;
    case "wait_for": {
      const what = typeof p["text"] === "string" ? JSON.stringify(p["text"]) : typeof p["id"] === "string" ? `id=${p["id"]}` : typeof p["label"] === "string" ? JSON.stringify(p["label"]) : "";
      return `wait_for ${what}${p["gone"] === true ? " gone" : ""}`.trim();
    }
    case "open_url":
      return "open_url";
    case "app_command":
      return `app_command ${String(p["name"] ?? "")}`.trim();
    case "performance":
      return p["launch"] === true ? "performance launch" : `performance ${Number(p["seconds"] ?? 3)} s`;
    case "back":
      return "back";
    case "drive": {
      // A drive step reads as the place or route it goes to (AGENT-TOOLS 1.13 9.1: it counts as one step).
      const where = typeof p["to"] === "string" ? p["to"] : typeof p["route"] === "string" ? `route ${p["route"]}` : "";
      return `drive${where !== "" ? ` ${where}` : ""}`;
    }
    case "compare_screen":
      return `compare_screen ${JSON.stringify(p["name"] ?? "")}`;
    default:
      return where ? `${step.tool} ${where}` : step.tool;
  }
}

/** How a failed expectation reads: `text "Saved" didn't appear within 2 s`. */
export function expectFailure(e: Expect, seconds: number, actual?: string): string {
  const what = e.text !== undefined ? `text ${JSON.stringify(e.text)}` : e.id !== undefined ? `id ${JSON.stringify(e.id)}` : `label ${JSON.stringify(e.label)}`;
  if (e.value !== undefined) {
    return `${what} didn't have the value ${JSON.stringify(e.value)} within ${seconds} s${actual !== undefined ? ` (it has ${JSON.stringify(actual)})` : ""}`;
  }
  return e.gone === true ? `${what} didn't go away within ${seconds} s` : `${what} didn't appear within ${seconds} s`;
}

/** `Note:` lines from a step's own answer, labelled with the step (`Note (step 2): closed the keyboard first.`). */
export function stepNotes(answer: string, step: number): string[] {
  return answer
    .split("\n")
    .filter((line) => line.startsWith("Note: ") && !line.startsWith("Note: changes are since your last list"))
    .map((line) => `Note (step ${step}): ${line.slice("Note: ".length)}`);
}

/** The error line of a failed step's answer, split into its code and message. */
export function parseError(answer: string): { code: string; message: string; rest: string[] } {
  const [first = "", ...rest] = answer.split("\n");
  const m = /^Error (\w+): (.*)$/.exec(first);
  return m ? { code: m[1]!, message: m[2]!, rest } : { code: "internal", message: first, rest };
}
