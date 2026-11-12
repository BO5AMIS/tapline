import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * AGENT-TOOLS 1.8 §12: the action log. One JSON object per line in `actions-YYYY-MM-DD.jsonl`, the same
 * schema as Tapwright's. Typed text is never logged, only its length; a secure field only ever its length.
 */

export interface ActionLogEntry {
  /** ISO 8601 UTC with milliseconds. */
  t: string;
  source: "tapline";
  by: "agent" | "person";
  tool: string;
  target?: unknown;
  /** The element's line without its ref; absent for a point or when unknown. */
  element?: string;
  ok: boolean;
  code?: string;
  reason?: string;
  ms?: number;
  app?: string;
  batch?: { id: string; step: number };
  dry_run?: boolean;
  confirmed?: boolean;
  /** For typing: how many characters, never the text. */
  chars?: number;
  /** AGENT-TOOLS 1.11 §16.1: `"read"` for a call that isn't an action (look, wait_for, logs, ...). */
  kind?: "read";
  /** One id per host run (an agent's session); with `call` it names a call. */
  session?: string;
  /** The call's number within the session, from 1; a `run`'s steps share their run's number. */
  call?: number;
  /** For a step of a batch call (`run`, `replay`): the tool call it belongs to. */
  of?: string;
  /** The agent's client id (the MCP client's name). */
  client?: string;
  /** The size of the call's answer in characters (its text), never the text itself. */
  size?: number;
  /** The call's answer carried the change list or the full list (the call wasn't `look: false`). */
  listed?: boolean;
  /** A touch after scrolls: the target was already in the last full list before the first scroll. Absent when unknown. */
  in_list?: boolean;
  /** For a `look`: the picture arguments it was given (booleans and numbers only), so a look that asked for more than the action's answer had isn't called waste. */
  look_args?: { screenshot?: boolean; width?: number; labels?: boolean };
}

export const LOG_KEEP_DAYS = 14;

export class ActionLog {
  private ready = false;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates the folder and deletes files older than 14 days. Never throws. */
  open(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const cutoff = this.now().getTime() - LOG_KEEP_DAYS * 24 * 3600 * 1000;
      for (const name of readdirSync(this.dir)) {
        if (!/^actions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
        const path = join(this.dir, name);
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      }
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  /** Appends one line. A log that can't be written never fails the action. */
  write(entry: Omit<ActionLogEntry, "t" | "source">, when?: Date): void {
    if (!this.ready) return;
    const at = when ?? this.now();
    const line: ActionLogEntry = { t: at.toISOString(), source: "tapline", ...entry };
    try {
      appendFileSync(join(this.dir, `actions-${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // the disk is full or the folder went away: the action still happened
    }
  }
}

/** A tool's parameters fit for the log: the target as given; typed text replaced by its length. */
export function loggedTarget(params: unknown): { target?: unknown; chars?: number } {
  if (typeof params !== "object" || params === null) return {};
  const p = params as Record<string, unknown>;
  const out: { target?: unknown; chars?: number } = {};
  const target = p["target"];
  // as the agent gave it: the app's testID is the tool's id
  if (typeof target === "object" && target !== null && "testID" in target) {
    const { testID, ...rest } = target as Record<string, unknown>;
    out.target = { id: testID, ...rest };
  } else if (target !== undefined) out.target = target;
  if (typeof p["text"] === "string") out.chars = [...p["text"]].length;
  return out;
}
