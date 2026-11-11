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
  write(entry: Omit<ActionLogEntry, "t" | "source">): void {
    if (!this.ready) return;
    const at = this.now();
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
