import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ActionLogEntry } from "./actionlog.js";
import { SYSTEM_SHEETS, stripPaths, type BugFinding, type BugHow } from "./bug.js";
import { appFolderName, type BugMade, type BugStore, type BugText, type GateValues } from "./bugstore.js";
import { FINDING_KINDS, LOG_LINES_MAX, LOG_LINE_MAX, TYPED, cutText, redactFinding, reproScript, type Finding, type PathStep } from "./findings.js";
import type { MapRoad, PlaceKey } from "./mapfile.js";

// Making a bug (AGENT-TOOLS 1.16 §29.3): from a finding of an explore report, from the last failed check, or from the session's own action log.
// The tool wiring is in tools.ts; everything here takes what it needs as arguments.

/** What a bug needs from the host: where in the map a place is, what a road calls its elements, and what needs a person. */
export interface BugContext {
  store: BugStore;
  /** The single-pass redactor (§29.6): vault values, one-time codes and the session's typed values. */
  redact: BugText;
  /** The place's key from the map, or null. */
  placeKey(app: string, place: string | null): PlaceKey | null;
  /** The map's roads of an app. */
  roads(app: string): readonly MapRoad[];
  /** A step whose target carries a policy word (§11.1, §25.5). */
  needsPerson(app: string, step: PathStep): boolean;
  /** Values the gate also looks for by their forms (tests). */
  gateValues?: GateValues;
}

const home = (): string => homedir();

/** A path as a person reads it: `~/.tapline/...` when it is under the home folder. */
export function shownPath(path: string): string {
  const base = home();
  return path.startsWith(base) ? `~${path.slice(base.length)}`.replace(/\\/g, "/") : path;
}

// -- steps

const ELEMENT_TOOLS: ReadonlySet<string> = new Set(["tap", "long_press", "toggle", "type_text"]);

type Named = { id?: string; label?: string; text?: string };

/** The name a target has when it can be written down: by id, else label, else text (§18.2). Rows go by index. */
function nameOf(target: unknown): { id?: string; label?: string; text?: string; row?: true; index?: number } | null {
  if (typeof target !== "object" || target === null) return null;
  const t = target as Record<string, unknown>;
  const index = typeof t["index"] === "number" && Number.isInteger(t["index"]) && t["index"] >= 0 ? t["index"] : undefined;
  const by = (key: keyof Named): string | undefined => (typeof t[key] === "string" && t[key] !== "" ? (t[key] as string) : undefined);
  if (by("id") !== undefined) return { id: by("id") as string, ...(index !== undefined ? { index } : {}) };
  if (by("label") !== undefined) return { label: by("label") as string, ...(index !== undefined ? { index } : {}) };
  if (by("text") !== undefined) return { text: by("text") as string, ...(index !== undefined ? { index } : {}) };
  if (t["row"] === true) return { row: true, index: typeof t["index"] === "number" ? t["index"] : 1 };
  return null;
}

/** Whether a step can be written down for a person: a touch of an element needs an id, label, text or row; a swipe its points (§29.3). */
export function isWritable(step: PathStep): boolean {
  if (ELEMENT_TOOLS.has(step.tool)) return nameOf(step.target) !== null;
  if (step.tool === "swipe") return ["x0", "y0", "x1", "y1"].every((key) => typeof step[key] === "number");
  if (step.tool === "open_url") return typeof step["url"] === "string" && step["url"] !== "";
  return true;
}

/** The steps after the last one that can't be written down, and whether any were dropped (§29.3). A typed step keeps `${typed}` only. */
export function writablePath(steps: readonly PathStep[]): { steps: PathStep[]; cut: boolean } {
  let last = -1;
  steps.forEach((step, i) => {
    if (!isWritable(step)) last = i;
  });
  const kept = steps.slice(last + 1).map((step): PathStep => {
    if (step.tool !== "type_text") return step;
    const { text: _text, ...rest } = step;
    return { ...rest, text: TYPED };
  });
  return { steps: kept, cut: last >= 0 };
}

/** What the map's road with the same move calls the step's element (its label, else its text), or null (§29.1). */
export function roadName(roads: readonly MapRoad[], step: PathStep): string | null {
  const target = step.target;
  if (target === undefined || target.row === true) return null;
  for (const road of roads) {
    if (road.move.tool !== step.tool) continue;
    const t = road.move.target;
    if (t === undefined) continue;
    const same = (target.id !== undefined && t.id === target.id) || (target.label !== undefined && t.label === target.label) || (target.text !== undefined && t.text === target.text);
    if (!same) continue;
    const names = road.names;
    const name = names?.label ?? names?.text;
    if (typeof name === "string" && name !== "") return name;
  }
  return null;
}

// -- the finding of a bug

const FRAME_FILE = /^\*?([^\s:]+?)(?::(\d+))?(?::\d+)?\s/;

/** The source of the top app frame of a crash or a JS error: its file name and line (§29.8); never the text of the line. */
export function sourceOf(finding: Pick<BugFinding, "crash">): { file: string; line?: number } | null {
  const top = finding.crash?.frames.find((frame) => frame.startsWith("*"));
  if (top === undefined) return null;
  const match = FRAME_FILE.exec(`${stripPaths(top)} `);
  if (match === null || match[1] === undefined || !/\.[A-Za-z]+$/.test(match[1])) return null;
  return { file: match[1], ...(match[2] !== undefined ? { line: Number(match[2]) } : {}) };
}

/** A finding made safe for the page: every text redacted first, then cut (§29.6). */
export function cleanFinding(finding: BugFinding, redact: BugText): BugFinding {
  const safe = redactFinding(finding, redact);
  return {
    ...safe,
    path: safe.path.map((step) => (step.tool === "type_text" ? { ...step, text: TYPED } : step)),
    logs: safe.logs.slice(-LOG_LINES_MAX).map((line) => cutText(stripPaths(line), LOG_LINE_MAX)),
    ...(safe.crash !== undefined ? { crash: { reason: safe.crash.reason, frames: safe.crash.frames.slice(0, 8).map((frame) => stripPaths(frame)) } } : {}),
    ...(safe.system !== undefined && !(SYSTEM_SHEETS as readonly string[]).includes(safe.system) ? { system: "other" as const } : {}),
  };
}

export interface MakeArgs {
  finding: BugFinding;
  how: BugHow;
  /** `<run folder>/<finding id>`, or `failure/<when>` and `now/<when>` (§29.5). */
  sourceKey: string;
  run?: string;
  script?: Record<string, unknown> | null;
  picture?: Uint8Array | null;
  withPicture?: boolean;
  /** Earlier steps couldn't be written down. */
  stepsCut?: boolean;
  /** The 0-based steps whose text the app says others wrote. */
  others?: number[];
  reproduced?: Parameters<BugStore["make"]>[0]["reproduced"];
  notChecked: string;
}

/** Makes the bug (or adds a sighting). A gate that refuses throws `BugGateError`; nothing was written then. */
export function makeBug(ctx: BugContext, args: MakeArgs): BugMade {
  const finding = cleanFinding(args.finding, ctx.redact);
  const app = finding.app;
  const roads = ctx.roads(app);
  const names = finding.path.map((step) => {
    const name = roadName(roads, step);
    return name === null ? null : ctx.redact(name);
  });
  const needs = finding.path.flatMap((step, i) => (ctx.needsPerson(app, step) ? [i] : []));
  const source = sourceOf(finding);
  const script = args.script === undefined || args.script === null ? reproScript(finding as unknown as Pick<Finding, "id" | "app" | "path_from" | "path">) : args.script;
  const key = ctx.placeKey(app, finding.place);
  const route = key !== null && "route" in key ? `route ${key.route.join(" › ")}${key.tab !== undefined ? `, tab ${key.tab}` : ""}` : null;
  return ctx.store.make({
    finding,
    placeKey: key,
    source: { how: args.how, key: args.sourceKey, ...(args.run !== undefined ? { run: args.run } : {}), finding: finding.id, ...(source !== null ? { file: source.file, ...(source.line !== undefined ? { line: source.line } : {}) } : {}) },
    script: redactFinding(script, ctx.redact),
    picture: args.picture ?? null,
    withPicture: args.withPicture === true,
    extras: { names, route_text: route, ...(args.stepsCut === true ? { steps_cut: true } : {}), ...(args.others !== undefined ? { others: args.others } : {}), needs_person: needs },
    ...(args.reproduced !== undefined ? { reproduced: args.reproduced } : {}),
    notChecked: args.notChecked,
    redact: ctx.redact,
    ...(ctx.gateValues !== undefined ? { gateValues: ctx.gateValues } : {}),
  });
}

// -- an explore report folder

const RUN_NAME = /^\d{8}T\d{6}Z(?:-\d+)?$/;

/** The newest explore report folder of an app, or null. */
export function newestRun(exploreDir: string, app: string): string | null {
  try {
    const dir = join(exploreDir, appFolderName(app));
    const name = readdirSync(dir).filter((entry) => RUN_NAME.test(entry) && existsSync(join(dir, entry, "report.json"))).sort().at(-1);
    return name === undefined ? null : join(dir, name);
  } catch {
    return null;
  }
}

export type RunRead = { ok: true; finding: BugFinding; script: Record<string, unknown> | null; picture: Uint8Array | null; run: string } | { ok: false; code: "not_found" | "bad_params"; message: string };

const inside = (root: string, path: string): boolean => {
  const base = resolve(root);
  const full = resolve(path);
  return full === base || full.startsWith(base + sep);
};

/** Whether the file's real place (links followed) is inside the folder's real place; a file that isn't there is not. */
const insideReal = (root: string, path: string): boolean => {
  try {
    return inside(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Reads one finding, its script and its picture from an explore report folder (§25.10). A file the report names stays inside the folder. */
export function readRunFinding(runDir: string, findingId: string): RunRead {
  const reportPath = join(runDir, "report.json");
  if (!existsSync(runDir)) return { ok: false, code: "not_found", message: `no report folder ${shownPath(runDir)}.` };
  if (!existsSync(reportPath)) {
    return { ok: false, code: "bad_params", message: `${shownPath(runDir)} holds no report.json: only an explore report can be made into a bug. A journey's report has no findings.json in the shape of §27 yet.` };
  }
  let report: unknown;
  try {
    report = readJson(reportPath);
  } catch {
    return { ok: false, code: "bad_params", message: `${shownPath(reportPath)} can't be read.` };
  }
  const findings = typeof report === "object" && report !== null && Array.isArray((report as { findings?: unknown }).findings) ? ((report as { findings: unknown[] }).findings as Record<string, unknown>[]) : null;
  if (findings === null) return { ok: false, code: "bad_params", message: `${shownPath(reportPath)} is not an explore report.` };
  const found = findings.find((item) => item["id"] === findingId);
  if (found === undefined) {
    return { ok: false, code: "not_found", message: `no finding "${findingId}" in ${shownPath(runDir)}; its findings are ${findings.map((f) => String(f["id"])).join(", ") || "none"}.` };
  }
  const kind = found["kind"];
  if (typeof kind !== "string" || !(FINDING_KINDS as readonly string[]).includes(kind)) return { ok: false, code: "bad_params", message: `finding ${findingId} has a kind (${String(kind)}) a bug report doesn't take.` };
  const finding = found as unknown as BugFinding;
  let script: Record<string, unknown> | null = null;
  const repro = typeof found["repro"] === "string" ? found["repro"] : null;
  if (repro !== null && /^repro\/[\w.-]+$/.test(repro) && inside(runDir, join(runDir, repro)) && insideReal(runDir, join(runDir, repro))) {
    try {
      const parsed = readJson(join(runDir, repro));
      if (typeof parsed === "object" && parsed !== null) script = parsed as Record<string, unknown>;
    } catch {
      script = null;
    }
  }
  let picture: Uint8Array | null = null;
  if (finding.picture !== null && typeof finding.picture === "object" && /^findings\/[\w.-]+$/.test(finding.picture.file) && inside(runDir, join(runDir, finding.picture.file)) && insideReal(runDir, join(runDir, finding.picture.file))) {
    try {
      picture = readFileSync(join(runDir, finding.picture.file));
    } catch {
      picture = null;
    }
  }
  const name = runDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "run";
  return { ok: true, finding, script, picture, run: name };
}

// -- from the action log (§29.3)

/** The touches `from: "now"` takes from the log. */
const NOW_TOUCHES: ReadonlySet<string> = new Set(["tap", "long_press", "toggle", "type_text", "scroll", "swipe", "back", "open_url"]);
export const NOW_STEPS_MAX = 10;

export interface ObservedInput {
  entries: readonly ActionLogEntry[];
  app: string;
  note: string;
  expected?: string | undefined;
  info: { appVersion: string; build: string; device: { model: string; os: string }; toolVersion: string };
  when: Date;
  /** The current screen's place, as a look would name it. */
  place: string | null;
  logs: string[];
  picture: { file: string; private: boolean } | null;
}

/** One logged touch as a step, or null when it can't be written down. */
function stepOfEntry(entry: ActionLogEntry): PathStep | null {
  const extra = (entry as ActionLogEntry & { args?: Record<string, unknown> }).args ?? {};
  const named = nameOf(entry.target);
  const target = named === null || named.row === true ? null : named;
  switch (entry.tool) {
    case "tap":
    case "long_press":
    case "toggle":
      return target === null ? null : { tool: entry.tool, target };
    case "type_text":
      return target === null ? null : { tool: "type_text", target, text: TYPED };
    case "scroll":
      return { tool: "scroll", ...(typeof extra["direction"] === "string" ? { direction: extra["direction"] } : {}), ...(typeof extra["to"] === "string" ? { to: extra["to"] } : {}), ...(target !== null ? { target } : {}) };
    case "swipe":
      return ["x0", "y0", "x1", "y1"].every((key) => typeof extra[key] === "number") ? { tool: "swipe", x0: extra["x0"], y0: extra["y0"], x1: extra["x1"], y1: extra["y1"] } : null;
    case "back":
      return { tool: "back" };
    case "open_url":
      return typeof extra["url"] === "string" && extra["url"] !== "" ? { tool: "open_url", url: extra["url"] } : null;
    default:
      return null;
  }
}

/** The finding `from: "now"` makes from the last touches of the action log, or null when the log holds none (§29.3). */
export function observedFinding(input: ObservedInput): { finding: BugFinding; stepsCut: boolean; others: number[] } | null {
  const touches = input.entries.filter((entry) => NOW_TOUCHES.has(entry.tool) && entry.ok && entry.dry_run !== true && entry.kind !== "read" && (entry.app === undefined || entry.app === input.app)).slice(-NOW_STEPS_MAX);
  if (touches.length === 0) return null;
  let last = -1;
  const steps = touches.map((entry, i) => {
    const step = stepOfEntry(entry);
    if (step === null) last = i;
    return step;
  });
  const keptFrom = last + 1;
  const path: PathStep[] = [];
  const others: number[] = [];
  for (let i = keptFrom; i < touches.length; i++) {
    path.push(steps[i] as PathStep);
    const entry = touches[i] as ActionLogEntry;
    if (typeof entry.element === "string" && entry.element.includes("(from others)")) others.push(path.length - 1);
  }
  // Where the first kept step ran: its own move's start when the tool knew it, else the nearest later one, else (nothing moved) the place now.
  let from: string | null = null;
  for (let i = keptFrom; i < touches.length; i++) {
    const way = (touches[i] as ActionLogEntry).way;
    if (way !== undefined) {
      from = way.from;
      break;
    }
  }
  if (from === null && keptFrom < touches.length) from = input.place;
  const build = input.info.build;
  const finding: BugFinding = {
    id: "f1",
    kind: "observed",
    app: input.app,
    app_version: input.info.appVersion,
    build,
    tool: "tapline",
    tool_version: input.info.toolVersion,
    when: input.when.toISOString(),
    device: input.info.device,
    place: input.place,
    path_from: from,
    path,
    expected: input.expected ?? "(not given)",
    got: input.note,
    picture: input.picture,
    logs: input.logs,
    repro: null,
    count: 1,
  };
  return { finding, stepsCut: keptFrom > 0, others };
}

// -- the answer (§29.3)

const times = (n: number): string => `${n} ${n === 1 ? "time" : "times"}`;

/** The reproduction line: `Reproduced: 3 of 3 runs.` or `Reproduced: not checked.` with the reason for a check that couldn't run. */
export function reproducedAnswer(made: Pick<BugMade, "meta">, reasonShown: boolean): string {
  const r = made.meta.reproduced;
  if ("checked" in r) return reasonShown ? `Reproduced: not checked (${r.why}).` : "Reproduced: not checked.";
  return `Reproduced: ${r.n} of ${r.of} runs${r.n === 0 ? ": not reproduced" : r.n < r.of ? " (flaky)" : ""}.`;
}

export function bugAnswer(made: BugMade, redact: BugText, options: { reasonShown?: boolean } = {}): string {
  const s = made.meta.seen;
  const builds = s.builds.length === 1 ? `build ${s.builds[0]}` : `builds ${s.builds.join(", ")}`;
  const head = made.isNew ? `New bug: ${made.title}` : `Known bug (seen ${times(s.count)}): ${made.title}`;
  const lines = [head, reproducedAnswer(made, options.reasonShown === true), `Seen: ${times(s.count)}, ${s.last.slice(0, 10)}, ${builds}.`, `Folder: ${shownPath(made.dir)}`];
  return redact(lines.join("\n"));
}

