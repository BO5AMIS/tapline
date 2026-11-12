import { actionsOf, formatElement, roleOf } from "./format.js";
import type { TreeElement } from "./protocol.js";

/** The most lines a brief answer shows of a change block, or of a new screen (AGENT-TOOLS 1.13 §13.4). */
export const BRIEF_MAX_LINES = 12;

export interface BriefInput {
  /** The answer's first line. */
  first: string;
  /** The `Place: …` line, when known (task 12 supplies it). */
  place?: string;
  /** `Same screen. Changes:`, shown above the block (not counted in the 12). */
  label?: string;
  /** The change block's lines, in order. */
  changes: string[];
  /** A new screen: its lines replace the change block. */
  screen?: { headers: string[]; actionable: string[]; newText: string[] };
  /** Never cut: `Alert:`, `Network:`, `Keyboard:`, `Place:`, `Note:`, `Error`, `Reflex:` lines. */
  fixed: string[];
}

/** Lines that close an answer; the others (`Alert:`, `Keyboard:`, `Network:`, `Place:`) stand above the block. */
const TAIL = /^(Note\b|Error\b|Reflex:|Screenshot:|Logs\b)/;

/** A `+` line for a text element: `+ e12 text "Wrong password" …`. */
const ADDED_TEXT = /^\+ (?:e\d+ )?text(?: |$)/;

/** A cut change block keeps `+` text lines ahead of `~` and `↕` lines; the rest keep their order. */
export function orderForCut(changes: string[]): string[] {
  return [...changes.filter((line) => ADDED_TEXT.test(line)), ...changes.filter((line) => !ADDED_TEXT.test(line))];
}

/** The line that ends a cut block. */
function moreLine(count: number): string {
  return `…${count} more: look shows them.`;
}

/** At most `BRIEF_MAX_LINES` of `lines` (already in cut order), then how many were left out. */
function cut(lines: string[]): string[] {
  if (lines.length <= BRIEF_MAX_LINES) return lines;
  return [...lines.slice(0, BRIEF_MAX_LINES), moreLine(lines.length - BRIEF_MAX_LINES)];
}

/** Builds the brief answer's lines. `…<n> more: look shows them.` ends a cut block. */
export function briefLines(input: BriefInput): string[] {
  const out: string[] = [input.first];
  if (input.place !== undefined) out.push(input.place);
  const above = input.fixed.filter((line) => !TAIL.test(line));
  const below = input.fixed.filter((line) => TAIL.test(line));
  if (input.screen !== undefined) {
    // New text first: it is what says an action failed ("Wrong password"), so a cut never takes it.
    out.push(...above, ...cut([...input.screen.newText, ...input.screen.headers, ...input.screen.actionable]));
  } else {
    if (input.label !== undefined) out.push(input.label);
    out.push(...above);
    out.push(...cut(input.changes.length > BRIEF_MAX_LINES ? orderForCut(input.changes) : input.changes));
  }
  out.push(...below);
  return out;
}

/** Roles a person can act on; list rows, radios and checkboxes count with them (AGENT-TOOLS 1.13.1 item 1). */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set(["button", "input", "switch", "link", "tab", "cell", "radio", "checkbox"]);

/**
 * Pressable elements count as actionable: buttons, inputs, switches, links, tabs, list rows, radios, checkboxes,
 * and any element that takes a tap, a toggle or typing (AGENT-TOOLS 1.13.1 item 1).
 */
export function isActionable(element: TreeElement): boolean {
  const role = roleOf(element);
  if (role !== null && ACTIONABLE_ROLES.has(role)) return true;
  return actionsOf(element).some((action) => action === "tap" || action === "toggle" || action === "type");
}

function textOfElement(element: TreeElement): string {
  return (element.text ?? "").trim();
}

/**
 * A new screen in brief: its headers, its actionable elements and the text that wasn't in the list the agent had
 * (`previous`). One line each, as a full list writes them, so refs keep working.
 */
export function briefScreen(
  elements: TreeElement[],
  previous: TreeElement[],
  options: { eyes?: boolean } = {},
): { headers: string[]; actionable: string[]; newText: string[] } {
  const seen = new Set(previous.map(textOfElement).filter((text) => text !== ""));
  const line = (element: TreeElement): string => formatElement(element, { eyes: options.eyes === true });
  const headers: string[] = [];
  const actionable: string[] = [];
  const newText: string[] = [];
  for (const element of elements) {
    const role = roleOf(element);
    if (role === "header") headers.push(line(element));
    else if (isActionable(element)) actionable.push(line(element));
    else if (role === "text" && textOfElement(element) !== "" && !seen.has(textOfElement(element))) newText.push(line(element));
  }
  return { headers, actionable, newText };
}
