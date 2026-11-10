import { isErrorAnswer } from "../lab.js";
import type { CallResult, ToolSession } from "../mcp.js";
import { redactToken } from "../viewer/link.js";
import { parseLook } from "../viewer/suite.js";

/* ---------- answers ---------- */

export interface ParsedError {
  code: string;
  message: string;
}

/** Reads `Error <code>: <message>` from the first line of an answer; null when it isn't an error. */
export function parseError(text: string): ParsedError | null {
  const m = /^\s*Error\s+([a-z_]+):\s*(.*)$/i.exec(text.split("\n")[0] ?? "");
  return m?.[1] === undefined ? null : { code: m[1].toLowerCase(), message: m[2] ?? "" };
}

/** True when the message starts with the reason (`off_screen` also reads as `off screen`). */
export function startsWithReason(message: string, reasons: string[]): boolean {
  const m = message.trim().toLowerCase();
  return reasons.some((r) => m.startsWith(r) || m.startsWith(r.replace(/_/g, " ")));
}

/** The first answer line, token-redacted and cut, for notes. */
export function firstLine(text: string, token?: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return redactToken(line, token).slice(0, 160) || "(empty answer)";
}

/* ---------- geometry ---------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `@x,y WxH` box of the element line `id=<id>` in a `look` answer. */
export function elementRect(text: string, id: string): Rect | null {
  const line = text.split("\n").find((l) => new RegExp(`\\bid=${escapeRe(id)}(\\s|$)`).test(l));
  const r = line
    ? /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) (\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(line)
    : null;
  if (!r?.[1] || !r[2] || !r[3] || !r[4]) return null;
  return { x: Number(r[1]), y: Number(r[2]), w: Number(r[3]), h: Number(r[4]) };
}

export function screenOf(text: string): { w: number; h: number } | null {
  return parseLook(text, "")?.screen ?? null;
}

/** True when the element's line exists and its centre is on the screen. */
export function isOnScreen(text: string, id: string): boolean {
  const rect = elementRect(text, id);
  if (!rect) return false;
  const screen = screenOf(text);
  if (!screen) return true;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return cx >= 0 && cy >= 0 && cx <= screen.w && cy <= screen.h;
}

/** How a cut text ends: `…`, or since AGENT-TOOLS v1.5 `…(+57)`. */
const CUT_END = /(…|\.\.\.)(\(\+\d+\))?\s*$/;

/**
 * The `field=value` pairs visible in the lab's state line of a `look` answer: the quoted text of the
 * `id=lab-state` element, else (the sheet hides it) of `id=lab-sheet-state`. A long text may be cut;
 * the field cut at the end is unknown, so it is left out.
 */
export function parseStateFields(lookText: string): Record<string, string> {
  const lines = lookText.split("\n");
  const find = (id: string): string | undefined =>
    lines.find((l) => new RegExp(`\\bid=${escapeRe(id)}(\\s|$)`).test(l));
  const line = find("lab-state") ?? find("lab-sheet-state");
  const quoted = line ? /"([^"]*)"/.exec(line)?.[1] : undefined;
  if (quoted === undefined) return {};
  const cut = CUT_END.test(quoted);
  const tokens = quoted.replace(CUT_END, "").trim().split(/\s+/).filter(Boolean);
  if (cut) tokens.pop();
  const fields: Record<string, string> = {};
  for (const t of tokens) {
    const i = t.indexOf("=");
    if (i > 0) fields[t.slice(0, i)] = t.slice(i + 1);
  }
  return fields;
}

/** Reads the visible state fields now, with a `look` (no screenshot). */
export async function readStateFields(tool: ToolSession): Promise<Record<string, string>> {
  const r = await tool.call("look", { screenshot: false });
  return parseStateFields(r.text);
}

/** `field=value` parts, for `wait_for` text. */
export function fieldParts(fields: Record<string, string>): string[] {
  return Object.entries(fields).map(([k, v]) => `${k}=${v}`);
}

export const LAB_SCROLL = { id: "lab-scroll" };

/**
 * Makes sure `id` is on screen before acting on it. Looks (no screenshot); when the element's line is
 * missing or outside the screen, scrolls `lab-scroll` to the start (for elements above), then down by
 * 0.5, up to `maxScrolls` times. Returns whether the element ended up on screen.
 */
export async function bringIntoView(
  tool: ToolSession,
  id: string,
  maxScrolls = 8,
): Promise<boolean> {
  const seen = async (): Promise<boolean> => {
    const r = await tool.call("look", { screenshot: false });
    return isOnScreen(r.text, id);
  };
  if (await seen()) return true;
  await tool.call("scroll", { target: LAB_SCROLL, to: "start", look: false });
  if (await seen()) return true;
  for (let i = 0; i < maxScrolls; i++) {
    await tool.call("scroll", { target: LAB_SCROLL, direction: "down", amount: 0.5, look: false });
    if (await seen()) return true;
  }
  return false;
}

/** A look lists the share sheet's own parts (iOS 26: the popover's dismiss region and the sheet). */
export function shareSheetListed(lookText: string): boolean {
  return /\bid=(?:PopoverDismissRegion|ActivityListView)(?:\s|$)/m.test(lookText);
}

/**
 * Makes lab-state readable before `wait_for` reads it: a tool's wait_for sees only what's on screen,
 * and a step further down the lab leaves lab-state above the top. Looks; when neither lab-state nor
 * the sheet's copy (lab-sheet-state) is on screen and nothing covers the lab (no `Alert:` line, no
 * share sheet), scrolls lab-scroll to the start. Returns that look's text.
 */
export async function showState(tool: ToolSession): Promise<string> {
  const text = (await tool.call("look", { screenshot: false })).text;
  if (isOnScreen(text, "lab-state") || isOnScreen(text, "lab-sheet-state")) return text;
  const covered = /^Alert:/m.test(text) || shareSheetListed(text) || !/\bid=lab-/.test(text);
  if (!covered) await tool.call("scroll", { target: LAB_SCROLL, to: "start", look: false });
  return text;
}

/* ---------- tool capabilities and busy retry ---------- */

/** True when the tool's MCP tool list names `name`. Without a list (or when listing fails): false. */
export async function toolHas(tool: ToolSession, name: string): Promise<boolean> {
  if (!tool.listTools) return false;
  try {
    return (await tool.listTools()).includes(name);
  } catch {
    return false;
  }
}

/** The `alert` tool (Tapwright has it, Tapline doesn't). */
export function hasAlertTool(tool: ToolSession): Promise<boolean> {
  return toolHas(tool, "alert");
}

/**
 * A session that retries once, after `idleMs`, when an answer is `Error busy` (a person's input in
 * the viewer holds the agent back for 3 s).
 */
export function withBusyRetry(
  tool: ToolSession,
  idleMs: number,
  sleep: (ms: number) => Promise<void>,
): ToolSession {
  return {
    async call(name, args): Promise<CallResult> {
      const first = await tool.call(name, args);
      if (parseError(first.text)?.code !== "busy") return first;
      await sleep(idleMs);
      return tool.call(name, args);
    },
    ...(tool.listTools ? { listTools: () => tool.listTools?.() ?? Promise.resolve([]) } : {}),
  };
}

export function failed(r: CallResult): boolean {
  return isErrorAnswer(r.text, r.isError);
}
