import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * AGENT-TOOLS 1.8 §12: the action log. One JSON object per line in `actions-YYYY-MM-DD.jsonl`, the same
 * schema as Tapwright's. Typed text is never logged, only its length; a secure field only ever its length.
 */

/** Fields whose values are fixed words of the schema, never content: a vault value equal to one must not rewrite it. */
const STRUCTURAL = ["confirmed_by", "via", "animations", "v", "kind"] as const;

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
  /** The time in the tool, in ms: an action's own, a read's whole call (AGENT-TOOLS 1.13 §16.1). `t` is when it began. */
  ms?: number;
  /** 2: `t` is when the call began and `ms` its time. Older entries stamped the end, so the Time line leaves them out. */
  v?: 2;
  /** `"call"` when the call came through the thin call, a new process each time (§18.10). */
  via?: "call";
  /** `"fast"` when fast-forwarded animations were on while the call ran (PLAN-1.6 F4); the report says how many calls. */
  animations?: "fast";
  app?: string;
  batch?: { id: string; step: number };
  dry_run?: boolean;
  confirmed?: boolean;
  /** Where a person's OK came from: the host's dialog or the live view (AGENT-TOOLS 1.13 §11.3). */
  confirmed_by?: "chat" | "live view";
  /** AGENT-TOOLS 1.14 §12, §19: the name of the grant that let the touch through. */
  grant?: string;
  /** With `grant`: the count including this use, `2 of 3 today` (the report's Grants line says it). */
  grant_use?: string;
  /** A grant matched the touch but didn't cover it, so a person was asked: why, `limit reached`, `quiet hours`, `ended` or `revoked`. */
  grant_asked?: string;
  /** For typing: how many characters, never the text. */
  chars?: number;
  /** AGENT-TOOLS 1.16 §29.3: what a scroll, a swipe or a link did, so a bug report can write the step (never typed text; a link is cut down to its plain words). */
  args?: { direction?: string; to?: string; x0?: number; y0?: number; x1?: number; y1?: number; url?: string };
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
  /**
   * The whole call failed although its actions went through (a run whose expectation didn't hold): its error code.
   * Set on the call's action entries, so a report counts the call as failed (Codex review of 1.4.0).
   */
  call_failed?: string;
  /** A `compare_screen` that matched under its threshold but named changed clusters (AGENT-TOOLS 1.13.1 item 2). */
  matched_with_changes?: boolean;
  /**
   * A touch that took the app from one place to another: their names (the map's own, never screen text), and whether the map
   * already held a proven road between them. The report uses it to say a way was known (AGENT-TOOLS 1.13 16.1).
   */
  way?: { from: string; to: string; known: boolean };
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

  private scrub: ((value: unknown) => unknown) | undefined;

  /** A backstop at the writer (AGENT-TOOLS 1.14 §20.3): the content values of every line are scrubbed, never its keys. */
  setBackstop(scrub: ((value: unknown) => unknown) | undefined): void {
    this.scrub = scrub;
  }

  /** The backstop's result with the structural fields (fixed words, never content) put back: `isEntry` and the report read them. */
  private scrubbed(made: ActionLogEntry): ActionLogEntry {
    const out = { ...(this.scrub?.(made) as ActionLogEntry), by: made.by };
    for (const key of STRUCTURAL) {
      if (made[key] !== undefined) Object.assign(out, { [key]: made[key] });
    }
    return out;
  }

  /** Appends one line. A log that can't be written never fails the action. */
  write(entry: Omit<ActionLogEntry, "t" | "source">, when?: Date): void {
    if (!this.ready) return;
    const at = when ?? this.now();
    const made: ActionLogEntry = { t: at.toISOString(), source: "tapline", ...entry };
    const line = this.scrub === undefined ? made : this.scrubbed(made);
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
