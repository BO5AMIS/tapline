import type { TreeElement } from "./protocol.js";
import type { Step } from "./run.js";
import { describeProbe } from "./run.js";

/**
 * AGENT-TOOLS 1.13 §9.1: the check behind a step's `if` and `optional`. One look, made once right after the
 * step before settled, with no wait of its own; `wait_for` is the step that waits.
 */

/** What to look for. `ref` is read against the app's current list; the others go to the app as one `waitFor`. */
export type Probe = { text: string } | { testID: string } | { label: string } | { ref: string };

export interface Condition {
  kind: "if" | "optional";
  probe: Probe;
  /** True: the step runs when the thing is NOT there (`if` with `gone: true`). */
  gone: boolean;
  /** How the thing reads in the skipped line: `"Not now"`, `id=save`, `e3`. */
  label: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function probeOf(source: Record<string, unknown>): Probe | null {
  const text = str(source["text"]);
  if (text !== undefined) return { text };
  const id = str(source["id"] ?? source["testID"]);
  if (id !== undefined) return { testID: id };
  const label = str(source["label"]);
  if (label !== undefined) return { label };
  const ref = str(source["ref"]);
  return ref !== undefined ? { ref } : null;
}

/** The step's `if`, then its `optional`: every check that must hold for the step to run. */
export function conditionsOf(step: Step): Condition[] {
  const found: Condition[] = [];
  const given = (step as Record<string, unknown>)["if"];
  if (typeof given === "object" && given !== null) {
    const source = given as Record<string, unknown>;
    const probe = probeOf(source);
    if (probe !== null) found.push({ kind: "if", probe, gone: source["gone"] === true, label: describeProbe(probe) });
  }
  if ((step as Record<string, unknown>)["optional"] === true) {
    const target = (step as Record<string, unknown>)["target"];
    // A point target, or a step with no target (`back`, `wait`), has nothing to look for: it always counts as there.
    const probe = typeof target === "object" && target !== null ? probeOf(target as Record<string, unknown>) : null;
    if (probe !== null) found.push({ kind: "optional", probe, gone: false, label: describeProbe(probe) });
  }
  return found;
}

/** The first check of a step, or null when it has none. */
export function conditionOf(step: Step): Condition | null {
  return conditionsOf(step)[0] ?? null;
}

/** Whether a probe matches an element, as the app's `waitFor` matches (text contains, id equal, label equal; case-insensitive text and label). */
export function matchesProbe(element: TreeElement, probe: Probe): boolean {
  if ("ref" in probe) return element.ref === probe.ref;
  if ("testID" in probe) return element.testID === probe.testID;
  if ("label" in probe) return (element.label ?? element.text ?? "").toLowerCase() === probe.label.toLowerCase();
  return (element.text ?? "").toLowerCase().includes(probe.text.toLowerCase());
}

/** Whether the check holds on a list: the thing is in it (or, with `gone`, isn't). The whole list counts, off screen too (§9.1). */
export function holdsIn(elements: TreeElement[], condition: Condition): boolean {
  return elements.some((element) => matchesProbe(element, condition.probe)) !== condition.gone;
}

/** The wire params of the one `waitFor` that makes the check (never a `ref`). */
export function waitParams(condition: Condition, glass: boolean): Record<string, unknown> | null {
  if ("ref" in condition.probe) return null;
  return { ...condition.probe, ...(condition.gone ? { gone: true } : {}), ...(glass ? { glass: true } : {}), once: true };
}
