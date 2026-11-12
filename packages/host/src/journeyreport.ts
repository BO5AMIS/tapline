import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShotImage } from "./annotate.js";
import { jpegOf, markBox, markRing, readPixels, type ShareBox } from "./images.js";
import { GIF_MAX_BYTES, encodeJourneyGif, type GifFrame } from "./journeygif.js";
import { formatDuration, personaWords, summaryLine, summaryNotes, type JourneyState, type JourneyStep } from "./journey.js";
import type { UxAction, UxFindingSummary } from "./uxcheck.js";

/**
 * The journey's visual report (AGENT-TOOLS 1.12 §17.5): the frames kept after each counted step, the findings, and
 * the folder written at `stop`: `report.md`, `report.html`, `frames/`, `findings/`, `journey.gif`, `key-1.jpg`,
 * `key-2.jpg`. Pictures stay in files; only the two key pictures reach the agent.
 */

export const FRAME_WIDTH = 360;
/** The report lists this many findings at most (the worst first) and says how many more there were; it never blocks `stop`. */
export const MAX_FINDINGS = 100;
/** `ux_check` findings kept (each with a picture) while the journey runs. */
const MAX_SEEN = 300;
const FRAME_QUALITY = 0.7;

// ---- frames -------------------------------------------------------------------

/** What the app showed at one moment, from a cheap read that touches nothing. */
export interface Peek {
  /** Hash of what is on screen: same hash, same screen. */
  signature: string;
  screen?: { w: number; h: number };
  route: string[];
}

/** Where the recorder gets its pictures: the host's requests to the app, or a fake in tests. */
export interface FrameSource {
  /** Whether the journey's app is connected and in front: frames are only taken then. */
  where(): "front" | "background" | "disconnected" | "other";
  peek(): Promise<Peek | undefined>;
  shot(width: number, quality: number): Promise<ShotImage | undefined>;
}

/** The screen's elements as one hash: texts, values, positions and the route, not refs. */
export function screenSignature(
  elements: ReadonlyArray<{ role?: string | null; text?: string | null; label?: string | null; value?: unknown; frame?: { x: number; y: number; width: number; height: number } | null }>,
  route: string[],
  alerts: number,
): string {
  const hash = createHash("sha1");
  hash.update(JSON.stringify([route, alerts, elements.map((e) => [e.role ?? "", e.text ?? "", e.label ?? "", typeof e.value === "string" || typeof e.value === "number" || typeof e.value === "boolean" ? e.value : "", e.frame ? [Math.round(e.frame.x), Math.round(e.frame.y), Math.round(e.frame.width), Math.round(e.frame.height)] : null])]));
  return hash.digest("hex");
}

/** Where a step touched, in points, and the frame of the element it touched. */
export interface Touch {
  point?: { x: number; y: number };
  frame?: { x: number; y: number; width: number; height: number };
}

export interface FrameRecord {
  /** 1-based, in the order kept. */
  n: number;
  /** The step this frame follows; 0 is the screen at the start. */
  step: number;
  /** Relative to the report folder. */
  file: string;
  at: number;
  /** The journey's screen number. */
  screen: number | undefined;
  signature: string;
  /** Where the step touched and the touched element's box, as shares of the screen. */
  tap?: { x: number; y: number };
  box?: ShareBox;
}

/** One finding of a `ux_check` the agent made during the journey, with its marked-up picture. */
export interface SeenFinding extends UxFindingSummary {
  screen: number | undefined;
  title: string;
  /** Relative path of the picture with the red box. */
  shot?: string;
}

export class JourneyRecorder {
  readonly frames: FrameRecord[] = [];
  readonly seen: SeenFinding[] = [];
  /** Skipped frames: the list hadn't changed and nothing animated. */
  skipped = 0;
  /** Frames not taken because the journey's app was not connected and in front, by where it was. */
  readonly away = new Map<string, number>();
  private readonly actions = new Map<number, UxAction[]>();
  private queue: Promise<void> = Promise.resolve();
  private lastSignature: string | undefined;
  private uxCount = 0;
  /** A network condition a stress moment turned on, to put back at the stop. */
  networkStress = false;
  /** Times the app's photo picker was skipped (`media` with `picker`) during the journey. */
  pickerSkips = 0;
  pickerPictures = 0;

  constructor(
    readonly folder: string,
    private readonly source: FrameSource,
    private readonly clock: () => number,
  ) {
    mkdirSync(join(folder, "frames"), { recursive: true });
  }

  get name(): string {
    return this.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "journey";
  }

  /** Runs `work` after the ones before it: the pictures come in the order of the steps. */
  private later(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next.catch(() => undefined);
  }

  /**
   * Keeps a small picture of the screen after a step. Skipped when the element list is what it was and nothing
   * animates (AGENTS.md: don't look twice). Never fails the step.
   */
  frame(step: number, screen: number | undefined, touch: Touch | undefined, animating: boolean): Promise<void> {
    return this.later(async () => {
      const where = this.source.where();
      if (where !== "front") {
        this.away.set(where, (this.away.get(where) ?? 0) + 1);
        return;
      }
      const peek = await this.source.peek();
      if (peek !== undefined && peek.signature === this.lastSignature && !animating) {
        this.skipped++;
        return;
      }
      const shot = await this.source.shot(FRAME_WIDTH, FRAME_QUALITY);
      if (shot === undefined) return;
      const n = this.frames.length + 1;
      const file = `frames/${String(n).padStart(3, "0")}.jpg`;
      writeFileSync(join(this.folder, file), Buffer.from(shot.data, "base64"));
      const size = peek?.screen;
      const share = (x: number, w: number, extent: number): [number, number] => [x / extent, w / extent];
      const record: FrameRecord = { n, step, file, at: this.clock(), screen, signature: peek?.signature ?? "" };
      if (touch !== undefined && size !== undefined && size.w > 0 && size.h > 0) {
        if (touch.point !== undefined) record.tap = { x: touch.point.x / size.w, y: touch.point.y / size.h };
        if (touch.frame !== undefined) {
          const [x, w] = share(touch.frame.x, touch.frame.width, size.w);
          const [y, h] = share(touch.frame.y, touch.frame.height, size.h);
          record.box = { x, y, w, h };
          record.tap ??= { x: x + w / 2, y: y + h / 2 };
        }
      }
      this.frames.push(record);
      this.lastSignature = peek?.signature;
    });
  }

  /** The action labels of the screens seen before `current`, for `ux_check`'s naming check. */
  earlier(current: number | undefined): UxAction[] {
    const out: UxAction[] = [];
    for (const [screen, list] of this.actions) if (screen !== current) out.push(...list);
    return out;
  }

  /** A `ux_check` was made: keep its actions, and a picture per finding with the element boxed in red. */
  uxSeen(
    screen: number | undefined,
    title: string,
    actions: UxAction[],
    findings: UxFindingSummary[],
  ): Promise<void> {
    if (this.source.where() !== "front") return Promise.resolve();
    if (screen !== undefined) this.actions.set(screen, actions);
    const room = Math.max(0, MAX_SEEN - this.seen.length);
    const fresh = findings
      .filter((f) => !this.seen.some((s) => s.screen === screen && s.kind === f.kind && s.problem === f.problem && s.ref === f.ref))
      .slice(0, room);
    const mine: SeenFinding[] = fresh.map((f) => {
      const { frame: _frame, ...summary } = f;
      return { ...summary, screen, title };
    });
    this.seen.push(...mine);
    if (fresh.length === 0) return Promise.resolve();
    const k = ++this.uxCount;
    return this.later(async () => {
      const [peek, shot] = await Promise.all([this.source.peek(), this.source.shot(FRAME_WIDTH, FRAME_QUALITY)]);
      if (shot === undefined) return;
      const pixels = readPixels(shot);
      mkdirSync(join(this.folder, "findings"), { recursive: true });
      for (const [i, f] of fresh.entries()) {
        const target = mine[i];
        const size = peek?.screen;
        if (target === undefined) continue;
        const marked =
          f.frame !== undefined && size !== undefined && size.w > 0 && size.h > 0
            ? markBox(pixels, { x: f.frame.x / size.w, y: f.frame.y / size.h, w: f.frame.width / size.w, h: f.frame.height / size.h })
            : pixels;
        const file = `findings/ux-${k}-${i + 1}.jpg`;
        writeFileSync(join(this.folder, file), Buffer.from(jpegOf(marked).data, "base64"));
        target.shot = file;
      }
    });
  }

  /** Everything asked for is on disk. */
  done(): Promise<void> {
    return this.queue;
  }
}

// ---- findings -----------------------------------------------------------------

export type Severity = "high" | "medium" | "low";

export interface Finding {
  severity: Severity;
  kind: string;
  /** One line: what is wrong. */
  title: string;
  screen: number | undefined;
  basis: string;
  /** Relative path of the marked-up picture. */
  shot?: string;
}

/**
 * Simple rules, written in the report's footer. A `ux_check` kind not named here is low.
 */
export const SEVERITY_RULES = [
  "High: the goal wasn't reached; the app crashed or lost its connection; a stress moment wasn't survived; a screen leaves the user with no next step (an error or empty state with nothing to tap, or no way back).",
  "Medium: something blocked or misled the user (a touch a user couldn't make, an error, a wrong turn, more taps than a house rule allows, no clear main action, an icon-only button with no name, cut-off text, too many choices).",
  "Low: polish (contrast, small tap areas, thumb reach, the same action named differently, hesitation).",
];

const UX_SEVERITY: Readonly<Record<string, Severity>> = {
  dead_end: "high",
  way_back: "high",
  main_action: "medium",
  icon_only: "medium",
  cut_off_text: "medium",
  choices: "medium",
  contrast: "low",
  target_size: "low",
  thumb_reach: "low",
  naming: "low",
};

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function stepWords(step: JourneyStep): string {
  const target = step.target !== undefined ? ` ${step.target}` : "";
  return `${step.tool}${target}`;
}

/** The findings of a finished journey, worst first. `steps` pictures are filled in by `markSteps`. */
export function buildFindings(state: JourneyState, seen: readonly SeenFinding[], maxTaps: number | undefined): Finding[] {
  const out: Finding[] = [];
  const lastScreen = state.currentScreen;
  if (state.reached === false) {
    out.push({
      severity: "high",
      kind: "goal_not_reached",
      title: `The goal wasn't reached${state.why !== undefined ? `: ${state.why}` : "."}`,
      screen: lastScreen,
      basis: "journey result",
    });
  }
  for (const stress of state.stress) {
    if (stress.survived === false) {
      out.push({ severity: "high", kind: "stress", title: stress.said.replace(/^Stress: /, ""), screen: state.steps[stress.afterStep - 1]?.screen ?? lastScreen, basis: "stress moment" });
    }
  }
  const once = new Set<string>();
  for (const step of state.steps) {
    for (const flag of step.flags ?? []) {
      const key = `${flag}|${step.tool}|${step.target ?? ""}|${step.screen ?? ""}`;
      if (once.has(key)) continue;
      once.add(key);
      const at = `${stepWords(step)}: ${step.said}`;
      if (flag === "crash") out.push({ severity: "high", kind: "crash", title: `The app crashed or lost its connection at ${at}`, screen: step.screen, basis: `measured, step ${step.n}` });
      else if (flag === "error") out.push({ severity: "medium", kind: "error", title: `An error at ${at}`, screen: step.screen, basis: `measured, step ${step.n}` });
      else if (flag === "dead_end") out.push({ severity: "medium", kind: "dead_end_touch", title: `A touch a user couldn't make at ${at}`, screen: step.screen, basis: `measured, step ${step.n}` });
      else out.push({ severity: "medium", kind: "wrong_turn", title: `A wrong turn: this screen was left by going back with nothing done on it (${at})`, screen: step.screen, basis: `measured, step ${step.n}` });
    }
  }
  if (maxTaps !== undefined && state.reached === true && state.tapsToGoal !== null && state.tapsToGoal > maxTaps) {
    out.push({
      severity: "medium",
      kind: "max_taps_to_goal",
      title: `The goal took ${state.tapsToGoal} taps; the house rule allows ${maxTaps}.`,
      screen: lastScreen,
      basis: `house rule: max_taps_to_goal ${maxTaps}`,
    });
  }
  for (const f of seen) {
    const shot = f.shot;
    out.push({
      severity: UX_SEVERITY[f.kind] ?? "low",
      kind: f.kind,
      title: f.problem,
      screen: f.screen,
      basis: f.basis,
      ...(shot !== undefined ? { shot } : {}),
    });
  }
  if (state.measures.hesitations >= 2) {
    out.push({ severity: "low", kind: "hesitation", title: `${state.measures.hesitations} hesitations: reads in a row with no action, a sign the screen didn't say what to do.`, screen: lastScreen, basis: "measured" });
  }
  return out.map((f, i) => ({ f, i })).sort((a, b) => ORDER[a.f.severity] - ORDER[b.f.severity] || a.i - b.i).map(({ f }) => f);
}

export function countFindings(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** `Findings: 2 high, 3 medium, 1 low.` or `Findings: none.` */
export function findingsLine(counts: Record<Severity, number>): string {
  const parts = (["high", "medium", "low"] as const).filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return `Findings: ${parts.length > 0 ? parts.join(", ") : "none"}.`;
}

// ---- the folder ---------------------------------------------------------------

/** `2026-11-12-1530-log-breakfast-by-scanning-its-barcode`, in the computer's local time. */
export function reportFolderName(goal: string, at: number): string {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  const slug = goal
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${stamp}-${slug === "" ? "journey" : slug}`;
}

/** A folder name that doesn't exist yet in `root` (`-2`, `-3` when the same goal ran in the same minute). */
export function freshFolder(root: string, goal: string, at: number): string {
  const base = reportFolderName(goal, at);
  let name = base;
  for (let n = 2; existsSync(join(root, name)); n++) name = `${base}-${n}`;
  return join(root, name);
}

export interface ReportResult {
  folder: string;
  name: string;
  findings: Finding[];
  counts: Record<Severity, number>;
  /** Files of the folder, relative, for the export. */
  files: string[];
  /** What an export uploads: the report, the GIF and the pictures the report uses; not every raw frame. */
  exportFiles: string[];
  /** The first picture of the path, for an export's comment when there is no GIF. */
  firstPicture: string | undefined;
  /** Findings beyond the 100 the report lists. */
  omitted: number;
  gif: { frames: number; bytes: number; dropped: number } | null;
  /** The key pictures, relative: where the journey ended, and the worst finding. */
  keys: string[];
  notes: string[];
}

function writeJpegFile(path: string, data: string): void {
  writeFileSync(path, Buffer.from(data, "base64"));
}

function readShot(folder: string, file: string): ShotImage | undefined {
  try {
    return { mime: "image/jpeg", data: readFileSync(join(folder, file)).toString("base64") };
  } catch {
    return undefined;
  }
}

/** The frame a step's finding shows: the one made after that step, else the nearest before it. */
function frameForStep(frames: readonly FrameRecord[], step: number): FrameRecord | undefined {
  let found: FrameRecord | undefined;
  for (const f of frames) if (f.step <= step) found = f;
  return found ?? frames[0];
}

/** Pictures for the findings that came from steps: the frame, with a red box at the touched element where there is one. */
function markSteps(folder: string, state: JourneyState, findings: Finding[], frames: readonly FrameRecord[]): void {
  mkdirSync(join(folder, "findings"), { recursive: true });
  findings.forEach((finding, i) => {
    if (finding.shot !== undefined) return;
    const stepNumber = /step (\d+)$/.exec(finding.basis)?.[1];
    const step = stepNumber !== undefined ? Number(stepNumber) : finding.kind === "goal_not_reached" || finding.kind === "max_taps_to_goal" ? state.steps.length : undefined;
    const stressStep = finding.kind === "stress" ? state.stress.find((s) => finding.title.startsWith(s.said.replace(/^Stress: /, "")))?.afterStep : undefined;
    const at = step ?? stressStep;
    if (at === undefined) return;
    const frame = frameForStep(frames, at);
    if (frame === undefined) return;
    const shot = readShot(folder, frame.file);
    if (shot === undefined) return;
    const file = `findings/${String(i + 1).padStart(2, "0")}-${finding.kind}.jpg`;
    let pixels = readPixels(shot);
    if (frame.step === at && frame.box !== undefined) pixels = markBox(pixels, frame.box);
    else if (frame.step === at && frame.tap !== undefined) pixels = markBox(pixels, { x: frame.tap.x - 0.06, y: frame.tap.y - 0.03, w: 0.12, h: 0.06 });
    writeJpegFile(join(folder, file), jpegOf(pixels).data);
    finding.shot = file;
  });
}

function buildGif(folder: string, frames: readonly FrameRecord[], maxBytes: number): ReportResult["gif"] {
  const gifFrames: GifFrame[] = [];
  for (const frame of frames) {
    const shot = readShot(folder, frame.file);
    if (shot === undefined) continue;
    gifFrames.push({ pixels: readPixels(shot), at: frame.at, ...(frame.tap !== undefined ? { tap: frame.tap } : {}) });
  }
  if (gifFrames.length === 0) return null;
  const gif = encodeJourneyGif(gifFrames, { maxBytes });
  writeFileSync(join(folder, "journey.gif"), gif.bytes);
  return { frames: gif.frames, bytes: gif.bytes.length, dropped: gif.dropped };
}

// ---- words --------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function screenName(state: JourneyState, n: number | undefined): string {
  if (n === undefined) return "no screen";
  const screen = state.screens[n - 1];
  if (screen === undefined) return `screen ${n}`;
  return `screen ${n}${screen.route.length > 0 ? ` (${screen.route.join(" › ")})` : ""}`;
}

function conditionWords(state: JourneyState): string {
  const parts = Object.entries(state.conditions).map(([k, v]) => `${k.replace("_", " ")} ${String(v)}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function resultWords(state: JourneyState): string {
  const base = state.reached === true ? "Reached" : "Not reached";
  return state.why !== undefined ? `${base}: ${state.why}` : base;
}

function numbersTable(state: JourneyState): Array<[string, string]> {
  const m = state.measures;
  const elapsed = (state.endedAt ?? state.startedAt) - state.startedAt;
  return [
    ["Taps", String(m.taps)],
    ["Taps to the goal", state.tapsToGoal === null ? "not reached" : String(state.tapsToGoal)],
    ["Typing", String(m.typing)],
    ["Scrolls", String(m.scrolls)],
    ["Screens entered", String(m.screensEntered)],
    ["Time", `${formatDuration(elapsed)} (${formatDuration(m.waitMs)} waiting)`],
    ["Wrong turns", String(m.wrongTurns)],
    ["Dead ends", String(m.deadEnds)],
    ["Errors hit", String(m.errors)],
    ["Hesitations", String(m.hesitations)],
  ];
}

function usedLines(state: JourneyState, rec: JourneyRecorder): string[] {
  const lines: string[] = [];
  if (state.shortcuts.length > 0) lines.push(`Shortcuts used (a person doesn't have these): ${state.shortcuts.map((s) => `${s.tool} ${JSON.stringify(s.what)}`).join(", ")}.`);
  if (rec.pickerSkips > 0) lines.push(`Photo picker skipped ${rec.pickerSkips === 1 ? "once" : `${rec.pickerSkips} times`} (${rec.pickerPictures} picture${rec.pickerPictures === 1 ? "" : "s"} handed over without the OS picker): picker skipped.`);
  if (state.eyesSwitchedAt !== undefined) lines.push("Eyes: agent. The agent turned a user's eyes off during the journey (it saw ids, labels and everything in the tree and could jump), so the numbers after that are not a user's.");
  return lines;
}

export interface Ctx {
  state: JourneyState;
  rec: JourneyRecorder;
  findings: Finding[];
  counts: Record<Severity, number>;
  /** Findings past the cap, not listed. */
  omitted: number;
  gif: ReportResult["gif"];
  maxTaps: number | undefined;
  textRules: readonly string[];
}

function pathScreens(ctx: Ctx): Array<{ n: number; title: string; picture?: string; steps: JourneyStep[] }> {
  return ctx.state.screens.map((screen) => ({
    n: screen.n,
    title: screenName(ctx.state, screen.n),
    ...(ctx.rec.frames.find((f) => f.screen === screen.n)?.file !== undefined ? { picture: ctx.rec.frames.find((f) => f.screen === screen.n)?.file as string } : {}),
    steps: ctx.state.steps.filter((s) => s.screen === screen.n),
  }));
}

function stepLine(step: JourneyStep): string {
  return `${step.n}. ${stepWords(step)}${step.ok ? "" : ` (failed${step.code !== undefined ? `: ${step.code}` : ""})`} — ${step.said}`;
}

function rulesLines(ctx: Ctx): string[] {
  const out: string[] = [];
  if (ctx.maxTaps !== undefined) out.push(`max_taps_to_goal: ${ctx.maxTaps}`);
  for (const rule of ctx.textRules) out.push(`${rule} (judged by the agent)`);
  return out;
}

export function renderMarkdown(ctx: Ctx): string {
  const { state } = ctx;
  const lines: string[] = [`# Journey report: ${state.goal}`, "", summaryLine(state), findingsLine(ctx.counts), ""];
  lines.push(`- Goal: ${state.goal}`, `- Persona: ${personaWords(state)}`, `- Conditions: ${conditionWords(state)}`, `- Result: ${resultWords(state)}`, "");
  if (ctx.gif !== null) lines.push("![The journey](journey.gif)", "");
  lines.push("## Numbers", "", "| Measure | Value |", "| --- | --- |", ...numbersTable(state).map(([k, v]) => `| ${k} | ${v} |`), "");
  lines.push("## The path", "");
  const screens = pathScreens(ctx);
  if (screens.length === 0) lines.push("No screen was listed during the journey.", "");
  for (const s of screens) {
    lines.push(`### ${s.title}`, "");
    if (s.picture !== undefined) lines.push(`![${s.title}](${s.picture})`, "");
    else lines.push("(no picture was kept for this screen)", "");
    for (const step of s.steps) lines.push(`- ${stepLine(step)}`);
    if (s.steps.length > 0) lines.push("");
  }
  lines.push("## Findings", "");
  if (ctx.findings.length === 0) lines.push("None.", "");
  if (ctx.omitted > 0) lines.push(`Showing the worst ${ctx.findings.length}; ${ctx.omitted} more findings are not listed.`, "");
  ctx.findings.forEach((f, i) => {
    lines.push(`### ${i + 1}. [${f.severity}] ${f.kind}`, "", f.title, "", `- Screen: ${screenName(state, f.screen)}`, `- Basis: ${f.basis}`, "");
    if (f.shot !== undefined) lines.push(`![Finding ${i + 1}](${f.shot})`, "");
  });
  if (state.stress.length > 0) {
    lines.push("## Stress moments", "", ...state.stress.map((s) => `- ${s.said}`), "");
  }
  const used = usedLines(state, ctx.rec);
  lines.push("## Shortcuts and eyes", "", ...(used.length > 0 ? used.map((l) => `- ${l}`) : ["- None: no shortcut was used, and the journey stayed in a user's eyes."]), "");
  const notes = summaryNotes(state).filter((l) => !used.includes(l) && !l.startsWith("Eyes:") && !l.startsWith("Shortcuts used"));
  if (notes.length > 0) lines.push("## Notes", "", ...notes.map((l) => `- ${l}`), "");
  const rules = rulesLines(ctx);
  if (rules.length > 0) lines.push("## House rules", "", ...rules.map((r) => `- ${r}`), "");
  lines.push("---", "", "How severity is chosen:", "", ...SEVERITY_RULES.map((r) => `- ${r}`), "");
  return lines.join("\n");
}

export function renderHtml(ctx: Ctx): string {
  const { state } = ctx;
  const e = escapeHtml;
  const img = (src: string, alt: string): string => `<img src="${e(src)}" alt="${e(alt)}" loading="lazy">`;
  const body: string[] = [`<h1>Journey report: ${e(state.goal)}</h1>`, `<p class="sum">${e(summaryLine(state))}<br>${e(findingsLine(ctx.counts))}</p>`];
  body.push(
    `<ul><li>Goal: ${e(state.goal)}</li><li>Persona: ${e(personaWords(state))}</li><li>Conditions: ${e(conditionWords(state))}</li><li>Result: ${e(resultWords(state))}</li></ul>`,
  );
  if (ctx.gif !== null) body.push(`<p>${img("journey.gif", "The journey")}</p>`);
  body.push("<h2>Numbers</h2>", `<table>${numbersTable(state).map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join("")}</table>`);
  body.push("<h2>The path</h2>");
  const screens = pathScreens(ctx);
  if (screens.length === 0) body.push("<p>No screen was listed during the journey.</p>");
  for (const s of screens) {
    body.push(`<h3>${e(s.title)}</h3>`);
    body.push(s.picture !== undefined ? `<p>${img(s.picture, s.title)}</p>` : "<p>(no picture was kept for this screen)</p>");
    if (s.steps.length > 0) body.push(`<ul>${s.steps.map((step) => `<li>${e(stepLine(step))}</li>`).join("")}</ul>`);
  }
  body.push("<h2>Findings</h2>");
  if (ctx.findings.length === 0) body.push("<p>None.</p>");
  if (ctx.omitted > 0) body.push(`<p>Showing the worst ${ctx.findings.length}; ${ctx.omitted} more findings are not listed.</p>`);
  ctx.findings.forEach((f, i) => {
    body.push(
      `<section class="finding ${f.severity}"><h3>${i + 1}. <span class="sev">${f.severity}</span> ${e(f.kind)}</h3><p>${e(f.title)}</p><p class="meta">Screen: ${e(screenName(state, f.screen))}<br>Basis: ${e(f.basis)}</p>${f.shot !== undefined ? `<p>${img(f.shot, `Finding ${i + 1}`)}</p>` : ""}</section>`,
    );
  });
  if (state.stress.length > 0) body.push("<h2>Stress moments</h2>", `<ul>${state.stress.map((s) => `<li>${e(s.said)}</li>`).join("")}</ul>`);
  const used = usedLines(state, ctx.rec);
  body.push("<h2>Shortcuts and eyes</h2>", `<ul>${(used.length > 0 ? used : ["None: no shortcut was used, and the journey stayed in a user's eyes."]).map((l) => `<li>${e(l)}</li>`).join("")}</ul>`);
  const rules = rulesLines(ctx);
  if (rules.length > 0) body.push("<h2>House rules</h2>", `<ul>${rules.map((r) => `<li>${e(r)}</li>`).join("")}</ul>`);
  body.push(`<footer><p>How severity is chosen:</p><ul>${SEVERITY_RULES.map((r) => `<li>${e(r)}</li>`).join("")}</ul></footer>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journey report: ${e(state.goal)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--mute:#6b6b70;--line:#d8d8dc;--high:#c4261d;--medium:#b7791f;--low:#3b6ea5}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f2f2f4;--mute:#a0a0a8;--line:#38383c;--high:#ff6b62;--medium:#e5b04a;--low:#7ab0e8}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem 16px 3rem}
img{max-width:100%;width:360px;height:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse}th,td{text-align:left;padding:.2rem .8rem .2rem 0;border-bottom:1px solid var(--line)}
.sum{font-weight:600}.meta,footer{color:var(--mute);font-size:.9rem}
.finding{border-left:4px solid var(--line);padding-left:.8rem;margin:1rem 0}
.finding.high{border-color:var(--high)}.finding.medium{border-color:var(--medium)}.finding.low{border-color:var(--low)}
.finding.high .sev{color:var(--high)}.finding.medium .sev{color:var(--medium)}.finding.low .sev{color:var(--low)}
.sev{text-transform:uppercase;font-size:.8em;letter-spacing:.04em}
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

export interface WriteOptions {
  state: JourneyState;
  rec: JourneyRecorder;
  maxTaps: number | undefined;
  textRules?: readonly string[];
  gifMaxBytes?: number;
}

/** Writes the report folder: waits for the pictures asked for, then the findings, GIF, key pictures, `report.md` and `report.html`. */
export async function writeReport(options: WriteOptions): Promise<ReportResult> {
  const { state, rec } = options;
  const notes: string[] = [];
  await rec.done();
  const folder = rec.folder;
  mkdirSync(join(folder, "findings"), { recursive: true });
  const every = buildFindings(state, rec.seen, options.maxTaps);
  // The report lists the worst 100; the counts are of all of them.
  const findings = every.slice(0, MAX_FINDINGS);
  const omitted = every.length - findings.length;
  markSteps(folder, state, findings, rec.frames);
  const counts = countFindings(every);
  for (const [where, n] of rec.away) notes.push(`Note: ${n} frame${n === 1 ? " was" : "s were"} not kept because the app was ${where === "background" ? "in the background" : where === "disconnected" ? "not connected" : "not the journey's app"}.`);
  let gif: ReportResult["gif"] = null;
  try {
    gif = buildGif(folder, rec.frames, options.gifMaxBytes ?? GIF_MAX_BYTES);
  } catch (error) {
    notes.push(`Note: the GIF could not be made: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rec.frames.length === 0) notes.push("Note: no pictures were kept (the app can't take screenshots, or none came back); add react-native-view-shot.");

  const keys: string[] = [];
  const last = rec.frames[rec.frames.length - 1];
  if (last !== undefined) {
    // Where the goal was reached, or where the journey stopped: with the last tap ringed, as the GIF shows it.
    const shot = readShot(folder, last.file);
    if (shot !== undefined) {
      const pixels = readPixels(shot);
      const marked = last.tap !== undefined ? markRing(pixels, last.tap) : pixels;
      writeJpegFile(join(folder, "key-1.jpg"), jpegOf(marked).data);
      keys.push("key-1.jpg");
    }
  }
  const worst = findings.find((f) => f.shot !== undefined);
  if (worst?.shot !== undefined) {
    copyFileSync(join(folder, worst.shot), join(folder, "key-2.jpg"));
    keys.push("key-2.jpg");
  }

  const ctx: Ctx = { state, rec, findings, counts, omitted, gif, maxTaps: options.maxTaps, textRules: options.textRules ?? [] };
  const markdown = renderMarkdown(ctx);
  writeFileSync(join(folder, "report.md"), markdown, "utf8");
  writeFileSync(join(folder, "report.html"), renderHtml(ctx), "utf8");
  // An export uploads the report, its GIF and the pictures the report uses, not every raw frame.
  const used = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "").filter((p) => p !== "" && existsSync(join(folder, p)));
  const exportFiles = [...new Set(["report.md", "report.html", ...used])].sort();
  const firstPicture = used.find((p) => p.startsWith("frames/"));
  return { folder, name: rec.name, findings, counts, files: listFiles(folder), exportFiles, firstPicture, omitted, gif, keys, notes };
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSyncSafe(join(root, rel))) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory) out.push(...listFiles(root, path));
    else out.push(path);
  }
  return out.sort();
}


function readdirSyncSafe(dir: string): Array<{ name: string; isDirectory: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch {
    return [];
  }
}
