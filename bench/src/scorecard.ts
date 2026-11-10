import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarize } from "./stats.js";
import {
  isMax,
  isMinTarget,
  targetFor,
  valueTargetFor,
  type Link,
  type Target,
  type ValueTarget,
} from "./targets.js";

export interface SpeedRow {
  id: string;
  samples: number;
  median: number;
  p95: number;
  target: Target;
  pass: boolean;
  notes?: string;
}

/** Reliability rows (part 3): checks run, misses found. */
export interface CheckRow {
  id: string;
  checks: number;
  misses: number;
  /** null: the runner can't measure it (R6-R8); report only. */
  pass: boolean | null;
  notes?: string;
}

/**
 * A single-value row (viewer suite: fps, longest stall, px/pt, KB/s). `pass` is null when the bar
 * only asks for a report, or the runner can't measure it.
 */
export interface ValueRow {
  id: string;
  value: number | null;
  unit: string;
  target: ValueTarget | null;
  pass: boolean | null;
  notes?: string;
}

export type ResultRow = SpeedRow | CheckRow | ValueRow;

export interface Scorecard {
  tool: string;
  version: string;
  phone: string;
  ios: string;
  link: Link;
  date: string;
  results: ResultRow[];
}

export function isSpeedRow(r: ResultRow): r is SpeedRow {
  return "samples" in r;
}

export function isValueRow(r: ResultRow): r is ValueRow {
  return "unit" in r;
}

/** Seconds, rounded to 3 decimals. NaN stays NaN (serialized as null by JSON). */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Builds a speed row from samples in seconds. `errors` counts failed attempts; any error fails the row.
 */
export function speedRow(
  id: string,
  samplesS: number[],
  link: Link,
  opts: { errors?: number; notes?: string } = {},
): SpeedRow {
  const s = summarize(samplesS);
  const target = targetFor(id, link);
  const errors = opts.errors ?? 0;
  const within =
    s.n > 0 &&
    (isMax(target) ? s.max <= target.max : s.median <= target.median && s.p95 <= target.p95);
  const notes = [opts.notes, errors > 0 ? `${errors} failed attempt(s)` : undefined]
    .filter((x): x is string => Boolean(x))
    .join("; ");
  return {
    id,
    samples: s.n,
    median: round3(s.median),
    p95: round3(s.p95),
    target,
    pass: within && errors === 0,
    ...(notes ? { notes } : {}),
  };
}

/**
 * Builds a value row. No finite value fails the row, `failed` fails it, and a link whose target is
 * null (report only) gives `pass: null`.
 */
export function valueRow(
  id: string,
  value: number,
  unit: string,
  link: Link,
  opts: { failed?: boolean; notes?: string } = {},
): ValueRow {
  const target = valueTargetFor(id, link);
  const finite = Number.isFinite(value);
  let pass: boolean | null;
  if (!finite || opts.failed) pass = false;
  else if (target === null) pass = null;
  else pass = isMinTarget(target) ? value >= target.min : value <= target.max;
  return {
    id,
    value: finite ? round3(value) : null,
    unit,
    target,
    pass,
    ...(opts.notes ? { notes: opts.notes } : {}),
  };
}

/** A row the runner doesn't measure (or can't, here): `pass: null`. */
export function notMeasuredRow(id: string, unit: string, notes: string): ValueRow {
  return { id, value: null, unit, target: null, pass: null, notes };
}

export function buildScorecard(
  meta: Omit<Scorecard, "date" | "results">,
  results: ResultRow[],
  date: Date = new Date(),
): Scorecard {
  return { ...meta, date: date.toISOString(), results };
}

export function scorecardFileName(card: Scorecard): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe(card.tool)}-${card.link}-${card.date.replace(/:/g, "")}.json`;
}

export function writeScorecard(dir: string, card: Scorecard): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, scorecardFileName(card));
  writeFileSync(path, JSON.stringify(card, null, 2) + "\n", "utf8");
  return path;
}

export function allPass(card: Scorecard): boolean {
  return card.results.length > 0 && card.results.every((r) => r.pass !== false);
}

function fmtValueTarget(t: ValueTarget | null): string {
  if (t === null) return "-";
  return isMinTarget(t) ? `>= ${t.min}` : `<= ${t.max}`;
}

function fmtResult(pass: boolean | null): string {
  return pass === null ? "n/a" : pass ? "PASS" : "FAIL";
}

function fmtTarget(t: Target): string {
  return isMax(t) ? `<= ${t.max}` : `${t.median} / ${t.p95}`;
}

/** Plain text table: id, n, median, p95, target, PASS/FAIL (seconds). */
export function formatTable(card: Scorecard): string {
  const header = ["id", "n", "median", "p95", "target", "result"];
  const rows: string[][] = card.results.map((r) =>
    isValueRow(r)
      ? [
          r.id,
          "-",
          r.value === null ? "-" : `${r.value} ${r.unit}`,
          "-",
          fmtValueTarget(r.target),
          fmtResult(r.pass),
        ]
      : isSpeedRow(r)
      ? [
          r.id,
          String(r.samples),
          Number.isFinite(r.median) ? r.median.toFixed(3) : "-",
          Number.isFinite(r.p95) ? r.p95.toFixed(3) : "-",
          fmtTarget(r.target),
          r.pass ? "PASS" : "FAIL",
        ]
      : [r.id, String(r.checks), `${r.misses} miss`, "-", "0 misses", fmtResult(r.pass)],
  );
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]): string =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  const out = [
    `${card.tool} ${card.version} | ${card.phone} iOS ${card.ios} | link ${card.link} | ${card.date}`,
    "times in seconds; single-value rows show their unit",
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ];
  const notes = card.results.filter((r) => r.notes).map((r) => `${r.id}: ${r.notes}`);
  if (notes.length > 0) out.push("", ...notes);
  return out.join("\n");
}
