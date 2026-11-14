import type { ExploreReport, ResetEntry, RunFolder, SkippedEntry, StopReason } from "./explorereport.js";
import { isoSeconds } from "./explorereport.js";
import { HOST_VERSION } from "./version.js";
import {
  floorVerdict,
  recipientVerdict,
  isListedSubmit,
  isSecretField,
  protectedPlaceWord,
  screenTitles,
  submitWord,
  type FloorHit,
  type FloorRules,
} from "./explorefloor.js";
import {
  A11Y_LINES_MAX,
  CRASH_FRAMES_MAX,
  FindingBook,
  LOG_LINES_MAX,
  LOG_LINE_MAX,
  TYPED,
  cutText,
  redactFinding,
  reproScript,
  type Finding,
  type FindingDraft,
  type FindingKind,
  type PathStep,
} from "./findings.js";
import { roleOf } from "./format.js";
import type { MapRoad, SkipWhy } from "./mapfile.js";
import { cheapestWay, isRouteLeg } from "./mapcmd.js";
import { placeNameFromRoute, samePlace, type AppMap, type KnownPlaces } from "./places.js";
import type { LogEntry, TreeElement, TreeResult } from "./protocol.js";
import type { CrashRecord } from "./server.js";
import { signaturesOf, type NamedElement } from "./signature.js";

// `explore` (AGENT-TOOLS 1.15 §25): a deterministic search over the (place, action) pairs nobody has tried. It needs no model.
// This file is the search; what it may touch is explorefloor.ts, what it finds is findings.ts, and the host (tools.ts) gives it
// the moves, which all go through the ordinary action path.

/** The tool version a finding and a report carry (§27.1, §25.10): the host's own package version (1.8.0 is the first to explore). */
export const EXPLORE_TOOL_VERSION: string = HOST_VERSION;

export const EXPLORE_DEFAULTS = { minutes: 10, steps: 500, depth: 8, fill: "none" as "none" | "test-data", continue: false };
export const EXPLORE_LIMITS = { minutes: [1, 60], steps: [1, 5000], depth: [1, 20] } as const;

/** The rows of a list the explorer tries (§25.4 item 3). */
export const ROWS_TRIED = 2;
/** How many times it scrolls a place down to reveal what is below (§25.4 item 2). */
export const SCROLLS_MAX = 5;
/** More than this many ms to settle after a move is a `slow` finding (§25.10). */
export const SLOW_MS = 3000;
/** Resets in a row that bring the app to no known place before the run stops (§25.8). */
export const RESETS_IN_A_ROW = 3;
/** Progress is told once every this many steps (§25.2). */
export const PROGRESS_EVERY = 10;
/** A place's visit is cut after this many rounds (a screen that keeps changing by itself must not hold the run). */
const MAX_ROUNDS = 2000;

export interface ExploreArgs {
  minutes: number;
  steps: number;
  depth: number;
  from?: string | undefined;
  focus?: string | undefined;
  fill: "none" | "test-data";
  continue: boolean;
  account?: string | undefined;
}

/** A target as the tools take it. A ref is only for an element with no name and is never kept. */
export type TargetArg = { id: string; index?: number } | { label: string; index?: number } | { text: string; index?: number } | { ref: string };

export type ExploreMove =
  | { tool: "tap"; target: TargetArg }
  | { tool: "toggle"; target: TargetArg; value?: boolean }
  | { tool: "scroll"; direction?: "down" | "up"; to?: "start" }
  | { tool: "back" }
  | { tool: "type"; target: TargetArg; text: string };

export type MoveOutcome =
  | { ok: true; used: number; settledMs?: number; value?: unknown; text: string }
  | { ok: false; used: number; code: string; message: string; text: string };

export interface ExploreInfo {
  app: string;
  name: string;
  appVersion: string;
  /** `CFBundleVersion`. */
  build: string;
  /** The build as a road remembers it, `1.5.0 (220)`. */
  buildLabel: string;
  device: { model: string; os: string };
}

/** What happened since a mark: the crash (with the JS error that ended the app), a bare disconnect, and the error lines. */
export interface Since {
  crash: CrashRecord | null;
  disconnected: boolean;
  errors: LogEntry[];
}

/** What the engine needs from the host: reads, and moves that all go through the ordinary action path. */
export interface ExploreHost {
  now(): number;
  /** Milliseconds the run has spent waiting for a person (not counted toward `minutes`, §25.9). */
  waitedMs(): number;
  wall(): Date;
  info(): ExploreInfo | null;
  map: AppMap;
  known(): Promise<KnownPlaces>;
  /** A fresh element list, or null when the app is gone. */
  tree(): Promise<TreeResult | null>;
  mark(): unknown;
  since(mark: unknown): Since;
  move(move: ExploreMove): Promise<MoveOutcome>;
  go(place: string, by: "taps" | "link" | "any", account?: string): Promise<{ ok: boolean; used: number; text: string }>;
  reload(): Promise<{ ok: boolean; used: number; text: string }>;
  commands(): Promise<string[]>;
  runCommand(name: string): Promise<{ ok: boolean; used: number; text: string }>;
  audit(): Promise<string[] | null>;
  ux(): Promise<string[] | null>;
  picture(): Promise<Uint8Array | null>;
  frontState(): "front" | "background" | "gone";
  waitForApp(ms: number): Promise<boolean>;
  redact(text: string): string;
  progress(line: string, steps: number): void;
  /** The call was cancelled by its client: the run stops between moves and writes its report. */
  cancelled(): boolean;
  rules: FloorRules;
  /** A vault entry the explorer may type from: marked `"explore": true`, its kind, and whether `field` may be typed (§25.6). */
  vaultFill(entry: string, field: string): "ok" | "no";
}

export interface ExploreOptions {
  args: ExploreArgs;
  folder: RunFolder;
  /** How long it waits for the app to be in front or connected again (a crash with `continue`, a move that left the app). */
  graceMs: number;
}

export interface ExploreOutcome {
  report: ExploreReport;
  /** The place the app was left at, when known. */
  leftAt: string | null;
  /** The toggle's name for `Stopped: a toggle could not be set back (id=notify-switch).` */
  detail?: string;
  /** Findings as `1 crash, 2 js_error`. */
  findingsLine: string;
}

// -- small helpers

interface Action {
  sig: string;
  kind: "tap" | "toggle";
  el: TreeElement;
  target: TargetArg;
  step: PathStep;
  skip: FloorHit | null;
  /** A control tapped only after typing: its id is in the policy's `explore.submit`. */
  afterTyping: boolean;
  /** A control that may submit a form (§25.7): skipped unless listed. */
  mayList: boolean;
}

interface InputAction {
  sig: string;
  el: TreeElement;
  target: TargetArg;
  step: PathStep;
}

interface Plan {
  actions: Action[];
  inputs: InputAction[];
  scroll: TreeElement | null;
  /** Rows beyond the ones tried, per list: the note says so. */
  rowsCut: boolean;
  hasInput: boolean;
  /** Every signature seen (rows beyond the tried ones are not in it). */
  seen: string[];
}

const filled = (v: string | null | undefined): v is string => typeof v === "string" && v !== "";
const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function contains(outer: NonNullable<TreeElement["frame"]>, inner: NonNullable<TreeElement["frame"]>): boolean {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
}

/** A toggle's value, when it can be read (§25.7): `checked` or `value`, as a boolean. */
export function readToggle(el: Pick<TreeElement, "checked" | "value">): boolean | undefined {
  const asBool = (v: unknown): boolean | undefined => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (["true", "on", "1", "checked", "yes"].includes(t)) return true;
      if (["false", "off", "0", "unchecked", "no"].includes(t)) return false;
    }
    return undefined;
  };
  return asBool(el.checked) ?? asBool(el.value);
}

const isToggle = (el: TreeElement): boolean => roleOf(el) === "switch" || (el.actions ?? []).includes("toggle");
const isTappable = (el: TreeElement): boolean => (el.actions ?? []).some((a) => a === "press" || a === "tap");
const isInput = (el: TreeElement): boolean => roleOf(el) === "input";

/** The area of a route (§25.11): its first name after the groups; `root` when it has none. */
export function areaOf(route: readonly string[]): string {
  const first = route.filter((piece) => !/^\(.*\)$/.test(piece))[0];
  return first === undefined || first === "index" ? "root" : first;
}

const routeStartsWith = (route: readonly string[], prefix: readonly string[]): boolean => prefix.length <= route.length && prefix.every((piece, i) => route[i] === piece);

/** The words after `Error <code>:` of a refusal, and its first token (`covered`, `off_screen`, `disabled`). */
function reasonToken(message: string): string {
  return /^([a-z_]+)\b/.exec(message)?.[1] ?? "";
}

/** The policy word an answer names: `(policy word "Delete")` or `blocked by the policy ("Delete")`. */
function wordIn(message: string): string | undefined {
  return /policy word "([^"]+)"/.exec(message)?.[1] ?? /\(("[^"]+")\)/.exec(message)?.[1]?.replace(/^"|"$/g, "");
}

/** The reason of a skip the host's check named: `(explore skip: app_mark)`. */
function whyIn(message: string): SkipWhy | undefined {
  const why = /explore skip: (floor|policy|skip_list|app_mark|may_submit)\b/.exec(message)?.[1];
  return why as SkipWhy | undefined;
}

class Stop extends Error {
  constructor(
    readonly reason: StopReason,
    readonly detail?: string,
  ) {
    super(`stopped: ${reason}`);
  }
}

// -- the explorer

export class Explorer {
  private readonly host: ExploreHost;
  private readonly args: ExploreArgs;
  private readonly folder: RunFolder;
  private readonly graceMs: number;
  private readonly findings = new FindingBook();
  private readonly skipped: SkippedEntry[] = [];
  private readonly skippedKeys = new Set<string>();
  private readonly notes: string[] = [];
  private readonly resets: ResetEntry[] = [];
  private readonly depthOf = new Map<string, number>();
  /** How the run first reached a place: the hop, and the typing steps that filled the form a submit hop sent (`TYPED`, never the text). */
  private readonly via = new Map<string, { from: string; step: PathStep; before?: PathStep[] }>();
  private readonly seen = new Set<string>();
  private readonly below = new Set<string>();
  private readonly queue: string[] = [];
  private readonly enqueued = new Set<string>();
  private readonly typedAt = new Set<string>();
  /** The typing steps of the visit in progress, per place: a finding that follows them has them in its path, as `${typed}` (§27.1). */
  private readonly typedSteps = new Map<string, PathStep[]>();
  private readonly firstFrames = new Map<string, NonNullable<TreeElement["frame"]>>();
  private startPlace: string | null = null;
  private focusRoute: string[] | undefined;
  private focusName: string | undefined;
  private steps = 0;
  private startedAt = 0;
  private waited0 = 0;
  private startedWall = new Date(0);
  private resetsInARow = 0;
  private lastProgressAt = 0;
  private leftAt: string | null = null;
  private ranOutOf: StopReason | null = null;
  private stopDetail: string | undefined;
  private lastTree: TreeResult | null = null;

  constructor(host: ExploreHost, options: ExploreOptions) {
    this.host = host;
    this.args = options.args;
    this.folder = options.folder;
    this.graceMs = options.graceMs;
  }

  /** Runs the search to its end. Never throws for what happens in the app: every stop is a reason in the report. */
  async run(): Promise<ExploreOutcome | { error: string }> {
    const info = this.host.info();
    if (info === null) return { error: "Error not_connected: no app is connected." };
    this.startedAt = this.host.now();
    this.waited0 = this.host.waitedMs();
    this.startedWall = this.host.wall();
    try {
      const started = await this.start();
      if (started !== null) return { error: started };
      await this.search();
      if (this.ranOutOf === null) this.ranOutOf = "frontier_empty";
      // The app ends where it started (§25.13).
      if (this.startPlace !== null) await this.ensureAt(this.startPlace);
    } catch (error) {
      if (error instanceof Stop) {
        this.ranOutOf = error.reason;
        this.stopDetail = error.detail;
      } else throw error;
    }
    const stopped: StopReason = this.ranOutOf ?? "frontier_empty";
    if (stopped === "frontier_empty") await this.unreachable();
    return this.outcome(stopped);
  }

  // -- the start

  private async start(): Promise<string | null> {
    const map = this.host.map;
    const { from, focus } = this.args;
    for (const [flag, name] of [["from", from], ["focus", focus]] as const) {
      if (name !== undefined && map.data().places[name] === undefined) return `Error bad_params: ${flag} names no place the map knows: "${name}". map lists the places.`;
    }
    if (focus !== undefined) {
      this.focusName = focus;
      const key = map.data().places[focus]?.key;
      if (key !== undefined && "route" in key) this.focusRoute = key.route;
    }
    const target = from ?? focus;
    let tree = await this.read();
    if (target !== undefined) {
      const here = this.observe(tree).place.name;
      if (here !== target) {
        const went = await this.host.go(target, "any", this.args.account);
        this.steps += went.used;
        if (!went.ok) return `Error off_route: the explorer couldn't get to ${target}. ${firstLineOf(went.text)}`;
        tree = await this.read();
        if (this.observe(tree).place.name !== target) return `Error off_route: the explorer couldn't get to ${target}.`;
      }
    }
    const here = this.observe(tree);
    this.startPlace = here.place.name;
    this.depthOf.set(here.place.name, 0);
    this.seen.add(here.place.name);
    this.below.add(here.place.name);
    this.queue.push(here.place.name);
    this.enqueued.add(here.place.name);
    await this.firstVisit(here.place.name, tree);
    return null;
  }

  // -- the search

  private async search(): Promise<void> {
    while (this.queue.length > 0) {
      this.checkBudget();
      const place = this.queue.shift() as string;
      const depth = this.depthOf.get(place) ?? 0;
      // A place at `depth` is saved and not expanded (§25.4 item 4). Outside the focus nothing is expanded (item 5).
      if (depth >= this.args.depth || !this.inFocus(place)) continue;
      await this.expand(place);
    }
  }

  private minutesUsed(): number {
    return (this.host.now() - this.startedAt - (this.host.waitedMs() - this.waited0)) / 60_000;
  }

  private checkBudget(): void {
    if (this.host.cancelled()) throw new Stop("paused");
    if (this.steps >= this.args.steps) throw new Stop("budget_steps");
    if (this.minutesUsed() >= this.args.minutes) throw new Stop("budget_minutes");
  }

  private progress(): void {
    if (this.steps - this.lastProgressAt < PROGRESS_EVERY) return;
    this.lastProgressAt = this.steps - (this.steps % PROGRESS_EVERY);
    this.host.progress(`explored ${this.seen.size} places, ${this.findings.all().length} findings`, this.steps);
  }

  private inFocus(place: string): boolean {
    if (this.focusName === undefined) return true;
    if (place === this.focusName) return true;
    const key = this.host.map.data().places[place]?.key;
    if (this.focusRoute !== undefined && key !== undefined && "route" in key) return routeStartsWith(key.route, this.focusRoute);
    return this.below.has(place);
  }

  /** Reads the screen; stops the run when the app is gone. */
  private async read(): Promise<TreeResult> {
    const tree = await this.host.tree();
    if (tree === null) {
      await this.appGone();
      // The app came back (the person opened it): read again.
      const again = await this.host.tree();
      if (again === null) throw new Stop("app_closed");
      this.lastTree = again;
      return again;
    }
    this.lastTree = tree;
    return tree;
  }

  private observe(tree: TreeResult): { place: { name: string }; isNew: boolean } {
    const seen = this.host.map.observe(tree);
    this.leftAt = seen.place.name;
    return { place: seen.place, isNew: seen.isNew };
  }

  /** The app isn't there. It waits a while for a person to open it, else the run ends (§28.4). */
  private async appGone(): Promise<void> {
    if (this.host.frontState() === "front") return;
    const back = await this.host.waitForApp(this.graceMs);
    if (!back) throw new Stop("app_closed");
  }

  // -- a place

  /** Visits a place: tries each action nobody has tried, and returns to the place after each that moves the app. */
  private async expand(place: string): Promise<void> {
    if (!(await this.ensureAt(place))) return;
    const map = this.host.map;
    this.seen.add(place);
    this.typedSteps.delete(place);
    this.firstFrames.clear();
    const done = new Set<string>();
    let scrolled = 0;
    let scrollSig: string | null = null;
    let returned = false;
    let lastBelow = Number.POSITIVE_INFINITY;
    let typed = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      this.checkBudget();
      const tree = await this.read();
      if (this.observe(tree).place.name !== place) {
        if (!(await this.ensureAt(place))) return;
        continue;
      }
      // Read each round: the live title of the screen protects a place whose stored name is generic (§25.5).
      const protectedWord = protectedPlaceWord(place, this.routeOf(place), screenTitles(tree.elements));
      const plan = this.plan(place, tree);
      map.markSeen(place, [...plan.seen, ...(protectedWord === null ? ["back"] : [])]);
      if (plan.rowsCut) this.note(`rows: first ${ROWS_TRIED} of the list tried (${place})`);
      // Skips and what an earlier run tried come first; neither costs a step.
      let next: Action | undefined;
      for (const action of plan.actions) {
        if (done.has(action.sig)) continue;
        if (protectedWord !== null) {
          this.skip(place, action.sig, { why: "floor", word: protectedWord });
          done.add(action.sig);
          continue;
        }
        const verdict = this.verdict(action, plan, typed);
        if (verdict !== null) {
          this.skip(place, action.sig, verdict);
          done.add(action.sig);
          continue;
        }
        if (action.afterTyping && !typed) continue;
        if (map.isTried(place, action.sig)) {
          this.enqueueKnown(place, action.sig);
          done.add(action.sig);
          continue;
        }
        next = action;
        break;
      }
      if (next !== undefined) {
        done.add(next.sig);
        if (!(await this.perform(place, next))) return;
        continue;
      }
      if (protectedWord !== null) {
        this.note(`${place}: an account, privacy or security place (${protectedWord}) is saved and not expanded`);
        return;
      }
      // Scroll to reveal what is below, up to 5 times, then back to the start of the list (§25.4 item 2).
      const below = tree.offScreen?.below ?? 0;
      if (plan.scroll !== null && !returned && scrolled < SCROLLS_MAX && below > 0 && below < lastBelow) {
        scrollSig ??= this.sigOfScroll(plan, tree);
        const worth = scrollSig === null || !map.isTried(place, scrollSig) || map.frontier(place).some((sig) => !plan.seen.includes(sig));
        if (worth) {
          scrolled += 1;
          lastBelow = below;
          if (!(await this.scrollMove(place, { tool: "scroll", direction: "down" }))) return;
          continue;
        }
      }
      if (scrolled > 0 && !returned) {
        returned = true;
        if (!(await this.scrollMove(place, { tool: "scroll", to: "start" }))) return;
        if (scrollSig !== null) map.markTried(place, scrollSig, { result: "same" });
        continue;
      }
      if (this.args.fill === "test-data" && !typed && plan.inputs.length > 0) {
        typed = true;
        if (!(await this.fillInputs(place, plan))) return;
        continue;
      }
      if (!done.has("back")) {
        done.add("back");
        if (map.isTried(place, "back")) this.enqueueKnown(place, "back");
        else if (!(await this.tryBack(place))) return;
        continue;
      }
      return;
    }
  }

  private routeOf(place: string): readonly string[] | undefined {
    const key = this.host.map.data().places[place]?.key;
    return key !== undefined && "route" in key ? key.route : undefined;
  }

  private sigOfScroll(plan: Plan, tree: TreeResult): string | null {
    const el = plan.scroll;
    if (el === null) return null;
    const names = this.signatures(tree);
    const at = tree.elements.indexOf(el);
    return at >= 0 ? (names[at] ?? null) : null;
  }

  private note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  /** Records a skip once per run: in the report and in the map (§28.3). The floor was checked right now; a saved skip allows nothing. */
  private skip(place: string, sig: string, hit: FloorHit): void {
    const key = `${place}\u0000${sig}`;
    if (this.skippedKeys.has(key)) return;
    this.skippedKeys.add(key);
    this.host.map.markSkipped(place, sig, hit.why, hit.word);
    this.skipped.push({ place, sig, why: hit.why, ...(hit.word !== undefined ? { word: hit.word } : {}) });
  }

  /** Why an action is not touched now (the floor, then the submit rule), or null. */
  private verdict(action: Action, plan: Plan, typed: boolean): FloorHit | null {
    if (action.skip !== null) return action.skip;
    // §25.7: on a screen with a text input, a control that may submit is skipped unless its id is in `submit`.
    if (plan.hasInput && action.mayList && !isListedSubmit(action.el, this.host.rules)) {
      const word = submitWord(action.el);
      return { why: "may_submit", ...(word !== null ? { word } : {}) };
    }
    // On a screen where it typed, the only moves are `back` and the controls in `submit`.
    if (typed && !isListedSubmit(action.el, this.host.rules)) return { why: "may_submit" };
    return null;
  }

  /** An action an earlier run tried and that led to a place: that place may still have a frontier. */
  private enqueueKnown(place: string, sig: string): void {
    const tried = this.host.map.triedAction(place, sig);
    if (tried?.result !== "road" || tried.to === undefined) return;
    const to = tried.to;
    if (this.depthOf.has(to) || to === place) return;
    if (this.host.map.data().places[to] === undefined) return;
    const depth = (this.depthOf.get(place) ?? 0) + 1;
    this.depthOf.set(to, depth);
    this.via.set(to, { from: place, step: this.stepFromRecord(place, sig, to) });
    if (this.below.has(place)) this.below.add(to);
    // Places this run has seen or queued are not counted again (a cycle of back roads leads home).
    if (this.needsVisit(to, new Set([...this.seen, ...this.enqueued]))) this.enqueue(to);
  }

  private stepFromRecord(from: string, _sig: string, to: string): PathStep {
    const road = this.host.map.data().roads.find((r) => r.from === from && r.to === to);
    return road !== undefined ? stepOfRoad(road) : { tool: "tap" };
  }

  /** Whether a place an earlier run found has something left: untried actions, no record, or a road to such a place. */
  private needsVisit(place: string, visited: Set<string>): boolean {
    if (visited.has(place)) return false;
    visited.add(place);
    const record = this.host.map.data().places[place]?.explored;
    if (record === undefined || this.host.map.frontier(place).length > 0) return true;
    return record.actions.some((a) => a.result === "road" && a.to !== undefined && this.needsVisit(a.to, visited));
  }

  private enqueue(place: string): void {
    if (this.enqueued.has(place)) return;
    this.enqueued.add(place);
    this.queue.push(place);
  }

  // -- reading a place into actions

  private signatures(tree: TreeResult): Array<string | null> {
    const screen = tree.screen ?? null;
    const named: NamedElement[] = tree.elements.map((el) => ({ ...el, role: el.role ?? roleOf(el) }));
    const scrolls = tree.elements.filter((el) => roleOf(el) === "scroll");
    const listOf = new Map<TreeElement, string>();
    const rowNumbers = this.rowNumbers(tree);
    const rowByNamed = new Map<NamedElement, TreeElement>();
    named.forEach((n, i) => rowByNamed.set(n, tree.elements[i] as TreeElement));
    const scrollSig = (scroll: TreeElement): string => {
      const at = tree.elements.indexOf(scroll);
      const item = named[at] as NamedElement;
      return signaturesOf([item], { screen })[0] ?? "list";
    };
    for (const el of tree.elements) {
      if (el.row !== true || el.frame === null || el.frame === undefined) continue;
      const frame = el.frame;
      const owner = owningScroll(scrolls, frame);
      listOf.set(el, owner !== undefined ? scrollSig(owner) : "list");
    }
    return signaturesOf(named, {
      screen,
      redact: (text) => this.host.redact(text),
      frameOf: (n) => {
        const el = rowByNamed.get(n);
        const first = el !== undefined ? this.firstFrames.get(el.ref) : undefined;
        return first ?? n.frame ?? undefined;
      },
      rowOf: (n) => {
        const el = rowByNamed.get(n);
        if (el === undefined) return undefined;
        const index = rowNumbers.get(el);
        const list = listOf.get(el);
        return index === undefined || list === undefined ? undefined : { list, n: index };
      },
    });
  }

  /** The number of each outermost row in its own list, from 1, top to bottom then left to right. Elements inside a row are not numbered. */
  private rowNumbers(tree: TreeResult): Map<TreeElement, number> {
    const rows = tree.elements.filter((el) => el.row === true && el.frame !== null && el.frame !== undefined && (isTappable(el) || isToggle(el)) && el.disabled !== true);
    // Outermost: not inside another row (of two rows with the same frame the first is the outer one).
    const outer = rows.filter((el, i) => !rows.some((other, j) => j !== i && other.frame !== null && other.frame !== undefined && el.frame !== null && el.frame !== undefined && contains(other.frame, el.frame) && (!contains(el.frame, other.frame) || j < i)));
    outer.sort((a, b) => num(a.frame?.y) - num(b.frame?.y) || num(a.frame?.x) - num(b.frame?.x));
    // Each list counts its own rows: the rows of a second list are not "beyond the first two" of the first.
    const scrolls = tree.elements.filter((el) => roleOf(el) === "scroll");
    const counts = new Map<TreeElement | null, number>();
    const numbers = new Map<TreeElement, number>();
    for (const el of outer) {
      const owner = el.frame !== null && el.frame !== undefined ? (owningScroll(scrolls, el.frame) ?? null) : null;
      const n = (counts.get(owner) ?? 0) + 1;
      counts.set(owner, n);
      numbers.set(el, n);
    }
    return numbers;
  }

  private plan(place: string, tree: TreeResult): Plan {
    for (const el of tree.elements) if (el.frame !== null && el.frame !== undefined && !this.firstFrames.has(el.ref)) this.firstFrames.set(el.ref, el.frame);
    const sigs = this.signatures(tree);
    const rowNumbers = this.rowNumbers(tree);
    const hasInput = tree.elements.some(isInput);
    const actions: Action[] = [];
    const inputs: InputAction[] = [];
    const seen: string[] = [];
    let rowsCut = false;
    tree.elements.forEach((el, i) => {
      const sig = sigs[i];
      if (sig === null || sig === undefined) return;
      if (el.disabled === true) return;
      if (isInput(el)) {
        // The floor applies to inputs too (§25.5): a skip mark (inherited ones included), a policy or skip-list word, a card word.
        const barred = this.args.fill === "test-data" ? floorVerdict(el, this.host.rules) : null;
        if (barred !== null) {
          this.skip(place, sig, barred);
          return;
        }
        if (this.args.fill === "test-data" && this.fillFor(el) !== null) {
          inputs.push({ sig, el, target: this.targetOf(el, sig, tree, i), step: this.stepOf(el, sig, tree, "type_text") });
          seen.push(sig);
        }
        return;
      }
      if (roleOf(el) === "scroll") return;
      if (!isTappable(el) && !isToggle(el)) return;
      if (el.row === true) {
        const n = rowNumbers.get(el);
        // Elements inside a row are not tried; rows beyond the first two are not either, and the report says so.
        if (n === undefined) return;
        if (n > ROWS_TRIED) {
          rowsCut = true;
          return;
        }
      }
      const hit = floorVerdict(el, this.host.rules);
      const listed = isListedSubmit(el, this.host.rules);
      actions.push({
        sig,
        kind: isToggle(el) ? "toggle" : "tap",
        el,
        target: this.targetOf(el, sig, tree, i),
        step: this.stepOf(el, sig, tree, isToggle(el) ? "toggle" : "tap"),
        skip: hit,
        afterTyping: listed && this.args.fill === "test-data" && tree.elements.some((other) => isInput(other) && this.fillFor(other) !== null),
        mayList: submitWord(el) !== null,
      });
      seen.push(sig);
    });
    // Top to bottom, then left to right, then by signature as text (§25.4 item 2).
    const order = (a: { el: TreeElement; sig: string }, b: { el: TreeElement; sig: string }): number => {
      const fa = a.el.frame;
      const fb = b.el.frame;
      const ya = fa === null || fa === undefined ? Number.POSITIVE_INFINITY : fa.y;
      const yb = fb === null || fb === undefined ? Number.POSITIVE_INFINITY : fb.y;
      if (ya !== yb) return ya < yb ? -1 : 1;
      const xa = fa === null || fa === undefined ? Number.POSITIVE_INFINITY : fa.x;
      const xb = fb === null || fb === undefined ? Number.POSITIVE_INFINITY : fb.x;
      if (xa !== xb) return xa < xb ? -1 : 1;
      return a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0;
    };
    actions.sort(order);
    inputs.sort(order);
    // A scroll view the floor skips (a mark, inherited ones included, or a word) is never scrolled; the host's gate checks the same again.
    const view = tree.elements.find((el) => roleOf(el) === "scroll") ?? null;
    const barredView = view === null ? null : recipientVerdict(view, this.host.rules, false);
    if (barredView !== null) this.note(`${place}: a scroll view is marked skip, so it is not scrolled`);
    const scroll = barredView === null ? view : null;
    return { actions, inputs, scroll, rowsCut, hasInput, seen: [...new Set(seen)] };
  }

  /** How the tools target an element: by id, else label, else text (with `index` where several share it), else by ref (never kept). */
  private targetOf(el: TreeElement, sig: string, tree: TreeResult, at: number): TargetArg {
    void tree;
    void at;
    const index = /#(\d+)$/.exec(sig)?.[1];
    const n = index !== undefined && el.row !== true ? { index: Number(index) } : {};
    if (el.row === true) return { ref: el.ref };
    if (filled(el.testID)) return { id: el.testID, ...n };
    if (filled(el.label)) return { label: el.label, ...n };
    if (filled(el.text)) return { text: el.text, ...n };
    return { ref: el.ref };
  }

  /** The step a finding's path shows for an element: never a ref; a row with no id (or a shared one) is `{row: true, index}` (§27.1). */
  private stepOf(el: TreeElement, sig: string, tree: TreeResult, tool: string): PathStep {
    const rowIndex = /^row:.*#(\d+)$/.exec(sig)?.[1];
    if (el.row === true) {
      const sharedId = filled(el.testID) && tree.elements.filter((other) => other.testID === el.testID).length > 1;
      if (filled(el.testID) && !sharedId) return { tool, target: { id: el.testID } };
      return { tool, target: { row: true, index: rowIndex !== undefined ? Number(rowIndex) : 1 } };
    }
    const t = this.targetOf(el, sig, tree, 0);
    if ("ref" in t) {
      const f = el.frame;
      return f !== null && f !== undefined
        ? { tool, target: { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) } as PathStep["target"] }
        : { tool };
    }
    return { tool, target: t };
  }

  // -- one action

  /** Makes one move for an action and decides what it means. False: this place's visit ends (a stop is thrown). */
  private async perform(place: string, action: Action): Promise<boolean> {
    if (action.kind === "toggle") return this.performToggle(place, action);
    const mark = this.host.mark();
    const out = await this.host.move({ tool: "tap", target: action.target });
    this.steps += out.used;
    this.progress();
    return this.afterMove(place, action.sig, action.step, mark, out, "tap");
  }

  private async afterMove(place: string, sig: string | null, step: PathStep, mark: unknown, out: MoveOutcome, kind: "tap" | "toggle" | "back" | "type" | "scroll"): Promise<boolean> {
    const map = this.host.map;
    const tried = (result: Parameters<AppMap["markTried"]>[2]): void => {
      if (sig !== null) map.markTried(place, sig, result);
    };
    const after = this.host.since(mark);
    if (after.crash !== null || (after.disconnected && !out.ok)) {
      // With `continue` the app is open again by now: the visit goes on from where the place is.
      await this.onCrash(place, sig, step, after);
      return this.recover(place);
    }
    if (!out.ok) {
      switch (out.code) {
        case "busy":
        case "paused":
        case "locked":
          throw new Stop(out.code);
        case "lease_lost":
          throw new Stop("busy");
        case "not_allowed": {
          // The budget ran out inside one move (a drive or a route): the run ends there, nothing is skipped for it.
          const budget = /explore budget: (steps|minutes)/.exec(out.message)?.[1];
          if (budget !== undefined) throw new Stop(budget === "steps" ? "budget_steps" : "budget_minutes");
          // The check right before the touch said a person's OK is needed, the touch is blocked, or the real recipient is skipped: it isn't made (§25.5).
          const word = wordIn(out.message);
          const why = whyIn(out.message) ?? "policy";
          if (sig !== null) this.skip(place, sig, { why, ...(word !== undefined ? { word } : {}) });
          return true;
        }
        case "not_actionable": {
          const reason = reasonToken(out.message);
          tried({ result: "refused", code: reason || "not_actionable" });
          if (reason === "covered" || reason === "off_screen") {
            await this.finding("refused", place, [step], { expected: "the control works when a person taps it", got: `not_actionable: ${out.message}`.split("\n")[0] as string, picture: true });
            return true;
          }
          if (reason === "behind_alert") return this.alertInTheWay(place);
          return true;
        }
        case "not_found":
        case "ambiguous":
        case "stale":
          tried({ result: "refused", code: out.code });
          return true;
        case "not_connected":
        case "in_background":
        case "reconnecting":
        case "not_answering": {
          tried({ result: "left" });
          await this.finding("dead_end", place, [step], { expected: "the app stays open", got: `the app went away (${out.code})`, picture: false });
          await this.appGone();
          return this.recover(place);
        }
        default:
          tried({ result: "refused", code: out.code });
          return true;
      }
    }
    // The move was made. Slow? (§25.10)
    if (out.settledMs !== undefined && out.settledMs > SLOW_MS) {
      await this.finding("slow", place, [step], { expected: `the screen settles within ${SLOW_MS / 1000} s`, got: `${(out.settledMs / 1000).toFixed(1)} s to settle`, picture: true });
    }
    // JS errors since the move began (§25.4 item 7).
    if (after.errors.length > 0) {
      await this.finding("js_error", place, [step], { expected: "no error in the app's log", got: errorLine(after.errors[0] as LogEntry, (text) => this.host.redact(text)), logs: after.errors, picture: true });
    }
    // Did it leave the app?
    if (this.host.frontState() !== "front") {
      tried({ result: "left" });
      await this.finding("dead_end", place, [step], { expected: "the app stays in front", got: "the move left the app", picture: false });
      await this.appGone();
      return this.recover(place);
    }
    // A scroll or a back is read by the caller; only a touch's arrival is decided here.
    if (kind === "scroll" || kind === "back") return true;
    const tree = await this.read();
    const at = this.observe(tree);
    if (tree.alerts?.some((alert) => !alert.standIn) === true) {
      tried({ result: "refused", code: "behind_alert" });
      return this.alertInTheWay(place);
    }
    if (kind === "toggle") return true;
    if (at.place.name === place) {
      tried({ result: "same" });
      return true;
    }
    // It arrived at another place: a road (§25.4 item 7).
    const arrived = at.place.name;
    tried({ result: "road", to: arrived });
    const fresh = !this.depthOf.has(arrived);
    if (fresh) {
      this.depthOf.set(arrived, (this.depthOf.get(place) ?? 0) + 1);
      const typed = this.typedSteps.get(place) ?? [];
      this.via.set(arrived, { from: place, step, ...(typed.length > 0 ? { before: [...typed] } : {}) });
      if (this.inFocusFrom(place)) this.below.add(arrived);
      this.seen.add(arrived);
      await this.firstVisit(arrived, tree);
      if ((this.depthOf.get(arrived) ?? 0) < this.args.depth && this.inFocus(arrived)) this.enqueue(arrived);
    }
    return this.getBack(place, arrived);
  }

  /**
   * A system alert (a permission prompt, the share sheet) is open: Tapline can't answer it, and it is never allowed (§25.7, §28.4).
   * The branch stops and the report says so; the app is reset, so the other branches go on, or the run ends where it can't.
   */
  private async alertInTheWay(place: string): Promise<boolean> {
    this.note(`a system alert stopped the branch at ${place}: a person has to answer it (it is never allowed)`);
    await this.reset(place);
    return false;
  }

  private inFocusFrom(place: string): boolean {
    return this.focusName === undefined || this.inFocus(place);
  }

  // -- toggles (§25.7)

  private async performToggle(place: string, action: Action): Promise<boolean> {
    const map = this.host.map;
    const old = readToggle(action.el);
    // Where the value can't be read, the toggle isn't flipped.
    if (old === undefined) {
      map.markTried(place, action.sig, { result: "refused", code: "value_unreadable" });
      this.note(`${place}: ${action.sig} is a toggle whose value can't be read, so it was not flipped`);
      return true;
    }
    const mark = this.host.mark();
    const out = await this.host.move({ tool: "toggle", target: action.target });
    this.steps += out.used;
    this.progress();
    const flipped = !out.ok ? false : true;
    // The flip is a move like any other: its crash, error and arrival are read; the flip back follows at once (one move for a pause).
    const kept = await this.afterMove(place, action.sig, action.step, mark, out, "toggle");
    if (!flipped) return kept;
    if (!kept) {
      // The branch ended (an alert, a crash, the app gone) after the flip: a reload keeps the data, so the flip may still be there.
      await this.restoreAfterBreak(place, action, old);
      return false;
    }
    let here = await this.read();
    if (this.observe(here).place.name !== place) {
      // The flip took the app elsewhere: come back, then set it back.
      if (!(await this.ensureAt(place))) throw new Stop("toggle_not_restored", toggleName(action.el));
      here = await this.read();
    }
    const found = this.findBySig(here, action.sig);
    const nowValue = found === undefined ? undefined : readToggle(found);
    // The toggle's role is kept with the result: a repair of a script's toggle needs the role it had (§26.2).
    const role = roleOf(action.el) ?? undefined;
    if (nowValue === old) {
      map.markTried(place, action.sig, { result: "same", role });
      return true;
    }
    const back = await this.host.move({ tool: "toggle", target: found !== undefined ? this.targetOf(found, action.sig, here, 0) : action.target, value: old });
    this.steps += back.used;
    const check = await this.read();
    const after = this.findBySig(check, action.sig);
    if (!back.ok || after === undefined || readToggle(after) !== old) throw new Stop("toggle_not_restored", toggleName(action.el));
    map.markTried(place, action.sig, { result: "same", role });
    return true;
  }

  /** After a recovery that ended a toggle's branch: the toggle is read again, and flipped back when it kept the flip. It never ends unverified. */
  private async restoreAfterBreak(place: string, action: Action, old: boolean): Promise<void> {
    const lost = (): Stop => new Stop("toggle_not_restored", toggleName(action.el));
    if (!(await this.ensureAt(place))) throw lost();
    const here = await this.read();
    const found = this.findBySig(here, action.sig);
    const now = found === undefined ? undefined : readToggle(found);
    if (found === undefined || now === undefined) throw lost();
    if (now === old) return;
    const back = await this.host.move({ tool: "toggle", target: this.targetOf(found, action.sig, here, 0), value: old });
    this.steps += back.used;
    const check = await this.read();
    const after = this.findBySig(check, action.sig);
    if (!back.ok || after === undefined || readToggle(after) !== old) throw lost();
  }

  private findBySig(tree: TreeResult, sig: string): TreeElement | undefined {
    const sigs = this.signatures(tree);
    const at = sigs.indexOf(sig);
    return at >= 0 ? tree.elements[at] : undefined;
  }

  // -- scroll, back, typing

  private async scrollMove(place: string, move: ExploreMove): Promise<boolean> {
    const mark = this.host.mark();
    const out = await this.host.move(move);
    this.steps += out.used;
    this.progress();
    return this.afterMove(place, null, { tool: "scroll" }, mark, out, "scroll");
  }

  /** The `back` action of a place (§25.4 item 2): saves the road to the parent. It returns to the place afterwards. */
  private async tryBack(place: string): Promise<boolean> {
    const mark = this.host.mark();
    const out = await this.host.move({ tool: "back" });
    this.steps += out.used;
    this.progress();
    const ok = await this.afterMove(place, "back", { tool: "back" }, mark, out, "back");
    if (!ok) return false;
    const tree = await this.read();
    const at = this.observe(tree).place.name;
    if (at === place) {
      if (out.ok) this.host.map.markTried(place, "back", { result: "same" });
      return true;
    }
    this.host.map.markTried(place, "back", { result: "road", to: at });
    if (!this.depthOf.has(at)) {
      this.depthOf.set(at, (this.depthOf.get(place) ?? 0) + 1);
      this.via.set(at, { from: place, step: { tool: "back" } });
      this.seen.add(at);
      await this.firstVisit(at, tree);
      if ((this.depthOf.get(at) ?? 0) < this.args.depth && this.inFocus(at)) this.enqueue(at);
    }
    return this.reachPlace(place);
  }

  /** What `fill: "test-data"` types into a field, or null: only a field the app marks as safe, never a password or a card (§25.6). */
  private fillFor(el: TreeElement): { text: string } | null {
    if (this.args.fill !== "test-data") return null;
    if (isSecretField(el)) return null;
    const fake = (): { text: string } => ({ text: /email/i.test(`${el.testID ?? ""} ${el.label ?? ""}`) ? "test@example.com" : "Test" });
    const mark = el.exploreFill;
    if (typeof mark === "string") {
      const vault = /^vault:([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(mark);
      if (vault !== null) return this.host.vaultFill(vault[1] as string, vault[2] as string) === "ok" ? { text: `\${vault.${vault[1]}.${vault[2]}}` } : null;
      // `fixture:<name>`: an app command's fixture; Tapline doesn't type fixtures yet.
      return null;
    }
    if (mark === true) return fake();
    if (filled(el.testID) && /-test-safe$/.test(el.testID)) return fake();
    return null;
  }

  private async fillInputs(place: string, plan: Plan): Promise<boolean> {
    const map = this.host.map;
    for (const input of plan.inputs) {
      if (map.isTried(place, input.sig)) continue;
      this.checkBudget();
      const fill = this.fillFor(input.el);
      if (fill === null) continue;
      const mark = this.host.mark();
      this.typedAt.add(place);
      const out = await this.host.move({ tool: "type", target: input.target, text: fill.text });
      this.steps += out.used;
      this.progress();
      const step: PathStep = { ...input.step, tool: "type_text", text: TYPED };
      if (out.ok) this.typedSteps.set(place, [...(this.typedSteps.get(place) ?? []), step]);
      const ok = await this.afterMove(place, input.sig, step, mark, out, "type");
      if (!ok) return false;
      if (out.ok) map.markTried(place, input.sig, { result: "same" });
    }
    return true;
  }

  // -- getting back (§25.4 item 8) and reset (§25.8)

  /** After a move that arrived at `at`: back to `place` by `back`, by a proven road, by a link; else a reset. */
  private async getBack(place: string, at: string): Promise<boolean> {
    const mark = this.host.mark();
    const out = await this.host.move({ tool: "back" });
    this.steps += out.used;
    const after = this.host.since(mark);
    if (after.crash !== null) {
      await this.onCrash(at, "back", { tool: "back" }, after);
      return this.recover(place);
    }
    if (!out.ok && (out.code === "busy" || out.code === "paused" || out.code === "locked")) throw new Stop(out.code);
    if (out.ok) {
      const tree = await this.read();
      if (this.observe(tree).place.name === place) return true;
    }
    return this.reachPlace(place, at);
  }

  /** Gets the app to `place` without `back`: a proven road, then a link, then a reset. */
  private async reachPlace(place: string, stuckAt?: string): Promise<boolean> {
    for (const by of ["taps", "link"] as const) {
      this.checkBudget();
      const went = await this.host.go(place, by, this.args.account);
      this.steps += went.used;
      if (went.ok) {
        const tree = await this.read();
        if (this.observe(tree).place.name === place) return true;
      }
    }
    const here = this.leftAt ?? stuckAt ?? place;
    await this.finding("dead_end", here, [], { expected: `a way back to ${place}`, got: `no way back to ${place} except a reset`, picture: true });
    return this.reset(place);
  }

  /** Ends the branch with a reset to a known place (§25.8): the own reset first, then `app_command reset`. */
  private async reset(target: string): Promise<boolean> {
    const own = await this.host.reload();
    if (own.ok) {
      this.steps += own.used;
      this.resets.push({ how: "reload", data_kept: true, at_step: this.steps });
      if (await this.knownAfterReset(target)) return true;
    }
    const names = await this.host.commands();
    if (names.includes("reset")) {
      const cleared = await this.host.runCommand("reset");
      if (cleared.ok) {
        this.steps += cleared.used;
        this.resets.push({ how: "app_command", data_kept: false, at_step: this.steps });
        if (await this.knownAfterReset(target)) return true;
      }
    }
    if (!own.ok && !names.includes("reset")) this.note(`couldn't get back to ${target}: reload is not available here and the app offers no reset command`);
    this.resetsInARow += 1;
    if (this.resetsInARow >= RESETS_IN_A_ROW) throw new Stop("cant_get_back");
    return false;
  }

  /** After a reset: the app is at a known place, then it is driven to `target`. */
  private async knownAfterReset(target: string): Promise<boolean> {
    const tree = await this.host.tree();
    if (tree === null) return false;
    const here = this.observe(tree).place.name;
    if (!this.depthOf.has(here)) return false;
    this.resetsInARow = 0;
    if (here === target) return true;
    const went = await this.host.go(target, "any", this.args.account);
    this.steps += went.used;
    if (!went.ok) {
      this.note(`after a reset the way to ${target} was not found; the branch ends`);
      return false;
    }
    const back = await this.host.tree();
    return back !== null && this.observe(back).place.name === target;
  }

  /** The app is back (or a failure was handled): get to `place` again. */
  private async recover(place: string): Promise<boolean> {
    return this.ensureAt(place);
  }

  /** Makes sure the app is at `place`; false when it can't be (the branch ends, or a stop is thrown). */
  private async ensureAt(place: string): Promise<boolean> {
    const tree = await this.read();
    if (this.observe(tree).place.name === place) return true;
    return this.reachPlace(place);
  }

  // -- a crash (§25.9)

  private async onCrash(place: string, sig: string | null, step: PathStep, after: Since): Promise<void> {
    if (sig !== null) this.host.map.markTried(place, sig, { result: "crash" });
    const crash = after.crash;
    if (crash !== null) {
      const parsed = crashFacts(crash);
      await this.finding("crash", place, [step], {
        expected: "the screen opens and the app stays open",
        got: `the app crashed: ${parsed.line}`,
        picture: false,
        crash: parsed.crash,
        ...(parsed.components.length > 0 ? { component_stack: parsed.components } : {}),
        logs: [],
      });
    } else {
      await this.finding("crash", place, [step], {
        expected: "the screen opens and the app stays open",
        got: "the app disconnected (it may have crashed)",
        picture: false,
        crash: { reason: "the app disconnected (it may have crashed)", frames: [] },
        logs: [],
      });
    }
    if (!this.args.continue) throw new Stop("crash");
    // With `continue`, it goes on only when the app is open again (§28.4).
    const back = await this.host.waitForApp(this.graceMs);
    if (!back) throw new Stop("app_closed");
    this.resetsInARow = 0;
  }

  // -- findings

  private pathTo(place: string | null): { from: string | null; steps: PathStep[] } {
    if (place === null || this.startPlace === null) return { from: place, steps: [] };
    const steps: PathStep[] = [];
    let at = place;
    for (let n = 0; n < 64 && at !== this.startPlace; n++) {
      const hop = this.via.get(at);
      if (hop === undefined) {
        const road = this.mapPath(this.startPlace, at);
        if (road === null) return { from: place, steps: [] };
        return { from: this.startPlace, steps: [...road, ...steps] };
      }
      steps.unshift(...(hop.before ?? []), hop.step);
      at = hop.from;
    }
    return at === this.startPlace ? { from: this.startPlace, steps } : { from: place, steps: [] };
  }

  private mapPath(from: string, to: string): PathStep[] | null {
    const map = this.host.map;
    const chain = cheapestWay(map.data().roads, from, to, (road) => map.isProven(road));
    if (chain === null) return null;
    const steps: PathStep[] = [];
    for (const leg of chain) {
      if (isRouteLeg(leg)) return null;
      steps.push(stepOfRoad(leg));
    }
    return steps;
  }

  private async finding(
    kind: FindingKind,
    place: string | null,
    own: PathStep[],
    detail: { expected: string; got: string; picture: boolean; logs?: LogEntry[] | string[]; crash?: { reason: string; frames: string[] }; component_stack?: string[] },
  ): Promise<void> {
    const info = this.host.info();
    if (info === null) return;
    const path = this.pathTo(place);
    const logs = (detail.logs ?? []).map((line) => (typeof line === "string" ? line : logLine(line)));
    const draft: FindingDraft = {
      kind,
      app: info.app,
      app_version: info.appVersion,
      build: info.build,
      tool: "tapline",
      tool_version: EXPLORE_TOOL_VERSION,
      when: this.host.wall().toISOString(),
      device: info.device,
      place,
      path_from: path.from,
      path: [...path.steps, ...(this.typedSteps.get(place ?? "") ?? []).filter((typed) => !own.includes(typed)), ...own],
      expected: detail.expected,
      got: detail.got,
      logs: logs.slice(-LOG_LINES_MAX),
      ...(detail.crash !== undefined ? { crash: detail.crash } : {}),
      ...(detail.component_stack !== undefined ? { component_stack: detail.component_stack } : {}),
    };
    // Every text goes through the redaction first; the cuts come after it (§27.2).
    const redacted = redactFinding(draft, (text) => this.host.redact(text));
    redacted.logs = redacted.logs.map((line) => cutText(line, LOG_LINE_MAX));
    const { finding, isNew } = this.findings.add(redacted);
    if (!isNew) return;
    // A picture of the screen at the moment (small, and private: this tool can't know a test app, §27.2).
    if (detail.picture) {
      try {
        const bytes = await this.host.picture();
        if (bytes !== null) finding.picture = { file: this.folder.fileIn("findings", `${finding.id}.jpg`, bytes), private: true };
      } catch {
        // no picture is no finding
      }
    }
    try {
      finding.repro = this.folder.fileIn("repro", `${finding.id}.json`, `${JSON.stringify(redactFinding(reproScript(finding), (text) => this.host.redact(text)), null, 2)}\n`);
    } catch {
      // a repro that can't be written leaves the finding as it is
    }
  }

  /** What a new place gets once per run: the accessibility audit and the usability check, one finding each (§25.10). */
  private async firstVisit(place: string, tree: TreeResult): Promise<void> {
    void tree;
    const a11y = await this.host.audit();
    if (a11y !== null && a11y.length > 0) {
      await this.finding("a11y", place, [], { expected: "no accessibility issues", got: a11y.slice(0, A11Y_LINES_MAX).join("\n"), picture: true });
    }
    const ux = await this.host.ux();
    if (ux !== null && ux.length > 0) {
      await this.finding("ux", place, [], { expected: "no usability issues", got: ux.slice(0, A11Y_LINES_MAX).join("\n"), picture: true });
    }
  }

  // -- the end

  /** Places known up front that no visit has saved (§25.10, §25.11). */
  private async unreachable(): Promise<void> {
    const known = await this.host.known();
    const saved = Object.values(this.host.map.data().places);
    for (const place of known.places) {
      if (saved.some((own) => samePlace(own.key, { route: place.route }))) continue;
      const name = placeNameFromRoute(place.route);
      await this.finding("unreachable", name === "" ? null : name, [], { expected: "the place can be reached", got: `no road reached ${name === "" ? place.route.join("/") : name}`, picture: false });
    }
  }

  private async outcome(stopped: StopReason): Promise<ExploreOutcome> {
    const info = this.host.info();
    const known = await this.host.known().catch((): KnownPlaces => ({ source: "none", places: [] }));
    const saved = Object.values(this.host.map.data().places);
    const coverage: ExploreReport["coverage"] = { places: this.seen.size, frontier_left: this.frontierLeft() };
    if (known.places.length > 0) {
      const reached = known.places.filter((place) => saved.some((own) => samePlace(own.key, { route: place.route })));
      const missing = known.places.filter((place) => !reached.includes(place));
      const areas: Record<string, { known: number; visited: number }> = {};
      for (const place of known.places) {
        const area = areaOf(place.route);
        const entry = areas[area] ?? { known: 0, visited: 0 };
        entry.known += 1;
        if (reached.includes(place)) entry.visited += 1;
        areas[area] = entry;
      }
      coverage.known_up_front = known.places.length;
      coverage.reached = reached.length;
      coverage.not_reached = missing.map((place) => placeNameFromRoute(place.route) || place.route.join("/")).sort();
      coverage.areas = areas;
    }
    const ended = this.host.wall();
    const minutes = Math.round(this.minutesUsed() * 10) / 10;
    const report: ExploreReport = {
      format: "agent-tools-explore-report",
      version: 1,
      app: info?.app ?? "unknown",
      build: info?.buildLabel ?? "unknown",
      tool: "tapline",
      tool_version: EXPLORE_TOOL_VERSION,
      started: isoSeconds(this.startedWall),
      ended: isoSeconds(ended),
      stopped,
      start_place: this.startPlace,
      budget: { minutes: this.args.minutes, steps: this.args.steps, depth: this.args.depth },
      used: { minutes, steps: this.steps },
      coverage,
      findings: this.findings.all(),
      skipped: this.skipped,
      notes: this.notes,
      resets: this.resets,
    };
    return { report, leftAt: this.leftAt, findingsLine: this.findings.summary(), ...(this.stopDetail !== undefined ? { detail: this.stopDetail } : {}) };
  }

  private frontierLeft(): number {
    let n = 0;
    for (const place of this.seen) n += this.host.map.frontier(place).length;
    return n;
  }
}

// -- facts from the app

const firstLineOf = (text: string): string => text.split("\n")[0] ?? "";

function toggleName(el: TreeElement): string {
  return filled(el.testID) ? `id=${el.testID}` : filled(el.label) ? `label=${JSON.stringify(el.label)}` : filled(el.text) ? `text=${JSON.stringify(el.text)}` : "a toggle";
}

/** A road's move as a step of a path: the target by id, else label, else text; a row as `{row: true, index: 1}` (§27.1). */
function stepOfRoad(road: MapRoad): PathStep {
  const move = road.move;
  if (move.tool === "back" || move.tool === "open_url") return { tool: move.tool, ...(move.url !== undefined ? { url: move.url } : {}) };
  const t = move.target;
  if (t === undefined) return { tool: move.tool };
  if (t.row === true) return { tool: move.tool, target: { row: true, index: 1 } };
  if (t.id !== undefined) return { tool: move.tool, target: { id: t.id } };
  if (t.label !== undefined) return { tool: move.tool, target: { label: t.label } };
  if (t.text !== undefined) return { tool: move.tool, target: { text: t.text } };
  if (t.x !== undefined && t.y !== undefined) return { tool: move.tool, target: { x: t.x, y: t.y } as PathStep["target"] };
  return { tool: move.tool };
}

/** The smallest scroll view that holds a frame: the list a row belongs to. */
function owningScroll(scrolls: readonly TreeElement[], frame: NonNullable<TreeElement["frame"]>): TreeElement | undefined {
  return scrolls.filter((s) => s.frame !== null && s.frame !== undefined && contains(s.frame, frame)).sort((a, b) => num(a.frame?.width) * num(a.frame?.height) - num(b.frame?.width) * num(b.frame?.height))[0];
}

/** The first line of an error, redacted whole and cut after (a value cut in two would no longer match the redaction). */
export function errorLine(entry: LogEntry, redact: (text: string) => string): string {
  const clean = redact(entry.message);
  return (clean.split("\n")[0] ?? clean).slice(0, 300);
}

/** `HH:MM:SS.mmm error text`, as `logs` shows a line (§15.1). */
function logLine(entry: LogEntry): string {
  const d = new Date(entry.ts ?? 0);
  const two = (n: number): string => String(n).padStart(2, "0");
  const when = entry.ts === undefined ? "--:--:--.---" : `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
  const text = `${entry.message}${entry.stack !== undefined && entry.stack !== "" && entry.stack !== entry.message ? `\n${entry.stack}` : ""}`.replace(/\s*\n\s*/g, " | ").trim();
  return `${when} error ${text}`;
}

const base = (file: string): string => file.split(/[\\/]/).pop() ?? file;

/** The crash as a finding holds it (§27.1): the reason, the top 8 frames with the app's own marked `*`, the component names. */
export function crashFacts(crash: CrashRecord): { line: string; crash: { reason: string; frames: string[] }; components: string[] } {
  const type = crash.message.startsWith(`${crash.name}:`) ? "" : `${crash.name}: `;
  const message = `${type}${crash.message}`.replace(/\s+/g, " ").trim();
  const frames: string[] = [];
  for (const raw of crash.stack.split("\n")) {
    const text = raw.trim();
    const at = /^at\s+(?:(.*?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/.exec(text);
    const jsc = at === null ? /^([^@\s:]*)@(.+?)(?::(\d+))?(?::(\d+))?$/.exec(text) : null;
    const match = at !== null && /^at\s/.test(text) ? at : jsc;
    if (match === null) continue;
    const fn = match[1] ?? "";
    const file = (match[2] ?? "").replace(/^address at\s+/, "");
    const line = match[3];
    const own = file !== "" && file !== "native" && file !== "[native code]" && !/[\\/]node_modules[\\/]/.test(file) && !/^https?:/.test(file) && !/\.(?:js)?bundle(?:[?#]|$)/.test(file);
    frames.push(`${own ? "*" : ""}${base(file)}${line !== undefined ? `:${line}` : ""}${fn !== "" ? ` ${fn}` : ""}`);
  }
  const components = (crash.componentStack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => /^(?:at|in)\s+([\w$.]+)/.exec(l)?.[1] ?? l)
    .slice(0, 12);
  return { line: message, crash: { reason: message.split(" (")[0] ?? message, frames: frames.slice(0, CRASH_FRAMES_MAX) }, components };
}

/** Type guard used by tests and tools: an outcome, not a start error. */
export const isOutcome = (value: ExploreOutcome | { error: string }): value is ExploreOutcome => "report" in value;

export type { Finding, SkipWhy };
