import { stepOf } from "./guard.js";
import type { CallResult, ToolSession } from "./mcp.js";

/** A placeholder: every config names its own app's lab link in `labUrl`. */
export const DEFAULT_LAB_URL = "example://lab";

export function isErrorAnswer(text: string, isError: boolean): boolean {
  return isError || text.trimStart().startsWith("Error");
}

/** Opens the lab by deep link and waits for its state element. */
export async function openLab(tool: ToolSession, labUrl: string = DEFAULT_LAB_URL): Promise<void> {
  const opened = await tool.call("open_url", { url: labUrl, look: false });
  if (isErrorAnswer(opened.text, opened.isError)) {
    throw new Error(`open_url ${labUrl} failed: ${opened.text}`);
  }
  const ready = await tool.call("wait_for", { id: "lab-state", timeout: 15, look: false });
  if (isErrorAnswer(ready.text, ready.isError)) {
    throw new Error(`The lab did not appear (lab-state): ${ready.text}`);
  }
}

/** The start of lab-state right after a reset. */
export const RESET_STATE = "pressed=- typed= typed2= switch=off taps=0 long=0";

/**
 * How long the reset may take to show in lab-state, in seconds. It is a check that the reset landed,
 * not a timing: 2 s was enough over USB and the local host, and too short for a tool over Wi-Fi.
 */
export const RESET_WAIT_S = 5;

/** The first button (Cancel) of the lab's alert as the in-app stand-in draws it. */
export const LAB_ALERT_CANCEL = "tapline-alert-button-0";

/**
 * Closes a lab alert left open over the lab (its taps would cover everything else): taps its Cancel
 * button when a look lists it. True when it closed one.
 */
export async function closeLeftoverAlert(tool: ToolSession): Promise<boolean> {
  const look = await tool.call("look", { screenshot: false });
  if (!look.text.includes(`id=${LAB_ALERT_CANCEL}`)) return false;
  await tool.call("tap", { target: { id: LAB_ALERT_CANCEL }, look: false });
  return true;
}

/**
 * Closes a leftover lab alert, scrolls to the top, taps the reset button, scrolls to the top again,
 * and checks that lab-state reads as reset. Throws on the first call that fails, so a failed reset
 * stops the run instead of turning every later check into a miss. Its messages name the step that
 * ran before the reset, when the tool is guarded.
 */
export async function resetLab(tool: ToolSession): Promise<void> {
  const scroll = { id: "lab-scroll" };
  const before = stepOf(tool);
  const after = before ? ` (after ${before})` : "";
  const step = async (name: string, args: Record<string, unknown>): Promise<void> => {
    const r = await tool.call(name, args);
    if (isErrorAnswer(r.text, r.isError)) {
      throw new Error(`resetLab${after}: ${name} failed: ${(r.text.split("\n")[0] ?? "").slice(0, 160)}`);
    }
  };
  if (await closeLeftoverAlert(tool)) console.error(`resetLab${after}: closed a lab alert left open over the lab`);
  await step("scroll", { target: scroll, to: "start", look: false });
  // With the keyboard up, React Native spends the first tap outside the field on closing it.
  await tapOutsideField(tool);
  await step("scroll", { target: scroll, direction: "down", amount: 0.4, look: false });
  await step("tap", { target: { id: "lab-reset" }, look: false });
  await step("scroll", { target: scroll, to: "start", look: false });
  if (!(await expectState(tool, RESET_STATE, RESET_WAIT_S))) {
    throw new Error(`resetLab${after}: lab-state did not read "${RESET_STATE}" after the reset`);
  }
}

/**
 * A tap on lab-state (text near the top of the lab, no handler): outside any field, so a tool that
 * makes real touches closes the keyboard the way a person does (React Native's ScrollView spends the
 * first tap outside the focused field on that). A tool that never opens the keyboard (Tapline) refuses
 * it with no_action, which is fine: the answer is ignored.
 */
export async function tapOutsideField(tool: ToolSession): Promise<void> {
  await tool.call("tap", { target: { id: "lab-state" }, look: false });
}

/** Closes the keyboard after typing: back to the top of the lab, where lab-state is, then a tap outside the field. */
export async function closeKeyboard(tool: ToolSession): Promise<void> {
  await tool.call("scroll", { target: { id: "lab-scroll" }, to: "start", look: false });
  await tapOutsideField(tool);
}

/**
 * How long a check waits for a value that should be on screen already (a state that a refused
 * action must have left alone). Found on the first read, it costs nothing; the room is for a tool
 * whose single read of the screen is slow (QUALITY-BAR S3 allows a look 1.5 s at the slowest).
 */
export const PRESENT_WAIT_S = 2;

/** A `wait_for` answer that says the tool couldn't read the screen in time, so it proves nothing. */
function notKnown(r: CallResult): boolean {
  return isErrorAnswer(r.text, r.isError) && /isn't known/i.test(r.text.split("\n")[0] ?? "");
}

/** `wait_for` text; an answer that says it isn't known (a read that got no answer) is asked once more. */
async function waitForText(tool: ToolSession, args: Record<string, unknown>): Promise<CallResult> {
  const first = await tool.call("wait_for", args);
  return notKnown(first) ? tool.call("wait_for", args) : first;
}

/** True when `part` shows up on screen within `timeoutS` seconds. */
export async function expectState(
  tool: ToolSession,
  part: string,
  timeoutS = 2,
): Promise<boolean> {
  const r = await waitForText(tool, { text: part, timeout: timeoutS, look: false });
  return !isErrorAnswer(r.text, r.isError);
}

/** True when the answer is a `wait_for` timeout (an Error whose code or text says timeout). */
export function isTimeoutAnswer(text: string, isError: boolean): boolean {
  return isErrorAnswer(text, isError) && /timeout|timed out/i.test(text.split("\n")[0] ?? "");
}

/**
 * True when `part` does NOT show up: `wait_for {text, gone:false}` with a short timeout must time out.
 * Any other error is not a proof of absence, so it gives false.
 */
export async function expectNoState(
  tool: ToolSession,
  part: string,
  timeoutS = 0.5,
): Promise<boolean> {
  const r = await waitForText(tool, { text: part, gone: false, timeout: timeoutS, look: false });
  return isTimeoutAnswer(r.text, r.isError) && !notKnown(r);
}

/**
 * The state is unchanged: every `present` value is still there, and the `absent` value (the one a
 * wrong action would have set) is not. Returns what was wrong, empty when fine. A present value
 * gets `PRESENT_WAIT_S` (it should be there at once); an absent one is watched for `absentS`.
 */
export async function checkUnchanged(
  tool: ToolSession,
  present: string[],
  absent: string[],
  absentS = 0.5,
): Promise<string[]> {
  const problems: string[] = [];
  for (const p of present) {
    if (!(await expectState(tool, p, PRESENT_WAIT_S))) problems.push(`${p} is gone`);
  }
  for (const a of absent) {
    if (!(await expectNoState(tool, a, absentS))) problems.push(`${a} appeared`);
  }
  return problems;
}
