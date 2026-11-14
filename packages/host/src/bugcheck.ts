import { bugSignature, placeKeyJson, type BugFinding, type BugMeta } from "./bug.js";
import { LOG_LINE_MAX, cutText, firstLine, type PathStep } from "./findings.js";
import type { BugCheckOptions } from "./bugstore.js";
import type { PlaceKey } from "./mapfile.js";

// The reproduction check (AGENT-TOOLS 1.16 §29.4): run a bug's `repro.json` N times from a fresh start and count the runs that show the same bug.
// This file is the engine and holds no tool: everything it touches comes through `CheckHost`, which tools.ts builds on the one dispatch gate
// every touch goes through (§11, §25.1, §25.5), so the check can't reach anything a person's OK would be needed for.

export const VERIFY_DEFAULT = 3;
export const VERIFY_MAX = 10;
/** A run lasts at most this long (§29.4). */
export const RUN_LIMIT_MS = 60_000;
/** A move that took longer than this to settle is the slow finding of the explorer (§25.10). */
export const SLOW_MS = 3000;

/** What one step did. */
export type StepResult =
  /** It was made; `settledMs` is how long the screen took to settle. */
  | { kind: "ok"; settledMs?: number }
  /** The gate refused it because a person's OK is needed: a policy word, the skip floor. Nothing was touched. */
  | { kind: "person"; why: string }
  /** A person is using the phone, or paused the agent, or it is locked (§25.9). */
  | { kind: "stop"; code: "busy" | "paused" | "locked" }
  /** The move failed or the app answered with an error; `message` is the first line. */
  | { kind: "error"; code: string; message: string };

/** What the app did since a mark: a crash, a disconnect, the error lines of its log. */
export interface Seen {
  crash: { line: string; crash: { reason: string; frames: string[] } } | null;
  disconnected: boolean;
  /** The first line of each error, already redacted. */
  errors: string[];
}

export type ResetResult = { ok: true; words: string } | { ok: false };

/**
 * The only tools a reproduction step may name (§29.4): touches and navigation. Never `app_command` (a reset is the fresh start's, and only
 * with `reset: "app"`), never `run`, `drive`, `wait` and the rest, whether the step is a top-level one or sits inside another.
 */
export const CHECK_TOOLS: readonly string[] = ["tap", "long_press", "toggle", "scroll", "swipe", "back", "open_url", "type_text"];

const hasTool = (value: unknown, depth: number): boolean => {
  if (depth > 8 || typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => hasTool(item, depth + 1));
  const record = value as Record<string, unknown>;
  return typeof record["tool"] === "string" || Object.values(record).some((item) => hasTool(item, depth + 1));
};

/** Why a script can't be run, or null: every step is a plain object whose tool is allowed and that holds no other step (§29.4). */
export function stepsProblem(steps: readonly unknown[]): string | null {
  for (const [i, step] of steps.entries()) {
    const tool = typeof step === "object" && step !== null && !Array.isArray(step) ? (step as Record<string, unknown>)["tool"] : undefined;
    if (typeof tool !== "string" || !CHECK_TOOLS.includes(tool)) return `step ${i + 1} is ${typeof tool === "string" ? JSON.stringify(tool) : "not a step"}, which the check never runs`;
    const { tool: _tool, ...rest } = step as Record<string, unknown>;
    if (hasTool(rest, 0)) return `step ${i + 1} holds another step, which the check never runs`;
  }
  return null;
}

export interface CheckHost {
  clock(): number;
  wall(): Date;
  /** `<version> (<build>)` of the app in front, or null when no phone is connected. */
  build(): string | null;
  /** The fresh start (§25.8): the tool's own reset, and with `app` also the app's standard reset. `words` says which and whether data was kept. */
  reset(mode: "own" | "app", signal?: AbortSignal): Promise<ResetResult>;
  /** Drives to the script's start place; false when it can't. */
  start(place: string, signal?: AbortSignal): Promise<boolean>;
  /** One step, through the gate. `typed` is the value of a `${typed}` step (only ever given by a person at a prompt). `signal` aborts at the run's deadline. */
  step(step: PathStep, typed: string | null, signal?: AbortSignal): Promise<StepResult>;
  /** Why the check can't go on with this session (the app is gone, or another one is in front), or null. Asked before every action. */
  away?(): string | null;
  /** The longest a run lasts: one absolute deadline for its reset, its way to the start and every step; default `RUN_LIMIT_MS` (§29.4). */
  deadlineMs?: number;
  mark(): unknown;
  since(mark: unknown): Promise<Seen>;
  /** The key of the place the app is on, or null when it isn't known. */
  placeKey(): Promise<PlaceKey | null>;
  /** The accessibility or usability lines of the screen as it is, or null when the app can't say. */
  issues(kind: "a11y" | "ux"): Promise<string[] | null>;
  inFront(): boolean;
  redact(text: string): string;
}

export interface CheckBug {
  finding: BugFinding;
  meta: BugMeta;
  /** The `start` of `repro.json`, and its steps. */
  script: { start: string | null; steps: PathStep[] };
}

export type CheckOptions = Pick<BugCheckOptions, "reset" | "typed">;

const notChecked = (why: string): BugMeta["reproduced"] => ({ checked: false, why });

const CONNECTION = new Set(["not_connected", "in_background", "reconnecting", "not_answering"]);

/** The `expect` a `expect_failed` finding names in its `expected` line, `the step's expect holds ({…})` (§27.1). */
export function expectOf(expected: string): Record<string, unknown> | null {
  const open = expected.indexOf("(");
  if (!expected.startsWith("the step's expect holds (") || !expected.endsWith(")")) return null;
  try {
    const parsed: unknown = JSON.parse(expected.slice(open + 1, -1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface RunEnd {
  placeBefore: PlaceKey | null;
  placeNow: PlaceKey | null;
  last: StepResult | null;
  seen: Seen;
  complete: boolean;
}

type RunResult = { kind: "made"; same: boolean; words: string; given: boolean } | { kind: "not_started" } | { kind: "no_reset" } | { kind: "stopped"; why: string } | { kind: "timed_out" };

const EXPIRED: unique symbol = Symbol("expired");
type Within = <T>(work: Promise<T>) => Promise<T | typeof EXPIRED>;

/** Whether what a run ended with has the same signature as the bug (§29.4, §29.5). */
async function sameBug(host: CheckHost, bug: CheckBug, end: RunEnd): Promise<boolean> {
  const { finding, meta } = bug;
  const kind = finding.kind;
  // A bug whose place wasn't known (no key) has none to compare: the signature then holds `null` for it (§29.5).
  const keyOk = (at: PlaceKey | null): boolean => meta.place_key === null || placeKeyJson(at) === placeKeyJson(meta.place_key);
  const sig = (got: string, crash?: { reason: string; frames: string[] }): boolean =>
    bugSignature({ kind, placeKey: meta.place_key, got, ...(crash !== undefined ? { crash } : {}) }) === meta.signature;
  const last = end.last;
  const lastError = last !== null && last.kind === "error" ? last : null;
  switch (kind) {
    case "crash": {
      if (!keyOk(end.placeBefore)) return false;
      if (end.seen.crash !== null) return sig(host.redact(`the app crashed: ${end.seen.crash.line}`), end.seen.crash.crash);
      const gone = end.seen.disconnected || (lastError !== null && CONNECTION.has(lastError.code));
      return gone && sig("the app disconnected (it may have crashed)", { reason: "the app disconnected (it may have crashed)", frames: [] });
    }
    case "js_error": {
      const first = end.seen.errors[0];
      return first !== undefined && keyOk(end.placeBefore) && sig(first);
    }
    case "refused":
      return lastError !== null && lastError.code === "not_actionable" && keyOk(end.placeBefore) && sig(host.redact(`not_actionable: ${lastError.message}`.split("\n")[0] as string));
    case "dead_end": {
      if (!keyOk(end.placeBefore)) return false;
      if (lastError !== null && CONNECTION.has(lastError.code)) return sig(`the app went away (${lastError.code})`);
      return last !== null && last.kind === "ok" && !host.inFront() && sig("the move left the app");
    }
    case "slow":
      return last !== null && last.kind === "ok" && last.settledMs !== undefined && last.settledMs > SLOW_MS && keyOk(end.placeBefore) && sig(`${(last.settledMs / 1000).toFixed(1)} s to settle`);
    case "expect_failed":
      return lastError !== null && lastError.code === "expect_failed" && keyOk(end.placeBefore) && sig(cutText(firstLine(host.redact(lastError.message)), LOG_LINE_MAX));
    case "a11y":
    case "ux": {
      if (!keyOk(end.placeNow)) return false;
      const lines = await host.issues(kind);
      const first = lines?.[0];
      return first !== undefined && host.redact(first) === firstLine(finding.got);
    }
    case "observed":
      // A note can't be matched: every step ran and the app ended on the same place key (§29.4).
      return end.complete && keyOk(end.placeNow);
    default:
      return false;
  }
}

async function oneRun(host: CheckHost, bug: CheckBug, steps: PathStep[], options: CheckOptions): Promise<RunResult> {
  // One absolute deadline for the whole run: the reset, the way to the start and every step (§29.4). At its end the signal reaches the host,
  // which sends nothing more, the request in flight is no longer waited for, and the run counts as timed out.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), host.deadlineMs ?? RUN_LIMIT_MS);
  timer.unref?.();
  const expired = new Promise<typeof EXPIRED>((resolve) => controller.signal.addEventListener("abort", () => resolve(EXPIRED), { once: true }));
  const within: Within = (work) => {
    work.catch(() => undefined);
    return Promise.race([work, expired]);
  };
  try {
    return await runSteps(host, bug, steps, options, controller.signal, within);
  } finally {
    clearTimeout(timer);
  }
}

async function runSteps(host: CheckHost, bug: CheckBug, steps: PathStep[], options: CheckOptions, signal: AbortSignal, within: Within): Promise<RunResult> {
  const away = (): RunResult | null => {
    const why = host.away?.() ?? null;
    return why === null ? null : { kind: "stopped", why };
  };
  const gone = away();
  if (gone !== null) return gone;
  const reset = await within(host.reset(options.reset, signal));
  if (reset === EXPIRED) return { kind: "timed_out" };
  if (!reset.ok) return { kind: "no_reset" };
  if (bug.script.start !== null) {
    const beforeStart = away();
    if (beforeStart !== null) return beforeStart;
    const arrived = await within(host.start(bug.script.start, signal));
    if (arrived === EXPIRED) return { kind: "timed_out" };
    if (!arrived) return { kind: "not_started" };
  }
  const started = host.clock();
  const mark = host.mark();
  let typed: string | null = null;
  let given = false;
  let last: StepResult | null = null;
  let placeBefore: PlaceKey | null = null;
  let complete = true;
  for (const [i, step] of steps.entries()) {
    if (host.clock() - started > RUN_LIMIT_MS) return { kind: "made", same: false, words: reset.words, given };
    const lost = away();
    if (lost !== null) return lost;
    const types = step.tool === "type_text";
    if (types && typed === null) {
      // A value is never in repro.json and never in a call: only a person at a prompt can give one (§29.4).
      // The prompt is inside the deadline too: a person who never answers ends the run as timed out, and a value that comes late is never typed.
      const answer = options.typed !== undefined ? await within(Promise.resolve(options.typed("typed"))) : null;
      if (answer === EXPIRED) return { kind: "timed_out" };
      typed = answer;
      if (typed === null) return { kind: "stopped", why: `step ${i + 1} needs a person (a typed value)` };
      given = true;
    }
    // Nothing is dispatched once the deadline has passed.
    if (signal.aborted) return { kind: "timed_out" };
    if (i === steps.length - 1) {
      const key = await within(host.placeKey());
      if (key === EXPIRED) return { kind: "timed_out" };
      placeBefore = key;
    }
    const result = await within(host.step(step, types ? typed : null, signal));
    if (result === EXPIRED) return { kind: "timed_out" };
    if (result.kind === "person") return { kind: "stopped", why: `step ${i + 1} needs a person (${result.why})` };
    if (result.kind === "stop") return { kind: "stopped", why: `stopped (${result.code})` };
    last = result;
    if (result.kind === "error" && i < steps.length - 1) {
      complete = false;
      break;
    }
  }
  if (steps.length === 0) {
    const key = await within(host.placeKey());
    if (key === EXPIRED) return { kind: "timed_out" };
    placeBefore = key;
  }
  const lostAtEnd = away();
  // An app that is gone after the last step may be the crash itself: its evidence is examined before the run stops (a crash or a way back that went away).
  const evidence = lostAtEnd === null || bug.finding.kind === "crash" || bug.finding.kind === "dead_end";
  if (!evidence) return lostAtEnd;
  const placeNow = await within(host.placeKey());
  if (placeNow === EXPIRED) return { kind: "timed_out" };
  const seen = await within(host.since(mark));
  if (seen === EXPIRED) return { kind: "timed_out" };
  const end: RunEnd = { placeBefore, placeNow, last, seen, complete: complete && (last === null || last.kind === "ok") };
  if (lostAtEnd !== null) {
    const matched = complete ? await within(sameBug(host, bug, end)) : false;
    if (matched === EXPIRED) return { kind: "timed_out" };
    return matched ? { kind: "made", same: true, words: reset.words, given } : (lostAtEnd as RunResult);
  }
  const same = complete ? await within(sameBug(host, bug, end)) : false;
  if (same === EXPIRED) return { kind: "timed_out" };
  return { kind: "made", same, words: reset.words, given };
}

/** The check: `n` runs from a fresh start (§29.4). The result is what `finding.json`'s `bug.reproduced` and the page take. */
export async function runCheck(host: CheckHost, input: CheckBug, n: number, options: CheckOptions): Promise<BugMeta["reproduced"]> {
  const build = host.build();
  if (build === null) return notChecked("no phone connected");
  const { finding } = input;
  if (finding.kind === "unreachable") return notChecked("an unreachable place has no steps");
  if (finding.kind === "dead_end" && input.script.steps.length === 0) return notChecked("a way back that is missing has no steps to run");
  // Every step is checked before anything runs, nested ones too: nothing but a touch is ever sent, and no reset outside the fresh start (§29.4).
  const wrong = stepsProblem(input.script.steps);
  if (wrong !== null) return notChecked(wrong);
  let steps = input.script.steps;
  if (finding.kind === "expect_failed") {
    const expect = expectOf(finding.expected);
    const last = steps.at(-1);
    if (expect === null || last === undefined) return notChecked("the step's expect isn't in the bug, so it can't be run again");
    steps = [...steps.slice(0, -1), { ...last, expect }];
  }
  const runs = Math.min(VERIFY_MAX, Math.max(1, Math.floor(n)));
  let made = 0;
  let same = 0;
  let words = "";
  let given = false;
  for (let i = 0; i < runs; i++) {
    const run = await oneRun(host, input, steps, options);
    if (run.kind === "no_reset") {
      if (made === 0) return notChecked("no reset reached a known place");
      break;
    }
    if (run.kind === "stopped") {
      if (made === 0) return notChecked(run.why);
      break;
    }
    if (run.kind === "timed_out") {
      if (made === 0) return notChecked("timed out");
      break;
    }
    if (run.kind === "not_started") continue;
    made += 1;
    if (run.same) same += 1;
    words = run.words;
    given = given || run.given;
  }
  if (made === 0) return notChecked("no run could start");
  // The page says only that a value was given, never the value (§29.4).
  return { n: same, of: made, build, when: host.wall().toISOString(), reset: `${words}${given ? "; a value was given" : ""}` };
}

