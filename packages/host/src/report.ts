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
  /** Where each person's OK this call used came from (§11.3). */
  approvals?: Array<"chat" | "live view">;
  /** For a look: it asked for a screenshot, a width or labels, which the answer of the action before it could not give. */
  askedPicture?: boolean;
  /** For a single touch: where it led, and whether the map already held a proven road there (AGENT-TOOLS 1.13 16.1). */
  way?: { from: string; to: string; known: boolean };
  /** The agent's client id, so thinking time is measured within one client. */
  client?: string;
  /** Epoch ms when the call's last entry ended; absent when the log line has no `ms` (older logs). */
  end?: number;
  /** The call's time in the tool, in ms; absent for older logs. */
  ms?: number;
  /** The call came through the thin call (§16.1). */
  via?: "call";
  /** Fast animations were on when the call began. */
  fastAnimations?: true;
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
  /** The `Time:` line; absent when no call has a time (older logs). */
  time?: string;
  /** The `Grants:` line (AGENT-TOOLS 1.14 §19.7); absent when no grant was involved. */
  grants?: string;
  /** Person's OKs used, by where they were given; absent when none (§11.3). */
  approvals?: { chat: number; liveView: number };
  /** Calls that ran with fast animations on; absent when none did (PLAN-1.6 F4). */
  fastAnimations?: number;
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
    // Every entry's `t` is when it began and `ms` how long it took; the call ends when its last entry does.
    // Only v 2 entries stamp the start; older ones stamped the end of an action, so they give no time.
    const timed = group.filter((e) => e.v === 2 && typeof e.ms === "number" && Number.isFinite(e.ms) && e.ms >= 0);
    const start = Math.min(...group.map((e) => Date.parse(e.t)));
    const end = timed.length > 0 ? Math.max(...timed.map((e) => Date.parse(e.t) + (e.ms as number))) : undefined;
    const client = group.find((e) => e.client !== undefined)?.client;
    const approvals = group.flatMap((e) => (e.confirmed_by !== undefined ? [e.confirmed_by] : []));
    calls.push({
      n: 0,
      session: first.session ?? "legacy",
      tool,
      ok: failedEntry === undefined && callFailed === undefined,
      ...(failedEntry?.code !== undefined ? { code: failedEntry.code } : callFailed !== undefined ? { code: callFailed } : {}),
      t: start,
      ...(end !== undefined ? { end, ms: end - start } : {}),
      ...(client !== undefined ? { client } : {}),
      ...(group.some((e) => e.via === "call") ? { via: "call" as const } : {}),
      ...(group.some((e) => e.animations === "fast") ? { fastAnimations: true as const } : {}),
      listed: group.some((e) => e.listed === true),
      dryRun: group.some((e) => e.dry_run === true),
      ...(single && first.element !== undefined ? { element: first.element } : {}),
      ...(single && first.target !== undefined ? { target: first.target } : {}),
      ...(single && first.in_list !== undefined ? { inList: first.in_list } : {}),
      // A drive's own moves are the cure, not the waste: only a plain call carries its way (16.1).
      ...(single && first.way !== undefined && first.of === undefined ? { way: first.way } : {}),
      ...(single && askedPicture(first) ? { askedPicture: true } : {}),
      ...(first.matched_with_changes === true ? { matchedWithChanges: true } : {}),
      ...(approvals.length > 0 ? { approvals } : {}),
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
  /** Touches made one by one along a way the map already knew (§16.1): where they began, ended and the place they reached. */
  const ways: Array<{ from: number; to: number; place: string; calls: number }> = [];
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
    // 5. 3 or more touches in a row, each starting where the one before ended, every road one the map had proven: one drive
    // (1.13.1 item 11). Looks between them don't break it; the count is every call from the first touch to the last.
    for (let i = 0; i < seq.length; ) {
      const first = seq[i] as CallRecord;
      if (!(first.ok && first.way?.known === true)) {
        i++;
        continue;
      }
      let last = first;
      let lastAt = i;
      let touches = 1;
      let next = i + 1;
      while (next < seq.length) {
        const e = seq[next] as CallRecord;
        if (e.tool === "look") {
          next++;
          continue;
        }
        if (!(e.ok && e.way?.known === true && e.way.from === last.way?.to)) break;
        last = e;
        lastAt = next;
        touches++;
        next++;
      }
      if (touches >= KNOWN_WAY_TOUCHES) ways.push({ from: first.n, to: last.n, place: last.way?.to ?? "", calls: lastAt - i + 1 });
      i = lastAt + 1;
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
  for (const w of ways.slice(0, REPORT_MAX_NUMBERS)) {
    flags.push({ text: `${w.calls} calls in a row on a way the map knows (calls ${range(w)}): drive {"to": ${JSON.stringify(w.place)}} is one call` });
  }
  // Thin calls: each started a new process. Consecutive call numbers read as a range.
  const thin = calls.filter((c) => c.via === "call");
  if (thin.length >= THIN_CALLS_FLAGGED) {
    const ranges: Array<{ from: number; to: number }> = [];
    for (const c of thin) {
      const open = ranges[ranges.length - 1];
      if (open !== undefined && open.to + 1 === c.n) open.to = c.n;
      else ranges.push({ from: c.n, to: c.n });
    }
    flags.push({ text: `${thin.length} calls each from a new process (calls ${numbers(ranges.map(range))}): load the MCP server once; each call paid about 2 s` });
  }
  const time = timeLine(calls);
  const given = calls.flatMap((c) => c.approvals ?? []);
  return {
    calls: calls.length,
    minutes,
    toolCounts: [...counts].sort(byCount),
    failed,
    failedCodes: [...codes].sort(byCount),
    flags,
    ...(time !== undefined ? { time } : {}),
    ...(calls.some((c) => c.fastAnimations === true) ? { fastAnimations: calls.filter((c) => c.fastAnimations === true).length } : {}),
    ...(given.length > 0 ? { approvals: { chat: given.filter((v) => v === "chat").length, liveView: given.filter((v) => v === "live view").length } } : {}),
  };
}

/** Three touches in a row on a way the map knows are enough to say "drive is one call" (1.13.1 item 11). */
const KNOWN_WAY_TOUCHES = 3;
/** Five thin calls are enough to say "load the MCP server once" (1.13.1 item 11). */
const THIN_CALLS_FLAGGED = 5;
/** A gap longer than this is the agent away, not thinking (§16.1). */
const IDLE_GAP_MS = 2 * 60_000;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
/** A total: seconds under a minute, else whole minutes. */
const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** AGENT-TOOLS 1.13 §16.1: where the seconds went. Calls with no `ms` (older logs) are left out. */
function timeLine(calls: readonly CallRecord[]): string | undefined {
  const timed = calls.filter((c) => c.ms !== undefined && c.end !== undefined);
  if (timed.length === 0) return undefined;
  const gaps: number[] = [];
  const byClient = new Map<string, CallRecord[]>();
  for (const c of timed) {
    // A client name can repeat across sessions; their calls never follow one another.
    const key = `${c.session}\0${c.client ?? ""}`;
    const list = byClient.get(key);
    if (list === undefined) byClient.set(key, [c]);
    else list.push(c);
  }
  for (const list of byClient.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const gap = (list[i] as CallRecord).t - ((list[i - 1] as CallRecord).end as number);
      if (gap >= 0 && gap <= IDLE_GAP_MS) gaps.push(gap);
    }
  }
  const tool = timed.map((c) => c.ms as number);
  const perTool = new Map<string, number[]>();
  for (const c of timed) perTool.set(c.tool, [...(perTool.get(c.tool) ?? []), c.ms as number]);
  const top = [...perTool]
    .map(([name, values]) => ({ name, total: values.reduce((a, b) => a + b, 0), median: median(values) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const shown = top.slice(0, 3).map((t) => `${t.name} ${seconds(t.median)}`);
  if (top.length > 3) shown.push("…");
  const thinking = gaps.reduce((a, b) => a + b, 0);
  const inTool = tool.reduce((a, b) => a + b, 0);
  return `Time: ${span(thinking + inTool)}: thinking between calls ${span(thinking)} (median ${seconds(median(gaps))}), in the tool ${span(inTool)} (median ${seconds(median(tool))}; ${shown.join(", ")}).`;
}

const MAX_TOOLS_SHOWN = 8;

/** `accounts` are the loaded test accounts' names (§18.6); never their values. */
export function formatReport(report: Report, accounts: readonly string[] = []): string {
  const accountsLine = accounts.length > 0 ? `Accounts: ${accounts.join(", ")}.` : undefined;
  if (report.calls === 0) return ["Session: 0 calls.", ...(accountsLine !== undefined ? [accountsLine] : []), "Waste: none."].join("\n");
  const shown = report.toolCounts.slice(0, MAX_TOOLS_SHOWN).map(([tool, n]) => `${tool} ${n}`);
  if (report.toolCounts.length > MAX_TOOLS_SHOWN) shown.push("…");
  const failed =
    report.failed === 0 ? "Failed: 0." : `Failed: ${report.failed} (${report.failedCodes.map(([code, n]) => `${code} ${n}`).join(", ")}).`;
  const head = `Session: ${report.calls} ${report.calls === 1 ? "call" : "calls"} in ${report.minutes} min (${shown.join(", ")}). ${failed}`;
  const a = report.approvals;
  const approvalsLine =
    a === undefined ? undefined : `Approvals: ${[...(a.chat > 0 ? [`${a.chat} in chat`] : []), ...(a.liveView > 0 ? [`${a.liveView} in the live view`] : [])].join(", ")}.`;
  const animationsLine = report.fastAnimations === undefined ? undefined : `Animations: fast for ${report.fastAnimations} of ${report.calls} ${report.calls === 1 ? "call" : "calls"}.`;
  const top = [
    head,
    ...(report.time !== undefined ? [report.time] : []),
    ...(report.grants !== undefined ? [report.grants] : []),
    ...(approvalsLine !== undefined ? [approvalsLine] : []),
    ...(animationsLine !== undefined ? [animationsLine] : []),
    ...(accountsLine !== undefined ? [accountsLine] : []),
  ];
  if (report.flags.length === 0) return [...top, "Waste: none."].join("\n");
  return [...top, "Waste:", ...report.flags.map((f) => `- ${f.text}`)].join("\n");
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
export function reportFor(dir: string, sinceMs: number, onlySession?: string, accounts?: readonly string[]): string {
  const entries = readLogEntries(dir, sinceMs).filter((e) => onlySession === undefined || e.session === onlySession);
  const grants = grantsLine(entries);
  return formatReport({ ...analyze(buildCalls(entries)), ...(grants !== undefined ? { grants } : {}) }, accounts);
}

/**
 * AGENT-TOOLS 1.14 §19.7: `Grants: instagram_posting 2 uses (2 of 3 today); asked a person 1 time (limit reached).` From the touches
 * the log says a grant let through (`grant`, `grant_use`) and the ones a grant matched but didn't cover (`grant_asked`). Nothing
 * when no grant was involved.
 */
export function grantsLine(entries: readonly ActionLogEntry[]): string | undefined {
  const uses = new Map<string, { n: number; last: string | undefined }>();
  const asked = new Map<string, number>();
  let askedTotal = 0;
  for (const e of entries) {
    if (e.by !== "agent" || e.dry_run === true) continue;
    if (e.grant !== undefined && e.ok) {
      const seen = uses.get(e.grant);
      uses.set(e.grant, { n: (seen?.n ?? 0) + 1, last: e.grant_use ?? seen?.last });
    } else if (e.grant_asked !== undefined) {
      asked.set(e.grant_asked, (asked.get(e.grant_asked) ?? 0) + 1);
      askedTotal++;
    }
  }
  if (uses.size === 0 && askedTotal === 0) return undefined;
  const parts = [...uses].map(([name, { n, last }]) => `${name} ${n} ${n === 1 ? "use" : "uses"}${last !== undefined ? ` (${last})` : ""}`);
  if (askedTotal > 0) {
    const reasons = [...asked].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const why = reasons.length === 1 ? (reasons[0] as [string, number])[0] : reasons.map(([reason, n]) => `${reason} ${n}`).join(", ");
    parts.push(`asked a person ${askedTotal} ${askedTotal === 1 ? "time" : "times"} (${why})`);
  }
  return `Grants: ${parts.join("; ")}.`;
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
