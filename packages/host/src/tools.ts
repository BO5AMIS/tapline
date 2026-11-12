import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toBuffer as qrPng } from "qrcode";
import { z } from "zod";
import { annotateScreenshot, type ShotImage } from "./annotate.js";
import type { ControlQueue } from "./control.js";
import type { InputOutcome, OverlayRead, PersonInput, QualityPreset, Rect, ViewerAction } from "./viewer.js";
import { agentKind, captionFor, personKind, reasonOf } from "./captions.js";
import { composeFilmstrip, diffImages, imageSize, type DiffBox, type DiffResult } from "./images.js";
import { alertNotes, describeElement, filterLogs, formatChanges, formatElement, formatLogAnswer, formatLogs, formatOffScreenAfterList, formatTree } from "./format.js";
import { formatInspect, inspectResultSchema } from "./inspect.js";
import { AUDIT_TYPES, auditResultSchema, auditTitle, formatAudit } from "./audit.js";
import { NO_CRASH_TEXT, crashNote, disconnectNote, formatCrash } from "./crash.js";
import { ActionLog, loggedTarget, type ActionLogEntry } from "./actionlog.js";
import { Confirmations } from "./confirm.js";
import { DEFAULT_POLICY, elementKey, listsFor, matchWord, type PolicyFile } from "./policy.js";
import { readScript, refStep, scriptSteps, type SharedScript } from "./script.js";
import { badUnderKeys, checkUnder, formatPerfLines, perfFirstLine, perfResultSchema, type PerfMeasure, type PerfResult } from "./perf.js";
import {
  EXPECT_TIMEOUT_S,
  MAX_STEPS,
  RUN_TIMEOUT_MS,
  RUN_TOOLS,
  UNDER_KEYS,
  describeRunStep,
  expectFailure,
  parseError,
  stepNotes,
  stepSchema,
  type Expect,
  type RunTool,
  type Step,
} from "./run.js";
import { PAIR_CODE_TTL_MS, forgetLink, pairingLink } from "./pairing.js";
import {
  elementSchema,
  logEntrySchema,
  screenshotResultSchema,
  treeResultSchema,
  type LogEntry,
  type TreeElement,
  type TreeResult,
  type WireTarget,
} from "./protocol.js";
import { TaplineError, identityOf, type AppIdentity, type SessionInfo, type TaplineHost } from "./server.js";

// ---- input schemas ----------------------------------------------------------

export const targetSchema = z
  .object({
    ref: z.string().optional().describe('From your latest list, e.g. "e12"'),
    id: z.string().optional().describe("The testID, exact"),
    label: z.string().optional().describe("Accessibility label, exact"),
    text: z.string().optional().describe("Visible text: exact first, then part"),
    index: z.number().int().min(0).optional().describe("The Nth match of id, label or text (0-based)"),
    x: z.number().optional().describe("Points, with y"),
    y: z.number().optional().describe("Points, with x"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kinds = [
      value.ref !== undefined,
      value.id !== undefined,
      value.label !== undefined,
      value.text !== undefined,
      value.x !== undefined || value.y !== undefined,
    ].filter(Boolean).length;
    if (kinds !== 1) {
      ctx.addIssue({ code: "custom", message: "Give exactly one kind of target: {ref}, {id}, {label}, {text} or {x, y}." });
      return;
    }
    if ((value.x === undefined) !== (value.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "A point target needs both x and y." });
    }
    if (value.index !== undefined && value.id === undefined && value.label === undefined && value.text === undefined) {
      ctx.addIssue({ code: "custom", message: "index works with id, label or text." });
    }
  });
export type Target = z.infer<typeof targetSchema>;

const rectSchema = z
  .object({
    x: z.number().describe("Points"),
    y: z.number().describe("Points"),
    width: z.number().positive().describe("Points"),
    height: z.number().positive().describe("Points"),
  })
  .strict();
const ignoreListSchema = z.array(z.union([rectSchema, targetSchema]));

const targetField = targetSchema.describe("Exactly one of ref, id, label, text or x and y");
const lookField = z
  .boolean()
  .optional()
  .describe("false: only the first line; the next answer's changes then cover this action too");

const screenshotField = z.boolean().optional().describe("Add a screenshot (default false)");

const dryRunField = z
  .boolean()
  .optional()
  .describe("true: run every check and say what would happen; touch nothing");

/** `index` written beside `target` rather than in it: agents do that, and it means the same. */
const indexField = z.number().int().min(0).optional().describe("Same as target.index");

const forceField = z
  .boolean()
  .optional()
  .describe("Skip the reach checks (never disabled), only when you've decided a refusal is wrong");

export const toolShapes = {
  apps: {},
  open_app: { app: z.string().describe("The app's session id, app id or name, as apps lists them") },
  pair: {
    scheme: z
      .string()
      .optional()
      .describe(
        'The app\'s URL scheme ("scheme" in app.json or app.config), e.g. "myapp"; for an app running in Expo Go, the address Expo prints, e.g. "exp://192.168.1.20:8081"',
      ),
  },
  look: {
    screenshot: z.boolean().optional().describe("Include a screenshot (default true); false skips it"),
    width: z
      .number()
      .int()
      .min(160)
      .max(1320)
      .optional()
      .describe("Screenshot width in pixels, 160 to 1320 (default 600). Smaller costs fewer image tokens: 300 is enough to check a layout."),
    labels: z
      .boolean()
      .optional()
      .describe("Draw each actionable element's box and ref (e12) on the screenshot, so whoever views it can name elements by ref"),
  },
  check_layout: {},
  audit: {
    types: z
      .array(z.enum(AUDIT_TYPES))
      .optional()
      .describe("Which checks to run (default all): contrast, hit_region, description, dynamic_type, clipped_text, trait, element_detection, overlap, duplicate_id"),
  },
  inspect: { target: targetField },
  tap: { target: targetField, index: indexField, force: forceField, dry_run: dryRunField, look: lookField, screenshot: screenshotField },
  long_press: {
    target: targetField,
    index: indexField,
    seconds: z
      .number()
      .min(0.1)
      .max(10)
      .optional()
      .describe("How long to hold (default 1.0). Tapline calls the handler, so it doesn't wait"),
    force: forceField,
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
  },
  type_text: {
    text: z.string().describe("Text to enter"),
    target: targetField.optional().describe("Input to type into; default: the focused input, else the only input on screen (else ambiguous; none at all is not_found)"),
    index: indexField,
    replace: z.boolean().optional().describe("Replace the current text (default true); false appends"),
    submit: z.boolean().optional().describe("Also submit (like pressing return) after typing (default false)"),
    force: forceField,
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
  },
  scroll: {
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction (default down when no `to`)"),
    amount: z.number().min(0.1).max(1).optional().describe("How far: a share of the scroll area, 0.1 to 1 (default 0.8)"),
    to: z
      .enum(["start", "end", "target"])
      .optional()
      .describe('Instead of direction/amount: "start" or "end" jumps there; "target" scrolls until the `target` element is on screen, clear of the bars'),
    target: targetField
      .optional()
      .describe('Scroll view to scroll, or an element inside it; default: the largest one on screen. With to: "target", the element to bring onto the screen'),
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
  },
  toggle: {
    target: targetField,
    index: indexField,
    value: z.boolean().optional().describe("Desired state; omit to flip"),
    force: forceField,
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
  },
  open_url: {
    url: z.string().describe('URL or deep link to open, e.g. "myapp://settings"'),
    look: lookField,
    screenshot: screenshotField,
  },
  back: { dry_run: dryRunField, look: lookField, screenshot: screenshotField },
  swipe: {
    x0: z.number().describe("Where the finger starts, in points from the left"),
    y0: z.number().describe("Where the finger starts, in points from the top"),
    x1: z.number().describe("Where it lifts, in points from the left"),
    y1: z.number().describe("Where it lifts, in points from the top"),
    seconds: z.number().min(0.05).max(5).optional().describe("How long the drag takes (default 0.35)"),
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
  },
  app_command: {
    name: z.string().optional().describe("The command to run; omit to list the app's commands and what they take"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments, as the command's description says"),
    look: lookField,
    screenshot: screenshotField,
  },
  compare_screen: {
    name: z.string().describe('A name for this screen\'s reference picture, e.g. "home" or "checkout-empty"'),
    update: z.boolean().optional().describe("Replace the saved reference with the screen as it is now"),
    width: z
      .number()
      .int()
      .min(160)
      .max(1320)
      .optional()
      .describe("Screenshot width in pixels, 160 to 1320 (default 600); keep it the same for a name"),
    threshold: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("The share of the screen, in percent, 0 to 100 (default 0.5), that may change and still match"),
    ignore: z
      .array(z.union([rectSchema, targetSchema]))
      .optional()
      .describe("Painted out on both pictures before comparing (a clock, an avatar): targets {id}, {label}, {text}, {ref}, or a rect {x, y, width, height} in points"),
  },
  filmstrip: {
    frames: z.number().int().min(2).max(9).optional().describe("How many frames (default 6)"),
    interval_ms: z.number().int().min(0).max(2000).optional().describe("Time between frames in ms (default 250)"),
    frame_width: z.number().int().min(100).max(400).optional().describe("Width of each frame in pixels (default 200)"),
    tap: targetField.optional().describe("Tap this first, then film what it sets off (an animation, a loading state)"),
  },
  viewer: {},
  record: {
    start: z.boolean().optional().describe("Start recording: every action that succeeds from now on becomes a step"),
    stop: z.boolean().optional().describe("Stop and save the script (to path, else to the scripts folder under name)"),
    name: z.string().optional().describe("The script's name: letters, digits, '.', '_' and '-'"),
    path: z.string().optional().describe("Where stop saves the script file (optional)"),
    action: z
      .enum(["start", "stop", "status", "discard"])
      .optional()
      .describe("Older form: start, stop, status or discard"),
  },
  replay: {
    name: z.string().optional().describe("A saved script's name; omit name and path to list saved scripts"),
    path: z.string().optional().describe("A script file to replay (the shared agent-tools-script format)"),
    look: lookField,
    screenshot: screenshotField,
  },
  wait_for: {
    text: z.string().optional().describe("Wait until this visible text is on screen (or gone)"),
    id: z.string().optional().describe("Wait until the element with this id is on screen (or gone)"),
    label: z.string().optional().describe("Wait until the element with this accessibility label is on screen (or gone)"),
    gone: z.boolean().optional().describe("Wait until it is gone instead, e.g. a spinner"),
    network_idle: z.boolean().optional().describe("Also (or only) wait until no network request is in flight"),
    timeout: z.number().min(0.5).max(30).optional().describe("Seconds to wait at most, 0.5 to 30 (default 10)"),
    look: lookField,
    screenshot: screenshotField,
  },
  logs: {
    since: z.number().optional().describe("Only lines after this timestamp (epoch milliseconds)"),
    level: z.enum(["error", "warning", "info"]).optional().describe("That level and above (default info: everything)"),
    grep: z.string().optional().describe("Only lines containing this text (case-insensitive)"),
    limit: z.number().int().min(1).max(500).optional().describe("At most this many lines, the newest (1 to 500, default 100)"),
  },
  crash: {
    all: z.boolean().optional().describe("The last 5 crashes instead of only the newest"),
  },
  reload: { look: lookField },
  performance: {
    launch: z
      .boolean()
      .optional()
      .describe("true: reload the app's JavaScript and time it to the first settled screen (development builds only; not a cold start)"),
    seconds: z.number().min(0.5).max(30).optional().describe("Measure for this long, 0.5 to 30 seconds (default 3)"),
    tap: targetField.optional().describe("Tap this first, then measure what it sets off"),
  },
  wait: { seconds: z.number().min(0.1).max(30).describe("How long to wait, 0.1 to 30 seconds"), screenshot: screenshotField },
  run: {
    steps: z
      .array(stepSchema)
      .min(1)
      .max(MAX_STEPS)
      .describe(
        'The steps, in order: each is a tool call as an object, {"tool": "tap", "target": {...}, "expect": {...}}. Tools: tap, long_press, type_text, scroll, toggle, back, swipe, open_url, wait, wait_for, app_command, compare_screen (checks, never saves), performance. expect (optional): one of text, id or label, with gone, value and timeout (seconds, default 2); or matches (a reference name, alone or with one of them) with threshold; on a performance step, under: limits such as {"launch_s": 2, "drops": 0, "fps_min": 50, "busy_ms": 200, "js_heap_mb": 80}.',
      ),
    trace: z.boolean().optional().describe("Also list each step that ran, one line each"),
    dry_run: z
      .boolean()
      .optional()
      .describe("Check every step's parameters and resolve step 1 (later steps depend on what it does), then touch nothing"),
    look: lookField,
    screenshot: screenshotField,
  },
} as const;

type Shape<K extends keyof typeof toolShapes> = z.infer<z.ZodObject<(typeof toolShapes)[K]>>;

/** The arguments of one tool, as its schema describes them. */
export type ToolArgs<K extends keyof typeof toolShapes> = Shape<K>;

/**
 * The answer for a call that carries arguments the tool doesn't have (null when all are known). Zod strips unknown
 * keys silently, so `audit {labels: true}` would run and ignore `labels`; this says so instead. Every way in to a
 * tool (the MCP server, and through it the bench) goes through here; script steps are checked by `run` itself.
 */
export function unknownArgumentError(name: keyof typeof toolShapes, args: Record<string, unknown>): CallToolResult | null {
  const known = Object.keys(toolShapes[name]);
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length === 0) return null;
  const quoted = unknown.map((key) => JSON.stringify(key)).join(", ");
  const takes = known.length === 0 ? `${name} takes no arguments` : `${name} takes: ${known.join(", ")}`;
  return fail(`Error bad_params: unknown argument${unknown.length === 1 ? "" : "s"} ${quoted}; ${takes}.`);
}

// ---- compare_screen ---------------------------------------------------------

const DEFAULT_MATCH_THRESHOLD = 0.5;
const MAX_REGION_LINES = 8;

/** What `ignore` paints out: a target, or a rectangle in points. */
type IgnoreItem = Target | { x: number; y: number; width: number; height: number };

interface ReferenceOptions {
  /** The share of the screen, in percent, that may change and still match. */
  threshold: number;
  ignore: IgnoreItem[];
  width: number;
  /** Folders to look in for `<name>.jpg`, in order. */
  referencesDirs: string[];
}

type ReferenceCheck =
  | { kind: "missing"; shot: ShotImage }
  | { kind: "size"; message: string }
  | { kind: "error"; line: string }
  | { kind: "match"; percent: number; notes: string[] }
  | { kind: "differs"; percent: number; lines: string[]; reason: string; image: ShotImage; notes: string[] };

function describeIgnore(item: Target): string {
  if (item.id !== undefined) return `id=${item.id}`;
  if (item.label !== undefined) return `label ${JSON.stringify(item.label)}`;
  if (item.text !== undefined) return JSON.stringify(item.text);
  if (item.ref !== undefined) return item.ref;
  return `${String(item.x)},${String(item.y)}`;
}

/** The pixel rectangles to paint out for `ignore`, from a fresh element list; targets not on the screen give a note. */
function ignoreRects(
  ignore: IgnoreItem[],
  elements: TreeResult["elements"],
  scale: number,
  size: { width: number; height: number },
): { rects: DiffBox[]; notes: string[] } {
  const rects: DiffBox[] = [];
  const notes: string[] = [];
  const add = (x: number, y: number, width: number, height: number): void => {
    const x0 = Math.max(0, Math.floor(x * scale));
    const y0 = Math.max(0, Math.floor(y * scale));
    const x1 = Math.min(size.width, Math.ceil((x + width) * scale));
    const y1 = Math.min(size.height, Math.ceil((y + height) * scale));
    if (x1 > x0 && y1 > y0) rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  };
  for (const item of ignore) {
    if ("width" in item) {
      add(item.x, item.y, item.width, item.height);
      continue;
    }
    let found: TreeResult["elements"] = [];
    if (item.ref !== undefined) found = elements.filter((e) => e.ref === item.ref);
    else if (item.id !== undefined) found = elements.filter((e) => e.testID === item.id);
    else if (item.label !== undefined) {
      const wanted = item.label.toLowerCase();
      found = elements.filter((e) => (e.label ?? "").toLowerCase() === wanted);
    } else if (item.text !== undefined) {
      const wanted = item.text.toLowerCase();
      found = elements.filter((e) => (e.text ?? "").toLowerCase() === wanted);
      if (found.length === 0) found = elements.filter((e) => wanted !== "" && (e.text ?? "").toLowerCase().includes(wanted));
    } else if (item.x !== undefined && item.y !== undefined) {
      const px = item.x;
      const py = item.y;
      found = elements
        .filter((e) => e.frame && px >= e.frame.x && px <= e.frame.x + e.frame.width && py >= e.frame.y && py <= e.frame.y + e.frame.height)
        .sort((a, b) => (a.frame?.width ?? 0) * (a.frame?.height ?? 0) - (b.frame?.width ?? 0) * (b.frame?.height ?? 0))
        .slice(0, 1);
    }
    found = found.filter((e) => e.frame !== undefined);
    if (item.index !== undefined) found = found.slice(item.index, item.index + 1);
    if (found.length === 0) notes.push(`ignore ${describeIgnore(item)} isn't on the screen; skipped.`);
    for (const e of found) if (e.frame) add(e.frame.x, e.frame.y, e.frame.width, e.frame.height);
  }
  return { rects, notes };
}

// ---- helpers ----------------------------------------------------------------

export interface ConnectInfo {
  /** Where apps reach this host, e.g. ws://100.64.0.1:7210/ */
  url: string;
  /** This computer's name, shown on the phone before it connects. */
  name: string;
}

export interface ToolsOptions {
  connect: ConnectInfo;
  /**
   * Whether a phone has ever connected to this computer's host. When set, the first answer of the session says what
   * only a person can do (open the app, pair) if an app isn't connected: `Note: needs a person: …`, once.
   */
  pairedBefore?: () => boolean;
  /** Where the action log goes (AGENT-TOOLS 1.8 §12); none: no log. */
  logDir?: string;
  /** The safety policy (AGENT-TOOLS 1.8 §11). Default: the built-in words; --no-policy passes empty lists. */
  policy?: PolicyFile;
  /** Where a person's OK is asked for and given (the live viewer listens). Default: a fresh one. */
  confirmations?: Confirmations;
  /** False when nobody can answer a request (--viewer off). Default true. */
  canConfirm?: boolean;
  /**
   * Where `pair` writes the development offer for the Metro helper (`~/.tapline/offers`), so a phone that can
   * only reach Metro (a firewall in the way of 7210-7219) still finds it. None: only the host's own endpoint.
   */
  offerDir?: string;
  /** Where `pair` also saves the QR code as a PNG (so the user can open it). */
  pairImagePath?: string;
  /** How long that PNG is kept. Default: the code's 10 minutes. */
  pairImageLifetimeMs?: number;
  /** How long `reload` waits for the app to come back. Default 20 000 ms. */
  reloadWaitMs?: number;
  /** Extra delay after a reload before looking. Default 1500 ms. */
  reloadSettleMs?: number;
  /**
   * How `look` delivers screenshots: "inline" puts the image in the tool result; "file" saves it
   * and returns only its path, so a lead agent can hand it to a smaller model without seeing it.
   */
  screenshots?: "inline" | "file";
  /** Where file-mode screenshots go (required for "file"). */
  screenshotDir?: string;
  /** How many file-mode screenshots to keep; older ones are deleted. Default 50. */
  screenshotKeep?: number;
  /** Where `record` saves scripts and `replay` reads them (e.g. ~/.tapline/scripts). */
  scriptsDir?: string;
  /** Where `compare_screen` keeps reference pictures, one folder per app (e.g. ~/.tapline/baselines). */
  baselinesDir?: string;
  /** The live viewer's queue: agent actions wait for a person and stop while paused. */
  control?: ControlQueue;
  /** Shows each agent action to people watching the live viewer. */
  onAction?: (action: ViewerAction) => void;
  /** The live viewer's links (with its token), for the `viewer` tool. */
  viewerLinks?: () => string[];
  /**
   * Opens the live view on this computer (the default browser). When set, `viewer` opens it and never
   * shows the agent the link: its key could approve a held-back touch. Unset (tests) or with
   * `viewerLinkToAgent`, the link is in the answer.
   */
  openViewer?: (link: string) => boolean;
  /** `--viewer-link`: give the agent the link (benchmarks and scripts that drive the viewer themselves). */
  viewerLinkToAgent?: boolean;
  /** Whether the app's frames are on and at which quality, for the `viewer` tool's stats. */
  viewerFeed?: () => { on: boolean; quality: QualityPreset };
}

/**
 * Under this many points from its first point, a pointer path is a tap or a hold, not a drag.
 * Tapwright uses the same number, and the viewer page's pending ring (TAP_SLOP in viewer.html)
 * follows it: change all three together.
 */
const TAP_SLOP = 10;
/** Held at least this long, a tap is a long press. */
const LONG_PRESS_MS = 500;

const SCRIPT_NAME = /^[A-Za-z0-9][\w.-]{0,60}$/;

/** One recorded request; `route` is the screen it ended on, `fragile` marks a target that only worked that run (a ref). */
interface ScriptStep {
  method: string;
  params: Record<string, unknown>;
  route?: string[];
  fragile?: boolean;
  /** Typed into a password field: its text wasn't saved (never written to the file). */
  secret?: boolean;
}

const scriptSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  app: z.object({ name: z.string(), id: z.string().optional() }),
  recordedAt: z.string(),
  steps: z.array(
    z.object({
      method: z.string(),
      params: z.record(z.string(), z.unknown()),
      route: z.array(z.string()).optional(),
      fragile: z.boolean().optional(),
    }),
  ),
});
type Script = z.infer<typeof scriptSchema>;

/** A target that works again on a new run: testID, else label, else visible text; refs only work for the run they came from. */
function stableParams(params: unknown, result: unknown): { params: Record<string, unknown>; fragile: boolean } {
  const copy: Record<string, unknown> =
    typeof params === "object" && params !== null ? { ...(params as Record<string, unknown>) } : {};
  const target = copy["target"];
  if (typeof target !== "object" || target === null) return { params: copy, fragile: false };
  // A target the agent gave by testID, label, text or point already picked one element: keep it.
  if (!("ref" in target)) return { params: copy, fragile: false };
  const element =
    typeof result === "object" && result !== null && "element" in result
      ? elementSchema.safeParse((result as { element: unknown }).element)
      : null;
  if (element?.success) {
    const { testID, label, text: shown } = element.data;
    if (typeof testID === "string" && testID !== "") copy["target"] = { testID };
    else if (typeof label === "string" && label !== "") copy["target"] = { label };
    else if (typeof shown === "string" && shown !== "") copy["target"] = { text: shown };
  }
  const kept = copy["target"];
  const fragile = typeof kept === "object" && kept !== null && "ref" in kept;
  return { params: copy, fragile };
}

/** A short description of a step, e.g. `press id=save` or `type "Ann" into label="Name"`. */
function describeStep(step: ScriptStep): string {
  const p = step.params;
  const target = p["target"];
  let where = "";
  if (typeof target === "object" && target !== null) {
    const t = target as Record<string, unknown>;
    if (typeof t["testID"] === "string") where = `id=${t["testID"]}`;
    else if (typeof t["label"] === "string") where = `label=${JSON.stringify(t["label"])}`;
    else if (typeof t["text"] === "string") where = `text=${JSON.stringify(t["text"])}`;
    else if (typeof t["ref"] === "string") where = `ref ${t["ref"]}`;
    else if (typeof t["x"] === "number") where = `point ${String(t["x"])},${String(t["y"])}`;
  }
  switch (step.method) {
    case "sleep":
      return `wait ${String(p["seconds"])} s`;
    case "type":
      return `type ${JSON.stringify(p["text"])}${where ? ` into ${where}` : ""}`;
    case "openURL":
      return `open ${String(p["url"])}`;
    case "command":
      return `command ${String(p["name"])}`;
    case "swipe":
      return `swipe ${String(p["x0"])},${String(p["y0"])} → ${String(p["x1"])},${String(p["y1"])}`;
    case "waitFor": {
      const what = ["text", "testID", "label"].find((key) => typeof p[key] === "string");
      const thing = what ? `${what === "testID" ? "id" : what}=${JSON.stringify(p[what])}${p["gone"] === true ? " gone" : ""}` : "";
      return `wait for ${[thing, p["networkIdle"] === true ? "quiet network" : ""].filter(Boolean).join(" and ")}`;
    }
    default:
      return `${step.method}${where ? ` ${where}` : ""}`;
  }
}

const overlaySchema = z.object({
  rev: z.number().optional(),
  screen: z.object({ width: z.number(), height: z.number() }),
  elements: z.array(
    z.object({
      ref: z.string().nullish(),
      type: z.string().nullish(),
      label: z.string().nullish(),
      id: z.string().nullish(),
      frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    }),
  ),
});

const feedAnswerSchema = z.object({
  on: z.boolean(),
  stats: z
    .object({
      frames: z.number(),
      avgCaptureMs: z.number(),
      maxCaptureMs: z.number(),
      observedFrames: z.number(),
      janky: z.number(),
      jankyWhileCapturing: z.number(),
      failures: z.number().optional(),
      lastFailure: z.string().optional(),
      heartbeats: z.number().optional(),
      backoffs: z.number().optional(),
    })
    .optional(),
});

/** Bounds of TAPLINE_FEED_GAP_MS, as the app checks them. */
const MIN_FEED_GAP_MS = 30;
const MAX_FEED_GAP_MS = 2000;

/**
 * The app's `feed` params. For measuring only, TAPLINE_FEED_GAP_MS (30–2000) replaces the app's
 * live pace with a fixed gap between captures; apps without it ignore it.
 */
export function feedParams(on: boolean, quality: QualityPreset, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const raw = env.TAPLINE_FEED_GAP_MS;
  const gapMs = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (gapMs >= MIN_FEED_GAP_MS && gapMs <= MAX_FEED_GAP_MS) return { on, quality, gapMs };
  return { on, quality };
}

const commandsSchema = z.object({
  commands: z.array(z.object({ name: z.string(), description: z.string() })),
});

const findingsSchema = z.object({
  findings: z.array(z.object({ kind: z.string(), ref: z.string(), other: z.string().optional(), message: z.string() })),
});

/** A phone described as `apps` lists it: name, platform and OS, or the install id when it sends no name. */
function deviceLabel(s: SessionInfo): string {
  // iPhones send no name, so the install id is what tells two of them apart.
  const install = s.device.name === undefined && s.device.id !== undefined ? `install ${s.device.id.slice(0, 6)}` : undefined;
  const device = [s.device.name, [s.device.platform, s.device.osVersion].filter(Boolean).join(" "), install]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .join(", ");
  return device || "unknown device";
}

/** Default screenshot width in pixels: readable, about 1,000 image tokens for a phone screen. */
export const DEFAULT_SCREENSHOT_WIDTH = 600;

/** The app methods whose result may say `closedKeyboard: true` (the app closed the keyboard before acting). */
const KEYBOARD_METHODS: ReadonlySet<string> = new Set(["press", "longPress", "toggle", "type"]);

const NO_SCREENSHOT_NOTE ="Note: no screenshot: this app doesn't support it; add react-native-view-shot.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** waitFor answers only when its own wait ends (default 10 s): wait that long plus a margin for it. */
function answerTimeoutMs(method: string, params: unknown): number | undefined {
  if (method !== "waitFor") return undefined;
  const timeout = typeof params === "object" && params !== null && "timeout" in params ? params.timeout : undefined;
  return (typeof timeout === "number" && timeout > 0 ? timeout : 10) * 1000 + 5000;
}

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The target with an `index` that was written beside it moved inside (its own index wins). */
function withIndex(target: Target, index: number | undefined): Target {
  return index !== undefined && target.index === undefined ? { ...target, index } : target;
}

function toWireTarget(target: Target): WireTarget {
  const withIndex = <T extends object>(t: T): T & { index?: number } =>
    target.index !== undefined ? { ...t, index: target.index } : t;
  if (target.ref !== undefined) return { ref: target.ref };
  if (target.id !== undefined) return withIndex({ testID: target.id });
  if (target.label !== undefined) return withIndex({ label: target.label });
  if (target.text !== undefined) return withIndex({ text: target.text });
  return { x: target.x ?? 0, y: target.y ?? 0 };
}

/** A target as the agent wrote it, in words: `id=save`, `"Save"`, `e3`, `120,300`. */
function targetWords(target: Target): string {
  if (target.id !== undefined) return `id=${target.id}`;
  if (target.text !== undefined) return JSON.stringify(target.text);
  if (target.label !== undefined) return JSON.stringify(target.label);
  if (target.ref !== undefined) return target.ref;
  return `${target.x ?? 0},${target.y ?? 0}`;
}

function candidateLines(details: unknown): string[] {
  const lines: string[] = [];
  const bareRefs: string[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") {
        bareRefs.push(item);
        continue;
      }
      const element = elementSchema.safeParse(item);
      if (element.success) lines.push(formatElement(element.data));
    }
  };
  if (typeof details === "object" && details !== null) {
    const record = details as Record<string, unknown>;
    visit(record["candidates"]);
    visit(record["refs"]);
    const data = record["data"];
    if (typeof data === "object" && data !== null) {
      const nested = data as Record<string, unknown>;
      visit(nested["candidates"]);
      visit(nested["refs"]);
    }
  }
  // Full element lines say more than refs; refs only stand in when the app sent no elements.
  return [...new Set(lines.length > 0 ? lines : bareRefs)];
}

/** At most this many candidates are listed in an `ambiguous` answer (AGENT-TOOLS §4). */
const MAX_CANDIDATES = 5;

/**
 * The `ambiguous` block (AGENT-TOOLS §4): the message, `Candidates:` with up to 5 lines indented two
 * spaces, a `(+N more; …)` line when there are more, then the retry line. `total` is the number of
 * matches when known. "N inputs on screen" (`type_text` without a target) has no `index` to add: its
 * retry line and its `(+N more; …)` line say only to use a ref.
 */
export function ambiguousBlock(message: string, candidates: string[], total?: number, retry?: string): string {
  const inputsCase = /^\d+ inputs on screen/.test(message);
  const shown = candidates.slice(0, MAX_CANDIDATES);
  const count = Math.max(total ?? candidates.length, candidates.length);
  const more = count - shown.length;
  const lines = [`Error ambiguous: ${message}`];
  if (shown.length > 0) lines.push("Candidates:", ...shown.map((c) => `  ${c}`));
  if (more > 0) lines.push(inputsCase ? `  (+${more} more; use a ref)` : `  (+${more} more; use a ref or "index")`);
  lines.push(retry ?? (inputsCase ? "Retry with one of the refs as the target." : 'Retry with one of the refs, or add "index" (0-based).'));
  return lines.join("\n");
}

/** A person's input that failed: its code, reason word (when refused) and message, for the viewer. */
function failure(error: unknown): { ok: false; code: string; reason?: string; message: string } {
  const code = error instanceof TaplineError ? error.code : "internal";
  const message = error instanceof Error ? error.message : String(error);
  const reason = reasonOf(code, message);
  return { ok: false, code, ...(reason !== undefined ? { reason } : {}), message };
}

export function describeError(error: unknown): string {
  if (error instanceof TaplineError) {
    if (error.code === "ambiguous") {
      const counted = /^(\d+) (?:elements match|inputs on screen)/.exec(error.message);
      return ambiguousBlock(error.message, candidateLines(error.details), counted?.[1] !== undefined ? Number(counted[1]) : undefined);
    }
    return `Error ${error.code}: ${error.message}`;
  }
  return `Error internal: ${error instanceof Error ? error.message : String(error)}`;
}

/** Ends a guarded call inside the agent's turn with the policy's answer (nothing was touched). */
class PolicyStop extends Error {
  constructor(readonly answer: CallToolResult) {
    super("stopped by the policy");
  }
}

/** Adds a note line to the end of an answer's first text block. */
function appendNote(answer: CallToolResult, note: string): CallToolResult {
  const [top, ...rest] = answer.content;
  if (top === undefined || top.type !== "text") return answer;
  return { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), note].join("\n") }, ...rest] };
}

/** An app's dry-run answer (AGENT-TOOLS 1.8 §11.4). */
const dryRunResultSchema = z.object({
  element: elementSchema.nullish(),
  dryRun: z.literal(true),
  point: z.object({ x: z.number(), y: z.number() }).optional(),
  value: z.unknown().optional(),
});

/** For an app without dry runs: every element on its list the target could mean. */
function candidatesFor(target: unknown, elements: TreeElement[]): TreeElement[] {
  if (typeof target !== "object" || target === null) return [];
  const t = target as Record<string, unknown>;
  const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");
  const x = t["x"];
  const y = t["y"];
  let found: TreeElement[];
  if (typeof t["ref"] === "string") found = elements.filter((e) => e.ref === t["ref"]);
  else if (typeof t["testID"] === "string") found = elements.filter((e) => e.testID === t["testID"]);
  else if (typeof t["label"] === "string") found = elements.filter((e) => lower(e.label) === lower(t["label"]));
  else if (typeof t["text"] === "string") {
    const want = lower(t["text"]);
    found = elements.filter((e) => lower(e.text).includes(want) || lower(e.label).includes(want));
  } else if (typeof x === "number" && typeof y === "number") {
    found = elements.filter((e) => {
      const f = e.frame;
      return f !== null && f !== undefined && x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height;
    });
  } else found = [];
  const index = t["index"];
  const picked = typeof index === "number" ? found[index] : undefined;
  return picked !== undefined ? [picked] : found;
}

// ---- tool handlers ----------------------------------------------------------

/** Every tool whose answer can end with a crash note (all but `crash`, which tells it in full). */
const CRASH_NOTED_TOOLS = [
  "apps", "openApp", "pair", "look", "run", "inspect", "audit", "checkLayout", "viewer", "compareScreen", "filmstrip",
  "record", "replay", "tap", "longPress", "typeText", "scroll", "toggle", "appCommand", "waitFor", "swipe", "back",
  "openUrl", "logs", "reload", "performance", "wait",
] as const satisfies readonly (keyof TaplineTools)[];

/** The tool handlers behind the MCP server. They only talk to a TaplineHost, so they are easy to test. */
export class TaplineTools {
  private readonly reloadWaitMs: number;
  /** The action log (§12), when one is configured. */
  private readonly actionLog: ActionLog | null;
  /** When the action in flight started, for the log's `ms`. */
  private actionStartedAt: number | undefined;
  /** Set while `run` runs a step: the log ties the action to its batch. */
  private batch: { id: string; step: number } | undefined;
  /** Extra fields for the next log line (a dry run, a confirmed touch). */
  private logExtra: Partial<ActionLogEntry> | undefined;
  readonly confirmations: Confirmations;
  private readonly policy: PolicyFile;
  private readonly reloadSettleMs: number;
  private readonly noScreenshot = new Set<string>();
  private readonly shotFiles: string[] = [];
  /** Sessions this agent has had an element list for (so later lists can be just the changes). */
  private readonly listed = new Set<string>();
  /** Sessions whose previous answer had an alert open, so the next change block can say `Alert: gone`. */
  private readonly alertOpen = new Set<string>();
  /** Per session: how many actions answered with `look: false` since the agent was last given a list or a change block. */
  private readonly unlistedActions = new Map<string, number>();
  /** The route of the latest element list, for recording and checking replays. */
  private lastLookRoute: string[] | undefined;
  /** A person acted (in the viewer, or a finger on the phone) since the agent's last full list: `{ref}` targets fail with `stale`. */
  private personActed = false;
  /** The next answer to the agent says a person used the app, once. */
  private personNotePending = false;
  private recording: { name: string; app: { name: string; id?: string }; steps: ScriptStep[] } | null = null;
  private replaying = false;
  /**
   * While a script replays (AGENT-TOOLS 1.9 §14.3): the references folder next to it (looked in first), where a
   * failed check puts its red picture, and whether the checks save instead of compare (`--update-references`).
   */
  private replayContext: { referencesDir: string; diffDir: string; update: boolean } | null = null;
  /** Where the latest failed check of the running batch saved its picture. */
  private diffSaved: string | null = null;
  /** What the last `performance` call measured, for the `under` limits of a `run` step. */
  private lastPerf: PerfMeasure | undefined;
  /** The screen size in points from the latest list or overlay, for the live viewer's 0..1 positions. */
  private lastScreen: { w: number; h: number } | undefined;
  private shotCount = 0;
  private pairWrites = 0;
  /** Per app (by identity): crash events up to this one have been told to the agent. */
  private readonly notedCrashSeqs = new Map<string, number>();
  /** Crash events up to this one happened before this agent's session: an app with no entry above starts here. */
  private readonly crashBaseline: number;
  /** Set inside a tool call (and everything it awaits), so a call within a call (`run`'s steps) adds no notes. */
  private readonly noteScope = new AsyncLocalStorage<true>();

  constructor(
    private readonly host: TaplineHost,
    private readonly options: ToolsOptions,
  ) {
    this.reloadWaitMs = options.reloadWaitMs ?? 20_000;
    this.confirmations = options.confirmations ?? new Confirmations();
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.actionLog = options.logDir !== undefined ? new ActionLog(options.logDir) : null;
    this.actionLog?.open();
    this.reloadSettleMs = options.reloadSettleMs ?? 1500;
    // A finger on the phone itself: the app saw a real touch. It can't be queued like viewer input
    // (it has already happened), so it only leaves the note and makes `{ref}` targets stale.
    host.on("touch", (session) => {
      if (this.host.current()?.id === session.id) this.markPersonUsedApp();
    });
    // Crashes before this agent's session began are not its news.
    this.crashBaseline = host.crashMark();
    for (const name of CRASH_NOTED_TOOLS) {
      const original: unknown = Reflect.get(this, name);
      if (typeof original !== "function") continue;
      const method = original as (this: TaplineTools, ...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
      Reflect.set(this, name, (...args: unknown[]) => this.noting(() => method.apply(this, args)));
    }
  }

  /**
   * Runs a tool call and ends its answer with a note when the app stopped (AGENT-TOOLS 15.2): during this
   * call, or earlier, with its time, once. Calls inside a call (`run`'s steps) add nothing of their own.
   */
  private noting(run: () => CallToolResult | Promise<CallToolResult>): CallToolResult | Promise<CallToolResult> {
    // Nesting belongs to the call and what it awaits (not to this object), so calls running side by side each
    // count as outermost, and only a step inside a call is skipped.
    if (this.noteScope.getStore() === true) return run();
    const mark = this.host.crashMark();
    const startedWith: AppIdentity | undefined = this.host.current();
    return this.noteScope.run(true, () => {
      const result = run();
      if (result instanceof Promise) return result.then((answer) => this.withPersonNote(this.withCrashNotes(answer, mark, startedWith)));
      return this.withPersonNote(this.withCrashNotes(result, mark, startedWith));
    });
  }

  /** The first call has been answered, so the "needs a person" note has had its turn. */
  private personNoteDone = false;

  /**
   * The first answer of the session says what only a person can do, once, when something is pending: the app isn't
   * connected (open it on the phone, same Wi-Fi), and the phone has never paired. Nothing pending: never.
   */
  private withPersonNote(answer: CallToolResult): CallToolResult {
    if (this.personNoteDone || this.options.pairedBefore === undefined) return answer;
    this.personNoteDone = true;
    if (this.host.current() !== undefined) return answer;
    const items: string[] = [];
    if (!this.options.pairedBefore()) items.push("the phone isn't paired yet (call `pair`, then the user scans the QR code or taps Connect)");
    items.push("the app isn't connected (the user opens it on the phone, on the same Wi-Fi as this computer)");
    return appendNote(answer, `Note: needs a person: ${items.join("; ")}.`);
  }

  /** What was told about this app's crashes so far: the crash events up to this number. */
  private notedSeqOf(app: AppIdentity): number {
    return this.notedCrashSeqs.get(identityOf(app)) ?? this.crashBaseline;
  }

  /**
   * The notes for the app this call used (the one at its start, the one at its end, or, with none connected, the
   * one that dropped last). Other apps' events stay pending until that app is the one being driven.
   */
  private withCrashNotes(answer: CallToolResult, mark: number, startedWith: AppIdentity | undefined): CallToolResult {
    const apps = new Map<string, AppIdentity>();
    const endedWith: AppIdentity | undefined = this.host.current() ?? (startedWith === undefined ? this.host.lastDisconnect()?.session : undefined);
    for (const app of [startedWith, endedWith]) if (app !== undefined) apps.set(identityOf(app), app);
    const events = [...apps.values()]
      .flatMap((app) => this.host.crashEventsAfter(this.notedSeqOf(app), app))
      .sort((a, b) => a.seq - b.seq);
    if (events.length === 0) return answer;
    const told = this.host.crashMark();
    for (const key of apps.keys()) this.notedCrashSeqs.set(key, told);
    let noted = answer;
    for (const event of events) {
      // During this call: no time. A crash the phone had kept and sent later says when it happened.
      const during = event.seq > mark;
      // A crash kept by an earlier run of the app (this host had not started yet) says so, with its date.
      const earlier = event.kind === "crash" && event.crash.source === "saved" && event.crash.ts < this.host.startedAt;
      noted = appendNote(
        noted,
        event.kind === "crash"
          ? crashNote(event.crash, !(during && event.crash.source === "live"), earlier)
          : disconnectNote(during ? undefined : event.at),
      );
    }
    return noted;
  }

  /** A person used the app: the next answer says so once, and `{ref}` targets are stale until the next full list. */
  private markPersonUsedApp(): void {
    this.personActed = true;
    this.personNotePending = true;
  }

  private notConnected(): CallToolResult {
    const silent = this.silentDropMessage();
    if (silent !== undefined) return fail(`Error not_answering: ${silent}`);
    return fail(`Error not_connected: ${this.noAppMessage()}`);
  }

  /** Set when the silence sweep dropped the last app while it wasn't in the background: it stopped answering. */
  private silentDropMessage(): string | undefined {
    const last = this.host.lastDisconnect();
    if (last === undefined || last.silentForMs === undefined) return undefined;
    const when = new Date(last.at).toTimeString().slice(0, 8);
    return `${last.session.app.name} stopped answering at ${when} (nothing from it for ${Math.round(last.silentForMs / 1000)} s while connected). Ask the user to close the app and open it again; it reconnects by itself then.`;
  }

  /** How to connect an app, shown when nothing is connected. */
  noAppMessage(): string {
    const { url, name } = this.options.connect;
    const lines: string[] = [];
    const last = this.host.lastDisconnect();
    if (last !== undefined) {
      const when = new Date(last.at).toTimeString().slice(0, 8);
      const state = last.session.appState?.state;
      const silent = this.silentDropMessage();
      lines.push(
        silent !== undefined
          ? silent
          : state === "inactive"
          ? `${last.session.app.name} disconnected at ${when} after iOS put something in front of it (a system prompt such as a password request, a call, or Control Center). Tapline can't see or answer it: ask the user to deal with it on the phone. The app reconnects by itself.`
          : state === "background"
          ? `${last.session.app.name} disconnected at ${when} after it went to the background (the user switched apps or locked the phone, and iOS paused it). Ask the user to open the app again: it reconnects by itself.`
          : `${last.session.app.name} disconnected at ${when} (${last.reason}). If the app is still open, it reconnects by itself.`,
      );
    }
    return [
      "No app is connected to Tapline.",
      ...lines,
      `This host listens at ${url} on ${name}.`,
      'To connect a phone, call `pair`. A development build loading its code from this computer then asks by itself: the user taps Connect. Other builds: pass the app\'s URL scheme ("scheme" in app.json, e.g. "myapp") and show the user the QR code to scan.',
      "The phone needs to be on the same Wi-Fi as this computer, and the app must be a build with Tapline turned on, open in the foreground.",
      "A phone that paired with this host before reconnects by itself while the app is open; one paired with a host on another port (e.g. before a restart) needs `pair` again. Once it connects, retry.",
    ].join("\n");
  }

  // -- pair

  async pair(args: Shape<"pair">): Promise<CallToolResult> {
    const { url, name } = this.options.connect;
    // Zero-QR pairing (Tapline 1.1): a development build whose JavaScript comes from this computer finds the
    // offer itself and asks its person to connect. Open for 10 minutes, one use, local network only.
    const offer = this.host.openDevOffer(name);
    this.writeOffer(offer);
    const devLine =
      "A development build that loads its JavaScript from this computer (Metro) on the same Wi-Fi asks by itself within a few seconds: the user only taps Connect, no QR code (open for 10 minutes, once).";
    if (args.scheme === undefined || args.scheme.trim() === "") {
      return text(
        [
          `Pairing is open for development builds for 10 minutes (${name}).`,
          devLine,
          "Ask the user to open the app on the phone and tap Connect, then call `apps`.",
          "For a TestFlight or release build, call pair again with the app's URL scheme to get a QR code.",
        ].join("\n"),
      );
    }
    let link: string;
    let forget: string;
    try {
      link = pairingLink({ scheme: args.scheme, url, code: this.host.createPairCode(), name });
      forget = forgetLink(args.scheme);
    } catch (error) {
      return fail(`Error bad_params: ${error instanceof Error ? error.message : String(error)}`);
    }
    const png = await qrPng(link, { type: "png", margin: 2, scale: 8, errorCorrectionLevel: "M" });

    let saved = "";
    const path = this.options.pairImagePath;
    if (path !== undefined) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, png, { mode: 0o600 });
        saved = ` The same QR code is saved at ${path} until it expires.`;
        // Delete it with its code, unless a newer pair call has replaced it.
        const write = ++this.pairWrites;
        setTimeout(() => {
          if (write === this.pairWrites) rmSync(path, { force: true });
        }, this.options.pairImageLifetimeMs ?? PAIR_CODE_TTL_MS).unref();
      } catch {
        // the image in this result is enough
      }
    }
    const lines = [
      `Pairing link for ${name} (valid 10 minutes, works once):`,
      link,
      "",
      `Show the user the QR code (attached).${saved} They scan it with the phone's camera, open the app and tap Connect.`,
      "The phone needs to be on the same Wi-Fi as this computer, and the app must be a build with Tapline turned on.",
      devLine,
      "Once paired, the app reconnects to this host (this address and port) by itself whenever it is open; call `apps` to check.",
      `To unpair the phone, open ${forget} on it.`,
    ];
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    };
  }

  /** `<offerDir>/<port>.json` (0600): the open offer for the Metro helper. Never fails the pair call. */
  private writeOffer(offer: { code: string; name: string; until: number }): void {
    const dir = this.options.offerDir;
    const port = this.host.boundPort();
    if (dir === undefined || port === undefined) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${port}.json`);
      writeFileSync(file, JSON.stringify({ code: offer.code, name: offer.name, port, until: offer.until }), { mode: 0o600 });
      this.host.setDevOfferFile(file);
      const remove = (): void => {
        try {
          // only our own offer: a newer pair call has written its own
          if (existsSync(file) && readFileSync(file, "utf8").includes(offer.code)) rmSync(file, { force: true });
        } catch {
          // gone already
        }
      };
      // Used: the code works once, so Metro stops handing it out at once.
      const onConnect = (): void => {
        if (this.host.currentDevOffer()?.code === offer.code) return;
        this.host.off("connect", onConnect);
        remove();
      };
      this.host.on("connect", onConnect);
      setTimeout(() => {
        this.host.off("connect", onConnect);
        try {
          // only our own offer: a newer pair call has written its own
          if (existsSync(file) && readFileSync(file, "utf8").includes(offer.code)) rmSync(file, { force: true });
        } catch {
          // gone already
        }
      }, Math.max(0, offer.until - Date.now())).unref();
    } catch {
      // the host's own endpoint still has it
    }
  }

  // -- apps

  apps(): CallToolResult {
    const sessions = this.host.sessions();
    if (sessions.length === 0) return text(this.noAppMessage());
    const current = this.host.current();
    const now = Date.now();
    const lines = sessions.map((s) => this.appLine(s, current?.id === s.id, now));
    const footer = sessions.length > 1 ? "\n* = selected. Use open_app {app} to switch." : "\n* = selected.";
    return text(`Connected apps:\n${lines.join("\n")}${footer}`);
  }

  /** One line of the `apps` list. */
  private appLine(s: SessionInfo, selected: boolean, now: number): string {
    const version = s.app.version !== undefined ? ` ${s.app.version}${s.app.build !== undefined ? ` (${s.app.build})` : ""}` : "";
    const age = Math.max(0, Math.round((now - s.connectedAt) / 1000));
    return `${selected ? "*" : " "} ${s.id}  ${s.app.name}${version} [${s.app.id}] on ${deviceLabel(s)}, connected ${age}s ago`;
  }

  openApp(args: Shape<"open_app">): CallToolResult {
    const sessions = this.host.sessions();
    if (sessions.length === 0) return this.notConnected();
    const wanted = args.app.trim().toLowerCase();
    // A session id is exact; an app id or name can match several phones, and Tapline never guesses between them.
    const matches = sessions.filter((s) => s.id.toLowerCase() === wanted);
    if (matches.length === 0) {
      matches.push(...sessions.filter((s) => s.app.id.toLowerCase() === wanted || s.app.name.toLowerCase() === wanted));
    }
    if (matches.length > 1) {
      const current = this.host.current();
      const now = Date.now();
      return fail(
        ambiguousBlock(
          `${matches.length} connected apps match "${args.app}".`,
          matches.map((s) => this.appLine(s, current?.id === s.id, now).trim()),
          undefined,
          "Retry with open_app and one of these session ids.",
        ),
      );
    }
    const session = matches[0];
    if (session === undefined) {
      return fail(
        `Error not_connected: ${args.app} isn't connected. Tapline can't launch apps: open it on the phone, on the same Wi-Fi as this computer (it reconnects by itself), or pair it with pair.`,
      );
    }
    try {
      this.host.select(session.id);
    } catch (error) {
      return fail(describeError(error));
    }
    return text(`Driving ${session.app.name} (${session.app.id}) on ${deviceLabel(session)}.`);
  }

  // -- look

  async look(args: Shape<"look"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const parts = await this.lookParts(
      session,
      args.screenshot ?? true,
      args.width ?? DEFAULT_SCREENSHOT_WIDTH,
      false,
      args.labels === true,
    );
    return { content: parts.content, ...(parts.isError ? { isError: true } : {}) };
  }

  // -- run (AGENT-TOOLS 1.8 §9): a batch of steps, answered once

  async run(args: Shape<"run">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const steps = args.steps as Step[];
    for (const [i, step] of steps.entries()) {
      if (!(RUN_TOOLS as readonly string[]).includes(step.tool)) {
        return fail(`Error bad_params: step ${i + 1}: "${step.tool}" can't be a step (steps act; use it on its own call). Steps can be: ${RUN_TOOLS.join(", ")}.`);
      }
      const shape = toolShapes[step.tool as RunTool];
      const { tool: _tool, expect: _expect, route: _route, ...params } = step as Step & { route?: unknown };
      if (step.tool === "compare_screen" && (params as { update?: unknown }).update !== undefined) {
        return fail(`Error bad_params: step ${i + 1}: update can't be used in run (a step never saves a reference)`);
      }
      const under = step.expect?.under;
      if (under !== undefined) {
        if (step.tool !== "performance") {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): under goes only on a performance step.`);
        }
        const unknown = badUnderKeys(under);
        if (unknown.length > 0) {
          return fail(
            `Error bad_params: step ${i + 1} (${describeRunStep(step)}): under has ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the limits are ${UNDER_KEYS.join(", ")}.`,
          );
        }
        if (Object.keys(under).length === 0) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): under is empty; give at least one limit (${UNDER_KEYS.join(", ")}).`);
        }
        const negative = Object.entries(under).filter(([, limit]) => limit < 0 || !Number.isFinite(limit));
        if (negative.length > 0) {
          return fail(
            `Error bad_params: step ${i + 1} (${describeRunStep(step)}): under limits can't be negative (${negative.map(([key]) => key).join(", ")}).`,
          );
        }
        if (under["launch_s"] !== undefined && (step as { launch?: unknown }).launch !== true) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): launch_s goes only on a launch step (performance with launch: true).`);
        }
      }
      // A step's own look and screenshot are ignored (§9.1).
      if (step.tool === "performance") {
        delete params["look"];
        delete params["screenshot"];
      }
      const parsed = z.object(shape).strict().safeParse(params);
      if (!parsed.success) {
        return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ")}`);
      }
      if (step.expect?.ignore !== undefined) {
        const ignored = ignoreListSchema.safeParse(step.expect.ignore);
        if (!ignored.success) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): expect.ignore: ${ignored.error.issues.map((issue) => issue.message).join("; ")}`);
        }
      }
    }
    this.diffSaved = null;
    if (args.dry_run === true) return this.dryRunBatch(steps);
    const before = this.unlistedActions.get(session.id) ?? 0;
    const started = Date.now();
    const batchId = `b${started.toString(36)}`;
    const notes: string[] = [];
    const trace: string[] = [];
    let ran = 0;
    let stop: { index: number; code: string; message: string; rest: string[] } | null = null;
    // The newest log time when the current step began: a failed step shows the app's warnings since then (§15.4).
    let stepMark: number | undefined;
    for (const [i, step] of steps.entries()) {
      if (Date.now() - started > RUN_TIMEOUT_MS) {
        stop = { index: i, code: "timeout", message: `the batch ran longer than ${RUN_TIMEOUT_MS / 1000} s`, rest: [] };
        break;
      }
      const at = Date.now();
      stepMark = this.newestLogTs(session.id);
      this.batch = { id: batchId, step: i + 1 };
      const answer = await this.runStep(step).finally(() => {
        this.batch = undefined;
      });
      const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
      if (answer.isError === true) {
        stop = { index: i, ...parseError(said) };
        break;
      }
      notes.push(...stepNotes(said, i + 1));
      if (step.expect?.under !== undefined) {
        // AGENT-TOOLS §15.3: the limits a performance step must keep; every broken one is listed.
        const measured = this.lastPerf;
        if (measured === undefined) {
          // A limit nobody measured must not pass.
          stop = { index: i, code: "expect_failed", message: "no measurement to check.", rest: [] };
          break;
        }
        const checked = checkUnder(step.expect.under, measured);
        notes.push(...checked.notes.map((note) => `Note (step ${i + 1}): ${note}`));
        if (checked.missed.length > 0) {
          stop = { index: i, code: "expect_failed", message: `${checked.missed.join("; ")}.`, rest: [] };
          break;
        }
      } else if (step.expect !== undefined) {
        const missed = await this.expectMissed(step.expect);
        if (missed !== null) {
          stop = { index: i, code: "expect_failed", message: `its action ran, but ${missed}`, rest: [] };
          break;
        }
      }
      const route = (step as { route?: unknown }).route;
      if (Array.isArray(route) && route.every((part) => typeof part === "string")) {
        const now = await this.currentRoute();
        if (now !== null && now.join(" \u203a ") !== route.join(" \u203a ")) {
          stop = { index: i, code: "expect_failed", message: `its action ran, but it ended on ${now.join(" \u203a ")}; the recording ended on ${route.join(" \u203a ")}`, rest: [] };
          break;
        }
      }
      ran++;
      if (args.trace === true) trace.push(`  ${i + 1}. ${said.split("\n")[0] ?? ""} (${((Date.now() - at) / 1000).toFixed(1)} s)`);
    }
    // The batch is one call: the changes below are measured from the list the agent had before it.
    if (before > 0) this.unlistedActions.set(session.id, before);
    else this.unlistedActions.delete(session.id);
    const total = steps.length;
    const failed = stop !== null;
    const head = stop === null
      ? `Ran ${total} of ${total} steps in ${((Date.now() - started) / 1000).toFixed(1)} s.`
      : `Error ${stop.code}: Ran ${ran} of ${total} steps; stopped at step ${stop.index + 1} (${describeRunStep(steps[stop.index] as Step)}): ${stop.message}`;
    const diffNote = stop !== null && this.diffSaved !== null ? [`Note: the difference is saved at ${this.diffSaved}.`] : [];
    const first = [head, ...trace, ...(stop?.rest ?? []), ...diffNote].join("\n");
    const tail = [...(stop !== null ? this.failureLogs(session.id, stop.index + 1, stepMark) : []), ...notes];
    let response: CallToolResult;
    const live = this.host.current();
    if (args.look === false || live === undefined) {
      response = text([first, ...tail].join("\n"));
    } else {
      response = await this.withLook(live, first, args.screenshot === true);
      if (tail.length > 0) {
        const [top, ...rest] = response.content;
        if (top !== undefined && top.type === "text") response = { ...response, content: [{ type: "text", text: [top.text.trimEnd(), ...tail].join("\n") }, ...rest] };
      }
    }
    return failed ? { ...response, isError: true } : response;
  }

  /** The newest log time of a session (or of the app's current session), undefined without lines. */
  private newestLogTs(sessionId: string): number | undefined {
    return this.sessionLogs(sessionId).reduce<number | undefined>((max, e) => (e.ts !== undefined && (max === undefined || e.ts > max) ? e.ts : max), undefined);
  }

  /** A session's buffered lines; when it is gone (the app went away and came back), the current session's. */
  private sessionLogs(sessionId: string): LogEntry[] {
    const ids = [sessionId, this.host.current()?.id].filter((id): id is string => id !== undefined);
    for (const id of ids) {
      try {
        return this.host.logs(id);
      } catch {
        // that session is gone; try the next
      }
    }
    return [];
  }

  /** AGENT-TOOLS §15.4: `Logs (since step <n>):` and up to 20 lines at warning or above since the step began. */
  private failureLogs(sessionId: string, step: number, since: number | undefined): string[] {
    const lines = filterLogs(this.sessionLogs(sessionId), { since, level: "warning", limit: 20 });
    return lines.length === 0 ? [] : [`Logs (since step ${step}):`, ...formatLogs(lines).split("\n")];
  }

  /** `run` with dry_run (§11.4): the steps are checked already; step 1 is resolved, nothing is touched. */
  private async dryRunBatch(steps: Step[]): Promise<CallToolResult> {
    const total = steps.length;
    const first = steps[0] as Step;
    const head = `Would run ${total} step${total === 1 ? "" : "s"}`;
    // A performance step with a tap: the tap resolves like any touch; nothing is measured (AGENT-TOOLS §15.3).
    const perfTap = first.tool === "performance" ? (first as Record<string, unknown>)["tap"] : undefined;
    const probe = perfTap !== undefined ? ({ tool: "tap", target: perfTap } as Step) : first;
    if (["tap", "long_press", "toggle", "type_text", "scroll", "back", "swipe"].includes(probe.tool)) {
      const answer = await this.runStep({ ...probe, dry_run: true } as Step);
      const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
      const [line, ...rest] = said.split("\n");
      if (answer.isError === true) {
        const { code, message } = parseError(said);
        return fail(`Error ${code}: ${head}; step 1 (${describeRunStep(first)}) would fail: ${message}`);
      }
      const would = (line ?? "").replace(/^Would /, "would ");
      return text([`${head}; step 1 ${would}`, ...rest].join("\n"));
    }
    if (first.tool === "performance") {
      const p = first as Record<string, unknown>;
      return text(`${head}; step 1 would ${p["launch"] === true ? "reload the app and time it to the first settled screen" : `measure ${Number(p["seconds"] ?? 3)} s`}.`);
    }
    return text(`${head}; step 1 would ${describeRunStep(first)}.`);
  }

  /** One step of `run`, as its own tool call without a list. */
  private runStep(step: Step): Promise<CallToolResult> {
    const { tool, expect: _expect, route: _route, ...rest } = step as Step & { route?: unknown };
    const quiet = { ...rest, look: false, screenshot: false };
    switch (tool as RunTool) {
      case "tap":
        return this.tap(quiet as Shape<"tap">);
      case "long_press":
        return this.longPress(quiet as Shape<"long_press">);
      case "type_text":
        return this.typeText(quiet as Shape<"type_text">);
      case "scroll":
        return this.scroll(quiet as Shape<"scroll">);
      case "toggle":
        return this.toggle(quiet as Shape<"toggle">);
      case "back":
        return this.back(quiet as Shape<"back">);
      case "swipe":
        return this.swipe(quiet as Shape<"swipe">);
      case "open_url":
        return this.openUrl(quiet as Shape<"open_url">);
      case "wait":
        return this.wait({ seconds: Number((rest as { seconds?: unknown }).seconds ?? 0) });
      case "wait_for":
        return this.waitFor(quiet as Shape<"wait_for">);
      case "app_command":
        return this.appCommand(quiet as Shape<"app_command">);
      case "compare_screen":
        return this.compareStep(rest as Shape<"compare_screen">);
      case "performance":
        return this.performance(rest as Shape<"performance">);
    }
  }

  /** The screen's route names now (one cheap read), or null when the app has no router or didn't answer. */
  private async currentRoute(): Promise<string[] | null> {
    const session = this.host.current();
    if (session === undefined) return null;
    const tree = treeResultSchema.safeParse(await this.host.request("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
    return tree.success && tree.data.route !== undefined ? tree.data.route.names : null;
  }

  /** Null when the expectation holds within its time; else how it failed. */
  private async expectMissed(e: Expect): Promise<string | null> {
    if (e.text !== undefined || e.id !== undefined || e.label !== undefined) {
      const missed = await this.textExpectMissed(e);
      if (missed !== null) return missed;
    }
    // A picture check comes last, once the rest held.
    return e.matches === undefined ? null : this.matchMissed(e.matches, e.threshold ?? DEFAULT_MATCH_THRESHOLD, ignoreListSchema.parse(e.ignore ?? []));
  }

  private async textExpectMissed(e: Expect): Promise<string | null> {
    const seconds = e.timeout ?? EXPECT_TIMEOUT_S;
    const which = e.text !== undefined ? { text: e.text } : e.id !== undefined ? { id: e.id } : { label: e.label as string };
    const seen = await this.waitFor({ ...which, ...(e.gone === true ? { gone: true } : {}), timeout: Math.max(0.5, seconds), look: false });
    if (seen.isError === true) return expectFailure(e, seconds);
    if (e.value === undefined || e.gone === true) return null;
    // The element is there: wait for its value (a switch reads "on" or "off").
    const session = this.host.current();
    if (session === undefined) return expectFailure(e, seconds);
    const until = Date.now() + seconds * 1000;
    let actual: string | undefined;
    for (;;) {
      const tree = treeResultSchema.safeParse(await this.host.request("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
      const element = tree.success
        ? tree.data.elements.find((el) => (e.id !== undefined ? el.testID === e.id : (el.label ?? "").toLowerCase() === (e.label ?? "").toLowerCase()))
        : undefined;
      if (element !== undefined) {
        actual = typeof element.checked === "boolean" ? (element.checked ? "on" : "off") : typeof element.value === "string" ? element.value : undefined;
        // A switch takes "true" and "false" too (it reads checked=true in the list).
        const wanted = typeof element.checked === "boolean" && (e.value === "true" || e.value === "false") ? (e.value === "true" ? "on" : "off") : e.value;
        if (actual === wanted) return null;
      }
      if (Date.now() >= until) return expectFailure(e, seconds, actual);
      await sleep(100);
    }
  }

  // -- inspect (Tapline 1.1): from the screen to the code

  async inspect(args: Shape<"inspect">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    let raw: unknown;
    try {
      raw = await this.host.request("inspect", { target: toWireTarget(args.target) }, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = inspectResultSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned an inspect answer the host could not read.");
    return text(formatInspect(parsed.data));
  }

  // -- audit (AGENT-TOOLS 1.8 §10)

  async audit(args: Shape<"audit"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (!session.capabilities.includes("audit")) {
      return fail("Error unsupported: this app's Tapline is too old for audit; update react-native-tapline (check_layout works meanwhile).");
    }
    let raw: unknown;
    try {
      raw = await this.host.request("audit", args.types !== undefined ? { types: args.types } : {}, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = auditResultSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned an audit the host could not read.");
    const title = auditTitle(await this.currentRoute(), session.app.name);
    return text([formatAudit(title, parsed.data, args.types), ...this.takePersonNote()].join("\n"));
  }

  // -- check_layout

  async checkLayout(_args: Shape<"check_layout"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    let raw: unknown;
    try {
      raw = await this.host.request("check", {}, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = findingsSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned layout findings the host could not read.");
    const findings = parsed.data.findings;
    if (findings.length === 0) {
      return text(
        "No layout problems found (tap areas, cut-off edges, overlaps, text contrast, unnamed buttons, truncated text). Refs are from the latest list.",
      );
    }
    const lines = findings.map((f) => `${f.ref} ${f.kind}: ${f.message}`);
    return text(
      [`${findings.length} finding${findings.length === 1 ? "" : "s"} (refs from the latest list):`, ...lines].join("\n"),
    );
  }

  /** Saves a file-mode screenshot (0600, newest `screenshotKeep` kept) and returns its path. */
  private saveShot(sessionId: string, mime: string, data: string): string {
    const dir = this.options.screenshotDir;
    if (dir === undefined) throw new Error("screenshotDir is not set");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = mime === "image/png" ? "png" : "jpg";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${sessionId}-${++this.shotCount}.${ext}`);
    writeFileSync(path, Buffer.from(data, "base64"), { mode: 0o600 });
    this.shotFiles.push(path);
    const keep = Math.max(1, this.options.screenshotKeep ?? 50);
    while (this.shotFiles.length > keep) {
      const old = this.shotFiles.shift();
      if (old !== undefined) rmSync(old, { force: true });
    }
    return path;
  }

  /** Text lines plus an optional screenshot (an image, or a file path in file mode) for the current screen. */
  private async lookParts(
    session: SessionInfo,
    wantScreenshot: boolean,
    width: number = DEFAULT_SCREENSHOT_WIDTH,
    onlyChanges = false,
    labels = false,
  ): Promise<{ content: CallToolResult["content"]; isError: boolean }> {
    const sid = session.id;
    // Changes only make sense against a list this agent has already been given in this session.
    const askChanges = onlyChanges && this.listed.has(sid);
    // `onlyChanges` is the after-an-action call. With `changes: true` the app keeps the refs and
    // counts on from the highest one; `look` (onlyChanges false) always restarts at e1.
    const treeParams: Record<string, unknown> = askChanges ? { changes: true } : {};
    const treePromise = this.host.request("tree", treeParams, { sessionId: sid });
    const shotPromise =
      wantScreenshot && !this.noScreenshot.has(sid)
        ? this.host
            .request("screenshot", { format: "jpg", quality: 0.75, maxWidth: width }, { sessionId: sid })
            .then((value) => ({ ok: true as const, value }))
            .catch((error: unknown) => ({ ok: false as const, error }))
        : Promise.resolve(undefined);

    let tree: TreeResult;
    try {
      const raw = await treePromise;
      const parsed = treeResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new TaplineError("internal", "The app returned a tree the host could not read.");
      }
      tree = parsed.data;
    } catch (error) {
      await shotPromise;
      return { content: [{ type: "text", text: describeError(error) }], isError: true };
    }

    this.listed.add(sid);
    this.lastLookRoute = tree.route?.names;
    if (tree.screen) this.lastScreen = { w: tree.screen.width, h: tree.screen.height };
    const alertsNow = (tree.alerts ?? []).length > 0;
    const alertGone = this.alertOpen.has(sid) && !alertsNow;
    if (alertsNow) this.alertOpen.add(sid);
    else this.alertOpen.delete(sid);
    const changesText = askChanges ? formatChanges(tree, { alertGone }) : null;
    // A full list gives every ref a fresh meaning, so refs are trustworthy again.
    if (changesText === null) this.personActed = false;
    const lines = [changesText ?? formatTree(tree, { name: session.app.name, id: session.app.id })];
    // A full list in place of the changes (most of the screen changed) still says what changed out of view.
    if (askChanges && changesText === null) lines.push(...formatOffScreenAfterList(tree));
    const content: CallToolResult["content"] = [];
    // Notes come last (AGENT-TOOLS §3.6), after the list and any `Screenshot:` path line.
    const notes: string[] = [...alertNotes(tree)];
    // The changes are measured from the agent's last list. When actions answered with `look: false`
    // came in between, the block covers them too, and "No visible change." may hide a round trip
    // (a sheet opened by one action and closed by this one): say how far back the list is.
    const unlisted = this.unlistedActions.get(sid) ?? 0;
    this.unlistedActions.delete(sid);
    if (changesText !== null && unlisted > 0) {
      notes.push(`Note: changes are since your last list, ${unlisted + 1} actions ago.`);
    }
    if (tree.elements.length === 0) {
      notes.push(
        "Note: something outside the app (a system sheet or browser) may cover it. Tapline can't see it: ask the user, or use Tapwright.",
      );
    }
    const shot = await shotPromise;
    if (shot === undefined) {
      if (wantScreenshot) notes.push(NO_SCREENSHOT_NOTE);
    } else if (shot.ok) {
      const parsed = screenshotResultSchema.safeParse(shot.value);
      if (!parsed.success) notes.push("Note: screenshot unavailable: unreadable response.");
      else {
        const screen = tree.screen;
        const image =
          labels && screen !== null && screen !== undefined
            ? annotateScreenshot(parsed.data, tree.elements, screen)
            : parsed.data;
        if (labels) notes.push("Note: screenshot labeled with each tappable element's box and ref.");
        if (this.options.screenshots === "file") {
          const { mime, data, width: w, height: h } = image;
          try {
            const size = w !== undefined && h !== undefined ? ` (${w}x${h})` : "";
            lines.push(`Screenshot: ${this.saveShot(sid, mime, data)}${size}`);
          } catch (error) {
            notes.push(`Note: screenshot not saved: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else content.push({ type: "image", data: image.data, mimeType: image.mime });
      }
    } else if (shot.error instanceof TaplineError && shot.error.code === "unsupported") {
      this.noScreenshot.add(sid);
      notes.push(NO_SCREENSHOT_NOTE);
    } else {
      notes.push(`Note: screenshot failed: ${shot.error instanceof Error ? shot.error.message : String(shot.error)}`);
    }
    lines.push(...notes, ...this.takePersonNote());
    return { content: [{ type: "text", text: lines.join("\n") }, ...content], isError: false };
  }

  // -- actions

  /** The one-time note that a person used the app, as note lines (empty when already said). */
  private takePersonNote(): string[] {
    if (!this.personNotePending) return [];
    this.personNotePending = false;
    return ["Note: a person used the app since your last look."];
  }

  /** Runs a request, then (unless disabled) appends the fresh element list and how long the app took to settle. */
  private async act(
    method: string,
    params: unknown,
    describe: (result: unknown) => string,
    withLook: boolean | undefined,
    screenshot?: boolean,
    extraNotes?: (result: unknown) => string[],
    /** True when the result means nothing was done: the first line is then the whole answer. */
    nothingDone?: (result: unknown) => boolean,
    /** Runs inside the agent's turn, right before the request: an answer stops the call there (the policy). */
    preflight?: () => Promise<CallToolResult | null>,
  ): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    let result: unknown;
    this.actionStartedAt = Date.now();
    try {
      const timeoutMs = answerTimeoutMs(method, params);
      const run = async (): Promise<unknown> => {
        if (preflight !== undefined) {
          const stop = await preflight();
          if (stop !== null) throw new PolicyStop(stop);
        }
        return this.host.request(method, params, { sessionId: session.id, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      };
      // With the live viewer, a person watching goes first.
      result = this.options.control ? await this.options.control.runAgent(run) : await run();
    } catch (error) {
      if (error instanceof PolicyStop) return error.answer;
      this.logExtra = undefined;
      this.showAction(
        "agent",
        method,
        undefined,
        params,
        error instanceof TaplineError ? error.code : "internal",
        error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined,
      );
      return fail(describeError(error));
    }
    const line = describe(result);
    if (nothingDone?.(result) === true) {
      this.logExtra = undefined;
      return text([line, ...this.takePersonNote()].join("\n"));
    }
    this.showAction("agent", method, result, params);
    let response: CallToolResult;
    this.lastLookRoute = undefined;
    const settledMs =
      typeof result === "object" && result !== null && "settledMs" in result ? (result as { settledMs: unknown }).settledMs : undefined;
    const settled = typeof settledMs === "number" && Number.isFinite(settledMs) && settledMs >= 0
      ? `Settled in ${(settledMs / 1000).toFixed(2)} s.`
      : undefined;
    if (withLook === false) {
      this.unlistedActions.set(session.id, (this.unlistedActions.get(session.id) ?? 0) + 1);
      response = text([line, ...this.takePersonNote()].join("\n"));
    } else {
      // The app already waited until it was still (AGENT-TOOLS §6), so the list is fresh.
      response = await this.withLook(session, line, screenshot === true);
      if (settled !== undefined) {
        const [first, ...rest] = response.content;
        if (first !== undefined && first.type === "text") {
          // `Settled in` is the last line that isn't a note: it goes before the trailing `Note:` lines.
          const all = first.text.trimEnd().split("\n");
          let end = all.length;
          while (end > 1 && all[end - 1]?.startsWith("Note: ") === true) end--;
          all.splice(end, 0, settled);
          response = { ...response, content: [{ type: "text", text: all.join("\n") }, ...rest] };
        }
      }
    }
    const extra = [...(extraNotes?.(result) ?? [])];
    const capMs = typeof result === "object" && result !== null && "settleCapMs" in result ? (result as { settleCapMs: unknown }).settleCapMs : undefined;
    if (typeof capMs === "number" && Number.isFinite(capMs) && capMs > 0) {
      extra.push(`Note: the screen was still changing after ${Number((capMs / 1000).toFixed(3))} s (an animation or video); positions may be mid-change.`);
    }
    if (KEYBOARD_METHODS.has(method) && typeof result === "object" && result !== null && "closedKeyboard" in result && result.closedKeyboard === true) {
      extra.push("Note: closed the keyboard first.");
    }
    // `force` let through what the checks refuse (AGENT-TOOLS v1.6): the answer mustn't read like any tap.
    if (typeof result === "object" && result !== null && "forced" in result && typeof result.forced === "string" && /^[a-z_]+$/.test(result.forced)) {
      extra.push(`Note: forced (${result.forced}): a person couldn't have done this.`);
    }
    if (extra.length > 0) {
      const [first, ...rest] = response.content;
      if (first !== undefined && first.type === "text") {
        response = { ...response, content: [{ type: "text", text: [first.text.trimEnd(), ...extra].join("\n") }, ...rest] };
      }
    }
    if (this.recording !== null && !this.replaying) {
      const { params: chosen, fragile } = stableParams(params, result);
      // A ref saved as a label or text that several elements share needs its index (AGENT-TOOLS 1.8 §9.4).
      const stable = await this.withIndexIfShared(params, chosen, result, session.id);
      // A password field's text is never saved in a script (Tapwright's review, M4).
      const secret = method === "type" && typeof result === "object" && result !== null && "secure" in result && result.secure === true;
      const step: ScriptStep = { method, params: secret ? { ...stable, text: "" } : stable };
      if (secret) step.secret = true;
      if (this.lastLookRoute !== undefined) step.route = this.lastLookRoute;
      if (fragile) step.fragile = true;
      this.recording.steps.push(step);
    }
    return response;
  }

  /**
   * When the agent's ref was saved as a testID, label or text that more than one element on screen has, add
   * the element's `index` among them (reading order), so the replay picks the same one instead of
   * answering `ambiguous`. One extra read, only while recording and only for ref targets.
   */
  private async withIndexIfShared(
    original: unknown,
    chosen: Record<string, unknown>,
    result: unknown,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const before = typeof original === "object" && original !== null ? (original as { target?: unknown }).target : undefined;
    const target = chosen["target"];
    if (typeof before !== "object" || before === null || !("ref" in before)) return chosen;
    if (typeof target !== "object" || target === null || "ref" in target || "index" in target) return chosen;
    const element = typeof result === "object" && result !== null && "element" in result
      ? elementSchema.safeParse((result as { element: unknown }).element)
      : null;
    if (!element?.success) return chosen;
    const tree = treeResultSchema.safeParse(await this.host.request("tree", { peek: true }, { sessionId }).catch(() => null));
    if (!tree.success) return chosen;
    const t = target as { testID?: unknown; label?: unknown; text?: unknown };
    const same = tree.data.elements.filter((el) =>
      typeof t.testID === "string"
        ? el.testID === t.testID
        : typeof t.label === "string"
          ? (el.label ?? "").toLowerCase() === t.label.toLowerCase()
          : typeof t.text === "string"
            ? el.text === t.text
            : false,
    );
    if (same.length < 2) return chosen;
    const at = same.findIndex((el) => el.ref === element.data.ref);
    return at < 0 ? chosen : { ...chosen, target: { ...(target as Record<string, unknown>), index: at } };
  }

  // -- the live viewer

  /** An element's frame (points) as 0..1 of the screen. */
  private normalized(frame: { x: number; y: number; width: number; height: number } | null | undefined): Rect | undefined {
    const screen = this.lastScreen;
    if (!frame || !screen || screen.w <= 0 || screen.h <= 0) return undefined;
    return { x: frame.x / screen.w, y: frame.y / screen.h, w: frame.width / screen.w, h: frame.height / screen.h };
  }

  /** The viewer's description of an action: its kind (protocol 1.4), its element's name and where it was. */
  private describeAction(kind: string, result: unknown, point?: { x: number; y: number }): Omit<ViewerAction, "by" | "ok" | "code"> {
    const element =
      typeof result === "object" && result !== null && "element" in result
        ? elementSchema.safeParse((result as { element: unknown }).element)
        : null;
    const data = element?.success ? element.data : undefined;
    const label = data ? (data.text || data.label || data.testID || undefined) : undefined;
    const rect = this.normalized(data?.frame);
    return {
      kind,
      ...(label ? { label: label.slice(0, 80) } : {}),
      ...(rect ? { rect } : {}),
      ...(point ? { point } : {}),
    };
  }

  /** One line in the action log (§12). Never fails the action. */
  private logAction(by: "agent" | "person", tool: string, params: unknown, result: unknown, code?: string, reason?: string): void {
    if (this.actionLog === null) return;
    const element =
      typeof result === "object" && result !== null && "element" in result
        ? elementSchema.safeParse((result as { element: unknown }).element)
        : null;
    const session = this.host.current();
    this.actionLog.write({
      by,
      tool,
      ...loggedTarget(params),
      // typed text never reaches the log, not even as the field's value (§12)
      ...(element?.success ? { element: formatElement({ ...element.data, ref: "", value: null, placeholder: null }, { actions: false }) } : {}),
      ok: code === undefined,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(by === "agent" && this.actionStartedAt !== undefined ? { ms: Date.now() - this.actionStartedAt } : {}),
      ...(session !== undefined ? { app: session.app.id ?? session.app.name } : {}),
      ...(by === "agent" && this.batch !== undefined ? { batch: this.batch } : {}),
      ...(by === "agent" ? (this.logExtra ?? {}) : {}),
    });
    if (by === "agent") this.logExtra = undefined;
  }

  private showAction(by: "agent" | "person", method: string, result: unknown, params: unknown, code?: string, reason?: string): void {
    const onAction = this.options.onAction;
    if (onAction === undefined) {
      this.logAction(by, by === "agent" ? agentKind(method) : method, params, result, code, reason);
      return;
    }
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    const t = typeof target === "object" && target !== null ? (target as { x?: unknown; y?: unknown }) : undefined;
    const screen = this.lastScreen;
    const point =
      t && typeof t.x === "number" && typeof t.y === "number" && screen ? { x: t.x / screen.w, y: t.y / screen.h } : undefined;
    const kind = by === "agent" ? agentKind(method) : method;
    this.logAction(by, kind, params, result, code, reason);
    const described = this.describeAction(kind, result, point);
    // A failed step has no element in its answer: name it from the target the agent gave, if it's words.
    const named =
      described.label ??
      (t && typeof (t as { text?: unknown }).text === "string" ? (t as { text: string }).text : undefined) ??
      (t && typeof (t as { label?: unknown }).label === "string" ? (t as { label: string }).label : undefined);
    const caption = by === "agent" ? captionFor(kind, kind === "app_command" ? undefined : named, params) : undefined;
    try {
      onAction({
        by,
        ...described,
        ...(caption !== undefined ? { caption } : {}),
        ok: code === undefined,
        ...(code ? { code } : {}),
        ...(reason ? { reason } : {}),
      });
    } catch {
      // a viewer's trouble must not fail the action
    }
  }

  /** The screen size in points, from the latest list or a fresh overlay read. */
  private async screenSize(sessionId: string): Promise<{ w: number; h: number } | undefined> {
    if (this.lastScreen) return this.lastScreen;
    await this.readOverlay(sessionId).catch(() => null);
    return this.lastScreen;
  }

  /** The elements on screen for the live viewer's boxes, in points. */
  async readOverlay(sessionId?: string): Promise<OverlayRead | null> {
    const sid = sessionId ?? this.host.current()?.id;
    if (sid === undefined) return null;
    const parsed = overlaySchema.safeParse(await this.host.request("overlay", {}, { sessionId: sid }));
    if (!parsed.success) return null;
    const { rev, screen, elements } = parsed.data;
    this.lastScreen = { w: screen.width, h: screen.height };
    return {
      ...(rev !== undefined ? { rev } : {}),
      size: { w: screen.width, h: screen.height },
      elements: elements.map((e) => ({
        ref: e.ref ?? null,
        type: e.type ?? null,
        label: e.label ?? null,
        id: e.id ?? null,
        rect: { x: e.frame.x, y: e.frame.y, w: e.frame.width, h: e.frame.height },
      })),
    };
  }

  /** Starts or stops the app's frames. */
  async setFeed(on: boolean, quality: QualityPreset): Promise<{ ok: boolean; code?: string; message?: string }> {
    const session = this.host.current();
    if (session === undefined) return { ok: false, message: "No app is connected." };
    try {
      await this.host.request("feed", feedParams(on, quality), { sessionId: session.id });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof TaplineError ? error.code : "internal",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** A person's input from the live viewer, mapped onto the app's actions; it goes ahead of the agent. */
  async personInput(input: PersonInput): Promise<InputOutcome> {
    const session = this.host.current();
    if (session === undefined) return { ok: false, code: "reconnecting", message: "The app isn't connected." };
    const run = async (): Promise<InputOutcome> => {
      const size = await this.screenSize(session.id);
      if (size === undefined) return { ok: false, code: "unsupported", message: "Couldn't read the screen size yet." };
      const { method, params, point, swipe } = this.mapInput(input, size);
      // The request reaches the app from here on, whether it succeeds or is refused.
      this.markPersonUsedApp();
      // A drag goes to what takes a finger's drag (a sheet's swipe to close, a pan view) first; when
      // nothing does (a list moves natively), it scrolls, as before.
      if (swipe !== undefined) {
        try {
          const swiped = await this.host.request("swipe", swipe, { sessionId: session.id });
          return { ok: true, action: this.describeAction(personKind(input, "swipe"), swiped, point) };
        } catch (error) {
          if (!(error instanceof TaplineError && error.code === "not_actionable")) {
            return { ...failure(error), action: { kind: personKind(input, "swipe"), ...(point ? { point } : {}) } };
          }
        }
      }
      try {
        const result = await this.host.request(method, params, { sessionId: session.id });
        return { ok: true, action: this.describeAction(personKind(input, method), result, point) };
      } catch (error) {
        return { ...failure(error), action: { kind: personKind(input, method), ...(point ? { point } : {}) } };
      }
    };
    try {
      const outcome = this.options.control ? await this.options.control.runPerson(run) : await run();
      // The log (§12): a person's input too, its typed text only as a length.
      this.logAction("person", outcome.action?.kind ?? input.type, input.type === "text" ? { text: input.text } : {}, undefined, outcome.ok ? undefined : outcome.code, outcome.reason);
      return outcome;
    } catch (error) {
      return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private mapInput(
    input: PersonInput,
    size: { w: number; h: number },
  ): { method: string; params: Record<string, unknown>; point?: { x: number; y: number }; swipe?: Record<string, unknown> } {
    switch (input.type) {
      case "gesture": {
        const first = input.points[0] ?? [0, 0, 0];
        const last = input.points[input.points.length - 1] ?? first;
        const fx = first[1] * size.w;
        const fy = first[2] * size.h;
        const moved = Math.max(...input.points.map(([, x, y]) => Math.hypot(x * size.w - fx, y * size.h - fy)));
        const target = { x: Math.round(fx), y: Math.round(fy) };
        const point = { x: first[1], y: first[2] };
        if (moved < TAP_SLOP) {
          return { method: last[0] - first[0] >= LONG_PRESS_MS ? "longPress" : "press", params: { target }, point };
        }
        const dx = (last[1] - first[1]) * size.w;
        const dy = (last[2] - first[2]) * size.h;
        // A finger moving up shows what is further down.
        const vertical = Math.abs(dy) >= Math.abs(dx);
        const direction = vertical ? (dy < 0 ? "down" : "up") : dx < 0 ? "right" : "left";
        const seconds = Math.min(5, Math.max(0.05, (last[0] - first[0]) / 1000));
        const swipe = { x0: target.x, y0: target.y, x1: Math.round(last[1] * size.w), y1: Math.round(last[2] * size.h), seconds };
        return { method: "scroll", params: { target, direction, amount: Math.round(Math.abs(vertical ? dy : dx)) }, point, swipe };
      }
      case "scroll": {
        const target = { x: Math.round(input.x * size.w), y: Math.round(input.y * size.h) };
        const vertical = Math.abs(input.dy) >= Math.abs(input.dx);
        const direction = vertical ? (input.dy > 0 ? "down" : "up") : input.dx > 0 ? "right" : "left";
        const amount = Math.round(vertical ? Math.abs(input.dy) * size.h : Math.abs(input.dx) * size.w);
        return { method: "scroll", params: { target, direction, amount }, point: { x: input.x, y: input.y } };
      }
      case "text":
        return { method: "type", params: { text: input.text, replace: false, submit: false } };
      case "key":
        return input.key === "enter"
          ? { method: "type", params: { replace: false, submit: true } }
          : { method: "type", params: { backspace: 1, replace: false, submit: false } };
    }
  }

  async viewer(_args: Shape<"viewer"> = {}): Promise<CallToolResult> {
    const links = this.options.viewerLinks?.() ?? [];
    if (links.length === 0) return fail("Error unsupported: this host has no live viewer.");
    const open = this.options.openViewer;
    const local = links[0];
    let lines: string[];
    if (open !== undefined && this.options.viewerLinkToAgent !== true && local !== undefined) {
      // The key in the link can approve a held-back touch: it goes to the browser, never to the agent.
      const opened = open(local);
      lines = [
        opened
          ? "Opened the live view in a browser on this computer: the user watches the app and what you do there, and can tap and type too."
          : "Couldn't open a browser on this computer. Ask the user to start the MCP server with --viewer-link if they want the link.",
        "The link isn't shown to you: its key can approve touches that need a person's OK.",
        ...(links.length > 1 ? ["For their own devices on Tailscale, the user finds that link in this server's log."] : []),
        "While the user acts in the live view, their touches go first and your actions wait.",
      ];
    } else {
      lines = [
        "Live viewer (watch the app, see what you do, and let the user tap and type too):",
        ...links.map((link) => `- ${link}`),
        "The link carries a key: give it to the user only. While they use the viewer, their touches go first and your actions wait.",
      ];
    }
    const feed = this.options.viewerFeed?.();
    const session = this.host.current();
    if (feed?.on === true && session !== undefined) {
      try {
        const answer = feedAnswerSchema.safeParse(await this.host.request("feed", feedParams(true, feed.quality), { sessionId: session.id }));
        const stats = answer.success ? answer.data.stats : undefined;
        if (stats !== undefined) {
          lines.push(
            `Capture: ${stats.frames} frames, ${Math.round(stats.avgCaptureMs)} ms each on average (longest ${Math.round(stats.maxCaptureMs)} ms). Stutter: ${stats.janky} of ${stats.observedFrames} animation frames were slow, ${stats.jankyWhileCapturing} of them during a capture.`,
          );
          if (stats.backoffs !== undefined && stats.backoffs > 0) {
            lines.push(`The feed slowed down ${stats.backoffs} time(s) after slow animation frames near a capture.`);
          }
          if (stats.failures !== undefined && stats.failures > 0) {
            lines.push(
              `Failed captures: ${stats.failures}${stats.lastFailure ? ` (last: ${stats.lastFailure})` : ""}; while captures fail, the viewer gets about one frame a second.`,
            );
          }
        }
      } catch {
        // stats are a bonus
      }
    }
    return text(lines.join("\n"));
  }

  // -- compare_screen and filmstrip

  private async takeShot(sessionId: string, width: number, quality: number): Promise<ShotImage> {
    const raw = await this.host.request("screenshot", { format: "jpg", quality, maxWidth: width }, { sessionId });
    const parsed = screenshotResultSchema.safeParse(raw);
    if (!parsed.success) throw new TaplineError("internal", "The app returned a screenshot the host could not read.");
    return parsed.data;
  }

  /** Adds an image to a result: inline, or saved with its path in file mode. */
  private deliver(sessionId: string, image: ShotImage, lines: string[], content: CallToolResult["content"]): void {
    if (this.options.screenshots === "file") {
      try {
        const size = image.width !== undefined && image.height !== undefined ? ` (${image.width}x${image.height})` : "";
        lines.push(`Image: ${this.saveShot(sessionId, image.mime, image.data)}${size}`);
      } catch (error) {
        lines.push(`Note: image not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else content.push({ type: "image", data: image.data, mimeType: image.mime });
  }

  /** Where this app's reference pictures are kept, or an error answer. */
  private referenceFolder(session: SessionInfo): string | CallToolResult {
    const dir = this.options.baselinesDir;
    if (dir === undefined) return fail("Error internal: no folder for reference pictures is configured.");
    return join(dir, (session.app.id ?? session.app.name).replace(/[^\w.-]/g, "_"));
  }

  /** The element list for naming regions and masking, read as a peek: the agent's refs and baseline must stay as they are. */
  private async peekElements(sessionId: string): Promise<{ scaleBase: number | undefined; elements: TreeResult["elements"] }> {
    try {
      const tree = treeResultSchema.safeParse(await this.host.request("tree", { peek: true }, { sessionId }));
      if (tree.success && tree.data.screen) return { scaleBase: tree.data.screen.width, elements: tree.data.elements };
    } catch {
      // positions stay in pixels
    }
    return { scaleBase: undefined, elements: [] };
  }

  /**
   * Takes the screen and compares it with the saved reference called `name`, never saving. `referencesDirs` are the
   * folders to look in, in order. A missing reference hands back the screenshot, so the caller may save it.
   */
  private async checkAgainstReference(session: SessionInfo, name: string, options: ReferenceOptions): Promise<ReferenceCheck> {
    let shot: ShotImage;
    try {
      shot = await this.takeShot(session.id, options.width, 0.9);
    } catch (error) {
      return { kind: "error", line: describeError(error) };
    }
    const path = options.referencesDirs.map((dir) => join(dir, `${name}.jpg`)).find((candidate) => existsSync(candidate));
    if (path === undefined) return { kind: "missing", shot };
    const reference: ShotImage = { mime: "image/jpeg", data: readFileSync(path).toString("base64") };
    let refSize: { width: number; height: number };
    let shotSize: { width: number; height: number };
    try {
      refSize = imageSize(reference);
      shotSize = imageSize(shot);
    } catch (error) {
      return { kind: "error", line: `Error bad_params: ${error instanceof Error ? error.message : String(error)} To start over, use update: true.` };
    }
    if (refSize.width !== shotSize.width || refSize.height !== shotSize.height) {
      return {
        kind: "size",
        message: `the reference "${name}" is ${refSize.width}x${refSize.height} px and this screen is ${shotSize.width}x${shotSize.height}; take it at the same width, or update: true.`,
      };
    }

    let seen: { scaleBase: number | undefined; elements: TreeResult["elements"] } | undefined;
    const notes: string[] = [];
    const mask: DiffBox[] = [];
    if (options.ignore.length > 0) {
      seen = await this.peekElements(session.id);
      if (seen.scaleBase === undefined) {
        return { kind: "error", line: "Error internal: couldn't read the screen's elements to paint out what ignore names." };
      }
      const masked = ignoreRects(options.ignore, seen.elements, shotSize.width / seen.scaleBase, shotSize);
      mask.push(...masked.rects);
      notes.push(...masked.notes);
    }
    let diff: DiffResult;
    try {
      diff = diffImages(reference, shot, { mask });
    } catch (error) {
      return { kind: "error", line: `Error bad_params: ${error instanceof Error ? error.message : String(error)} To start over, use update: true.` };
    }
    if (diff.changedPixels === 0 || diff.changedPercent <= options.threshold) {
      return { kind: "match", percent: diff.changedPercent, notes };
    }

    // Name the regions in points, with the elements they touch.
    const found = seen ?? (await this.peekElements(session.id));
    const scale = found.scaleBase === undefined ? 1 : diff.width / found.scaleBase;
    const unit = scale === 1 ? "pixels" : "points";
    const regions = diff.boxes.map((box) => {
      const b = { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale };
      // The smallest named elements there: a page-sized container overlaps every change.
      const near = found.elements
        .filter((e) => e.frame && e.frame.x < b.x + b.width && e.frame.x + e.frame.width > b.x && e.frame.y < b.y + b.height && e.frame.y + e.frame.height > b.y)
        .filter((e) => (e.text ?? "") !== "" || (e.label ?? "") !== "" || (e.testID ?? "") !== "")
        .map((e) => ({ e, area: (e.frame?.width ?? 0) * (e.frame?.height ?? 0) }))
        .filter(({ area }) => area <= Math.max(b.width * b.height * 4, 2500))
        .sort((x, y) => x.area - y.area)
        .slice(0, 2)
        .map(({ e }) => describeElement(e));
      return { at: `@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`, near };
    });
    const count = regions.length;
    const where = `in ${count} region${count === 1 ? "" : "s"} (${unit})`;
    const lines = [`Differs from the reference "${name}": ${diff.changedPercent}% changed, ${where}:`];
    for (const region of regions.slice(0, MAX_REGION_LINES)) {
      lines.push(`- ${region.at}${region.near.length > 0 ? `: ${region.near.join(", ")}` : ""}`);
    }
    if (count > MAX_REGION_LINES) lines.push(`(+${count - MAX_REGION_LINES} more regions)`);
    const listed = regions.slice(0, MAX_REGION_LINES).map((region) => region.at).join(", ");
    const reason = `${diff.changedPercent}% changed from the reference "${name}" (threshold ${options.threshold}%), ${where}: ${listed}${count > MAX_REGION_LINES ? `, +${count - MAX_REGION_LINES} more` : ""}.`;
    return { kind: "differs", percent: diff.changedPercent, lines, reason, image: diff.image, notes };
  }

  /** Why a check does not hold (for `run`, as a step or as `matches`), or null when it matches. */
  private referenceReason(check: ReferenceCheck, name: string): { code: string; message: string } | null {
    switch (check.kind) {
      case "match":
        return null;
      case "missing":
        return { code: "expect_failed", message: `no reference "${name}" yet; save one with compare_screen { name: "${name}" }.` };
      case "size":
        return { code: "bad_params", message: check.message };
      case "error": {
        const { code, message } = parseError(check.line);
        return { code, message };
      }
      case "differs":
        return { code: "expect_failed", message: check.reason };
    }
  }

  /** Whether the screen matches the reference `name` now (`expect.matches`): null when it does, else the reason. */
  private async matchMissed(name: string, threshold: number, ignore: IgnoreItem[]): Promise<string | null> {
    const session = this.host.current();
    if (session === undefined) return "the app isn't connected";
    const folder = this.referenceFolder(session);
    if (typeof folder !== "string") return parseError(folder.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).message;
    if (this.replayContext?.update === true) {
      // --update-references: the check saves the screen into the script's folder, and holds.
      const saved = await this.saveReferenceHere(session, name, DEFAULT_SCREENSHOT_WIDTH, this.replayContext.referencesDir);
      return saved.isError === true ? parseError(saved.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).message : null;
    }
    const check = await this.checkAgainstReference(session, name, {
      threshold,
      ignore,
      width: DEFAULT_SCREENSHOT_WIDTH,
      referencesDirs: this.referencesDirs(folder),
    });
    this.keepDiff(check, name);
    return this.referenceReason(check, name)?.message ?? null;
  }

  /** Where a check looks for `<name>.jpg`: the folder next to a replayed script first, then the app's own store. */
  private referencesDirs(folder: string): string[] {
    return this.replayContext !== null ? [this.replayContext.referencesDir, folder] : [folder];
  }

  /** In a replay, a failed check leaves its red picture at `<script>.diff/<name>.jpg`. */
  private keepDiff(check: ReferenceCheck, name: string): void {
    if (this.replayContext === null || check.kind !== "differs") return;
    const path = join(this.replayContext.diffDir, `${name}.jpg`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(check.image.data, "base64"));
      this.diffSaved = path;
    } catch {
      // the failure still reads without the picture
    }
  }

  /** Takes the screen and saves it as the reference `name` in `dir`. */
  private async saveReferenceHere(session: SessionInfo, name: string, width: number, dir: string): Promise<CallToolResult> {
    try {
      return this.writeReference(dir, name, await this.takeShot(session.id, width, 0.9));
    } catch (error) {
      return fail(describeError(error));
    }
  }

  private writeReference(folder: string, name: string, shot: ShotImage): CallToolResult {
    const path = join(folder, `${name}.jpg`);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(shot.data, "base64"), { mode: 0o600 });
    } catch (error) {
      return fail(`Error internal: couldn't save the reference: ${error instanceof Error ? error.message : String(error)}`);
    }
    let size = `${shot.width ?? "?"}x${shot.height ?? "?"}`;
    try {
      const real = imageSize(shot);
      size = `${real.width}x${real.height}`;
    } catch {
      // the app's own size stays
    }
    return text(`Saved the reference "${name}" (${size} px).`);
  }

  /** A `compare_screen` step of `run`: it never saves; it holds on a match and stops the batch otherwise. */
  private async compareStep(args: Shape<"compare_screen">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const name = args.name.trim();
    if (!SCRIPT_NAME.test(name)) return fail("Error bad_params: name the reference with letters, digits, '.', '_' and '-'.");
    const folder = this.referenceFolder(session);
    if (typeof folder !== "string") return folder;
    if (this.replayContext?.update === true) {
      return this.saveReferenceHere(session, name, args.width ?? DEFAULT_SCREENSHOT_WIDTH, this.replayContext.referencesDir);
    }
    const check = await this.checkAgainstReference(session, name, {
      threshold: args.threshold ?? DEFAULT_MATCH_THRESHOLD,
      ignore: args.ignore ?? [],
      width: args.width ?? DEFAULT_SCREENSHOT_WIDTH,
      referencesDirs: this.referencesDirs(folder),
    });
    this.keepDiff(check, name);
    const why = this.referenceReason(check, name);
    if (why !== null) return fail(`Error ${why.code}: ${why.message}`);
    if (check.kind !== "match") return fail("Error internal: the comparison gave no answer.");
    return text([`Matches the reference "${name}": ${check.percent}% changed.`, ...check.notes.map((n) => `Note: ${n}`)].join("\n"));
  }

  /**
   * `ignore` as a script keeps it (AGENT-TOOLS 1.9 §14.2): a ref becomes the element's id, else label, else text,
   * read from the list now. A string is the error answer when a ref can't be kept.
   */
  private async stableIgnore(sessionId: string, ignore: IgnoreItem[]): Promise<IgnoreItem[] | string> {
    if (!ignore.some((item) => !("width" in item) && item.ref !== undefined)) return ignore;
    const seen = await this.peekElements(sessionId);
    const kept: IgnoreItem[] = [];
    for (const item of ignore) {
      if ("width" in item || item.ref === undefined) {
        kept.push(item);
        continue;
      }
      const element = seen.elements.find((e) => e.ref === item.ref);
      if (element === undefined) return `Error bad_params: ignore ${item.ref} isn't on the screen, so it can't be saved in a script.`;
      if (typeof element.testID === "string" && element.testID !== "") kept.push({ id: element.testID });
      else if (typeof element.label === "string" && element.label !== "") kept.push({ label: element.label });
      else if (typeof element.text === "string" && element.text !== "") kept.push({ text: element.text });
      else {
        return `Error bad_params: ignore ${describeElement(element)} has no id, label or text, so a script couldn't find it again; give it a testID, or ignore a rect {x, y, width, height}.`;
      }
    }
    return kept;
  }

  async compareScreen(args: Shape<"compare_screen">): Promise<CallToolResult> {
    const recording = this.recording !== null && !this.replaying;
    const session = this.host.current();
    let kept: IgnoreItem[] | undefined = args.ignore;
    if (recording && session !== undefined && kept !== undefined && kept.length > 0) {
      const stable = await this.stableIgnore(session.id, kept);
      if (typeof stable === "string") return fail(stable);
      kept = stable;
    }
    const answer = await this.compareScreenNow(args);
    if (recording && this.recording !== null && answer.isError !== true) {
      // `update` is never written: the script checks against the reference it carries.
      this.recording.steps.push({
        method: "compareScreen",
        params: {
          name: args.name.trim(),
          ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
          ...(kept !== undefined && kept.length > 0 ? { ignore: kept } : {}),
          ...(args.width !== undefined ? { width: args.width } : {}),
        },
      });
    }
    return answer;
  }

  private async compareScreenNow(args: Shape<"compare_screen">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const name = args.name.trim();
    if (!SCRIPT_NAME.test(name)) return fail("Error bad_params: name the reference with letters, digits, '.', '_' and '-'.");
    const folder = this.referenceFolder(session);
    if (typeof folder !== "string") return folder;
    const width = args.width ?? DEFAULT_SCREENSHOT_WIDTH;
    const save = (shot: ShotImage): CallToolResult => this.writeReference(folder, name, shot);
    if (args.update === true) {
      try {
        return save(await this.takeShot(session.id, width, 0.9));
      } catch (error) {
        return fail(describeError(error));
      }
    }
    const check = await this.checkAgainstReference(session, name, {
      threshold: args.threshold ?? DEFAULT_MATCH_THRESHOLD,
      ignore: args.ignore ?? [],
      width,
      referencesDirs: [folder],
    });
    switch (check.kind) {
      case "missing":
        return save(check.shot);
      case "error":
        return fail(check.line);
      case "size":
        return fail(`Error bad_params: ${check.message}`);
      case "match":
        return text([`Matches the reference "${name}": ${check.percent}% changed.`, ...check.notes.map((n) => `Note: ${n}`)].join("\n"));
      case "differs": {
        const lines = [...check.lines, "The image shows the screen now, faded, with the changed pixels in red.", ...check.notes.map((n) => `Note: ${n}`)];
        const content: CallToolResult["content"] = [];
        this.deliver(session.id, check.image, lines, content);
        return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
      }
    }
  }

  async filmstrip(args: Shape<"filmstrip">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const count = args.frames ?? 6;
    const interval = args.interval_ms ?? 250;
    const frameWidth = args.frame_width ?? 200;
    const lines: string[] = [];
    try {
      const frames: ShotImage[] = [];
      const started = Date.now();
      if (args.tap !== undefined) {
        // A screenshot takes a few hundred ms on a phone, so frame 1 is the "before".
        // The tap is a touch like any other: the safety policy decides first.
        const pressParams = { target: toWireTarget(args.tap) };
        const gate = await this.policyGate(session, "tap", "press", pressParams, listsFor(this.policy, session.app));
        if ("stop" in gate) return gate.stop;
        frames.push(await this.takeShot(session.id, frameWidth, 0.8));
        await this.host.request("press", pressParams, { sessionId: session.id });
      }
      for (let i = frames.length; i < count; i++) {
        const at = Date.now();
        frames.push(await this.takeShot(session.id, frameWidth, 0.8));
        const rest = interval - (Date.now() - at);
        if (i < count - 1 && rest > 0) await sleep(rest);
      }
      const spacing = count > 1 ? Math.round((Date.now() - started) / count) : 0;
      const strip = composeFilmstrip(frames, { columns: Math.min(3, count), frameWidth });
      lines.push(
        `Filmstrip: ${count} frames about ${spacing} ms apart, numbered in order, left to right and top to bottom${args.tap !== undefined ? "; frame 1 is just before the tap, the rest follow it" : ""}. Each capture takes a few hundred ms on a phone, so very quick animations fall between frames.`,
      );
      const content: CallToolResult["content"] = [];
      this.deliver(session.id, strip, lines, content);
      return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
    } catch (error) {
      return fail(error instanceof TaplineError ? describeError(error) : `Error internal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -- record and replay

  private scriptPath(name: string): string | null {
    const dir = this.options.scriptsDir;
    return dir === undefined || !SCRIPT_NAME.test(name) ? null : join(dir, `${name}.json`);
  }

  async record(args: Shape<"record">): Promise<CallToolResult> {
    const op = args.action ?? (args.start === true ? "start" : args.stop === true ? "stop" : "status");
    switch (op) {
      case "start": {
        const name = (args.name ?? "").trim() || `session-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
        if (this.scriptPath(name) === null) {
          return fail("Error bad_params: give the script a name of letters, digits, '.', '_' and '-' (e.g. \"checkout\").");
        }
        if (this.recording !== null) return fail(`Error bad_params: already recording "${this.recording.name}"; stop it first.`);
        const session = this.host.current();
        if (session === undefined) return this.notConnected();
        this.recording = { name, app: { name: session.app.name, ...(session.app.id ? { id: session.app.id } : {}) }, steps: [] };
        return text(
          `Recording "${name}" on ${session.app.name}. Every action from now on is a step; wait_for steps check the app is where it should be. Prefer testIDs: they replay best. Stop with record { stop: true }.`,
        );
      }
      case "status":
        return text(
          this.recording === null
            ? `Not recording.\n${this.scriptList()}`
            : `Recording "${this.recording.name}": ${this.recording.steps.length} step${this.recording.steps.length === 1 ? "" : "s"} so far.`,
        );
      case "discard": {
        const was = this.recording?.name;
        this.recording = null;
        return text(was === undefined ? "Not recording." : `Discarded the recording "${was}".`);
      }
      case "stop": {
        const recording = this.recording;
        if (recording === null) return fail("Error bad_params: not recording; start with record { start: true, name }.");
        const path = args.path !== undefined && args.path.trim() !== "" ? args.path.trim() : this.scriptPath(recording.name);
        if (path === null) return fail("Error internal: no scripts folder is configured; give a path.");
        const script: SharedScript = {
          format: "agent-tools-script",
          version: 1,
          name: recording.name,
          app: recording.app.id ?? recording.app.name,
          fresh: true,
          steps: scriptSteps(recording.steps),
        };
        try {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
          return fail(`Error internal: couldn't save the script: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.recording = null;
        const count = script.steps.length;
        // AGENT-TOOLS 1.9 §14.3: the references the steps use travel with the script.
        const copied = this.copyReferences(script.steps, recording.app, path);
        const withPictures = copied === null ? "" : `, and ${copied.count} reference picture${copied.count === 1 ? "" : "s"} to ${copied.folder}`;
        const lines = [`Saved ${count} step${count === 1 ? "" : "s"} to ${path}${withPictures}.`];
        const ref = refStep(script.steps);
        if (ref !== null) {
          lines.push(
            `Note: step ${ref + 1} targets a ref, which won't exist on a new run, so replay refuses the script. Give that element a testID, or record it again by its text or label.`,
          );
        }
        const secrets = recording.steps.filter((step) => step.secret === true).length;
        if (secrets > 0) {
          lines.push(
            `${secrets} step${secrets === 1 ? " types" : "s type"} into a password field: that text isn't saved. Put a test password into the script before you replay it.`,
          );
        }
        if (recording.steps.some((step) => step.method === "type" && step.secret !== true)) {
          lines.push("The script keeps the other text typed in it: keep it private.");
        }
        return text(lines.join("\n"));
      }
    }
  }

  /** `<script dir>/<script name>.references` and `.diff` for a script file. */
  private scriptSideFolder(path: string, kind: "references" | "diff"): string {
    return join(dirname(path), `${basename(path).replace(/\.json$/i, "")}.${kind}`);
  }

  /** Copies each reference the steps use from the app's store next to the script; null when there are none. */
  private copyReferences(steps: Step[], app: { name: string; id?: string }, scriptPath: string): { count: number; folder: string } | null {
    const dir = this.options.baselinesDir;
    if (dir === undefined) return null;
    const names = new Set<string>();
    for (const step of steps) {
      const p = step as Record<string, unknown>;
      if (step.tool === "compare_screen" && typeof p["name"] === "string") names.add(p["name"]);
      if (step.expect?.matches !== undefined) names.add(step.expect.matches);
    }
    const store = join(dir, (app.id ?? app.name).replace(/[^\w.-]/g, "_"));
    const folder = this.scriptSideFolder(scriptPath, "references");
    let count = 0;
    for (const name of names) {
      const from = join(store, `${name}.jpg`);
      if (!existsSync(from)) continue;
      try {
        mkdirSync(folder, { recursive: true });
        copyFileSync(from, join(folder, `${name}.jpg`));
        count++;
      } catch {
        // the script still saved; the picture stays in the store
      }
    }
    return count === 0 ? null : { count, folder };
  }

  private scriptList(): string {
    const dir = this.options.scriptsDir;
    if (dir === undefined || !existsSync(dir)) return "No saved scripts.";
    const lines: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const s = readScript(readFileSync(join(dir, file), "utf8"));
        if (s === null) continue;
        lines.push(`- ${s.name} (${s.steps.length} step${s.steps.length === 1 ? "" : "s"}${s.app ? `, ${s.app}` : ""})`);
      } catch {
        // skip unreadable files
      }
    }
    return lines.length === 0 ? "No saved scripts." : ["Saved scripts:", ...lines].join("\n");
  }

  async replay(args: Shape<"replay">, options: { updateReferences?: boolean } = {}): Promise<CallToolResult> {
    const name = (args.name ?? "").trim();
    const given = (args.path ?? "").trim();
    if (name === "" && given === "") return text(this.scriptList());
    if (this.recording !== null) return fail(`Error bad_params: stop recording "${this.recording.name}" before replaying.`);
    const path = given !== "" ? given : this.scriptPath(name);
    if (path === null || !existsSync(path)) return fail(`Error not_found: no script "${given || name}".\n${this.scriptList()}`);
    let script: SharedScript | null;
    try {
      script = readScript(readFileSync(path, "utf8"));
    } catch (error) {
      return fail(`Error internal: couldn't read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (script === null) return fail(`Error bad_params: ${path} isn't a script (format agent-tools-script, version 1).`);
    const ref = refStep(script.steps);
    if (ref !== null) return fail(`Error bad_params: step ${ref + 1} targets a ref; a script needs an id, label, text or point.`);
    if (script.steps.length === 0) return text(`Ran 0 of 0 steps in 0.0 s.`);
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const notes: string[] = [];
    script.steps.forEach((step, i) => {
      const target = (step as Record<string, unknown>)["target"];
      if (typeof target === "object" && target !== null && "x" in target) {
        notes.push(`Note (step ${i + 1}): a point target; it breaks when the layout changes.`);
      }
    });
    if (script.fresh !== false) {
      // Tapline can't close and open the app: it starts its JavaScript again (a development build).
      const fresh = await this.reload({});
      const said = fresh.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      if (fresh.isError === true) notes.push("Note: couldn't start the app fresh (a release build has no reload); the script ran on the screen as it was.");
      else if (said.startsWith("Reload requested, but")) notes.push("Note: the app hadn't reconnected after starting fresh when the steps began.");
    }
    this.replaying = true;
    this.replayContext = {
      referencesDir: this.scriptSideFolder(path, "references"),
      diffDir: this.scriptSideFolder(path, "diff"),
      update: options.updateReferences === true,
    };
    try {
      const answer = await this.run({ steps: script.steps, look: args.look, screenshot: args.screenshot });
      if (notes.length === 0) return answer;
      const [top, ...rest] = answer.content;
      return top !== undefined && top.type === "text"
        ? { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), ...notes].join("\n") }, ...rest] }
        : answer;
    } finally {
      this.replaying = false;
      this.replayContext = null;
    }
  }

  private async withLook(session: SessionInfo, line: string, screenshot = false): Promise<CallToolResult> {
    // The session may have been replaced (app restarted) in the meantime.
    const live = this.host.sessions().some((s) => s.id === session.id) ? session : this.host.current();
    if (live === undefined) return text(`${line}\nNote: the app disconnected, so there's no fresh element list.`);
    // Text only unless asked: a screenshot after every step would cost image tokens the agent rarely needs.
    const parts = await this.lookParts(live, screenshot, DEFAULT_SCREENSHOT_WIDTH, true);
    const [first, ...rest] = parts.content;
    const head = first !== undefined && first.type === "text" ? first.text : "";
    return { content: [{ type: "text", text: `${line}\n${head}` }, ...rest] };
  }

  /**
   * The element a result carries under `key`, for an answer's first line: without its actions, position or
   * size (AGENT-TOOLS 1.8 §13 rule 1; the change block or list has them). `withoutValue` for type_text,
   * whose sentence says the value (rule 5).
   */
  private elementName(result: unknown, key: "element" | "target" = "element", withoutValue = false): string {
    if (typeof result === "object" && result !== null && key in result) {
      const element = elementSchema.safeParse((result as Record<string, unknown>)[key]);
      if (element.success) {
        const shown = withoutValue ? { ...element.data, value: null, placeholder: null } : element.data;
        return formatElement(shown, { actions: false, frame: false });
      }
    }
    return "element";
  }

  // -- the safety policy (AGENT-TOOLS 1.8 §11)

  /**
   * A guarded touch: the app resolves the target in a dry run, the policy's words are matched against the
   * element's own label and text, and a confirm word waits for a person's OK in the live view. The check runs
   * inside the agent's turn, right before the touch, so nothing a person does in between can change what is
   * touched; when the check can't be made, nothing is touched (fail closed).
   */
  private async guarded(
    tool: "tap" | "long_press" | "toggle" | "swipe",
    method: string,
    params: Record<string, unknown>,
    dryRun: boolean,
    perform: (preflight?: () => Promise<CallToolResult | null>) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    this.logExtra = undefined;
    this.actionStartedAt = Date.now();
    const lists = listsFor(this.policy, session.app);
    if (!dryRun && lists.confirm.length === 0 && lists.block.length === 0) return perform();
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    if (dryRun) {
      const resolved = await this.resolveForPolicy(session, method, params);
      this.logExtra = { dry_run: true };
      if (resolved.kind === "error") {
        this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
        return fail(resolved.text);
      }
      const verdict = this.policyWords(lists, resolved.elements);
      const shown = resolved.elements[0];
      if (verdict.kind === "blocked") {
        this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "blocked");
        return fail(this.blockedLine(verdict.element, verdict.word));
      }
      const would = this.wouldLine(tool, shown, resolved.point, resolved.value);
      const needs = verdict.kind === "confirm" ? ` It needs a person's OK (policy word ${JSON.stringify(verdict.word)}).` : "";
      this.showAction("agent", method, shown !== undefined ? { element: shown } : undefined, params);
      return text([`${would}${needs}`, ...this.takePersonNote()].join("\n"));
    }
    let granted = false;
    const answer = await perform(async () => {
      const gate = await this.policyGate(session, tool, method, params, lists);
      if ("stop" in gate) return gate.stop;
      granted = gate.granted;
      if (granted) this.logExtra = { confirmed: true };
      return null;
    });
    return granted && answer.isError !== true ? appendNote(answer, "Note: a person allowed this.") : answer;
  }

  /**
   * The policy's verdict on a touch about to happen: stop with an answer (blocked, needs a person's OK, or
   * the check couldn't be made: fail closed), or go on (`granted` when a person's OK is being used up).
   */
  private async policyGate(
    session: SessionInfo,
    tool: string,
    method: string,
    params: Record<string, unknown>,
    lists: { confirm: string[]; block: string[] },
  ): Promise<{ stop: CallToolResult } | { granted: boolean }> {
    if (lists.confirm.length === 0 && lists.block.length === 0) return { granted: false };
    const resolved = await this.resolveForPolicy(session, method, params);
    if (resolved.kind === "error") {
      // Fail closed: what can't be checked isn't touched. The answer is the one the touch would give.
      this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
      return { stop: fail(resolved.text) };
    }
    const verdict = this.policyWords(lists, resolved.elements);
    if (verdict.kind === "blocked") {
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "blocked");
      return { stop: fail(this.blockedLine(verdict.element, verdict.word)) };
    }
    if (verdict.kind === "none") return { granted: false };
    const label = verdict.element.label ?? verdict.element.text ?? undefined;
    const caption = captionFor(tool, label ?? undefined, params) ?? tool;
    // An OK is for this app, this tool and this element only (Tapwright's review, M1).
    const check = this.confirmations.check(`${session.app.id}|${tool}|${elementKey(verdict.element)}`, { kind: tool, caption, word: verdict.word });
    if (check.granted) return { granted: true };
    const name = this.shortName(verdict.element, false);
    if ("held" in check) {
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
      return {
        stop: fail(
          `Error not_allowed: needs_confirmation: ${name} needs a person's OK (policy word ${JSON.stringify(verdict.word)}), and they declined it just now. Don't ask again by repeating the call: ask your user what they want.`,
        ),
      };
    }
    const where =
      this.options.canConfirm === false
        ? "The live view is off, so nobody can allow it here; ask your user."
        : "The live view asks them now; when they allow it, make the same call again. If nobody is watching, ask your user.";
    this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
    return {
      stop: fail(
        `Error not_allowed: needs_confirmation: ${this.shortName(verdict.element, false)} needs a person's OK (policy word ${JSON.stringify(verdict.word)}). ${where}${check.suffix}`,
      ),
    };
  }

  /** Which policy word, if any, the elements the target could mean carry: a block word first, then a confirm word. */
  private policyWords(
    lists: { confirm: string[]; block: string[] },
    elements: TreeElement[],
  ): { kind: "blocked" | "confirm"; element: TreeElement; word: string } | { kind: "none" } {
    for (const element of elements) {
      const word = matchWord(lists.block, element);
      if (word !== null) return { kind: "blocked", element, word };
    }
    for (const element of elements) {
      const word = matchWord(lists.confirm, element);
      if (word !== null) return { kind: "confirm", element, word };
    }
    return { kind: "none" };
  }

  private blockedLine(element: TreeElement, word: string): string {
    return `Error not_allowed: blocked: ${this.shortName(element, false)} is blocked by the policy (${JSON.stringify(word)}); don't try another way.`;
  }

  /** A dry run the app answers itself (scroll, back, swipe): its checks, nothing touched, one line. */
  private async dryCall(method: string, params: Record<string, unknown>, line: (result: unknown) => string): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (!session.capabilities.includes("dryRun")) {
      return fail("Error unsupported: this app's Tapline is too old for dry runs; update react-native-tapline.");
    }
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    this.actionStartedAt = Date.now();
    let result: unknown;
    try {
      result = await this.host.request(method, { ...params, dryRun: true }, { sessionId: session.id });
    } catch (error) {
      this.logExtra = { dry_run: true };
      this.showAction("agent", method, undefined, params, error instanceof TaplineError ? error.code : "internal", error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined);
      return fail(describeError(error));
    }
    if (typeof result !== "object" || result === null || (result as { dryRun?: unknown }).dryRun !== true) {
      return fail("Error internal: the app didn't answer the dry run.");
    }
    this.logExtra = { dry_run: true };
    this.showAction("agent", method, result, params);
    return text([line(result), ...this.takePersonNote()].join("\n"));
  }

  /** A dry run of a tool the policy doesn't guard (type_text): the app's checks, nothing touched. */
  private async dryRun(tool: string, method: string, params: Record<string, unknown>): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    const resolved = await this.resolveForPolicy(session, method, params);
    this.logExtra = { dry_run: true };
    if (resolved.kind === "error") {
      this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
      return fail(resolved.text);
    }
    this.showAction("agent", method, resolved.elements[0] !== undefined ? { element: resolved.elements[0] } : undefined, params);
    return text([this.wouldLine(tool, resolved.elements[0], resolved.point, resolved.value), ...this.takePersonNote()].join("\n"));
  }

  /**
   * What a touch would act on. Apps that know dry runs resolve it themselves, with every check; older
   * apps only give their element list, and every element the target could mean is checked.
   */
  private async resolveForPolicy(
    session: SessionInfo,
    method: string,
    params: Record<string, unknown>,
  ): Promise<
    | { kind: "ok"; elements: TreeElement[]; point?: { x: number; y: number }; value?: unknown }
    | { kind: "error"; text: string; code: string; reason?: string }
  > {
    if (session.capabilities.includes("dryRun")) {
      let raw: unknown;
      try {
        raw = await this.host.request(method, { ...params, dryRun: true }, { sessionId: session.id });
      } catch (error) {
        const reason = error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined;
        return {
          kind: "error",
          text: describeError(error),
          code: error instanceof TaplineError ? error.code : "internal",
          ...(reason !== undefined ? { reason } : {}),
        };
      }
      const parsed = dryRunResultSchema.safeParse(raw);
      if (!parsed.success) return { kind: "error", text: "Error internal: the app didn't answer the dry run.", code: "internal" };
      return {
        kind: "ok",
        elements: parsed.data.element ? [parsed.data.element] : [],
        ...(parsed.data.point !== undefined ? { point: parsed.data.point } : {}),
        ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
      };
    }
    // An app without dry runs: a swipe is checked by what lies under its start.
    const target = method === "swipe" ? { x: params["x0"], y: params["y0"] } : params["target"];
    if (method === "type" || target === undefined) {
      return { kind: "error", text: "Error unsupported: this app's Tapline is too old for dry runs; update react-native-tapline.", code: "unsupported" };
    }
    let raw: unknown;
    try {
      raw = await this.host.request("tree", {}, { sessionId: session.id });
    } catch (error) {
      return { kind: "error", text: describeError(error), code: error instanceof TaplineError ? error.code : "internal" };
    }
    const tree = treeResultSchema.safeParse(raw);
    if (!tree.success) return { kind: "error", text: "Error internal: the app returned an element list the host could not read.", code: "internal" };
    const elements = candidatesFor(target, tree.data.elements);
    if (elements.length === 0 && method !== "swipe") {
      return { kind: "error", text: "Error not_found: nothing on screen matches that target.", code: "not_found" };
    }
    const first = elements[0];
    const frame = elements.length === 1 && first !== undefined ? first.frame : null;
    return {
      kind: "ok",
      elements,
      ...(frame ? { point: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) } } : {}),
    };
  }

  /** `Would tap e12 button "Delete trip" at 215,640.` */
  private wouldLine(tool: string, element: TreeElement | undefined, point: { x: number; y: number } | undefined, value: unknown): string {
    const name = element !== undefined ? this.shortName(element, true) : "the element";
    const at = point !== undefined ? ` at ${point.x},${point.y}` : "";
    switch (tool) {
      case "long_press":
        return `Would long-press ${name}${at}.`;
      case "toggle":
        return `Would toggle ${name}${typeof value === "boolean" ? ` to ${String(value)}` : ""}${at}.`;
      case "type_text":
        return `Would type into ${name}.`;
      default:
        return `Would tap ${name}${at}.`;
    }
  }

  /** `e12 button "Delete trip"`: ref (when asked), role and name, nothing else. */
  private shortName(element: TreeElement, withRef: boolean): string {
    return formatElement(
      {
        ref: withRef ? element.ref : "",
        role: element.role ?? null,
        type: element.type ?? null,
        label: element.label ?? null,
        text: element.text ?? null,
        textMore: element.textMore ?? null,
      },
      { actions: false },
    );
  }

  /** A `{ref}` target after a person used the app: refs may point elsewhere. */
  private staleRef(params: unknown): CallToolResult | null {
    if (!this.personActed) return null;
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    if (typeof target === "object" && target !== null && "ref" in target) {
      // The error says it already, so the note isn't repeated.
      this.personNotePending = false;
      return fail(
        "Error stale: a person used the app since your last look, so refs from that list may point elsewhere. Look again, or target by id, label or text.",
      );
    }
    return null;
  }

  tap(args: Shape<"tap">): Promise<CallToolResult> {
    const params = { target: toWireTarget(withIndex(args.target, args.index)), ...(args.force === true ? { force: true } : {}) };
    return this.guarded("tap", "press", params, args.dry_run === true, (preflight) =>
      this.act("press", params, (r) => `Tapped ${this.elementName(r)}.`, args.look, args.screenshot, undefined, undefined, preflight),
    );
  }

  /** `seconds` is accepted for the shared interface; Tapline calls the handler, so it doesn't hold. */
  longPress(args: Shape<"long_press">): Promise<CallToolResult> {
    const params = { target: toWireTarget(withIndex(args.target, args.index)), ...(args.force === true ? { force: true } : {}) };
    return this.guarded("long_press", "longPress", params, args.dry_run === true, (preflight) =>
      this.act("longPress", params, (r) => `Long-pressed ${this.elementName(r)}.`, args.look, args.screenshot, undefined, undefined, preflight),
    );
  }

  typeText(args: Shape<"type_text">): Promise<CallToolResult> {
    const params: Record<string, unknown> = {
      text: args.text,
      replace: args.replace ?? true,
      submit: args.submit ?? false,
    };
    if (args.target !== undefined) params["target"] = toWireTarget(withIndex(args.target, args.index));
    if (args.force === true) params["force"] = true;
    // Typing isn't guarded by the policy (§11.1: the form's button is); a dry run still checks the field.
    if (args.dry_run === true) return this.dryRun("type_text", "type", params);
    return this.act(
      "type",
      params,
      (r) => {
        const value = typeof r === "object" && r !== null && "value" in r ? (r as { value: unknown }).value : undefined;
        // AGENT-TOOLS 1.8 §3.3: a secure field's value is never shown, not even as bullets in this line
        const secure = typeof r === "object" && r !== null && "secure" in r && (r as { secure: unknown }).secure === true;
        const shown = secure ? " The value is hidden (secure field)." : typeof value === "string" ? ` Value is now ${JSON.stringify(value)}.` : "";
        return `Typed into ${this.elementName(r, "element", shown !== "")}${args.submit ? " and submitted" : ""}.${shown}`;
      },
      args.look,
      args.screenshot,
    );
  }

  scroll(args: Shape<"scroll">): Promise<CallToolResult> {
    if (args.to !== undefined && (args.direction !== undefined || args.amount !== undefined)) {
      return Promise.resolve(fail("Error bad_params: use either `to` or `direction`/`amount`, not both."));
    }
    const toTarget = args.to === "target";
    if (toTarget && args.target === undefined) {
      return Promise.resolve(fail('Error bad_params: to: "target" needs a target: the element to bring onto the screen.'));
    }
    const params: Record<string, unknown> =
      args.to !== undefined ? { to: args.to } : { direction: args.direction ?? "down", fraction: args.amount ?? 0.8 };
    if (args.target !== undefined) params["target"] = toWireTarget(args.target);
    const flag = (r: unknown, key: string): unknown =>
      typeof r === "object" && r !== null && key in r ? (r as Record<string, unknown>)[key] : undefined;
    // The element was on screen and clear already: nothing was scrolled, and the first line says so.
    const alreadyThere = (r: unknown): boolean => toTarget && flag(r, "unchanged") === true;
    if (args.dry_run === true) {
      return this.dryCall("scroll", params, (r) => {
        if (toTarget) return `Would scroll ${this.elementName(r)} to ${this.elementName(r, "target")}.`;
        return `Would scroll ${this.elementName(r)} ${args.to !== undefined ? `to ${args.to}` : (args.direction ?? "down")}.`;
      });
    }
    const atEndAlready = (r: unknown): boolean => (args.to === "start" || args.to === "end") && flag(r, "moved") === false;
    return this.act(
      "scroll",
      params,
      (r) => {
        if (alreadyThere(r)) return `${this.elementName(r, "target")} is already on screen.`;
        // to: "start" or "end" with the list already there (AGENT-TOOLS v1.6 §5, shared with Tapwright).
        if (atEndAlready(r)) return `${this.elementName(r)} is already at its ${String(args.to)}.`;
        const offset = flag(r, "offset");
        const at = offset !== undefined ? ` Offset now ${JSON.stringify(offset)}.` : "";
        // "toward" when it stopped before the element was clear: the first line mustn't read like success.
        if (toTarget) return `Scrolled ${this.elementName(r)} ${flag(r, "reached") === false ? "toward" : "to"} ${this.elementName(r, "target")}.${at}`;
        return `Scrolled ${this.elementName(r)} ${args.to !== undefined ? `to ${args.to}` : (args.direction ?? "down")}.${at}`;
      },
      args.look,
      args.screenshot,
      (r) => {
        if (toTarget) {
          // The same sentence as Tapwright's, for a list that ends with the element still under a bar or off screen.
          return flag(r, "reached") === false
            ? ["Note: it doesn't scroll further: the target is as far into view as it gets."]
            : [];
        }
        const moved = flag(r, "moved");
        if (moved !== false || atEndAlready(r)) return [];
        const direction = args.to !== undefined ? (args.to === "start" ? "up" : "down") : (args.direction ?? "down");
        if (direction === "up") {
          return [
            "Note: the scroll view is already at the top (as far as Tapline can scroll it; a person's swipe can reach a little further when the system adds an inset).",
          ];
        }
        if (direction === "left") return ["Note: the scroll view is already at the start."];
        return ["Note: the scroll view is already at the end."];
      },
    );
  }

  toggle(args: Shape<"toggle">): Promise<CallToolResult> {
    const params: Record<string, unknown> = { target: toWireTarget(withIndex(args.target, args.index)) };
    if (args.value !== undefined) params["value"] = args.value;
    if (args.force === true) params["force"] = true;
    // The switch already had the asked value: the app touched nothing, and that line is the whole answer.
    const unchanged = (r: unknown): boolean => typeof r === "object" && r !== null && "unchanged" in r && r.unchanged === true;
    return this.guarded("toggle", "toggle", params, args.dry_run === true, (preflight) =>
      this.act(
        "toggle",
        params,
        (r) => {
          const value = typeof r === "object" && r !== null && "value" in r ? (r as { value: unknown }).value : undefined;
          if (unchanged(r)) return `${this.elementName(r)} is already ${JSON.stringify(value)}.`;
          return `Toggled ${this.elementName(r)}${value !== undefined ? ` to ${JSON.stringify(value)}` : ""}.`;
        },
        args.look,
        args.screenshot,
        undefined,
        unchanged,
        preflight,
      ),
    );
  }

  async appCommand(args: Shape<"app_command">): Promise<CallToolResult> {
    if (args.name === undefined || args.name.trim() === "") {
      const session = this.host.current();
      if (session === undefined) return this.notConnected();
      let raw: unknown;
      try {
        raw = await this.host.request("commands", {}, { sessionId: session.id });
      } catch (error) {
        return fail(describeError(error));
      }
      const parsed = commandsSchema.safeParse(raw);
      if (!parsed.success) return fail("Error internal: the app returned a command list the host could not read.");
      const lines = parsed.data.commands.map((c) => `${c.name}: ${c.description}`);
      return text(
        lines.length > 0
          ? [`${session.app.name} offers ${lines.length} command${lines.length === 1 ? "" : "s"}:`, ...lines].join("\n")
          : `${session.app.name} offers no commands.`,
      );
    }
    const name = args.name.trim();
    return this.act(
      "command",
      { name, args: args.args ?? {} },
      (r) => {
        const result = typeof r === "object" && r !== null && "result" in r ? (r as { result: unknown }).result : null;
        return result === null || result === undefined ? `Ran ${name}.` : `Ran ${name}: ${JSON.stringify(result)}`;
      },
      args.look,
      args.screenshot,
    );
  }

  waitFor(args: Shape<"wait_for">): Promise<CallToolResult> {
    const params: Record<string, unknown> = {};
    if (args.text !== undefined) params["text"] = args.text;
    if (args.id !== undefined) params["testID"] = args.id;
    if (args.label !== undefined) params["label"] = args.label;
    if (args.gone !== undefined) params["gone"] = args.gone;
    if (args.network_idle !== undefined) params["networkIdle"] = args.network_idle;
    if (args.timeout !== undefined) params["timeout"] = args.timeout;
    return this.act(
      "waitFor",
      params,
      (r) => {
        const ms = typeof r === "object" && r !== null && "waitedMs" in r ? (r as { waitedMs: unknown }).waitedMs : undefined;
        return typeof ms === "number" ? `Done after ${(Math.round(ms / 100) / 10).toFixed(1)} s.` : "Done.";
      },
      args.look,
      args.screenshot,
    );
  }

  /** A drag through React Native's touch system (AGENT-TOOLS 5.2): what a pan view or a swipe-to-close sheet handles. */
  swipe(args: Shape<"swipe">): Promise<CallToolResult> {
    const params: Record<string, unknown> = { x0: args.x0, y0: args.y0, x1: args.x1, y1: args.y1 };
    if (args.seconds !== undefined) params["seconds"] = args.seconds;
    if (args.dry_run === true) {
      return this.dryCall("swipe", params, (r) => {
        const on = this.elementName(r);
        return `Would swipe from (${args.x0}, ${args.y0}) to (${args.x1}, ${args.y1})${on === "element" ? "" : ` starting on ${on}`}.`;
      });
    }
    // A swipe that moves less than 10 pt is a touch where it starts: the policy checks it (AGENT-TOOLS 1.8 §11.1).
    const short = Math.hypot(args.x1 - args.x0, args.y1 - args.y0) < 10;
    const perform = (preflight?: () => Promise<CallToolResult | null>): Promise<CallToolResult> => this.act(
      "swipe",
      params,
      (r) => {
        const on = this.elementName(r);
        return `Swiped from (${args.x0}, ${args.y0}) to (${args.x1}, ${args.y1})${on === "element" ? "" : ` on ${on}`}.`;
      },
      args.look,
      args.screenshot,
      undefined,
      undefined,
      preflight,
    );
    return short ? this.guarded("swipe", "swipe", params, false, perform) : perform();
  }

  back(args: Shape<"back">): Promise<CallToolResult> {
    if (args.dry_run === true) {
      return this.dryCall("back", {}, (r) => {
        if (typeof r === "object" && r !== null && "closed" in r && r.closed === "sheet") return "Would close the sheet.";
        const route = typeof r === "object" && r !== null && "route" in r ? (r as { route: unknown }).route : undefined;
        const from = Array.isArray(route) && route.every((name) => typeof name === "string") ? ` from ${route.join(" › ")}` : "";
        return `Would go back${from}.`;
      });
    }
    return this.act(
      "back",
      {},
      (r) => {
        if (typeof r === "object" && r !== null && "closed" in r && r.closed === "sheet") return "Closed the sheet.";
        const route = typeof r === "object" && r !== null && "route" in r ? (r as { route: unknown }).route : undefined;
        const from = Array.isArray(route) && route.every((name) => typeof name === "string") ? ` from ${route.join(" › ")}` : "";
        return `Went back${from}.`;
      },
      args.look,
      args.screenshot,
    );
  }

  async openUrl(args: Shape<"open_url">): Promise<CallToolResult> {
    const answer = await this.act("openURL", { url: args.url }, () => `Opened ${args.url}.`, args.look, args.screenshot);
    // The app's own forget link unpairs it, so it drops the connection before answering: that is the link working.
    if (answer.isError === true && /(^|\/)tapline\/forget\/?$/.test(args.url.replace(/[?#].*$/, ""))) {
      const said = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (/^Error (reconnecting|not_connected)\b/.test(said)) {
        return text("Unpaired: the app forgot this computer and disconnected. To connect it again, call `pair`.");
      }
    }
    return answer;
  }

  async logs(args: Shape<"logs">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    let entries: LogEntry[] = this.host.logs(session.id, args.since);
    if (entries.length === 0) {
      // Nothing streamed to the host yet; ask the app for the lines it buffered before we connected.
      try {
        const raw = await this.host.request("logs", args.since !== undefined ? { since: args.since } : {}, { sessionId: session.id });
        const list = typeof raw === "object" && raw !== null && "entries" in raw ? (raw as { entries: unknown }).entries : [];
        entries = z.array(logEntrySchema).catch([]).parse(list);
      } catch {
        // fall through with an empty list
      }
    }
    const newest = entries.reduce<number | undefined>((max, e) => (e.ts !== undefined && (max === undefined || e.ts > max) ? e.ts : max), undefined);
    const query = { since: args.since, level: args.level, grep: args.grep, limit: args.limit };
    return text(formatLogAnswer(filterLogs(entries, query), query, newest ?? args.since ?? 0));
  }

  /** The newest fatal JS error of the app (`all`: the last 5). Reading them tells the agent what the notes did. */
  crash(args: Shape<"crash"> = {}): CallToolResult {
    // The app being driven, else the one that stopped last. Never every app's crashes at once.
    const known: AppIdentity | undefined = this.host.current() ?? this.host.lastCrashEvent()?.of;
    if (known === undefined) return text(NO_CRASH_TEXT);
    // Reading them tells the agent what the notes of this app said; other apps' stay pending.
    this.notedCrashSeqs.set(identityOf(known), this.host.crashMark());
    const crashes = this.host.crashes(known);
    if (crashes.length === 0) return text(NO_CRASH_TEXT);
    return text(crashes.slice(0, args.all === true ? 5 : 1).map(formatCrash).join("\n\n"));
  }

  async reload(args: Shape<"reload">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    try {
      try {
        // The app goes away on purpose: that is no crash.
        this.host.expectEnd(session.id);
        await this.host.request("reload", {}, { sessionId: session.id, timeoutMs: 5000 });
      } catch (error) {
        // The app dies mid-reload, so a dropped connection or a missing answer means it worked.
        const worked = error instanceof TaplineError && (error.code === "reconnecting" || error.code === "timeout" || error.code === "not_answering");
        if (!worked) return fail(describeError(error));
      }
      if (args.look === false) return text("Reload requested.");
      const deadline = Date.now() + this.reloadWaitMs;
      for (;;) {
        const now = this.host.current();
        if (now !== undefined && now.id !== session.id) break;
        if (Date.now() > deadline) return text("Reload requested, but the app has not reconnected yet. Try look in a few seconds.");
        await sleep(100);
      }
    } finally {
      // Whatever happened, the wait is over: a reload that "worked" without the app going away must not
      // leave a later, real crash of this session explained.
      this.host.expectEnd(session.id, false);
    }
    await sleep(this.reloadSettleMs);
    return this.withLook(this.host.current() ?? session, "Reloaded; the app reconnected.");
  }

  // -- performance (AGENT-TOOLS §15.3)

  /**
   * `launch`: a JavaScript reload (development builds), timed from the request to the new session's first
   * settled screen. Stops with the answer when the reload can't be made or the app doesn't come back.
   */
  private async timedReload(session: SessionInfo): Promise<{ stop: CallToolResult } | { session: SessionInfo; seconds: number }> {
    const started = Date.now();
    let fresh: SessionInfo | undefined;
    try {
      try {
        // The app goes away on purpose: that is no crash.
        this.host.expectEnd(session.id);
        await this.host.request("reload", {}, { sessionId: session.id, timeoutMs: 5000 });
      } catch (error) {
        // The app dies mid-reload, so a dropped connection or a missing answer means it worked.
        const worked = error instanceof TaplineError && (error.code === "reconnecting" || error.code === "timeout" || error.code === "not_answering");
        if (!worked) {
          if (error instanceof TaplineError && error.code === "unsupported") {
            return { stop: fail(`Error unsupported: launch is a JavaScript reload, and only development builds can do one (${error.message}).`) };
          }
          return { stop: fail(describeError(error)) };
        }
      }
      const deadline = Date.now() + this.reloadWaitMs;
      while (fresh === undefined) {
        const now = this.host.current();
        if (now !== undefined && now.id !== session.id) fresh = now;
        else if (Date.now() > deadline) {
          return { stop: fail(`Error timeout: the app hadn't reconnected ${Number((this.reloadWaitMs / 1000).toFixed(1))} s after the reload; try look in a few seconds.`) };
        } else await sleep(100);
      }
    } finally {
      // The wait is over, whatever happened: a reload that "worked" without the app going away must not leave
      // a later crash of this session explained away.
      this.host.expectEnd(session.id, false);
    }
    // The first settled screen: the app waits until React hasn't committed for a moment (§6).
    await this.host.request("perfSettle", {}, { sessionId: fresh.id, timeoutMs: 8000 }).catch(() => undefined);
    return { session: fresh, seconds: (Date.now() - started) / 1000 };
  }

  /** One measuring window in the app: start, (the tap,) wait out `seconds`, stop. */
  private async measureWindow(session: SessionInfo, seconds: number, press?: Record<string, unknown>): Promise<PerfResult> {
    const id = { sessionId: session.id };
    try {
      await this.host.request("perfStart", {}, id);
    } catch (error) {
      if (error instanceof TaplineError && error.code === "unsupported") {
        throw new TaplineError("unsupported", "this app's Tapline is too old for performance; update react-native-tapline.");
      }
      throw error;
    }
    const started = Date.now();
    try {
      if (press !== undefined) await this.host.request("press", press, id);
      const rest = seconds * 1000 - (Date.now() - started);
      if (rest > 0) await sleep(rest);
    } catch (error) {
      await this.host.request("perfStop", {}, id).catch(() => undefined);
      throw error;
    }
    const parsed = perfResultSchema.safeParse(await this.host.request("perfStop", {}, id));
    if (!parsed.success) throw new TaplineError("internal", "the app returned performance numbers the host could not read.");
    return parsed.data;
  }

  async performance(args: Shape<"performance"> = {}): Promise<CallToolResult> {
    this.lastPerf = undefined;
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (args.launch === true && args.tap !== undefined) {
      return fail("Error bad_params: launch reloads the app and tap taps in it; give one of them.");
    }
    const seconds = args.seconds ?? 3;
    try {
      let measure: PerfMeasure;
      if (args.launch === true) {
        const launched = await this.timedReload(session);
        if ("stop" in launched) return launched.stop;
        measure = { result: await this.measureWindow(launched.session, seconds), launchS: launched.seconds };
      } else {
        let press: Record<string, unknown> | undefined;
        if (args.tap !== undefined) {
          // The tap is a touch like any other: the safety policy decides first (as for filmstrip).
          press = { target: toWireTarget(args.tap) };
          const stale = this.staleRef(press);
          if (stale !== null) return stale;
          const gate = await this.policyGate(session, "tap", "press", press, listsFor(this.policy, session.app));
          if ("stop" in gate) return gate.stop;
        }
        measure = { result: await this.measureWindow(session, seconds, press) };
      }
      this.lastPerf = measure;
      if (this.recording !== null && !this.replaying) {
        this.recording.steps.push({
          method: "performance",
          params: {
            ...(args.launch === true ? { launch: true } : {}),
            ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
            ...(args.tap !== undefined ? { tap: args.tap } : {}),
          },
        });
      }
      const tapWords = args.tap === undefined ? undefined : targetWords(args.tap);
      return text([perfFirstLine(measure, tapWords), ...formatPerfLines(measure.result), ...this.takePersonNote()].join("\n"));
    } catch (error) {
      return fail(describeError(error));
    }
  }

  async wait(args: Shape<"wait">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    await sleep(args.seconds * 1000);
    if (this.recording !== null && !this.replaying) {
      this.recording.steps.push({ method: "sleep", params: { seconds: args.seconds } });
    }
    return this.withLook(session, `Waited ${args.seconds.toFixed(1)} s.`, args.screenshot === true);
  }
}
