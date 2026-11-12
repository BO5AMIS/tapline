import { clockTime } from "./format.js";
import type { CrashRecord } from "./server.js";

/**
 * AGENT-TOOLS 15.2: how a crash is told to the agent. The note is one line; `crash` shows the error, the top
 * frames with the app's own marked `*`, and the component stack.
 */

const TOP_FRAMES = 8;
const NOTE_MESSAGE_MAX = 160;
const COMPONENT_LINES = 12;

export interface StackFrame {
  /** The line as the stack had it, trimmed. */
  text: string;
  /** The function, when the line names one. */
  fn: string;
  file: string;
  line: number | undefined;
}

/** Frames of a Hermes/V8 (`at fn (file:1:2)`) or JavaScriptCore (`fn@file:1:2`) stack; lines of the message are skipped. */
export function parseFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const text = raw.trim();
    const at = /^at\s+(?:(.*?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/.exec(text);
    if (at !== null && /^at\s/.test(text)) {
      frames.push({ text, fn: at[1] ?? "", file: (at[2] ?? "").replace(/^address at\s+/, ""), line: at[3] !== undefined ? Number(at[3]) : undefined });
      continue;
    }
    const jsc = /^([^@\s:]*)@(.+?)(?::(\d+))?(?::(\d+))?$/.exec(text);
    if (jsc !== null) {
      frames.push({ text, fn: jsc[1] ?? "", file: jsc[2] ?? "", line: jsc[3] !== undefined ? Number(jsc[3]) : undefined });
    }
  }
  return frames;
}

/** The app's own code: not a library, not React Native's internals, not a bundle URL or native code. */
export function isAppFrame(frame: StackFrame): boolean {
  const file = frame.file;
  if (file === "" || file === "native" || file === "[native code]") return false;
  return !/[\\/]node_modules[\\/]/.test(file) && !/^https?:/.test(file);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…(+${flat.length - max})` : flat;
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}

/** `TypeError: undefined is not an object, at TripScreen.tsx:42`. */
export function crashSummary(crash: CrashRecord): string {
  const type = crash.message.startsWith(`${crash.name}:`) ? "" : `${crash.name}: `;
  const message = oneLine(crash.message, NOTE_MESSAGE_MAX).replace(/[.\s]+$/, "");
  const top = parseFrames(crash.stack).find(isAppFrame);
  const where = top !== undefined ? `, at ${baseName(top.file)}${top.line !== undefined ? `:${top.line}` : ""}` : "";
  return `${type}${message}${where}`;
}

/** The note that goes on an answer. `withTime` is for a crash that reached the host after the call it ended. */
export function crashNote(crash: CrashRecord, withTime: boolean): string {
  return `Note: the app crashed${withTime ? ` at ${clockTime(crash.ts, false)}` : ""}: ${crashSummary(crash)}. logs and crash show more.`;
}

export function disconnectNote(at: number | undefined): string {
  const when = at !== undefined ? ` at ${clockTime(at, false)}` : " during this call";
  return `Note: the app disconnected${when} (it may have crashed; Tapline can't read native crash reports, Tapwright's crash can).`;
}

/** One crash for the `crash` tool. */
export function formatCrash(crash: CrashRecord): string {
  const head = `${clockTime(crash.ts, false)} ${crash.message.startsWith(`${crash.name}:`) ? "" : `${crash.name}: `}${crash.message}`;
  const lines = [head];
  const frames = parseFrames(crash.stack);
  if (frames.length === 0 && crash.stack.trim() !== "") {
    lines.push("  (the stack has no frames Tapline can read)");
  }
  for (const frame of frames.slice(0, TOP_FRAMES)) lines.push(`${isAppFrame(frame) ? "  * " : "    "}${frame.text}`);
  if (frames.length > TOP_FRAMES) lines.push(`    …(+${frames.length - TOP_FRAMES} more frames)`);
  if (crash.componentStack !== undefined) {
    const components = crash.componentStack.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    lines.push("Component stack:");
    for (const line of components.slice(0, COMPONENT_LINES)) lines.push(`  ${line}`);
    if (components.length > COMPONENT_LINES) lines.push(`  …(+${components.length - COMPONENT_LINES} more)`);
  }
  return lines.join("\n");
}

export const NO_CRASH_TEXT =
  "No JS crash since the app connected. A native crash doesn't show here; Tapwright's crash reads those.";
