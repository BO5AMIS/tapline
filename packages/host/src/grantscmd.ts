import { AuditLog, deleteAuditLog, readAuditLines } from "./auditlog.js";
import { GrantBook, refusalLine, type Grant } from "./grants.js";
import { parseSince } from "./report.js";

/**
 * AGENT-TOOLS 1.14 §19.5, §19.7, §23: the commands a person runs in a terminal, `tapline grants` and `tapline audit-log`. They
 * are commands, not MCP tools, so the model can neither list the grants' history, revoke, nor read or delete the audit log
 * through the tool.
 */

export interface GrantsCommandOptions {
  /** `--policy FILE`: the policy file whose grants these are. */
  policy: string | undefined;
  /** The audit log's folder (`<config>/audit`). */
  auditDir: string;
  revokeAll?: boolean;
  now?: () => Date;
}

const LAST_USES = 3;

function standing(grant: Grant, today: string): string {
  if (grant.revoked !== undefined) return `revoked ${grant.revoked}`;
  return today > grant.until ? `ended ${grant.until}` : "active";
}

/**
 * `tapline grants`: every grant, today's counts and the last uses (from the audit log). `--revoke-all` revokes every grant in the
 * file first, writes a `revoke` line for each, and lists them as revoked.
 */
export async function runGrants(options: GrantsCommandOptions): Promise<{ text: string; code: number }> {
  if (options.policy === undefined) {
    return { text: "grants needs the policy file: tapline grants --policy FILE (the file you give `tapline mcp --policy`)", code: 2 };
  }
  const audit = new AuditLog(options.auditDir, options.now);
  const book = new GrantBook({ policyPath: options.policy, audit, ...(options.now !== undefined ? { now: options.now } : {}) });
  const lines: string[] = [];
  if (options.revokeAll === true) {
    const done = await book.revokeAll();
    if ("error" in done) return { text: `Couldn't revoke: ${done.error}`, code: 1 };
    lines.push(
      done.revoked.length === 0
        ? done.already.length === 0
          ? "No grants to revoke."
          : `Every grant was already revoked (${done.already.length}).`
        : `Revoked ${done.revoked.length} ${done.revoked.length === 1 ? "grant" : "grants"}: ${done.revoked.join(", ")}. A running route stops at its next touch that needs a grant.`,
      "",
    );
  }
  const { report, usage } = await book.listing();
  if (!report.fileOk) return { text: `Couldn't read the policy file ${options.policy}.`, code: 1 };
  const now = (options.now ?? (() => new Date()))();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const used = new Map<string, Array<{ t: string; detail: string }>>();
  for (const { entry } of readAuditLines(options.auditDir)) {
    if (entry?.kind !== "grant" || entry.name === undefined) continue;
    used.set(entry.name, [...(used.get(entry.name) ?? []), { t: entry.t, detail: entry.detail ?? "" }]);
  }
  if (report.grants.length === 0 && report.refused.length === 0) lines.push("No grants.");
  for (const grant of report.grants) {
    const counts = usage.get(grant.name);
    lines.push(`${grant.name}: ${standing(grant, today)}`);
    lines.push(
      `  ${[
        `app ${grant.app}`,
        `words ${grant.words.map((w) => JSON.stringify(w)).join(", ")}`,
        ...(grant.route !== undefined ? [`route ${grant.route}`] : []),
        `until ${grant.until}`,
        ...(grant.quiet !== undefined ? [`quiet ${grant.quiet.from} to ${grant.quiet.to}`] : []),
        ...(grant.draftsOnly ? ["drafts shown first"] : []),
      ].join("; ")}`,
    );
    lines.push(
      `  today ${counts == null ? "unknown (the state file doesn't parse)" : `${counts.today} of ${grant.perDay}${grant.perHour !== undefined ? `, this hour ${counts.hour} of ${grant.perHour}` : ""}`}`,
    );
    const last = (used.get(grant.name) ?? []).slice(-LAST_USES).reverse();
    lines.push(last.length === 0 ? "  last uses: none" : `  last uses: ${last.map((u) => `${u.t} ${u.detail}`.trim()).join("; ")}`);
  }
  for (const refusal of report.refused) lines.push(refusalLine(refusal).replace(/^Note: /, "Refused: "));
  if (report.stateBroken) lines.push("The state file doesn't parse: every grant counts as used up, and every touch asks a person.");
  return { text: lines.join("\n"), code: 0 };
}

/**
 * `--since` of `audit-log`: an ISO date (local midnight) or time, or epoch ms; `parseSince`'s other forms (`2h`) work too.
 * Null when it isn't one.
 */
function sinceOf(raw: string, now: number): number | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (date !== null) return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
  return parseSince(raw, now);
}

/**
 * `tapline audit-log [--since <date or ISO time>] [--delete]` (§23): the lines since then, one per line, as written; or
 * `--delete`, which deletes the log. `--delete` with `--since` is refused: the log is deleted whole or not at all.
 */
export function runAuditLog(options: { dir: string; since?: string; delete?: boolean; now?: () => number }): { text: string; code: number } {
  const now = (options.now ?? Date.now)();
  if (options.delete === true) {
    if (options.since !== undefined) return { text: "audit-log --delete deletes the whole log; leave --since out.", code: 2 };
    const lines = deleteAuditLog(options.dir);
    return { text: `Deleted the audit log (${lines} ${lines === 1 ? "line" : "lines"}).`, code: 0 };
  }
  let since: number | undefined;
  if (options.since !== undefined) {
    const parsed = sinceOf(options.since, now);
    if (parsed === null) return { text: `--since is a date or an ISO time, like 2026-11-14 or 2026-11-14T06:00:00Z, not "${options.since}"`, code: 2 };
    since = parsed;
  }
  const lines = readAuditLines(options.dir, since).map((l) => l.line);
  return { text: lines.length === 0 ? `The audit log has no lines${since !== undefined ? " since then" : ""}.` : lines.join("\n"), code: 0 };
}
