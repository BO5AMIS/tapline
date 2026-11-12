import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ActionLogEntry } from "./actionlog.js";

/**
 * AGENT-TOOLS 1.11 §16.1: `session_report` and `tapline report`. Reads the action log (§12), which also holds the
 * agent's reads, and says where the calls went and which of them could have been saved.
 */

/** Tools that touch the app one step at a time. `run` is its own thing. */
const ACTION_TOOLS: ReadonlySet<string> = new Set(["tap", "long_press", "type_text", "toggle", "scroll", "swipe", "back", "open_url", "app_command"]);
/** Actions that act on an element, so a scroll hunt can end in one. */
const ELEMENT_TOOLS: ReadonlySet<string> = new Set(["tap", "long_press", "type_text", "toggle"]);

export const REPORT_MAX_NUMBERS = 5;
export const REPORT_DEFAULT_WINDOW_MS = 24 * 3600 * 1000;

/** One call of the agent: a plain tool call, or a `run` (its steps folded into one). */
export interface CallRecord {
  /** The number the report names it by. */
  n: number;
  session: string;
  tool: string;
  ok: boolean;
  code?: string;
  /** Epoch ms of its first entry. */
  t: number;
  /** Its answer carried the changes or the full list. */
  listed: boolean;
  dryRun: boolean;
  /** For a single-element call: the element's line, and the target as given. */
  element?: string;
  target?: unknown;
  /** After scrolls: true (target was in the list before), false (it wasn't), absent (unknown). */
  inList?: boolean;
  /** A compare_screen that matched with named changes (1.13.1 item 2). */
  matchedWithChanges?: boolean;
  /** For a look: it asked for a screenshot, a width or labels, which the answer of the action before it could not give. */
  askedPicture?: boolean;
}

export interface Flag {
  /** One line, without the leading dash. */
  text: string;
}

export interface Report {
  calls: number;
  minutes: number;
  toolCounts: Array<[string, number]>;
  failed: number;
  failedCodes: Array<[string, number]>;
  flags: Flag[];
}

/** Groups the log's agent entries into calls, in order. Entries from before the call log have no call number: each is a call, a batch is one. */
export function buildCalls(entries: readonly ActionLogEntry[]): CallRecord[] {
  const groups = new Map<string, ActionLogEntry[]>();
  let legacy = 0;
  for (const entry of entries) {
    if (entry.by !== "agent") continue;
    const key =
      entry.session !== undefined && entry.call !== undefined
        ? `${entry.session}#${entry.call}`
        : entry.batch !== undefined
          ? `legacy-batch-${entry.batch.id}`
          : `legacy#${legacy++}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  const calls: CallRecord[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const failedEntry = group.find((e) => !e.ok);
    // A call whose actions went through but which failed as a whole (an expectation): failed, with its code.
    const callFailed = failedEntry === undefined ? group.find((e) => e.call_failed !== undefined)?.call_failed : undefined;
    const tool = first.of ?? (group.some((e) => e.batch !== undefined) ? "run" : first.tool);
    const single = group.length === 1 && first.batch === undefined && tool !== "run";
    calls.push({
      n: 0,
      session: first.session ?? "legacy",
      tool,
      ok: failedEntry === undefined && callFailed === undefined,
      ...(failedEntry?.code !== undefined ? { code: failedEntry.code } : callFailed !== undefined ? { code: callFailed } : {}),
      t: Date.parse(first.t),
      listed: group.some((e) => e.listed === true),
      dryRun: group.some((e) => e.dry_run === true),
      ...(single && first.element !== undefined ? { element: first.element } : {}),
      ...(single && first.target !== undefined ? { target: first.target } : {}),
      ...(single && first.in_list !== undefined ? { inList: first.in_list } : {}),
      ...(single && askedPicture(first) ? { askedPicture: true } : {}),
      ...(first.matched_with_changes === true ? { matchedWithChanges: true } : {}),
    });
  }
  // Sessions in the order they began; inside one, the call numbers (legacy: the order read).
  const callOf = new Map<CallRecord, number>();
  let position = 0;
  for (const group of groups.values()) {
    const c = group[0]?.call;
    callOf.set(calls[position] as CallRecord, c ?? position);
    position++;
  }
  const sessionStart = new Map<string, number>();
  for (const c of calls) sessionStart.set(c.session, Math.min(sessionStart.get(c.session) ?? Infinity, c.t));
  calls.sort(
    (a, b) =>
      (sessionStart.get(a.session) ?? 0) - (sessionStart.get(b.session) ?? 0) ||
      a.session.localeCompare(b.session) ||
      (callOf.get(a) ?? 0) - (callOf.get(b) ?? 0),
  );
  // One session: the numbers the log has. Several: their place in the list, so a number is never two calls.
  const sessions = new Set(calls.map((c) => c.session));
  calls.forEach((c, i) => {
    c.n = sessions.size === 1 && callOf.get(c) !== undefined && c.session !== "legacy" ? (callOf.get(c) as number) : i + 1;
  });
  return calls;
}

function askedPicture(entry: ActionLogEntry): boolean {
  const asked = entry.look_args;
  return asked !== undefined && (asked.screenshot === true || asked.width !== undefined || asked.labels === true);
}

function stringField(target: unknown, key: string): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const value = (target as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/** Whether a resolved element line is what the (failed) target asked for: its id, label or text. */
function sameElement(target: unknown, element: string | undefined): boolean {
  if (element === undefined) return false;
  const name = /"((?:[^"\\]|\\.)*)"/.exec(element)?.[1]?.trim().toLowerCase();
  const id = /\bid=(\S+)/.exec(element)?.[1]?.toLowerCase();
  const asked = [stringField(target, "id"), stringField(target, "label"), stringField(target, "text")].filter((v): v is string => v !== undefined && v !== "");
  return asked.some((v) => v === name || v === id);
}

function splitBySession(calls: readonly CallRecord[]): CallRecord[][] {
  const out: CallRecord[][] = [];
  for (const c of calls) {
    const last = out[out.length - 1];
    if (last !== undefined && last[0]?.session === c.session) last.push(c);
    else out.push([c]);
  }
  return out;
}

export function analyze(calls: readonly CallRecord[]): Report {
  const counts = new Map<string, number>();
  const codes = new Map<string, number>();
  let failed = 0;
  for (const c of calls) {
    counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
    if (!c.ok) {
      failed++;
      const code = c.code ?? "error";
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }
  const byCount = (a: [string, number], b: [string, number]): number => b[1] - a[1] || a[0].localeCompare(b[0]);
  // the earliest and the latest call: with several sessions the list is in session order, not time order
  const times = calls.map((c) => c.t);
  const first = times.length > 0 ? times.reduce((a, b) => Math.min(a, b)) : undefined;
  const last = times.length > 0 ? times.reduce((a, b) => Math.max(a, b)) : undefined;
  const minutes = first !== undefined && last !== undefined ? Math.max(1, Math.round((last - first) / 60000)) : 0;

  const looks: number[] = [];
  const retries: number[] = [];
  /** Retries whose failed target was itself an id: "use its id first" doesn't help them (1.13.1 item 4). */
  const idRetries: number[] = [];
  const hunts: Array<{ from: number; to: number; exact: boolean }> = [];
  const chains: Array<{ from: number; to: number }> = [];
  for (const seq of splitBySession(calls)) {
    for (let i = 0; i < seq.length; i++) {
      const c = seq[i] as CallRecord;
      const prev = seq[i - 1];
      // 1. a look right after an action whose answer had the changes
      if (c.tool === "look" && prev !== undefined && (ACTION_TOOLS.has(prev.tool) || prev.tool === "run") && prev.ok && prev.listed && !prev.dryRun && c.askedPicture !== true) {
        looks.push(c.n);
      }
      // 2. a retry after not_found that found the same element by another target
      if (!c.ok && c.code === "not_found" && ELEMENT_TOOLS.has(c.tool) && c.target !== undefined) {
        for (let j = i + 1; j <= i + 3 && j < seq.length; j++) {
          const r = seq[j] as CallRecord;
          if (r.tool !== c.tool || !r.ok) continue;
          if (JSON.stringify(r.target) !== JSON.stringify(c.target) && sameElement(c.target, r.element)) {
            (stringField(c.target, "id") !== undefined ? idRetries : retries).push(r.n);
          }
          break;
        }
      }
    }
    // 3. a scroll hunt: 3 or more scrolls in a row, then an action on an element
    for (let i = 0; i < seq.length; ) {
      if ((seq[i] as CallRecord).tool !== "scroll") {
        i++;
        continue;
      }
      let end = i;
      while (end < seq.length && (seq[end] as CallRecord).tool === "scroll") end++;
      const next = seq[end];
      if (end - i >= 3 && next !== undefined && ELEMENT_TOOLS.has(next.tool) && next.ok && next.inList !== false) {
        hunts.push({ from: (seq[i] as CallRecord).n, to: next.n, exact: next.inList === true });
      }
      i = end;
    }
    // 4. 3 or more actions back to back with no answer read in between (a scroll or a failure ends the chain)
    for (let i = 0; i < seq.length; ) {
      const c = seq[i] as CallRecord;
      if (!(ACTION_TOOLS.has(c.tool) && c.tool !== "scroll" && c.ok)) {
        i++;
        continue;
      }
      let end = i;
      while (end < seq.length) {
        const e = seq[end] as CallRecord;
        if (!(ACTION_TOOLS.has(e.tool) && e.tool !== "scroll" && e.ok)) break;
        end++;
      }
      if (end - i >= 3) chains.push({ from: c.n, to: (seq[end - 1] as CallRecord).n });
      i = end;
    }
  }

  const withChanges = calls.filter((c) => c.matchedWithChanges === true).map((c) => String(c.n));
  const flags: Flag[] = [];
  const numbers = (items: string[]): string => `${items.slice(0, REPORT_MAX_NUMBERS).join(", ")}${items.length > REPORT_MAX_NUMBERS ? ", …" : ""}`;
  const range = (r: { from: number; to: number }): string => (r.from === r.to ? String(r.from) : `${r.from}–${r.to}`);
  if (looks.length > 0) {
    flags.push({
      text: `${looks.length} ${looks.length === 1 ? "look" : "looks"} right after an action whose answer already had the changes (calls ${numbers(looks.map(String))})`,
    });
  }
  if (retries.length > 0) {
    flags.push({
      text: `${retries.length} ${retries.length === 1 ? "retry" : "retries"} after not_found that found the same element by another target (calls ${numbers(retries.map(String))}): use its id first`,
    });
  }
  if (withChanges.length > 0) {
    flags.push({ text: `${withChanges.length} compare_screen ${withChanges.length === 1 ? "match" : "matches"} with text changes (calls ${numbers(withChanges)}): look at them` });
  }
  if (idRetries.length > 0) {
    flags.push({
      text: `${idRetries.length} ${idRetries.length === 1 ? "retry" : "retries"} after not_found that found the same element by another target (calls ${numbers(idRetries.map(String))}): target what the latest look shows (its id there, when it has one)`,
    });
  }
  if (hunts.length > 0) {
    const maybe = hunts.filter((h) => !h.exact).length;
    const tag = maybe === 0 ? "" : maybe === hunts.length ? " (maybe)" : ` (${maybe} maybe)`;
    flags.push({
      text: `${hunts.length} scroll ${hunts.length === 1 ? "hunt" : "hunts"}${tag} of 3 or more scrolls for an element already in the list (calls ${numbers(hunts.map(range))}): let the action scroll`,
    });
  }
  if (chains.length > 0) {
    flags.push({
      text: `${chains.length} ${chains.length === 1 ? "run" : "runs"} of 3 or more actions with no answer read in between (calls ${numbers(chains.map(range))}): one run each`,
    });
  }
  return {
    calls: calls.length,
    minutes,
    toolCounts: [...counts].sort(byCount),
    failed,
    failedCodes: [...codes].sort(byCount),
    flags,
  };
}

const MAX_TOOLS_SHOWN = 8;

export function formatReport(report: Report): string {
  if (report.calls === 0) return "Session: 0 calls.\nWaste: none.";
  const shown = report.toolCounts.slice(0, MAX_TOOLS_SHOWN).map(([tool, n]) => `${tool} ${n}`);
  if (report.toolCounts.length > MAX_TOOLS_SHOWN) shown.push("…");
  const failed =
    report.failed === 0 ? "Failed: 0." : `Failed: ${report.failed} (${report.failedCodes.map(([code, n]) => `${code} ${n}`).join(", ")}).`;
  const head = `Session: ${report.calls} ${report.calls === 1 ? "call" : "calls"} in ${report.minutes} min (${shown.join(", ")}). ${failed}`;
  if (report.flags.length === 0) return `${head}\nWaste: none.`;
  return [head, "Waste:", ...report.flags.map((f) => `- ${f.text}`)].join("\n");
}

// ---- reading the log ---------------------------------------------------------

function isEntry(value: unknown): value is ActionLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["t"] === "string" && typeof v["tool"] === "string" && typeof v["ok"] === "boolean" && (v["by"] === "agent" || v["by"] === "person") && Number.isFinite(Date.parse(v["t"]));
}

/** The log's entries from `sinceMs` on, oldest first. A line that isn't an entry is skipped. Never throws. */
export function readLogEntries(dir: string, sinceMs: number): ActionLogEntry[] {
  const out: ActionLogEntry[] = [];
  try {
    if (!existsSync(dir)) return out;
    // A file is named by its UTC day; one day before `since` covers its edge.
    const earliest = new Date(sinceMs - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const files = readdirSync(dir)
      .filter((name) => /^actions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(8, 18) >= earliest)
      .sort();
    for (const name of files) {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isEntry(parsed) && Date.parse(parsed.t) >= sinceMs) out.push(parsed);
        } catch {
          // a half-written line
        }
      }
    }
  } catch {
    // an unreadable folder is an empty log
  }
  return out;
}

/** The report text for a log folder: `since` on, optionally only one session's calls. */
export function reportFor(dir: string, sinceMs: number, onlySession?: string): string {
  const entries = readLogEntries(dir, sinceMs).filter((e) => onlySession === undefined || e.session === onlySession);
  return formatReport(analyze(buildCalls(entries)));
}

/** `--since`: epoch ms, an ISO date or time, or how long ago (`90m`, `2h`, `1d`). Null when it isn't one. */
export function parseSince(raw: string, now: number): number | null {
  const text = raw.trim();
  const relative = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(text);
  if (relative !== null) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(relative[2] as string).toLowerCase()] as number;
    return now - Number(relative[1]) * unit;
  }
  if (/^\d{10,}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `tapline report [--since <time>]`: the text to print and the exit code. */
export function runReport(options: { dir: string; since?: string; now?: number }): { text: string; code: number } {
  const now = options.now ?? Date.now();
  let since = now - REPORT_DEFAULT_WINDOW_MS;
  if (options.since !== undefined) {
    const parsed = parseSince(options.since, now);
    if (parsed === null) return { text: `--since is a time: 90m, 2h, 1d, an ISO date or epoch milliseconds, not "${options.since}"`, code: 1 };
    since = parsed;
  }
  return { text: reportFor(options.dir, since), code: 0 };
}
