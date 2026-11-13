import { setStep } from "../guard.js";
import { checkUnchanged, closeKeyboard, expectState, resetLab } from "../lab.js";
import type { CallResult, ToolSession } from "../mcp.js";
import {
  R1_STEPS,
  R3_CHECKS,
  R5_CHECK,
  R6_CHECK,
  NO_ALERT_NOTE,
  type ActStep,
  type RefuseCheck,
  type StateCall,
  type Target,
} from "./checks.js";
import {
  bringIntoView,
  elementRect,
  failed,
  fieldParts,
  firstLine,
  isOnScreen,
  parseError,
  parseStateFields,
  readStateFields,
  screenOf,
  shareSheetListed,
  showState,
  startsWithReason,
} from "./helpers.js";

export type CheckGroup = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

/** One check's result. `note` says what went wrong when `ok` is false. */
export interface Outcome {
  id: CheckGroup;
  name: string;
  ok: boolean;
  note?: string;
}

export interface Env {
  tool: ToolSession;
  hasAlert: boolean;
  sleep: (ms: number) => Promise<void>;
  /** Notes that are not misses (skipped checks), collected once. */
  skipNotes: Set<string>;
  /** Tokens to redact from notes. */
  token?: string;
  /** The lab app's `App:` value when the tool is guarded; viewer taps check it first. */
  labApp?: string;
  /** The suite's run (1, 2, 3 …), for the guard's stop message. */
  run?: number;
}

/** Tells the guard which check runs now, as `run 2 R3 "Covered refused"`. */
export function markStep(env: Env, group: CheckGroup, name: string): void {
  setStep(env.tool, `${env.run !== undefined ? `run ${env.run} ` : ""}${group} "${name}"`);
}

const idOf = (t: Target | undefined): string | null => (t && "id" in t ? t.id : null);

function argsOf(c: StateCall, look: boolean): Record<string, unknown> {
  return { ...(c.target ? { target: c.target } : {}), ...(c.args ?? {}), ...(look || c.tool === "alert" ? {} : { look: false }) };
}

export interface CallOutcome {
  result: CallResult;
  /** Expected lab-state parts that did not show (all of them when the call was refused). */
  missing: string[];
  /** For `scrollsInto`: why the step doesn't prove the tool scrolled to the target (empty when it does). */
  unproven?: string[];
}

/**
 * What marks the lab's fixed header band: the bar itself (`lab-bar`) when the tool lists it, and
 * `lab-behind-bar`, the button the bar covers (QUALITY-BAR 2.5 R3). The band ends at the lowest edge listed.
 */
const HEADER_MARKS = ["lab-bar", "lab-behind-bar"];

/**
 * Where `id` is now, from a fresh look: `clear` (on screen, below the header band when the look lists
 * a mark of it), `under-header` (on screen, but its top is inside that band), `off` (not listed, or
 * its centre is outside the screen), or `unknown` (the look failed or has no Screen line). Only a
 * successful, readable look counts as evidence either way.
 */
export async function whereNow(
  env: Env,
  id: string,
): Promise<{ at: "clear" | "under-header" | "off" | "unknown"; why?: string }> {
  const r = await env.tool.call("look", { screenshot: false });
  if (failed(r)) return { at: "unknown", why: `the look failed: ${line(env, r)}` };
  if (!screenOf(r.text)) return { at: "unknown", why: "the look has no Screen line" };
  if (!isOnScreen(r.text, id)) return { at: "off" };
  const rect = elementRect(r.text, id);
  let headerBottom = -Infinity;
  for (const mark of HEADER_MARKS) {
    const m = elementRect(r.text, mark);
    if (m) headerBottom = Math.max(headerBottom, m.y + m.h);
  }
  if (rect && rect.y < headerBottom) return { at: "under-header" };
  return { at: "clear" };
}

/** Brings the target into view, makes the call, then waits for each expected state part. */
export async function runStateCall(
  env: Env,
  c: StateCall,
  opts: { immediate?: boolean; look?: boolean } = {},
): Promise<CallOutcome> {
  const unproven: string[] = [];
  for (const b of c.before ?? []) {
    const r = await env.tool.call(b.tool, b.args);
    if (c.scrollsInto && failed(r)) unproven.push(`${b.tool} before the call failed: ${line(env, r)}`);
  }
  const bring = c.bring === undefined ? idOf(c.target) : c.bring;
  if (bring && !opts.immediate) await bringIntoView(env.tool, bring);
  if (c.scrollsInto) {
    const before = await whereNow(env, c.scrollsInto);
    if (before.at === "unknown") {
      unproven.push(`couldn't see whether ${c.scrollsInto} was off screen before the call (${before.why ?? "no look"})`);
    } else if (before.at !== "off") {
      unproven.push(`${c.scrollsInto} was already on screen before the call, so nothing shows the tool scrolled to it`);
    }
  }
  const result = await env.tool.call(c.tool, argsOf(c, opts.look ?? false));
  // Read the screen at once: missingStates may scroll back to the top to read lab-state.
  if (c.scrollsInto && !failed(result)) {
    const after = await whereNow(env, c.scrollsInto);
    if (after.at === "unknown") {
      unproven.push(`couldn't see ${c.scrollsInto} right after the call (${after.why ?? "no look"})`);
    } else if (after.at === "off") {
      unproven.push(`${c.scrollsInto} wasn't on screen right after the call: the tool acted without scrolling to it`);
    } else if (after.at === "under-header") {
      unproven.push(`${c.scrollsInto} was under the fixed header right after the call: the tool acted where a person couldn't`);
    }
  }
  return {
    result,
    missing: await missingStates(env, result, c.expect ?? []),
    ...(c.scrollsInto ? { unproven } : {}),
  };
}

async function missingStates(env: Env, result: CallResult, expect: string[]): Promise<string[]> {
  if (failed(result)) return [...expect];
  if (expect.length === 0) return [];
  const look = await showState(env.tool);
  const missing: string[] = [];
  for (const part of expect) {
    // A tool that shows the share popover hides the app behind it, lab-state included.
    if (part === "shared=opened" && shareSheetListed(look)) continue;
    if (!(await expectState(env.tool, part))) missing.push(part);
  }
  return missing;
}

const line = (env: Env, r: CallResult): string => firstLine(r.text, env.token);

/* ---------- R1 and R2 ---------- */

/**
 * The alert flow. An alert the app draws itself (Tapline's stand-in) is answered by tapping its OK
 * button by text, whether the tool reports it as an `Alert:` line or lists its button; an OS alert
 * with the tool's `alert`.
 */
async function runAlertStep(env: Env, step: ActStep): Promise<CallOutcome> {
  const opened = await runStateCall(env, { ...step, expect: [] }, { look: true });
  if (failed(opened.result)) return { result: opened.result, missing: step.expect ?? [] };
  let answered: CallResult;
  const text = opened.result.text;
  if (/^Alert:.*\bOK\b/m.test(text) || /\bbutton "OK"/.test(text)) {
    answered = await env.tool.call("tap", { target: { text: "OK" }, look: false });
  } else if (env.hasAlert) {
    answered = await env.tool.call("alert", { action: "accept" });
  } else {
    return {
      result: opened.result,
      missing: [`${(step.expect ?? []).join(", ")} (no Alert: line with OK, and the tool has no alert)`],
    };
  }
  return { result: answered, missing: await missingStates(env, answered, step.expect ?? []) };
}

export async function runR1(env: Env): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const step of R1_STEPS) {
    markStep(env, "R1", step.name);
    const { result, missing, unproven = [] } = step.alert
      ? await runAlertStep(env, step)
      : await runStateCall(env, step, { immediate: step.immediate === true });
    if (step.closeKeyboard) await closeKeyboard(env.tool);
    const refused = failed(result);
    const problems = [
      ...unproven,
      ...(missing.length > 0 ? [`state lacks ${missing.join(", ")}`] : []),
    ];
    out.push({
      id: "R1",
      name: step.name,
      ok: !refused && problems.length === 0,
      ...(refused
        ? { note: line(env, result) }
        : problems.length > 0
        ? { note: `${problems.join("; ")}; answer: ${line(env, result)}` }
        : {}),
    });
    out.push({
      id: "R2",
      name: step.name,
      ok: !refused,
      ...(refused ? { note: line(env, result) } : {}),
    });
  }
  return out;
}

/* ---------- R3 ---------- */

/** Below the status and navigation bars on any iPhone in portrait, in points. */
const TOP_BARS_PT = 110;

/**
 * Where a person taps to close a popover-style share sheet (iOS 26): inside the full-screen
 * `PopoverDismissRegion`, halfway between the top bars and the sheet's top edge, far from any share
 * target. Null when the look lists no such region.
 */
export function popoverDismissPoint(lookText: string): { x: number; y: number } | null {
  const region = elementRect(lookText, "PopoverDismissRegion");
  if (!region) return null;
  const sheet = elementRect(lookText, "ActivityListView");
  const top = Math.max(region.y, TOP_BARS_PT);
  const sheetTop = sheet ? sheet.y : region.y + region.h / 2;
  if (sheetTop - top < 40) return null; // no clear room above the sheet
  return { x: Math.round(region.x + region.w / 2), y: Math.round((top + sheetTop) / 2) };
}

/** A look shows the share sheet: its parts are listed, or no lab element is (the sheet covers the lab). */
export function shareSheetShown(lookText: string): boolean {
  return shareSheetListed(lookText) || !/\bid=lab-/.test(lookText);
}

/**
 * Dismisses the OS share sheet by the tool's own means; true when a look no longer shows it. Judged by
 * a look, not by lab-state, which may be scrolled off screen. Each further means is tried only while
 * the sheet is still shown, and `back` only while its parts are listed: on the lab itself, `back`
 * leaves the lab.
 */
export async function dismissShare(env: Env): Promise<boolean> {
  const look = async (): Promise<string> => (await env.tool.call("look", { screenshot: false })).text;
  let text = await look();
  if (!shareSheetShown(text)) {
    // The look shows the lab. When lab-state is on screen it can still say the sheet is open: a tool
    // that doesn't see the sheet. Then only its own means, no touch (a touch would land on the sheet).
    const stateOnScreen = /\bid=lab-state(?:\s|$)/m.test(text);
    if (!stateOnScreen || !(await expectState(env.tool, "shared=opened", 0.3))) return true;
    await env.tool.call("alert", { action: "dismiss" });
    return (await expectState(env.tool, "shared=dismissed", 2)) || (await expectState(env.tool, "shared=done", 0.5));
  }
  // A popover share sheet closes the way a person closes it: a tap outside the sheet.
  const point = popoverDismissPoint(text);
  if (point) {
    await env.tool.call("tap", { target: point, look: false });
    text = await look();
    if (!shareSheetShown(text)) return true;
  }
  await env.tool.call("alert", { action: "dismiss" });
  text = await look();
  if (!shareSheetShown(text)) return true;
  if (!shareSheetListed(text)) return false;
  await env.tool.call("back", { look: false });
  return !shareSheetShown(await look());
}

export async function runRefuse(env: Env, c: RefuseCheck): Promise<Outcome | null> {
  if (c.needsAlert && !env.hasAlert) {
    env.skipNotes.add(NO_ALERT_NOTE);
    return null;
  }
  const problems: string[] = [];
  let ready = true;
  // Under OS-drawn UI the state can't be read; what `pressed=` says is read now, while it can.
  let pressedBefore: string | undefined;
  if (c.needsAlert) {
    await showState(env.tool);
    pressedBefore = fieldParts(await readStateFields(env.tool)).find((part) => part.startsWith("pressed="));
  }
  for (const s of c.setup ?? []) {
    const { result, missing } = await runStateCall(env, s);
    if (failed(result) || missing.length > 0) {
      ready = false;
      problems.push(`setup failed: ${failed(result) ? line(env, result) : `state lacks ${missing.join(", ")}`}`);
    }
  }
  let dirty = false;
  let tapped = false;
  if (ready) {
    for (const b of c.before ?? []) await env.tool.call(b.tool, b.args);
    const bring = c.bring === undefined ? idOf(c.target) : c.bring;
    if (bring) await bringIntoView(env.tool, bring);
    const look = await env.tool.call("look", { screenshot: false });
    const baseline = fieldParts(parseStateFields(look.text));
    if (c.needsAlert && !seesOsCover(look.text)) {
      // A real touch here would land on what the OS drew (a share target opens another app).
      problems.push(
        "the tool's look shows nothing covering the target while the OS UI is open; the runner sent no tap",
      );
    } else {
      tapped = true;
      dirty = await tapAndJudge(env, c, baseline, problems);
    }
  }
  for (const s of c.teardown ?? []) {
    const { result, missing } = await runStateCall(env, s);
    if (failed(result) || missing.length > 0) {
      problems.push(`teardown failed: ${failed(result) ? line(env, result) : `state lacks ${missing.join(", ")}`}`);
    }
  }
  if (c.dismissShare && !(await dismissShare(env))) {
    env.skipNotes.add("note: the share sheet could not be dismissed generically (alert dismiss, back)");
  }
  if (tapped && c.needsAlert) dirty = (await judgeAfterCover(env, c, pressedBefore, problems)) || dirty;
  if (dirty || problems.some((p) => p.startsWith("teardown"))) await resetLab(env.tool);
  return { id: "R3", name: c.name, ok: problems.length === 0, ...(problems.length ? { note: problems.join("; ") } : {}) };
}

/**
 * True when a look taken with OS-drawn UI open (native alert, share sheet) shows it: an `Alert:` line,
 * the note that something outside the app covers it, or none of the lab's elements listed (the UI
 * covers the whole lab). A missing target alone proves nothing: it may just be scrolled away.
 */
export function seesOsCover(lookText: string): boolean {
  if (/^Alert:/m.test(lookText)) return true;
  if (/^Note: something outside the app/m.test(lookText)) return true;
  return !/\bid=lab-/.test(lookText);
}

/**
 * The state check of a refusal under OS-drawn UI, once the cover is closed and lab-state can be
 * read: what the setup pressed is still the last press, and the refused target's press never came.
 * Closing the cover sets its own fields (alert=…, shared=…), so only `pressed=` is compared.
 */
async function judgeAfterCover(env: Env, c: RefuseCheck, pressedBefore: string | undefined, problems: string[]): Promise<boolean> {
  await showState(env.tool);
  const changed = await checkUnchanged(env.tool, pressedBefore ? [pressedBefore] : [], [`pressed=${c.notPressed}`]);
  if (changed.length === 0) return false;
  problems.push(`lab state changed (${changed.map((part) => `${part} once the cover was closed`).join(", ")})`);
  return true;
}

/** Taps the target that must be refused and notes what went wrong. True when the lab state changed. */
async function tapAndJudge(env: Env, c: RefuseCheck, baseline: string[], problems: string[]): Promise<boolean> {
  const r = await env.tool.call("tap", { target: c.target, look: false });
  const err = parseError(r.text);
  if (err?.code === "not_actionable") {
    if (!startsWithReason(err.message, c.reasons)) {
      problems.push(`wrong reason (want ${c.reasons.join(" or ")}): ${line(env, r)}`);
    }
  } else if (err?.code === "not_found" && c.notFoundNote) {
    problems.push(`${c.notFoundNote}: ${line(env, r)}`);
  } else if (err) {
    problems.push(`${err.code} instead of not_actionable: ${line(env, r)}`);
  } else {
    problems.push(`acted instead of refusing: ${line(env, r)}`);
  }
  // OS-drawn UI hides lab-state from a tool that sees it, so "it didn't appear" proves nothing while
  // it is open: the state is judged once the cover is closed (`judgeAfterCover`).
  if (c.needsAlert) return false;
  const changed = await checkUnchanged(env.tool, baseline, [`pressed=${c.notPressed}`]);
  if (changed.length === 0) return false;
  problems.push(`lab state changed (${changed.join(", ")})`);
  return true;
}

/** R3 checks that need no OS UI, then the ones that do (last, so a stuck dialog spoils little). */
export async function runR3(env: Env, osChecks: boolean): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const c of R3_CHECKS.filter((x) => (x.needsAlert === true) === osChecks)) {
    markStep(env, "R3", c.name);
    const o = await runRefuse(env, c);
    if (o) out.push(o);
  }
  return out;
}

/* ---------- R5 ---------- */

export async function runR5(env: Env): Promise<Outcome> {
  markStep(env, "R5", R5_CHECK.name);
  await bringIntoView(env.tool, "lab-dup-1");
  const baseline = fieldParts(await readStateFields(env.tool));
  const r = await env.tool.call("tap", { target: R5_CHECK.target, look: false });
  const problems: string[] = [];
  const err = parseError(r.text);
  if (err?.code !== "ambiguous") {
    problems.push(`${err ? err.code : "acted"} instead of ambiguous: ${line(env, r)}`);
  } else if (!r.text.includes("Candidates:")) {
    problems.push("ambiguous without a Candidates: block");
  }
  const changed = await checkUnchanged(
    env.tool,
    baseline,
    R5_CHECK.notPressed.map((p) => `pressed=${p}`),
  );
  if (changed.length > 0) {
    problems.push(`lab state changed (${changed.join(", ")})`);
    await resetLab(env.tool);
  }
  return { id: "R5", name: R5_CHECK.name, ok: problems.length === 0, ...(problems.length ? { note: problems.join("; ") } : {}) };
}

/* ---------- R6 ---------- */

/** Times for R6, all in ms. */
export interface R6Options {
  /** How long the lab's freeze blocks the app (the lab's own 20 s). */
  freezeMs: number;
  /** Extra wait after the freeze before the look that must work again. */
  recoverMs: number;
  /** A call made during the freeze must end within this. */
  callLimitMs: number;
  /** The look after the freeze must succeed within this. */
  afterLimitMs: number;
}

export const R6_DEFAULTS: R6Options = { freezeMs: 20_000, recoverMs: 2_000, callLimitMs: 20_000, afterLimitMs: 5_000 };

/** A real timer: tests replace `env.sleep`, but R6 waits for the app's own clock. */
const realWait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `0.06 s`: seconds, at most two decimals. */
const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(2))} s`;

/** The call's answer and how long it took. */
async function timedCall(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: CallResult; ms: number }> {
  const start = performance.now();
  const result = await env.tool.call(name, args);
  return { result, ms: performance.now() - start };
}

/** The answer is a success or an error that ends a call on a frozen app clearly. */
const endsClearly = (r: CallResult): boolean =>
  !failed(r) || R6_CHECK.clearCodes.includes(parseError(r.text)?.code ?? "");

const listsLab = (r: CallResult): boolean => !failed(r) && /\bid=lab-/.test(r.text);

/**
 * R6, drops end clearly: freezes the app's JavaScript for `freezeMs` (the lab's `lab-freeze`), then
 * checks that calls during the freeze end in time and clearly, that the tool works again afterwards,
 * that the freeze really happened (`froze=1`) and that the next action lands. Null (and a skip note)
 * when the lab has no `lab-freeze`. The lab is reset afterwards, so `froze` goes back to 0.
 */
export async function runR6(env: Env, opts: R6Options): Promise<Outcome | null> {
  markStep(env, "R6", R6_CHECK.step);
  if (!(await bringIntoView(env.tool, R6_CHECK.freezeId))) {
    env.skipNotes.add(R6_CHECK.noFixtureNote);
    return null;
  }
  const problems: string[] = [];
  const started = performance.now();
  const tapped = await timedCall(env, "tap", { target: { id: R6_CHECK.freezeId }, look: false });
  if (!endsClearly(tapped.result)) {
    problems.push(`the freezing tap answered ${parseError(tapped.result.text)?.code ?? line(env, tapped.result)}`);
  }
  if (tapped.ms > opts.callLimitMs) {
    problems.push(`the freezing tap took ${seconds(tapped.ms)} (limit ${seconds(opts.callLimitMs)})`);
  }
  // The app is frozen now: a look must end in time, as a normal look or a clear error.
  const during = await timedCall(env, "look", { screenshot: false });
  if (!listsLab(during.result) && !endsClearly(during.result)) {
    problems.push(`the look during the freeze answered: ${line(env, during.result)}`);
  } else if (!failed(during.result) && !listsLab(during.result)) {
    problems.push("the look during the freeze lists no lab elements");
  }
  if (during.ms > opts.callLimitMs) {
    problems.push(`look during the freeze took ${seconds(during.ms)} (limit ${seconds(opts.callLimitMs)})`);
  }
  const wait = started + opts.freezeMs + opts.recoverMs - performance.now();
  if (wait > 0) await realWait(wait);
  const after = await timedCall(env, "look", { screenshot: false });
  if (!listsLab(after.result)) {
    problems.push(`after the freeze the look failed: ${line(env, after.result)}`);
  } else if (after.ms > opts.afterLimitMs) {
    problems.push(`after the freeze the look took ${seconds(after.ms)} (limit ${seconds(opts.afterLimitMs)})`);
  }
  if (listsLab(after.result)) await judgeAfterFreeze(env, problems);
  await resetLab(env.tool);
  return { id: "R6", name: R6_CHECK.name, ok: problems.length === 0, ...(problems.length ? { note: problems.join("; ") } : {}) };
}

/** The state says the freeze happened, and the next action (a tap on lab-taps) still lands. */
async function judgeAfterFreeze(env: Env, problems: string[]): Promise<void> {
  await showState(env.tool);
  if (!(await expectState(env.tool, "froze=1", 2))) {
    problems.push("state lacks froze=1 (the freeze didn't happen, so nothing was tested)");
  }
  // taps may not be 0 here, so the expected value is read first.
  const taps = Number((await readStateFields(env.tool)).taps);
  if (!Number.isInteger(taps)) {
    problems.push("the next action was not tested: taps= is not readable in the state");
    return;
  }
  const { result, missing } = await runStateCall(env, {
    tool: "tap",
    target: { id: "lab-taps" },
    expect: [`taps=${taps + 1}`],
  });
  if (failed(result)) problems.push(`the next action after the freeze failed: ${line(env, result)}`);
  else if (missing.length > 0) problems.push(`the next action after the freeze did not land: state lacks ${missing.join(", ")}`);
}
