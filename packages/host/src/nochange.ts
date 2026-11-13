import { z } from "zod";
import { elementSchema, type TreeElement } from "./protocol.js";

// "A tap that changes nothing" (AGENT-TOOLS 1.13 §3): the note after `No visible change.` and its one clause.

/** The shortest time the screen is watched before saying a touch changed nothing (Tapline's floor, §3). */
export const NO_CHANGE_WATCH_MS = 500;

/** The action's name in the note, from one map (lead's answer 7): `the tap`, `the long press`, `the double tap`. */
export const ACTION_NAMES = { tap: "tap", long_press: "long press", double_tap: "double tap" } as const;
export type NoChangeAction = keyof typeof ACTION_NAMES;

/** The handler a touch calls, for the clause: a tap calls onPress, a long press onLongPress. */
export const HANDLER_NAMES: Record<NoChangeAction, string> = { tap: "onPress", long_press: "onLongPress", double_tap: "onPress" };

/** What the app says of the touch (`press` and `longPress` results, capability `pressFacts`). */
export const pressFactsSchema = z.object({
  handler: z
    .union([
      z.object({ kind: z.literal("own"), threw: z.string().optional() }),
      z.object({ kind: z.literal("parent"), element: elementSchema, threw: z.string().optional() }),
    ])
    .optional(),
  startedRequests: z.number().optional(),
});
export type PressFacts = z.infer<typeof pressFactsSchema>;

/** The facts from a result, or an empty set when the app sent none or sent something unreadable. */
export function readPressFacts(result: unknown): PressFacts {
  const parsed = pressFactsSchema.safeParse(result);
  return parsed.success ? parsed.data : {};
}

/** A message for the answer: control characters (and line breaks) gone, cut to 120 characters. */
export function cleanMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** `Note: the tap was delivered, and nothing on screen changed within 0.5 s.` `seconds` is the time watched. */
export function noChangeNote(action: NoChangeAction, seconds: number): string {
  return `Note: the ${ACTION_NAMES[action]} was delivered, and nothing on screen changed within ${Math.max(0.5, seconds).toFixed(1)} s.`;
}

/**
 * The one clause after the note, in this order: the handler threw, a parent took the touch, a request it
 * started is still running, else the handler ran and returned. Without the app's facts only the request
 * can be said (from the `Network:` line); otherwise there is no clause.
 */
export function noChangeClause(
  action: NoChangeAction,
  facts: PressFacts | null,
  requestRunning: boolean,
  nameOf: (element: TreeElement) => string,
): string | null {
  if (facts === null) return requestRunning ? "A request is still running: wait_for network_idle." : null;
  const handler = facts.handler;
  if (handler === undefined) return requestRunning ? "A request is still running: wait_for network_idle." : null;
  const name = HANDLER_NAMES[action];
  if (handler.threw !== undefined) return `Its ${name} threw: ${cleanMessage(handler.threw)} (see logs).`;
  if (handler.kind === "parent") return `It has no handler of its own; ${nameOf(handler.element)} took it.`;
  if (requestRunning && (facts.startedRequests ?? 0) > 0) return "It started a request that is still running: wait_for network_idle.";
  return `Its ${name} ran and returned.`;
}

/** What a handler that threw is said to be, in every answer: `its onPress threw: <message> (see logs).` Null when it didn't. */
export function threwText(action: NoChangeAction, facts: PressFacts): string | null {
  const threw = facts.handler?.threw;
  return threw === undefined ? null : `its ${HANDLER_NAMES[action]} threw: ${cleanMessage(threw)} (see logs).`;
}

/** Whether an answer's text says the screen didn't change (a change block with only that line). */
export function saysNoVisibleChange(answer: string): boolean {
  return /^Same screen\. Changes:\n(?:[^\n]*\n)*?No visible change\.$/m.test(answer) || /^No visible change\.$/m.test(answer);
}

/** Whether the answer's header says requests are still running. */
export function saysRequestsRunning(answer: string): boolean {
  return /^Network: \d+ requests? in flight$/m.test(answer);
}

/** What the app says of a double tap's second tap (`threw`: the handler threw on it, so the tap did land). */
export type SecondTap = { done: true; afterMs: number; threw?: string | undefined } | { done: false; reason: string; afterMs: number };

/** The sentence for a double tap's second tap: it went through, it reached the handler and threw, or it didn't land. */
export function secondTapSentence(second: SecondTap): string {
  if (!second.done) return `The first tap went through; the second, ${second.afterMs} ms later, didn't land (${second.reason}).`;
  if (second.threw !== undefined) {
    return `The first tap went through; the second, ${second.afterMs} ms later, reached the handler, but the handler threw: ${cleanMessage(second.threw)}`;
  }
  return `Both taps went through, ${second.afterMs} ms apart.`;
}
