import type { TreeElement } from "./protocol.js";
import type { Step } from "./run.js";
import { BUCKET_COLUMNS, BUCKET_ROWS, positionBucket, type Screen } from "./signature.js";

// Self-repairing tests (AGENT-TOOLS 1.15 §26), the pure part: what may be repaired, the score that orders candidates, the
// files a repair writes. The run that tries candidates is in repairrun.ts.

/** The most candidates tried for one step, and the most repairs in one script (§26.4). */
export const MAX_CANDIDATES = 3;
export const MAX_REPAIRS = 5;
/** A scroll candidate scrolls down at most this many times, stopping when the target appears (§26.1). */
export const MAX_SCROLLS = 5;
/** If the best two scores are closer than this, the tool can't tell them apart and doesn't repair (§26.3). */
export const NEAR_TIE = 0.02;

/** The tools a step may have to be repaired, and only with a `target` (§26.1). */
export const REPAIRABLE_TOOLS: readonly string[] = ["tap", "long_press", "toggle", "scroll"];

export type PartName = "role" | "id_stem" | "words" | "position" | "component";
export const PART_NAMES: readonly PartName[] = ["role", "id_stem", "words", "position", "component"];

/**
 * Tapline's own weights (§26.3: each tool chooses its own). The names and what they measure are shared; these numbers are
 * Tapline's. The ids and the words carry most, since a rename is what usually breaks a test; the position and the component are
 * hints. A weight is positive; a part that is missing on one side is left out of both sums.
 */
export const REPAIR_WEIGHTS: Readonly<Record<PartName, number>> = {
  role: 0.15,
  id_stem: 0.35,
  words: 0.35,
  position: 0.1,
  component: 0.05,
};

export type Parts = Partial<Record<PartName, number>>;

/** What a step's target says of the element it meant. Tapline's script keeps the id, label or text; the rest is learned when known. */
export interface OldElement {
  id?: string | undefined;
  label?: string | undefined;
  text?: string | undefined;
  role?: string | undefined;
  bucket?: string | undefined;
  component?: string | undefined;
}

export interface NewElement {
  id?: string | null | undefined;
  label?: string | null | undefined;
  text?: string | null | undefined;
  role?: string | null | undefined;
  bucket?: string | null | undefined;
  component?: string | null | undefined;
}

const filled = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";

// -- the parts

/** An id as lower-case words: split on `-`, `_`, spaces and case changes. */
export function idWords(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_\s.]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

/** Equal, or the shorter has at least 3 characters and its letters appear in order in the longer, with the same first letter (`btn`, `button`). */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3 || short[0] !== long[0]) return false;
  let at = 0;
  for (const letter of long) {
    if (letter === short[at]) at++;
    if (at === short.length) return true;
  }
  return false;
}

/** The ids compared word by word: matching words over the larger word count. Null when either has no id. */
export function idStem(a: string | undefined | null, b: string | undefined | null): number | null {
  if (!filled(a) || !filled(b)) return null;
  const left = idWords(a);
  const right = idWords(b);
  const larger = Math.max(left.length, right.length);
  if (larger === 0) return null;
  const used = new Set<number>();
  let matching = 0;
  for (const word of left) {
    const at = right.findIndex((other, index) => !used.has(index) && wordsMatch(word, other));
    if (at >= 0) {
      used.add(at);
      matching++;
    }
  }
  return matching / larger;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

/** 1 minus the edit distance over the longer length, on lower-cased, trimmed text. */
export function editSimilarity(a: string, b: string): number {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  const longer = Math.max(left.length, right.length);
  return longer === 0 ? 1 : 1 - editDistance(left, right) / longer;
}

/** The best of label with label, text with text, and a label with a text. Null when the old element has neither a label nor a text. */
export function wordsPart(old: Pick<OldElement, "label" | "text">, now: Pick<NewElement, "label" | "text">): number | null {
  const olds = [old.label, old.text].filter(filled);
  const news = [now.label, now.text].filter(filled);
  if (olds.length === 0 || news.length === 0) return null;
  let best = 0;
  for (const a of olds) for (const b of news) best = Math.max(best, editSimilarity(a, b));
  return best;
}

/** `c<col>r<row>` as numbers. */
function bucketCell(bucket: string): { col: number; row: number } | null {
  const m = /^c(\d+)r(\d+)$/.exec(bucket);
  return m === null ? null : { col: Number(m[1]), row: Number(m[2]) };
}

/** 1 for the same bucket, 0.5 for a neighbouring one (diagonals too), else 0. Null when a side has none. */
export function positionPart(a: string | undefined | null, b: string | undefined | null): number | null {
  if (!filled(a) || !filled(b)) return null;
  const left = bucketCell(a);
  const right = bucketCell(b);
  if (left === null || right === null) return null;
  const apart = Math.max(Math.abs(left.col - right.col), Math.abs(left.row - right.row));
  return apart === 0 ? 1 : apart === 1 ? 0.5 : 0;
}

export const GRID = { columns: BUCKET_COLUMNS, rows: BUCKET_ROWS } as const;

/** The parts that exist on both sides. */
export function scoreParts(old: OldElement, now: NewElement): Parts {
  const parts: Parts = {};
  if (filled(old.role) && filled(now.role)) parts.role = old.role === now.role ? 1 : 0;
  const stem = idStem(old.id, now.id);
  if (stem !== null) parts.id_stem = stem;
  const words = wordsPart(old, now);
  if (words !== null) parts.words = words;
  const position = positionPart(old.bucket, now.bucket);
  if (position !== null) parts.position = position;
  if (filled(old.component) && filled(now.component)) parts.component = old.component === now.component ? 1 : 0;
  return parts;
}

/** The weighted mean of the parts that exist: sum of weight times part, over the sum of those weights. 0 when no part exists. */
export function weightedScore(parts: Parts): number {
  let sum = 0;
  let weights = 0;
  for (const name of PART_NAMES) {
    const part = parts[name];
    if (part === undefined) continue;
    sum += REPAIR_WEIGHTS[name] * part;
    weights += REPAIR_WEIGHTS[name];
  }
  return weights === 0 ? 0 : sum / weights;
}

export const two = (value: number): string => value.toFixed(2);

/** `role 1.00, id_stem 0.85, words 1.00` in the order of the parts. */
export function formatParts(parts: Parts): string {
  return PART_NAMES.filter((name) => parts[name] !== undefined)
    .map((name) => `${name} ${two(parts[name] ?? 0)}`)
    .join(", ");
}

/** Reading order: top to bottom, then left to right. Elements with no frame go last, in their given order. */
export function readingOrder(a: Pick<TreeElement, "frame">, b: Pick<TreeElement, "frame">): number {
  const fa = a.frame;
  const fb = b.frame;
  if (!fa && !fb) return 0;
  if (!fa) return 1;
  if (!fb) return -1;
  return fa.y - fb.y || fa.x - fb.x;
}

export interface Scored {
  element: TreeElement;
  score: number;
  parts: Parts;
}

/** Candidates in score order, equal scores in reading order. */
export function rankScored(items: Scored[]): Scored[] {
  return [...items].sort((a, b) => b.score - a.score || readingOrder(a.element, b.element));
}

/** True when the best two scores are less than 0.02 apart (so there is no repair). Needs at least two. */
export function isNearTie(ranked: ReadonlyArray<{ score: number }>): boolean {
  const first = ranked[0];
  const second = ranked[1];
  return first !== undefined && second !== undefined && first.score - second.score < NEAR_TIE - 1e-9;
}

// -- what can take a step's action

const TAP_ROLES = new Set(["button", "tab", "link", "menuitem", "checkbox", "radio", "switch", "imagebutton"]);
const TOGGLE_ROLES = new Set(["switch", "checkbox"]);

/** The elements that can take the step's action (§3.3): by their listed actions, or the ones their role implies. */
export function canTake(tool: string, element: TreeElement): boolean {
  if (element.disabled === true) return false;
  const actions = element.actions ?? [];
  const role = (element.role ?? "").toLowerCase();
  switch (tool) {
    case "tap":
      return actions.includes("press") || TAP_ROLES.has(role);
    case "long_press":
      return actions.includes("longPress") || actions.includes("press") || TAP_ROLES.has(role);
    case "toggle":
      return actions.includes("toggle") || TOGGLE_ROLES.has(role);
    case "scroll":
      return actions.includes("scroll") || role === "scroll";
    default:
      return false;
  }
}

/** A toggle is repaired only to an element of the same kind: one that toggles. */
export function sameToggleKind(element: TreeElement): boolean {
  return (element.actions ?? []).includes("toggle") || TOGGLE_ROLES.has((element.role ?? "").toLowerCase());
}

// -- targets

export interface Target {
  id?: string;
  label?: string;
  text?: string;
  index?: number;
  row?: true;
  x?: number;
  y?: number;
  ref?: string;
}

/** A step's `target` as an object, or null. */
export function targetOf(step: Step): Target | null {
  const target = (step as Record<string, unknown>)["target"];
  return typeof target === "object" && target !== null && !Array.isArray(target) ? (target as Target) : null;
}

/** The words a target names (id, label or text), or null when it has none (a point, a row by index). */
export function namedBy(target: Target): "id" | "label" | "text" | null {
  if (filled(target.id)) return "id";
  if (filled(target.label)) return "label";
  if (filled(target.text)) return "text";
  return null;
}

/** `id=login-btn`, `"Log in"` (a label or a text). */
export function describeTarget(target: Target): string {
  const named = namedBy(target);
  if (named === "id") return `id=${target.id}`;
  if (named === "label") return JSON.stringify(target.label);
  if (named === "text") return JSON.stringify(target.text);
  return target.row === true ? "row" : "target";
}

/** The target a script step would use for an element: id, else label, else text; a row only by its id (§18.2). Null when it has none. */
export function targetFor(element: TreeElement): Target | null {
  if (filled(element.testID)) return { id: element.testID };
  if (element.row === true) return null;
  if (filled(element.label)) return { label: element.label };
  if (filled(element.text)) return { text: element.text };
  return null;
}

/** How a tool names a step's target on the wire: `id` is `testID` there. */
export function wireTarget(target: Target): Record<string, unknown> {
  const { id, ...rest } = target;
  return id !== undefined ? { testID: id, ...rest } : { ...rest };
}

// -- what is never repaired (§26.2)

/** A subject the policy words are matched against: the element's own label and text, or its id's words for an icon. */
export interface PolicyCheck {
  (subject: { label?: string; text?: string; testID?: string }): string | null;
}

/** The native Back: the navigation bar's back button is named Back (by label or text), or by an id that says only back. */
export function isNativeBack(target: Target): boolean {
  const said = [target.label, target.text].filter(filled).map((word) => word.trim().toLowerCase());
  if (said.includes("back")) return true;
  if (!filled(target.id)) return false;
  const words = idWords(target.id);
  const filler = new Set(["header", "nav", "navigation", "bar", "button", "btn", "left", "arrow", "native"]);
  return words.includes("back") && words.every((word) => word === "back" || filler.has(word));
}

/** True when the step holds a typed value, an account, a vault or a one-time-code reference (§18.6, §20.1). */
export function carriesSecret(step: Step): boolean {
  const reference = /\$\{\s*(account|vault|otp)\b/i;
  const scan = (value: unknown): boolean => {
    if (typeof value === "string") return reference.test(value);
    if (Array.isArray(value)) return value.some(scan);
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).some(([name, inner]) => name === "account" || name === "vault" || name === "otp" || scan(inner));
    }
    return false;
  };
  const { tool: _tool, expect: _expect, ...rest } = step;
  return scan(rest);
}

export interface NeverContext {
  /** A route marked `draftsOnly` (§21.3). */
  draftsOnly: boolean;
  /** The policy word an element carries (the floor included), or null. */
  policyHit: PolicyCheck;
}

/** Why a step is never repaired, or null when it may be (§26.1, §26.2). The reason is one short clause for the answer. */
export function neverRepaired(step: Step, context: NeverContext): string | null {
  if (context.draftsOnly) return "a step in a drafts-only route is never repaired";
  if (step.tool === "type_text") return "a type_text step is never repaired";
  if (step.tool === "back") return "a native Back is never repaired";
  if (!REPAIRABLE_TOOLS.includes(step.tool)) return `a ${step.tool} step is never repaired`;
  if (carriesSecret(step)) return "a step with a typed value, an account or a vault reference is never repaired";
  const target = targetOf(step);
  if (target === null || namedBy(target) === null) return "a step without a target by id, label or text is never repaired";
  if (isNativeBack(target)) return "a native Back is never repaired";
  const hit = context.policyHit({
    ...(filled(target.label) ? { label: target.label } : {}),
    ...(filled(target.text) ? { text: target.text } : {}),
    ...(filled(target.id) ? { testID: target.id } : {}),
  });
  if (hit !== null) return `its target carries the policy word "${hit}", so it is never repaired`;
  return null;
}

// -- where a step ran

/** The place a step expected: its own `place`, else (Tapline) the route of the step before it, as a place name. */
export function expectedPlace(steps: readonly Step[], at: number, nameOfRoute: (route: string[]) => string): string | null {
  const own = (steps[at] as Record<string, unknown> | undefined)?.["place"];
  if (typeof own === "string" && own !== "") return own;
  if (at === 0) return null;
  const route = (steps[at - 1] as Record<string, unknown> | undefined)?.["route"];
  if (Array.isArray(route) && route.length > 0 && route.every((part) => typeof part === "string")) {
    const name = nameOfRoute(route as string[]);
    return name === "" ? null : name;
  }
  return null;
}

// -- the screen

export function screenOf(tree: { screen?: { width: number; height: number } | null | undefined }): Screen | null {
  return tree.screen ?? null;
}

/** An element's position bucket on a screen, or null. */
export function bucketOf(element: TreeElement, screen: Screen | null): string | null {
  return element.frame ? positionBucket(element.frame, screen) : null;
}

/** `ids` from a `Closest:` part of an answer: the refs it names (`e12`). */
export function closestRefs(message: string): string[] {
  const at = message.indexOf("Closest:");
  if (at < 0) return [];
  return [...message.slice(at).matchAll(/\be(\d+)\b/g)].map((m) => `e${m[1] ?? ""}`);
}

// -- the answer's words

/** One short line for an element, as the suggestion shows it: `id=login-button, button "Log in"`. A row shows only its id (its text is content). */
export function describeElement(element: TreeElement, withId = true): string {
  const parts: string[] = [];
  if (withId && filled(element.testID)) parts.push(`id=${element.testID}`);
  if (element.row !== true) {
    const words = filled(element.text) ? element.text : filled(element.label) ? element.label : null;
    const role = filled(element.role) ? element.role : "element";
    if (words !== null) parts.push(`${role} ${JSON.stringify(words.length > 40 ? `${words.slice(0, 40)}…` : words)}`);
    else if (parts.length === 0) parts.push(role);
  } else if (parts.length === 0) {
    parts.push("row");
  }
  return parts.join(", ");
}

// -- the files (§26.6)

export interface RepairRecord {
  /** 1-based step number in the original script; for an inserted run, the step it was put in front of. */
  step: number;
  tool: string;
  kind: "target" | "road" | "scroll";
  was: Target | null;
  now: Target | null;
  /** Inserted steps (a road's moves, or the scrolls), as they run. */
  inserted: Step[];
  score?: number;
  parts?: Parts;
  place?: string;
  /** How the new element reads (`button "Log in"`), or the road's end. */
  shown: string;
  why: string;
  accepted: string;
}

/** The repaired script: the original's own object with the repairs applied, plus the `repaired` keys (§26.6). */
export function repairedScript(
  original: Record<string, unknown>,
  work: ReadonlyArray<{ origin: number | null; step: Step; repaired?: { was?: Target | null; score?: number; inserted?: true } }>,
  info: { from: string; at: string; build: string; count: number },
): Record<string, unknown> {
  const rawSteps = Array.isArray(original["steps"]) ? (original["steps"] as Array<Record<string, unknown>>) : [];
  const steps = work.map((item) => {
    if (item.origin === null) return { ...item.step, repaired: { inserted: true } };
    const raw = rawSteps[item.origin] ?? item.step;
    if (item.repaired?.was === undefined && item.repaired?.score === undefined) return raw;
    const target = (item.step as Record<string, unknown>)["target"];
    return {
      ...raw,
      ...(target !== undefined ? { target } : {}),
      repaired: { ...(item.repaired.was !== undefined && item.repaired.was !== null ? { was: item.repaired.was } : {}), ...(item.repaired.score !== undefined ? { score: Number(item.repaired.score.toFixed(2)) } : {}) },
    };
  });
  return { ...original, steps, repaired: { from: info.from, at: info.at, tool: "tapline", build: info.build, count: info.count } };
}

/** `sign_in.repair.md`: for each repair, the step, the old target, the new one, why and the evidence. No typed text, no value (§20.3). */
export function repairMarkdown(script: string, header: { date: string; version: string; build: string }, records: readonly RepairRecord[]): string {
  const lines = [`# Repairs for ${script} (${header.date}, tapline ${header.version}, build ${header.build})`, ""];
  records.forEach((record, i) => {
    const was = record.was === null ? "" : describeTarget(record.was);
    const now = record.now === null ? "" : describeTarget(record.now);
    const where = record.place !== undefined ? `, place ${record.place}` : "";
    if (record.kind === "target") {
      lines.push(`${i + 1}. Step ${record.step} (${record.tool}). Was ${was}; now ${now} (${record.shown}${where}).`);
    } else {
      lines.push(`${i + 1}. Step ${record.step} (${record.tool}). Inserted ${record.shown}${where}.`);
    }
    lines.push(`   - Why: ${record.why}`);
    if (record.score !== undefined && record.parts !== undefined) lines.push(`   - Score ${two(record.score)}: ${formatParts(record.parts)}.`);
    lines.push(`   - Accepted: ${record.accepted}`);
  });
  return `${lines.join("\n")}\n`;
}

/** `tap id=login-btn to id=login-button (score 0.93)`, for the answer's `Repaired:` line and the audit detail. */
export function repairPhrase(record: RepairRecord): string {
  if (record.kind === "target" && record.was !== null && record.now !== null) {
    return `${record.tool} ${describeTarget(record.was)} to ${describeTarget(record.now)}${record.score !== undefined ? ` (score ${two(record.score)})` : ""}`;
  }
  return `${record.tool} ${record.was === null ? "" : describeTarget(record.was)}, ${record.shown}`.replace(/ ,/, ",");
}
