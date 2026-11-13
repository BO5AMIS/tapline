import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AGENT-TOOLS 1.14 §23: the audit log. The record of what was done under a person's standing permission: JSON lines in
 * `<dir>/YYYY-MM.jsonl`. It is not the action log (§12). It has no off switch, and nothing the model can call reads or deletes it.
 */

export const AUDIT_KINDS = ["grant", "revoke", "vault", "otp", "schedule", "approval"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  /** ISO 8601 UTC with milliseconds. */
  t: string;
  tool: "tapline";
  kind: AuditKind;
  app?: string;
  name?: string;
  /** Never holds a value: it names a vault entry or a field, never its text. */
  detail?: string;
}

/** Entries older than this are removed at start (§23). */
export const AUDIT_KEEP_DAYS = 90;

/** What the grants need from the audit log: a line is written before the touch, and a grant needs its line. */
export interface AuditSink {
  /** True when the line is on disk; false when it could not be written (the grant then doesn't cover the touch). */
  write(entry: Omit<AuditEntry, "t" | "tool">): boolean;
}

export class AuditLog implements AuditSink {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates the folder and removes entries older than 90 days (by each line's own `t`). Never throws. */
  open(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      return;
    }
    const cutoff = this.now().getTime() - AUDIT_KEEP_DAYS * 24 * 3600 * 1000;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^\d{4}-\d{2}\.jsonl$/.test(name)) continue;
      const path = join(this.dir, name);
      try {
        const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
        // A line that doesn't parse is kept: the log never throws away what it can't read.
        const keep = lines.filter((line) => {
          const when = lineTime(line);
          return when === null || when >= cutoff;
        });
        if (keep.length === lines.length) continue;
        if (keep.length === 0) rmSync(path, { force: true });
        else writeFileSync(path, `${keep.join("\n")}\n`, { mode: 0o600 });
      } catch {
        // an unreadable file stays as it is
      }
    }
  }

  write(entry: Omit<AuditEntry, "t" | "tool">): boolean {
    const at = this.now();
    const line: AuditEntry = { t: at.toISOString(), tool: "tapline", ...entry };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(this.dir, `${line.t.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}

function lineTime(line: string): number | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const t = (parsed as { t?: unknown }).t;
    if (typeof t !== "string") return null;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}
