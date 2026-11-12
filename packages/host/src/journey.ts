import { z } from "zod";

/**
 * `journey` (AGENT-TOOLS 1.12 §17.1): the state of the one journey an agent has running, and what the host measures
 * from the agent's calls. This module holds no I/O. `TaplineTools` feeds it each call's outcome and each full list
 * the agent was given; the report writer (§17.5) and the stress moments (§17.4) read the same state.
 */

// ---- input ------------------------------------------------------------------

export const TEXT_SIZES = ["xs", "s", "m", "l", "xl", "xxl", "xxxl", "ax1", "ax2", "ax3", "ax4", "ax5", "system"] as const;
export const NETWORK_CONDITIONS = ["offline", "3g", "lossy"] as const;

/** The 1.4 conditions a journey may start under. */
export const conditionsSchema = z
  .object({
    language: z.string().min(2).max(35).optional().describe('BCP 47 code, e.g. "ar"'),
    region: z.string().length(2).optional().describe('ISO 3166 country code, e.g. "QA"'),
    text_size: z.enum(TEXT_SIZES).optional().describe("xs to xxxl, ax1 to ax5"),
    network: z.enum(NETWORK_CONDITIONS).optional().describe("offline, 3g or lossy"),
  })
  .strict();
export type Conditions = z.infer<typeof conditionsSchema>;

/** Where a finished journey's report goes, when the user asked for it (§17.5). */
export const exportSchema = z
  .object({
    to: z.enum(["pr", "issue"]),
    repo: z.string().min(3).max(140),
    pr: z.number().int().min(1).optional(),
    confirm: z.boolean().optional().describe("true: your user asked for this export (it writes to their GitHub)"),
    public: z.boolean().optional().describe("true: the repository is public and the report may be written there"),
    fork: z.boolean().optional().describe("With to: pr: true when the pull request's branch is in another repository (a fork) and the report may be written there"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.to === "issue" && value.fork !== undefined) ctx.addIssue({ code: "custom", message: 'export to "issue" takes no fork.' });
    if (value.to === "pr" && value.pr === undefined) ctx.addIssue({ code: "custom", message: 'export to "pr" needs the pull request number: pr.' });
    if (value.to === "issue" && value.pr !== undefined) ctx.addIssue({ code: "custom", message: 'export to "issue" takes no pr.' });
  });
export type JourneyExport = z.infer<typeof exportSchema>;

/** A stress moment (§17.4). Only the shape is built; the moments come with their own module. */
export const stressSchema = z
  .object({
    kind: z.enum(["background", "network", "double_tap", "rotate", "relaunch"]),
    mode: z.enum(["offline", "3g", "lossy", "normal"]).optional().describe("With network: the condition that starts mid-flow"),
    target: z
      .object({ ref: z.string().optional(), text: z.string().optional(), x: z.number().optional(), y: z.number().optional() })
      .strict()
      .optional()
      .describe("With double_tap: what to touch twice"),
  })
  .strict();
export type Stress = z.infer<typeof stressSchema>;

/** What must still be there after a stress moment (§17.4). */
export const survivesSchema = z.object({ text: z.string().optional(), goal_step: z.string().optional() }).strict();
export type Survives = z.infer<typeof survivesSchema>;

export const EYES = ["user", "agent"] as const;
export type Eyes = (typeof EYES)[number];

/** Shortcuts a journey may name in `allow` besides app commands. */
export const OPEN_URL = "open_url";

// ---- state ------------------------------------------------------------------

/** One screen the agent was shown in full: the first full list of a route, kept for the report. */
export interface JourneyScreen {
  /** 1-based, in the order the journey first reached them. */
  n: number;
  /** The route names (`Route:` line), or `[]` when the app has no router. */
  route: string[];
  /** The first full list the agent was given for this screen (the text, as answered). */
  firstList: string;
  /** How many times the journey entered this screen. */
  visits: number;
  /** Clock time of the first entry, ms. */
  at: number;
}

/** What the measures counted a call as, for the report's findings. */
export type StepFlag = "wrong_turn" | "dead_end" | "error" | "crash";

/** One call the agent made during the journey: the list the report's path and the GIF frames are built from. */
export interface JourneyStep {
  /** Set when the call was a wrong turn, a dead end, an error or a crash. */
  flags?: StepFlag[];
  n: number;
  tool: string;
  /** The target as the agent wrote it, in words (`"Save"`, `e3`, `120,300`), when it gave one. */
  target?: string;
  ok: boolean;
  code?: string;
  /** The first line of the answer. */
  said: string;
  /** Clock time the call began, ms, and how long it took. */
  at: number;
  ms: number;
  /** Index into `screens` (1-based `n`) of the screen the call ended on. */
  screen: number | undefined;
}

export interface JourneyMeasures {
  taps: number;
  typing: number;
  scrolls: number;
  /** Times a screen was entered (the same screen twice counts twice). */
  screensEntered: number;
  wrongTurns: number;
  deadEnds: number;
  errors: number;
  hesitations: number;
  /** Time spent waiting, ms: `wait`, `wait_for` and the `Settled in` time of actions. */
  waitMs: number;
}

/** A shortcut a person doesn't have, that `allow` let through. */
export interface UsedShortcut {
  tool: "open_url" | "app_command";
  /** The url, or the command's name. */
  what: string;
}

/** A condition as it was applied, and what undoing it did. */
export interface ConditionRecord {
  name: keyof Conditions;
  value: string;
  applied: boolean;
  /** Why it wasn't applied. */
  failure?: string;
  /** What the app said the value was before (language, region), when it said. */
  previous?: string;
  undone?: boolean;
  /** What undoing it did or why it didn't: a line for the stop answer. */
  undo?: string;
}

/** One stress moment (§17.4): what was done and whether what had to survive did. */
export interface StressResult {
  kind: Stress["kind"];
  /** The answer's sentence, `Stress: background; it survived: …`. */
  said: string;
  /** null: nothing was asked to survive, so nothing was checked. */
  survived: boolean | null;
  /** The count of steps made before it, to find its screen. */
  afterStep: number;
  at: number;
}

export interface JourneyState {
  goal: string;
  persona: string | undefined;
  conditions: Conditions;
  allow: string[];
  /** `"user"` until the agent turns it off; `eyesSwitchedAt` says when (the report says so). */
  eyes: Eyes;
  startedAt: number;
  eyesSwitchedAt?: number;
  endedAt?: number;
  reached?: boolean;
  why?: string;
  /** `taps` at the moment the goal was reached; null when it wasn't. */
  tapsToGoal: number | null;
  measures: JourneyMeasures;
  screens: JourneyScreen[];
  steps: JourneyStep[];
  shortcuts: UsedShortcut[];
  conditionRecords: ConditionRecord[];
  /** The stress moments (§17.4) and how the app took them. */
  stress: StressResult[];
  /** A network condition a stress moment set and that is still on: undone at the stop, report or not. */
  networkStress: boolean;
  /** The route key of the screen the agent is on now. */
  currentScreen: number | undefined;
}

/** What `record` is told of one finished call. */
export interface CallOutcome {
  tool: string;
  target?: string;
  ok: boolean;
  code?: string;
  /** The whole answer's text. */
  text: string;
  at: number;
  ms: number;
}

/** The counters read before a call, since the call's own list may start a new screen. */
export interface Pre {
  screen: number | undefined;
  actionsOnScreen: number;
  /** The screen was entered during the journey (not the one it started on). */
  entered: boolean;
}

const ACTION_TOOLS: ReadonlySet<string> = new Set(["tap", "long_press", "type_text", "toggle"]);
const TAP_TOOLS: ReadonlySet<string> = new Set(["tap", "long_press", "toggle"]);
const SCROLL_TOOLS: ReadonlySet<string> = new Set(["scroll", "swipe"]);
const WAIT_TOOLS: ReadonlySet<string> = new Set(["wait", "wait_for"]);
/** Tools that only look: two or more in a row with no action in between is a hesitation. */
export const READ_TOOLS_FOR_HESITATION: ReadonlySet<string> = new Set(["look", "check_layout", "audit", "inspect", "logs", "crash", "compare_screen", "filmstrip"]);

const SETTLED = /^Settled in (\d+(?:\.\d+)?) s\.$/m;
const CRASH_NOTE = /^Note: the app (?:crashed|disconnected)/m;

export class Journey {
  readonly state: JourneyState;
  private actionsOnScreen = 0;
  private readStreak = 0;
  private readonly listeners: Array<(step: JourneyStep) => void> = [];

  constructor(
    init: { goal: string; persona?: string; conditions?: Conditions; allow?: string[]; eyes?: Eyes },
    private readonly clock: () => number,
  ) {
    this.state = {
      goal: init.goal,
      persona: init.persona,
      conditions: init.conditions ?? {},
      allow: init.allow ?? [],
      eyes: init.eyes ?? "user",
      startedAt: clock(),
      tapsToGoal: null,
      measures: { taps: 0, typing: 0, scrolls: 0, screensEntered: 0, wrongTurns: 0, deadEnds: 0, errors: 0, hesitations: 0, waitMs: 0 },
      screens: [],
      steps: [],
      shortcuts: [],
      conditionRecords: [],
      stress: [],
      networkStress: false,
      currentScreen: undefined,
    };
  }

  get userEyes(): boolean {
    return this.state.eyes === "user";
  }

  /** The report's (and the GIF's) hook: told of every counted call as it is recorded. */
  onStep(listener: (step: JourneyStep) => void): void {
    this.listeners.push(listener);
  }

  /** `allow` names this shortcut (`open_url`, or an app command's name). */
  allows(name: string): boolean {
    return this.state.allow.includes(name);
  }

  noteShortcut(shortcut: UsedShortcut): void {
    this.state.shortcuts.push({ ...shortcut, what: withoutUrlSecrets(shortcut.what) });
  }

  pre(): Pre {
    return { screen: this.state.currentScreen, actionsOnScreen: this.actionsOnScreen, entered: this.state.measures.screensEntered > 1 };
  }

  /**
   * The agent was given a full list. `fromAction`: it came with an action's answer (most of the screen changed), not
   * from `look`. A new screen is a different route, or, in an app with no router, a full list after an action.
   */
  noteFullList(list: { route: string[]; text: string; fromAction: boolean }): void {
    const key = list.route.join(" › ");
    const current = this.state.currentScreen === undefined ? undefined : this.state.screens[this.state.currentScreen - 1];
    const same = current !== undefined && current.route.join(" › ") === key && !(list.route.length === 0 && list.fromAction);
    if (same) return;
    const known = list.route.length === 0 ? undefined : this.state.screens.find((s) => s.route.join(" › ") === key);
    this.state.measures.screensEntered++;
    this.actionsOnScreen = 0;
    if (known !== undefined) {
      known.visits++;
      this.state.currentScreen = known.n;
      return;
    }
    const n = this.state.screens.length + 1;
    this.state.screens.push({ n, route: list.route, firstList: list.text, visits: 1, at: this.clock() });
    this.state.currentScreen = n;
  }

  /** The agent's call has been answered: the measures. */
  record(outcome: CallOutcome, pre: Pre): void {
    const m = this.state.measures;
    const { tool, ok, code } = outcome;
    const screenChanged = this.state.currentScreen !== pre.screen;

    if (WAIT_TOOLS.has(tool)) m.waitMs += outcome.ms;
    else {
      const settled = SETTLED.exec(outcome.text);
      if (settled?.[1] !== undefined) m.waitMs += Math.round(Number(settled[1]) * 1000);
    }

    if (ok) {
      if (TAP_TOOLS.has(tool)) m.taps++;
      if (tool === "type_text") m.typing++;
      if (SCROLL_TOOLS.has(tool)) m.scrolls++;
    }
    if (ACTION_TOOLS.has(tool) && ok && !screenChanged) this.actionsOnScreen++;

    const flags: StepFlag[] = [];
    // A screen entered and left by `back` with no action on it (a sheet that closes is no screen).
    if (tool === "back" && ok && !/^Closed the sheet\./.test(outcome.text) && pre.entered && pre.actionsOnScreen === 0) {
      m.wrongTurns++;
      flags.push("wrong_turn");
    }

    if (code === "not_actionable" || code === "not_allowed") {
      m.deadEnds++;
      flags.push("dead_end");
    }
    if (code === "not_found" || CRASH_NOTE.test(outcome.text)) {
      m.errors++;
      flags.push(CRASH_NOTE.test(outcome.text) ? "crash" : "error");
    }

    // Hesitation: a run of two or more reads with no action. One counts at the second read.
    if (READ_TOOLS_FOR_HESITATION.has(tool)) {
      this.readStreak++;
      if (this.readStreak === 2) m.hesitations++;
    } else if (!WAIT_TOOLS.has(tool)) {
      this.readStreak = 0;
    }

    // What the agent typed is its own business (it may be a password the app hides): the step keeps the sentence without it.
    // The same for what a field holds: a tap or toggle on a filled input prints its value and placeholder too (finding 8).
    // A link may carry a sign-in token (`myapp://login?token=…`): only its scheme, host and path stay.
    const first = withoutUrlSecrets(withoutFieldText((outcome.text.split("\n")[0] ?? "").replace(tool === "type_text" ? / Value is now .*$/ : /(?!)/, "")));
    const step: JourneyStep = {
      n: this.state.steps.length + 1,
      tool,
      ...(outcome.target !== undefined ? { target: withoutUrlSecrets(outcome.target) } : {}),
      ok,
      ...(code !== undefined ? { code } : {}),
      said: first.length > 200 ? `${first.slice(0, 200)}…` : first,
      ...(flags.length > 0 ? { flags } : {}),
      at: outcome.at,
      ms: outcome.ms,
      screen: this.state.currentScreen,
    };
    this.state.steps.push(step);
    for (const listener of this.listeners) listener(step);
  }

  /** `stop`: fixes the end and the taps to the goal. */
  finish(reached: boolean, why: string | undefined): JourneyState {
    this.state.endedAt = this.clock();
    this.state.reached = reached;
    if (why !== undefined && why.trim() !== "") this.state.why = why.trim();
    this.state.tapsToGoal = reached ? this.state.measures.taps : null;
    return this.state;
  }

  switchEyes(): void {
    this.state.eyes = "agent";
    this.state.eyesSwitchedAt = this.clock();
  }
}

// ---- words ------------------------------------------------------------------

/** `52 s`, `1 min 52 s`, `2 min`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function personaWords(state: Pick<JourneyState, "persona">): string {
  return state.persona !== undefined && state.persona.trim() !== "" ? state.persona.trim() : "no persona";
}

/** The first line of the stop answer (§17.5): `Journey "…" as …: reached in 9 taps, 1 min 52 s (34 s waiting), 2 wrong turns, 3 hesitations.` */
export function summaryLine(state: JourneyState): string {
  const m = state.measures;
  const elapsed = (state.endedAt ?? state.startedAt) - state.startedAt;
  const numbers = [
    state.reached === true ? `reached in ${plural(state.tapsToGoal ?? m.taps, "tap")}` : `not reached after ${plural(m.taps, "tap")}`,
    `${formatDuration(elapsed)} (${formatDuration(m.waitMs)} waiting)`,
    plural(m.wrongTurns, "wrong turn"),
    plural(m.hesitations, "hesitation"),
  ];
  return `Journey "${state.goal}" as ${personaWords(state)}: ${numbers.join(", ")}.`;
}

/** The lines that follow the summary: what else was hit, what was used, what was and wasn't undone. */
export function summaryNotes(state: JourneyState): string[] {
  const m = state.measures;
  const lines: string[] = [];
  const hit: string[] = [];
  if (m.deadEnds > 0) hit.push(plural(m.deadEnds, "dead end"));
  if (m.errors > 0) hit.push(plural(m.errors, "error hit", "errors hit"));
  if (hit.length > 0) lines.push(`Also: ${hit.join(", ")}.`);
  if (state.why !== undefined) lines.push(`Why: ${state.why}`);
  if (state.eyesSwitchedAt !== undefined) lines.push("Eyes: the agent's, not a user's, from the moment it turned them off.");
  if (state.shortcuts.length > 0) {
    lines.push(`Shortcuts used (a person doesn't have these): ${state.shortcuts.map((s) => `${s.tool} ${JSON.stringify(s.what)}`).join(", ")}.`);
  }
  for (const record of state.conditionRecords) if (record.undo !== undefined) lines.push(record.undo);
  return lines;
}

/** Strips the ids a user's eyes must not show (` id=save`) from text the SDK composed (error messages, `Closest:` lists). */
export function withoutIds(text: string): string {
  return text.replace(/ id=[^\s,)]*[^\s,).]/g, "");
}

/**
 * Strips what a field holds (` value="…"`, ` placeholder="…"`, a quoted string with its escapes, or a bare number or
 * word) from a step's sentence: what was typed may be private, and the sentence goes into the report and the export.
 */
export function withoutFieldText(text: string): string {
  return text.replace(/ (?:value|placeholder)=(?:"(?:[^"\\]|\\.)*"(?:…\(\+\d+\))?|[^\s"]+)/g, "");
}

const URL_IN_TEXT = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g;
/** A path segment that looks like a token or an id worth hiding: 16 or more of letters, digits, - and _, with a digit. */
const SECRET_SEGMENT = /^(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}$/;

/**
 * Cuts what a link may carry that isn't the place it leads (a sign-in token, a reset code, a session): the query and
 * the fragment become `?…` and `#…`, a user and password before the host go, and a token-like path segment becomes
 * `…`. The scheme, host and the rest of the path stay, so the report still says where the link went.
 */
export function withoutUrlSecrets(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => {
    const trail = /[.,;:!?)\]]+$/.exec(url)?.[0] ?? "";
    const bare = trail === "" ? url : url.slice(0, -trail.length);
    const scheme = bare.slice(0, bare.indexOf("://") + 3);
    let rest = bare.slice(scheme.length);
    const hashAt = rest.indexOf("#");
    const fragment = hashAt >= 0 ? "#…" : "";
    if (hashAt >= 0) rest = rest.slice(0, hashAt);
    const queryAt = rest.indexOf("?");
    const query = queryAt >= 0 ? "?…" : "";
    if (queryAt >= 0) rest = rest.slice(0, queryAt);
    const slash = rest.indexOf("/");
    let authority = slash >= 0 ? rest.slice(0, slash) : rest;
    const path = slash >= 0 ? rest.slice(slash) : "";
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    const cleanPath = path
      .split("/")
      .map((segment) => (SECRET_SEGMENT.test(segment) ? "…" : segment))
      .join("/");
    return `${scheme}${authority}${cleanPath}${query}${fragment}${trail}`;
  });
}

/** The answer to `id` or `label` as a target in a journey (§17.1). */
export const IDS_HIDDEN = "Error bad_params: in a journey, ids and labels are hidden; use a ref or the visible text";
