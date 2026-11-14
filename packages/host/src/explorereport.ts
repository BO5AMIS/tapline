import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FINDING_KINDS, redactFinding, type Finding } from "./findings.js";
import type { SkipWhy } from "./mapfile.js";

// The report of `explore` (AGENT-TOOLS 1.15 §25.10): one folder per run, `report.json`, `report.md`, a picture per finding in
// `findings/` and a script per finding in `repro/`. The newest 20 folders of an app are kept.

export const STOP_REASONS = ["budget_minutes", "budget_steps", "frontier_empty", "crash", "paused", "busy", "locked", "toggle_not_restored", "cant_get_back", "app_closed"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** How many run folders an app keeps (§25.10). */
export const RUNS_KEPT = 20;

export interface SkippedEntry {
  place: string;
  sig: string;
  why: SkipWhy;
  word?: string;
}

export interface ResetEntry {
  how: "reload" | "app_command";
  data_kept: boolean;
  at_step: number;
}

export interface ExploreCoverage {
  places: number;
  known_up_front?: number;
  reached?: number;
  not_reached?: string[];
  areas?: Record<string, { known: number; visited: number }>;
  frontier_left: number;
}

export interface ExploreReport {
  format: "agent-tools-explore-report";
  version: 1;
  app: string;
  build: string;
  tool: "tapline";
  tool_version: string;
  started: string;
  ended: string;
  stopped: StopReason;
  start_place: string | null;
  budget: { minutes: number; steps: number; depth: number };
  used: { minutes: number; steps: number };
  coverage: ExploreCoverage;
  findings: Finding[];
  skipped: SkippedEntry[];
  notes: string[];
  resets: ResetEntry[];
}

/** `2026-11-14T09:15:00Z`: UTC, no milliseconds. */
export const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d+Z$/, "Z");

/** `20261114T091500Z`, UTC. */
export const folderStamp = (date: Date): string => isoSeconds(date).replace(/[-:]/g, "");

/** The reason as `Stopped:` says it (§25.9). `detail` is the toggle's id for `toggle_not_restored`. */
export function stoppedWords(reason: StopReason, detail?: string): string {
  switch (reason) {
    case "budget_minutes":
      return "the budget (minutes) is used up.";
    case "budget_steps":
      return "the budget (steps) is used up.";
    case "frontier_empty":
      return "the frontier is empty.";
    case "crash":
      return "the app crashed.";
    case "toggle_not_restored":
      return `a toggle could not be set back${detail !== undefined ? ` (${detail})` : ""}.`;
    case "cant_get_back":
      return "it can't get back to a known place.";
    case "app_closed":
      return "the app is closed.";
    case "paused":
      return "the user paused it.";
    case "busy":
      return "a person is using the app.";
    case "locked":
      return "the phone is locked.";
  }
}

/** A folder name for an app id: the id's own characters when they are plain, else `_`. */
const appFolder = (appId: string): string => appId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "unknown";

const RUN_FOLDER = /^\d{8}T\d{6}Z(?:-\d+)?$/;

export interface RunFolder {
  dir: string;
  /** `findings/` and `repro/` are made when the first file goes in. */
  fileIn(kind: "findings" | "repro", name: string, data: string | Uint8Array): string;
}

/**
 * Makes the run's folder, `<base>/<app id>/<UTC time>/`, and removes the app's oldest folders beyond the newest 20 (§25.10). The
 * folder is made first, so the new run is one of the 20. A second run in the same second gets `-2`.
 */
export function openRunFolder(base: string, appId: string, started: Date): RunFolder {
  const appDir = join(base, appFolder(appId));
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  const stamp = folderStamp(started);
  let dir = join(appDir, stamp);
  for (let n = 2; ; n++) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      dir = join(appDir, `${stamp}-${n}`);
    }
  }
  try {
    const folders = readdirSync(appDir).filter((name) => RUN_FOLDER.test(name)).sort();
    for (const old of folders.slice(0, Math.max(0, folders.length - RUNS_KEPT))) rmSync(join(appDir, old), { recursive: true, force: true });
  } catch {
    // a folder that can't be removed stays; the run goes on
  }
  return {
    dir,
    fileIn(kind, name, data) {
      const folder = join(dir, kind);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(join(folder, name), data);
      return `${kind}/${name}`;
    },
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** `Explored 23 places in 6.2 min (212 steps), 4 findings. Stopped: the frontier is empty.` and the lines after it (§25.2). */
export function answerLines(report: ExploreReport, findingsLine: string, reportPath: string, detail?: string): string[] {
  const lines = [
    `Explored ${plural(report.coverage.places, "place", "places")} in ${report.used.minutes} min (${plural(report.used.steps, "step", "steps")}), ${plural(report.findings.length, "finding", "findings")}. Stopped: ${stoppedWords(report.stopped, detail)}`,
  ];
  const c = report.coverage;
  if (c.known_up_front !== undefined && c.reached !== undefined) lines.push(`Coverage: ${c.reached} of ${c.known_up_front} places known up front; ${c.not_reached?.length ?? 0} not reached.`);
  lines.push(`Findings: ${findingsLine === "" ? "none" : findingsLine}.`);
  lines.push(`Report: ${reportPath}`);
  return lines;
}

/** `report.md`: the same content for a person, with the findings first (§25.10). */
export function reportMarkdown(report: ExploreReport, detail?: string): string {
  const out: string[] = [`# Explore report: ${report.app}`, ""];
  out.push(`Build ${report.build}, ${report.tool} ${report.tool_version}. ${report.started} to ${report.ended}. Stopped: ${stoppedWords(report.stopped, detail)}`, "");
  out.push(`## Findings (${report.findings.length})`, "");
  if (report.findings.length === 0) out.push("None.", "");
  for (const kind of FINDING_KINDS) {
    for (const f of report.findings.filter((finding) => finding.kind === kind)) {
      out.push(`### ${f.id} ${f.kind}${f.count > 1 ? ` (x${f.count})` : ""} at ${f.place ?? "an unknown place"}`, "");
      out.push(`- Expected: ${f.expected}`);
      out.push(`- Got: ${f.got.split("\n").join("\n  ")}`);
      if (f.path.length > 0 || f.path_from !== null) out.push(`- Path from ${f.path_from ?? "?"}: ${f.path.map((step) => pathText(step)).join(" > ") || "(nothing)"}`);
      if (f.picture !== null) out.push(`- Picture: ${f.picture.file}${f.picture.private ? " (private: may show personal data)" : ""}`);
      if (f.repro !== null) out.push(`- Repro: ${f.repro}`);
      for (const line of f.logs) out.push(`  - ${line}`);
      out.push("");
    }
  }
  const c = report.coverage;
  out.push("## Coverage", "");
  out.push(`- Places visited: ${c.places}`);
  if (c.known_up_front !== undefined) {
    out.push(`- Known up front: ${c.known_up_front}; reached ${c.reached ?? 0}`);
    if ((c.not_reached ?? []).length > 0) out.push(`- Not reached: ${(c.not_reached ?? []).join(", ")}`);
    for (const [area, n] of Object.entries(c.areas ?? {})) out.push(`- Area ${area}: ${n.visited} of ${n.known}`);
  }
  out.push(`- Frontier left: ${c.frontier_left}`, "");
  out.push(`## Used`, "", `- ${report.used.minutes} of ${report.budget.minutes} minutes, ${report.used.steps} of ${report.budget.steps} steps, depth ${report.budget.depth}`, "");
  if (report.skipped.length > 0) {
    out.push(`## Skipped (${report.skipped.length})`, "");
    for (const s of report.skipped) out.push(`- ${s.place}: ${s.sig} (${s.why}${s.word !== undefined ? `, ${JSON.stringify(s.word)}` : ""})`);
    out.push("");
  }
  if (report.notes.length > 0) out.push("## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  if (report.resets.length > 0) {
    out.push("## Resets", "");
    for (const r of report.resets) out.push(`- step ${r.at_step}: ${r.how === "reload" ? "reload only, data kept" : "app_command reset, data cleared"}`);
    out.push("");
  }
  return out.join("\n");
}

function pathText(step: Finding["path"][number]): string {
  const t = step.target;
  const where = t === undefined ? "" : t.id !== undefined ? ` id=${t.id}` : t.label !== undefined ? ` label=${JSON.stringify(t.label)}` : t.text !== undefined ? ` text=${JSON.stringify(t.text)}` : t.row === true ? ` row ${t.index ?? 1}` : "";
  return `${step.tool}${where}`;
}

/**
 * Writes `report.json` and `report.md`. Every text goes through the redaction first (§20.3); the JSON is redacted value by value,
 * so it stays valid JSON. Answers the path of `report.md`, or null when it can't be written (a report that fails never changes the run).
 */
export function writeReport(folder: RunFolder, report: ExploreReport, redact: (text: string) => string, detail?: string): string | null {
  try {
    const clean = redactFinding(report, redact);
    writeFileSync(join(folder.dir, "report.json"), `${JSON.stringify(clean, null, 2)}\n`);
    const md = join(folder.dir, "report.md");
    writeFileSync(md, redact(reportMarkdown(clean, detail)));
    return md;
  } catch {
    return null;
  }
}
