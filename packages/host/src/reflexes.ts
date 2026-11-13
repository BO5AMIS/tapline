import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { matchesProbe, type Probe } from "./conditions.js";
import type { MapReflex } from "./mapfile.js";
import { reflexDoSchema, type ReflexDo } from "./mapcmd.js";
import type { TreeElement, TreeResult } from "./protocol.js";
import type { Step } from "./run.js";

// Declared reflexes (AGENT-TOOLS 1.13 §18.7, 1.13.1 item 10). A reflex is a rule the tool applies by itself: when its `when` is on
// screen, its `do` runs. This module holds the pure part: which reflex matches, the limits, the line, and the checks made
// at the moment one fires. Where the checks run (place changes, before a failure is answered) is in tools.ts.

/** The most a reflex may fire in one call, whatever its map entry says. */
export const MAX_REFLEX_FIRINGS = 3;

export interface ReflexContext {
  /** The place the app is at, or null when it can't be read. */
  place: string | null;
  /** How often each reflex fired in this call so far. */
  firedThisCall: Map<string, number>;
  eyes: "user" | "agent";
  /** The running journey's `allow` names `reflexes` (§17.1, §18.12). */
  journeyAllowsReflexes: boolean;
  /** Reflexes that already fired at this moment: none fires twice at one moment. */
  firedThisMoment?: ReadonlySet<string>;
  /** Open alerts: one that asks for a permission switches every reflex off. */
  alerts?: TreeResult["alerts"];
  /** The screen's size, so an element wholly off screen doesn't count as showing. */
  screen?: { width: number; height: number } | null | undefined;
}

/** A permission prompt is the test's decision, never a reflex's (§18.7). */
const PERMISSION = /would like to|wants to (access|use|send|find|track|connect)|allow\b.{0,60}\bto (access|use|find|track|send|connect)|\bpermission\b|\bmicrophone\b|\bcamera\b.*\baccess\b/i;

export const isPermissionText = (text: string): boolean => PERMISSION.test(text);

function probeOf(when: MapReflex["when"]): Probe | null {
  const parts = [when.text, when.label, when.id].filter((value) => typeof value === "string" && value !== "");
  if (parts.length !== 1) return null;
  if (typeof when.text === "string" && when.text !== "") return { text: when.text };
  if (typeof when.label === "string" && when.label !== "") return { label: when.label };
  return typeof when.id === "string" && when.id !== "" ? { testID: when.id } : null;
}

/** Whether any part of the element lies on the screen (an element with no frame is taken as showing). */
function showing(element: TreeElement, screen: ReflexContext["screen"]): boolean {
  const frame = element.frame;
  if (frame === null || frame === undefined || screen === null || screen === undefined) return true;
  return frame.x < screen.width && frame.x + frame.width > 0 && frame.y < screen.height && frame.y + frame.height > 0;
}

const maxOf = (reflex: MapReflex): number => (typeof reflex.max === "number" && Number.isFinite(reflex.max) ? Math.min(MAX_REFLEX_FIRINGS, Math.max(1, Math.floor(reflex.max))) : 1);

/** The first reflex of the map whose moment has come, or null. */
export function matchReflex(reflexes: MapReflex[], screen: TreeElement[], ctx: ReflexContext): MapReflex | null {
  // Off in a user's-eyes journey unless its start allows reflexes: there the interruption is a finding.
  if (ctx.eyes === "user" && !ctx.journeyAllowsReflexes) return null;
  if (ctx.alerts?.some((alert) => isPermissionText(`${alert.title} ${alert.message ?? ""}`))) return null;
  for (const reflex of reflexes) {
    if (ctx.firedThisMoment?.has(reflex.name) === true) continue;
    if ((ctx.firedThisCall.get(reflex.name) ?? 0) >= maxOf(reflex)) continue;
    if (reflex.at !== undefined && reflex.at !== ctx.place) continue;
    const probe = probeOf(reflex.when);
    if (probe === null) continue;
    if ("text" in probe && isPermissionText(probe.text)) continue;
    if (screen.some((element) => showing(element, ctx.screen) && matchesProbe(element, probe))) return reflex;
  }
  return null;
}

/**
 * The failures a reflex gets its chance before they are answered (1.13.1 item 10): a target that isn't there, one covered by
 * something, or one behind an alert. Anything else (a policy refusal, a stale ref) is not for a reflex.
 */
export function isReflexFailure(code: string, message: string): boolean {
  return code === "not_found" || (code === "not_actionable" && /^(covered|behind_alert)\b/.test(message));
}

// -- the words

const quoted = (value: string): string => JSON.stringify(value);

function targetWords(target: { id?: string; label?: string; text?: string } | undefined): string {
  if (target === undefined) return "";
  if (target.text !== undefined) return quoted(target.text);
  if (target.label !== undefined) return quoted(target.label);
  return target.id !== undefined ? `id=${target.id}` : "";
}

/** What the reflex did, as a past-tense phrase: `tapped "Not now"`. */
function didWords(step: ReflexDo): string {
  switch (step.tool) {
    case "tap":
      return `tapped ${targetWords(step.target)}`;
    case "long_press":
      return `long-pressed ${targetWords(step.target)}`;
    case "toggle":
      return `toggled ${targetWords(step.target)}`;
    case "back":
      return "went back";
    case "swipe":
      return "swiped";
    case "scroll":
      return "scrolled";
    case "open_url":
      return "opened a link";
  }
}

/** What the reflex's step would be, in the present: for a refusal (`tap "Delete trip"`). */
function wouldWords(step: ReflexDo): string {
  const verb = step.tool === "long_press" ? "long press" : step.tool === "open_url" ? "open a link" : step.tool;
  return "target" in step && step.target !== undefined ? `${verb} ${targetWords(step.target)}` : verb;
}

/** `Reflex: closed "Rate Wayfare" (tapped "Not now").` Every firing is in the answer (§18.7). */
export function reflexLine(reflex: MapReflex): string {
  const when = targetWords(reflex.when);
  const step = reflexDoSchema.safeParse(reflex.do);
  return `Reflex: closed ${when} (${step.success ? didWords(step.data) : "ran its step"}).`;
}

// -- firing

/** The policy's verdict on a reflex's `do` at the moment it fires. */
export type ReflexVerdict = { kind: "none" } | { kind: "flagged" | "blocked"; word: string } | { kind: "unresolved"; why: string };

/** The same check a single call passes (§11), made against what the app shows now. */
export type PolicyCheck = (step: ReflexDo) => Promise<ReflexVerdict>;

/**
 * Fires one reflex. Its `do` is read again from the map file, which a person may have edited, and has to be a step a reflex may
 * take (no force, no typing). The policy is checked again right now: a flagged `do` needs a person's OK and a reflex never
 * asks for one, so it doesn't fire; a blocked one never fires (§18.7).
 */
export async function fireReflex(
  reflex: MapReflex,
  run: (step: Step) => Promise<CallToolResult>,
  policy: PolicyCheck,
): Promise<{ line: string } | { skipped: string }> {
  const parsed = reflexDoSchema.safeParse(reflex.do);
  if (!parsed.success) return { skipped: `reflex ${reflex.name} didn't fire: its do is not a step a reflex may take.` };
  const step = parsed.data;
  const verdict = await policy(step);
  if (verdict.kind === "blocked") {
    return { skipped: `reflex ${reflex.name} didn't fire: it would ${wouldWords(step)}, which the policy blocks (${quoted(verdict.word)}).` };
  }
  if (verdict.kind === "flagged") {
    return { skipped: `reflex ${reflex.name} didn't fire: it would ${wouldWords(step)}, which the policy flags (${quoted(verdict.word)}); a reflex never asks for a person's OK.` };
  }
  if (verdict.kind === "unresolved") return { skipped: `reflex ${reflex.name} didn't fire: ${verdict.why}.` };
  const answer = await run(step);
  if (answer.isError === true) {
    const first = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").split("\n")[0] ?? "";
    return { skipped: `reflex ${reflex.name} didn't fire: its step failed (${first.replace(/^Error /, "").slice(0, 120)}).` };
  }
  return { line: reflexLine(reflex) };
}
