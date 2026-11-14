import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TreeElement, TreeResult } from "./protocol.js";
import {
  MAX_CANDIDATES,
  MAX_REPAIRS,
  MAX_SCROLLS,
  bucketOf,
  canTake,
  closestRefs,
  describeElement,
  describeTarget,
  expectedPlace,
  formatParts,
  idStem,
  isNearTie,
  namedBy,
  neverRepaired,
  rankScored,
  repairPhrase,
  sameToggleRole,
  scoreParts,
  screenOf,
  targetFor,
  targetOf,
  two,
  weightedScore,
  wordsPart,
  type NeverContext,
  type OldElement,
  type RepairRecord,
  type Scored,
  type Target,
} from "./repair.js";
import type { Step } from "./run.js";

// Self-repairing tests (AGENT-TOOLS 1.15 §26): the candidates of a break, and the run that tries them with the one acceptance rule.

/** What the repair needs from the host. Every touch goes through `runSteps`, so each has the checks of any touch (§26.4). */
export interface RepairHost {
  /** The script's name, for the audit lines. */
  script: string;
  /** Runs steps as one batch the way a replay does, and answers as `run` does. */
  runSteps(steps: Step[]): Promise<CallToolResult>;
  /**
   * Runs the steps a repair makes of its own (a trial of a new target, a scroll, a road move put in, the way back): the same batch,
   * but every touch meets the whole explore floor on the element that really receives it, whatever the policy says (§25.5, §26.4).
   */
  trial(steps: Step[]): Promise<CallToolResult>;
  /** The role a passing run recorded for the toggle at this place (by its target), or null when none did. */
  toggleRole(place: string | null, target: Target): string | null;
  /** The element list now, read without changing anything; null when it can't be read. */
  tree(): Promise<TreeResult | null>;
  /** The name of the place the app is on, or null when it isn't a known place. */
  place(): Promise<string | null>;
  /** A place's name from route names. */
  placeName(route: string[]): string;
  /** The chain of proven tap roads from one place to another, as steps; null when there is none (or a road isn't a tap, a long press or a toggle). */
  way(from: string, to: string): Step[] | null;
  /** Takes the app back to a place by a proven road; false when it can't. */
  returnTo(place: string): Promise<boolean>;
  /** A native `back`, through the checks of any touch; false when it was refused. */
  back(): Promise<boolean>;
  /** The elements a target matches in a list (the matching a touch uses). */
  match(target: Target, elements: TreeElement[]): TreeElement[];
  never: NeverContext;
  /** One line of kind `repair` in the audit log; false when it can't be written. */
  audit(detail: string): boolean;
  now(): number;
}

export interface Break {
  /** 0-based index in the steps given. */
  index: number;
  code: string;
  message: string;
}

/** The break a failed batch answer says: `Error <code>: Ran 3 of 7 steps; stopped at step 4 (...): <message>`. Null for any other answer. */
export function parseBreak(answer: CallToolResult): Break | null {
  const top = answer.content[0];
  if (answer.isError !== true || top === undefined || top.type !== "text") return null;
  const first = top.text.split("\n")[0] ?? "";
  const m = /^Error (\w+): Ran \d+ of \d+ steps; stopped at step (\d+) \(.*?\): (.*)$/.exec(first);
  if (m === null) return null;
  return { index: Number(m[2]) - 1, code: m[1] ?? "internal", message: m[3] ?? "" };
}

/** The first line of an answer. */
function firstLineOf(answer: CallToolResult): string {
  const top = answer.content[0];
  return top !== undefined && top.type === "text" ? (top.text.split("\n")[0] ?? "") : "";
}

export interface Candidate {
  kind: "target" | "road" | "scroll";
  /** For the suggestion: `tap id=login-button, button "Log in" on welcome`. */
  summary: string;
  score?: number;
  parts?: ReturnType<typeof scoreParts>;
  newTarget?: Target;
  /** A road's moves, before the step. */
  moves?: Step[];
  /** How the new element reads, and where. */
  shown: string;
  place?: string;
  why: string;
  /** A road put after the step (it ended on another place than it was recorded to), not before it. */
  after?: boolean;
}

export type Analysis =
  | { kind: "none"; reason: string }
  | { kind: "tie"; ranked: Candidate[]; reason: string }
  | { kind: "ok"; list: Candidate[] };

/** The check a step has after it: its own expect, or the target of the step after it (§26.4 1). */
function nextTargetOf(step: Step | undefined): Target | null {
  if (step === undefined) return null;
  const target = targetOf(step);
  if (target !== null && namedBy(target) !== null) return target;
  if (step.tool === "wait_for") {
    const p = step as Record<string, unknown>;
    if (p["gone"] === true) return null;
    if (typeof p["id"] === "string") return { id: p["id"] };
    if (typeof p["label"] === "string") return { label: p["label"] };
    if (typeof p["text"] === "string") return { text: p["text"] };
  }
  return null;
}

export const hasCheck = (steps: readonly Step[], at: number): boolean => steps[at]?.expect !== undefined || nextTargetOf(steps[at + 1]) !== null;

const subjectOf = (element: TreeElement): { label?: string; text?: string; testID?: string } => ({
  ...(element.label ? { label: element.label } : {}),
  ...(element.text ? { text: element.text } : {}),
  ...(element.testID ? { testID: element.testID } : {}),
});

/**
 * The candidates of one break, ranked, without touching anything (§26.1, §26.3). `none` says why the step isn't repaired; `tie`
 * that the best two scores are too close to tell apart.
 */
export async function analyse(host: RepairHost, steps: readonly Step[], at: number, brk: Break): Promise<Analysis> {
  const step = steps[at];
  if (step === undefined) return { kind: "none", reason: "there is no such step" };
  // A step that ran and ended on another place than it was recorded to (`route`): a new screen is in the way after it (§26.1).
  const never = neverRepaired(step, host.never);
  if (never !== null) return { kind: "none", reason: never };
  if (brk.code === "expect_failed" && /^its action ran, but it ended on /.test(brk.message)) {
    // The same acceptance rule as any repair: the step's expect, or the target of the step after it, must be there to check it.
    if (!hasCheck(steps, at)) return { kind: "none", reason: "the step has no check (an expect, or a target in the step after it), so a repair couldn't be checked" };
    return analyseEnd(host, step);
  }
  const offScreen = brk.code === "not_actionable" && /^off_screen\b/.test(brk.message);
  if (brk.code !== "not_found" && brk.code !== "ambiguous" && !offScreen) {
    return { kind: "none", reason: brk.code === "expect_failed" ? "an expect that fails is a finding, never a break to repair" : `a ${brk.code} failure is a finding, not a break to repair` };
  }
  if (!hasCheck(steps, at)) return { kind: "none", reason: "the step has no check (an expect, or a target in the step after it), so a repair couldn't be checked" };
  const target = targetOf(step);
  if (target === null) return { kind: "none", reason: "the step has no target" };
  const tree = await host.tree();
  if (tree === null) return { kind: "none", reason: "the screen couldn't be read" };
  const here = await host.place();
  const expected = expectedPlace(steps, at, host.placeName);

  // A new screen in the way: the step expected another place than the one the app is on.
  if (expected !== null && here !== null && expected !== here) {
    const moves = host.way(here, expected);
    if (moves === null || moves.length === 0) return { kind: "none", reason: `the step ran on ${here}, not on ${expected}, and no proven road leads there` };
    for (const move of moves) {
      const why = neverRepaired(move, host.never);
      if (why !== null) return { kind: "none", reason: `a road move to ${expected} can't be inserted: ${why}` };
    }
    const shown = moves.map((move) => `${move.tool} ${describeTarget(targetOf(move) ?? {})}`).join(", ");
    return {
      kind: "ok",
      list: [
        {
          kind: "road",
          summary: `insert ${shown} to reach ${expected}, then ${describeStep(step)}`,
          moves,
          shown: `before it: ${shown} (${here} to ${expected})`,
          place: expected,
          why: `the step ran on ${here}, not on ${expected}; the proven road ${here} to ${expected} was put in front of it.`,
        },
      ],
    };
  }

  // A toggle is repaired only to the role it had; the role comes from a passing run that recorded it, never from the candidate.
  let toggleRole: string | undefined;
  if (step.tool === "toggle") {
    const known = host.toggleRole(expected ?? here, target);
    if (known === null) return { kind: "none", reason: "the toggle's original role isn't recorded (no passing run saw it at this place), so a toggle is never repaired" };
    toggleRole = known;
  }
  const matching = host.match(target, tree.elements);
  const list: Candidate[] = [];
  const wantsScroll = offScreen || (brk.code === "not_found" && matching.length === 0 && (tree.offScreen?.below ?? 0) > 0);
  if (wantsScroll) {
    list.push({
      kind: "scroll",
      summary: `scroll down (up to ${MAX_SCROLLS} times) until ${describeTarget(target)} shows, then ${describeStep(step)}`,
      shown: `before it: scroll down toward ${describeTarget(target)}`,
      ...(here !== null ? { place: here } : {}),
      why: `${describeTarget(target)} ${offScreen ? "was off the screen" : "wasn't made yet"}; the list was scrolled down until it showed.`,
    });
  }
  let tied: Candidate[] | null = null;
  if (!offScreen) {
    const ranked = elementCandidates(host, step, target, brk, tree, matching, toggleRole);
    if (isNearTie(ranked)) tied = ranked.map((item) => toCandidate(item, step, target, brk, here, tree, host));
    else for (const item of ranked) list.push(toCandidate(item, step, target, brk, here, tree, host));
  }
  if (list.length === 0) {
    if (tied !== null) {
      return { kind: "tie", ranked: tied, reason: `the best two scores (${two(tied[0]?.score ?? 0)} and ${two(tied[1]?.score ?? 0)}) are less than 0.02 apart, so the tool can't tell them apart` };
    }
    return { kind: "none", reason: `nothing on the screen can take the step's ${step.tool} and looks like ${describeTarget(target)}` };
  }
  return { kind: "ok", list };
}

/** The way from where a step ended to where it was recorded to end, as moves to put after it. */
async function analyseEnd(host: RepairHost, step: Step): Promise<Analysis> {
  if (host.never.draftsOnly) return { kind: "none", reason: "a step in a drafts-only route is never repaired" };
  const route = (step as Record<string, unknown>)["route"];
  const expected = Array.isArray(route) && route.every((part) => typeof part === "string") ? host.placeName(route as string[]) : "";
  const here = await host.place();
  if (expected === "" || here === null || here === expected) return { kind: "none", reason: "the place the step ended on, or the place it was recorded to end on, isn't known" };
  const moves = host.way(here, expected);
  if (moves === null || moves.length === 0) return { kind: "none", reason: `the step ended on ${here}, not on ${expected}, and no proven road leads there` };
  for (const move of moves) {
    const why = neverRepaired(move, host.never);
    if (why !== null) return { kind: "none", reason: `a road move to ${expected} can't be inserted: ${why}` };
  }
  const shown = moves.map((move) => `${move.tool} ${describeTarget(targetOf(move) ?? {})}`).join(", ");
  return {
    kind: "ok",
    list: [
      {
        kind: "road",
        after: true,
        summary: `after it, insert ${shown} to reach ${expected}`,
        moves,
        shown: `after it: ${shown} (${here} to ${expected})`,
        place: expected,
        why: `the step ended on ${here}, not on ${expected}; the proven road ${here} to ${expected} was put after it.`,
      },
    ],
  };
}

function describeStep(step: Step): string {
  const target = targetOf(step);
  return `${step.tool}${target !== null ? ` ${describeTarget(target)}` : ""}`;
}

function elementCandidates(
  host: RepairHost,
  step: Step,
  target: Target,
  brk: Break,
  tree: TreeResult,
  matching: TreeElement[],
  toggleRole: string | undefined,
): Scored[] {
  const screen = screenOf(tree);
  const roles = new Set(matching.map((element) => element.role ?? ""));
  const old: OldElement = {
    ...(target.id !== undefined ? { id: target.id } : {}),
    ...(target.label !== undefined ? { label: target.label } : {}),
    ...(target.text !== undefined ? { text: target.text } : {}),
    // The old role is known from a recorded run (a toggle), else only when the ambiguous matches agree on one.
    ...(toggleRole !== undefined ? { role: toggleRole } : brk.code === "ambiguous" && roles.size === 1 && [...roles][0] ? { role: [...roles][0] as string } : {}),
  };
  const closest = new Set(closestRefs(brk.message));
  const pool = tree.elements.filter((element) => {
    if (!canTake(step.tool, element)) return false;
    if (toggleRole !== undefined && !sameToggleRole(element, toggleRole)) return false;
    if (targetFor(element) === null) return false;
    if (host.never.policyHit(subjectOf(element)) !== null) return false;
    if (brk.code === "ambiguous") return matching.includes(element);
    if (closest.has(element.ref)) return true;
    const stem = idStem(old.id, element.testID);
    const words = wordsPart(old, element);
    return (stem !== null && stem > 0) || (words !== null && words >= 0.5);
  });
  const scored = pool.map((element): Scored => {
    const parts = scoreParts(old, {
      id: element.testID,
      label: element.label,
      text: element.text,
      role: element.role,
      bucket: bucketOf(element, screen),
      component: element.type,
    });
    return { element, parts, score: weightedScore(parts) };
  });
  return rankScored(scored);
}

function toCandidate(item: Scored, step: Step, target: Target, brk: Break, here: string | null, tree: TreeResult, host: RepairHost): Candidate {
  const base = targetFor(item.element) as Target;
  // Several elements named the same way: the new target says which (§9.4's `index`).
  const same = host.match(base, tree.elements);
  const newTarget: Target = same.length > 1 ? { ...base, index: Math.max(0, same.indexOf(item.element)) } : base;
  const shown = describeElement(item.element, false);
  const cause = brk.code === "ambiguous" ? `${describeTarget(target)} matched more than one element` : `${describeTarget(target)} wasn't found`;
  return {
    kind: "target",
    summary: `${step.tool} ${describeElement(item.element)}${here !== null ? ` on ${here}` : ""}`,
    score: item.score,
    parts: item.parts,
    newTarget,
    shown,
    ...(here !== null ? { place: here } : {}),
    why: `${cause}; the closest element that can take a ${step.tool.replace("_", " ")} is ${describeTarget(newTarget)} (${formatParts(item.parts)}).`,
  };
}

/** The lines `suggest` adds after the usual failure text (§26.5). */
export function suggestionText(analysis: Analysis): string[] {
  if (analysis.kind === "none") return [`Repair (suggest): none. ${analysis.reason[0]?.toUpperCase() ?? ""}${analysis.reason.slice(1)}.`];
  if (analysis.kind === "tie") return [`Repair (suggest, not checked): ambiguous. ${analysis.reason[0]?.toUpperCase() ?? ""}${analysis.reason.slice(1)}.`, "To repair it by hand, give the element an id; no repair was tried."];
  const lines = ["Repair (suggest, not checked):"];
  analysis.list.slice(0, MAX_CANDIDATES).forEach((candidate, i) => {
    const score = candidate.score !== undefined && candidate.parts !== undefined ? `: score ${two(candidate.score)} (${formatParts(candidate.parts)})` : "";
    lines.push(`${i + 1}. ${candidate.summary}${score}. Why: ${candidate.why}`);
  });
  lines.push('To check it: replay with repair: "apply".');
  return lines;
}

// -- the run

interface WorkStep {
  step: Step;
  /** The index in the original steps; null for an inserted step. */
  origin: number | null;
  repaired?: { was?: Target | null; score?: number; inserted?: true; routeMoved?: true };
}

export interface RepairRun {
  ok: boolean;
  /** On a pass: the last batch's answer. On a failure: the failing answer, numbered by the steps as repaired so far. */
  answer: CallToolResult;
  repairs: RepairRecord[];
  work: ReadonlyArray<WorkStep>;
  seconds: number;
  /** The failure that ended the run, when it did not pass. */
  failure?: { step: number; code: string; message: string; tool: string };
  /** The first line of a failure, with a note that says why a repair wasn't (or couldn't be) made. */
  notes: string[];
}

const oneLine = (text: string, max = 120): string => {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** The failing answer's first line, renumbered: `Ran 3 of 7`, `step 4` as they stand in the steps now. */
function renumbered(answer: CallToolResult, offset: number, total: number): CallToolResult {
  const top = answer.content[0];
  if (top === undefined || top.type !== "text") return answer;
  const [first = "", ...rest] = top.text.split("\n");
  const fixed = first.replace(/^(Error \w+: Ran )(\d+)( of )(\d+)( steps; stopped at step )(\d+)/, (_all, a: string, ran: string, b: string, _n: string, c: string, step: string) => `${a}${Number(ran) + offset}${b}${total}${c}${Number(step) + offset}`);
  return { ...answer, content: [{ type: "text", text: [fixed, ...rest].join("\n") }, ...answer.content.slice(1)] };
}

/** Runs the steps and repairs the first breaks it can check (§26.4): up to 3 candidates a step, up to 5 repairs a script. */
export async function runWithRepair(host: RepairHost, steps: Step[], options: { look?: boolean } = {}): Promise<RepairRun> {
  void options;
  const started = host.now();
  const work: WorkStep[] = steps.map((step, origin) => ({ step, origin }));
  const repairs: RepairRecord[] = [];
  const accepted: Array<{ phrase: string; step: number }> = [];
  const notes: string[] = [];
  let from = 0;

  const finish = (answer: CallToolResult, ok: boolean, failure?: RepairRun["failure"]): RepairRun => ({
    ok,
    answer,
    repairs,
    work,
    seconds: (host.now() - started) / 1000,
    notes,
    ...(failure !== undefined ? { failure } : {}),
  });

  const failWith = (answer: CallToolResult, brk: Break | null, offset: number): RepairRun => {
    // Repairs that were accepted, then the run failed: they weren't kept (§26.5), and the log says so.
    for (const done of accepted) host.audit(`step ${done.step}: ${done.phrase}, rejected (the run failed at step ${brk !== null ? brk.index + offset + 1 : "?"})`);
    if (repairs.length > 0) {
      notes.push(`Note: ${repairs.length} repair${repairs.length === 1 ? " was" : "s were"} made before it stopped; nothing was written.`);
    }
    const shown = renumbered(answer, offset, work.length);
    const step = brk === null ? undefined : work[brk.index + offset]?.step;
    return finish(shown, false, brk !== null && step !== undefined ? { step: brk.index + offset + 1, code: brk.code, message: brk.message, tool: step.tool } : undefined);
  };

  for (;;) {
    const suffix = work.slice(from).map((item) => item.step);
    const answer = await host.runSteps(suffix);
    if (answer.isError !== true) return finish(answer, true);
    const brk = parseBreak(answer);
    if (brk === null) return failWith(answer, null, from);
    const absolute: Break = { ...brk, index: brk.index + from };
    const all = work.map((item) => item.step);
    if (repairs.length >= MAX_REPAIRS) {
      notes.push(`Note: ${MAX_REPAIRS} repairs were made and the script still breaks; more than ${MAX_REPAIRS} breaks are left to a person.`);
      return failWith(answer, brk, from);
    }
    const analysis = await analyse(host, all, absolute.index, absolute);
    if (analysis.kind !== "ok") {
      notes.push(`Repair: none. ${analysis.reason[0]?.toUpperCase() ?? ""}${analysis.reason.slice(1)}.`);
      return failWith(answer, brk, from);
    }
    const step = all[absolute.index] as Step;
    const startPlace = await host.place();
    const startScreen = screenKey(await host.tree());
    let made = false;
    for (const candidate of analysis.list.slice(0, MAX_CANDIDATES)) {
      const tried = await tryCandidate(host, work, absolute.index, candidate);
      const stepNumber = (work[absolute.index]?.origin ?? absolute.index) + 1;
      const record: RepairRecord = {
        step: stepNumber,
        tool: step.tool,
        kind: candidate.kind,
        was: targetOf(step),
        now: candidate.newTarget ?? null,
        inserted: tried.inserted,
        ...(candidate.score !== undefined ? { score: candidate.score } : {}),
        ...(candidate.parts !== undefined ? { parts: candidate.parts } : {}),
        ...(candidate.place !== undefined ? { place: candidate.place } : {}),
        shown: candidate.kind === "scroll" && tried.ok ? `before it: scroll down ${tried.inserted.length} time${tried.inserted.length === 1 ? "" : "s"}` : candidate.shown,
        why: candidate.why,
        accepted: tried.ok ? tried.accepted : "",
      };
      const phrase = repairPhrase(record);
      if (!tried.ok) {
        host.audit(`step ${stepNumber}: ${phrase}, rejected (${tried.why})`);
        // A rejected trial may have moved the app: back to the place the step started on, or the repair stops (§26.4).
        if (!(await backAtStart(host, startPlace, startScreen))) {
          notes.push(`Note: a repair was tried and rejected, and the app couldn't be taken back to where the step started${startPlace !== null ? ` (${startPlace})` : ""}; the repair stopped.`);
          return failWith(answer, brk, from);
        }
        continue;
      }
      // The line is written before the repair counts: when it can't be, the repair isn't made.
      if (!host.audit(`step ${stepNumber}: ${phrase}, accepted`)) {
        notes.push("Note: the audit log couldn't be written, so no repair was made.");
        return failWith(answer, brk, from);
      }
      accepted.push({ phrase, step: stepNumber });
      repairs.push(record);
      made = true;
      from = tried.next;
      break;
    }
    if (!made) {
      notes.push(`Repair: ${analysis.list.length > MAX_CANDIDATES ? `the first ${MAX_CANDIDATES} candidates were` : analysis.list.length === 1 ? "the candidate was" : "the candidates were"} tried and none passed the check.`);
      return failWith(answer, brk, from);
    }
  }
}

/** The screen as its route names, or "" when the app has no router or the list couldn't be read. */
const screenKey = (tree: TreeResult | null): string => tree?.route?.names.join("/") ?? "";

/** After a rejected trial: back at the place the step started on (a proven road, else `back`). True when the app is there, or never left. */
async function backAtStart(host: RepairHost, startPlace: string | null, startScreen: string): Promise<boolean> {
  const moved = async (): Promise<boolean> => {
    const now = await host.place();
    if (startPlace !== null && now !== null) return now !== startPlace;
    // A start screen that was never known can't be verified: that counts as moved, so the way back is tried and the repair stops when it still can't be told.
    return startScreen === "" || screenKey(await host.tree()) !== startScreen;
  };
  if (!(await moved())) return true;
  if (startPlace !== null && (await host.returnTo(startPlace)) && !(await moved())) return true;
  if ((await host.back()) && !(await moved())) return true;
  return false;
}

type Tried = { ok: true; accepted: string; inserted: Step[]; next: number } | { ok: false; why: string; inserted: Step[] };

/** Runs one candidate for the step at `at` and checks it (§26.4 1). On a pass it changes `work` to hold it. */
async function tryCandidate(host: RepairHost, work: WorkStep[], at: number, candidate: Candidate): Promise<Tried> {
  const original = work[at] as WorkStep;
  const all = work.map((item) => item.step);
  let before: Step[] = [];
  let step: Step = original.step;
  let was: Target | null = null;
  if (candidate.kind === "target" && candidate.newTarget !== undefined) {
    was = targetOf(original.step);
    step = { ...original.step, target: candidate.newTarget } as Step;
  } else if (candidate.kind === "road" && candidate.after === true) {
    // The step ran and ended elsewhere: the moves go after it, and the check is that the app is where the recording ended.
    const moves = candidate.moves ?? [];
    const moved = await host.trial(moves);
    if (moved.isError === true) return { ok: false, why: oneLine(parseBreak(moved)?.message ?? firstLineOf(moved)), inserted: [] };
    const now = await host.place();
    if (candidate.place === undefined || now !== candidate.place) return { ok: false, why: `the app is on ${now ?? "an unknown place"}, not on ${candidate.place ?? "the place the recording ended on"}`, inserted: [] };
    // The same acceptance rule as any repair: the step's expect held (the batch checked it before the route), or the next step's target resolves now.
    const checked = await acceptance(host, original.step, all[at + 1], moves);
    if (!checked.ok) return checked;
    // The recording's route check moves behind the inserted navigation: it says where the script ends up, and it runs there when the script is replayed.
    const { route, ...bare } = original.step as Step & { route?: unknown };
    const placed: WorkStep[] = moves.map((item, i) => ({ step: i === moves.length - 1 && route !== undefined ? ({ ...item, route } as Step) : item, origin: null, repaired: { inserted: true } }));
    work.splice(at, 1, { ...original, step: bare as Step, ...(route !== undefined ? { repaired: { ...original.repaired, routeMoved: true as const } } : {}) }, ...placed);
    return { ok: true, accepted: `${checked.accepted.replace(/, and the whole run passed\.$/, "")}, the app was on ${candidate.place} where the recording ended, and the whole run passed.`, inserted: moves, next: at + 1 + placed.length };
  } else if (candidate.kind === "road") {
    before = candidate.moves ?? [];
  } else if (candidate.kind === "scroll") {
    const target = targetOf(original.step) as Target;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const tree = await host.tree();
      if (tree !== null && host.match(target, tree.elements).length > 0) break;
      const scrolled = await host.trial([{ tool: "scroll", direction: "down" } as Step]);
      if (scrolled.isError === true) return { ok: false, why: oneLine(firstLineOf(scrolled)), inserted: before };
      before.push({ tool: "scroll", direction: "down" } as Step);
    }
    const tree = await host.tree();
    const found = tree === null ? 0 : host.match(target, tree.elements).length;
    if (found !== 1) return { ok: false, why: found === 0 ? `${describeTarget(target)} didn't show after ${MAX_SCROLLS} scrolls` : `${describeTarget(target)} matched ${found} elements after scrolling`, inserted: before };
  }
  const trial = [...(candidate.kind === "road" ? before : []), step];
  const answer = await host.trial(trial);
  if (answer.isError === true) return { ok: false, why: oneLine(parseBreak(answer)?.message ?? firstLineOf(answer)), inserted: before };
  const checked = await acceptance(host, original.step, all[at + 1], before);
  if (!checked.ok) return checked;
  const accepted = checked.accepted;
  const inserted: WorkStep[] = before.map((item) => ({ step: item, origin: null, repaired: { inserted: true } }));
  const changed: WorkStep =
    candidate.kind === "target"
      ? { step, origin: original.origin, repaired: { was, ...(candidate.score !== undefined ? { score: candidate.score } : {}) } }
      : original;
  work.splice(at, 1, ...inserted, changed);
  return { ok: true, accepted, inserted: before, next: at + inserted.length + 1 };
}

/** The one acceptance rule (§26.4 1): the step's expect held (the batch checked it), or the next step's target resolves to exactly one element. */
async function acceptance(host: RepairHost, step: Step, following: Step | undefined, inserted: Step[]): Promise<{ ok: true; accepted: string } | { ok: false; why: string; inserted: Step[] }> {
  if (step.expect !== undefined) return { ok: true, accepted: `the step's expect ${describeExpect(step.expect)} held, and the whole run passed.` };
  const next = nextTargetOf(following);
  if (next === null) return { ok: false, why: "no check: the step has no expect and no target follows it", inserted };
  const tree = await host.tree();
  const found = tree === null ? 0 : host.match(next, tree.elements).length;
  if (found !== 1) return { ok: false, why: `the next step's target ${describeTarget(next)} ${found === 0 ? "isn't on the screen" : `matches ${found} elements`}`, inserted };
  return { ok: true, accepted: `the next step's target (${describeTarget(next)}) resolved to one element, and the whole run passed.` };
}

function describeExpect(expect: NonNullable<Step["expect"]>): string {
  if (expect.text !== undefined) return `(text ${JSON.stringify(expect.text)})`;
  if (expect.id !== undefined) return `(id ${JSON.stringify(expect.id)})`;
  if (expect.label !== undefined) return `(label ${JSON.stringify(expect.label)})`;
  if (expect.matches !== undefined) return `(matches ${JSON.stringify(expect.matches)})`;
  return "";
}
