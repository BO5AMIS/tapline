import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toBuffer as qrPng } from "qrcode";
import { z } from "zod";
import { annotateScreenshot, type ShotImage } from "./annotate.js";
import type { ControlQueue } from "./control.js";
import type { InputOutcome, OverlayRead, PersonInput, QualityPreset, Rect, ViewerAction } from "./viewer.js";
import { composeFilmstrip, diffImages, type DiffResult } from "./images.js";
import { describeElement, formatChanges, formatElement, formatLogs, formatTree } from "./format.js";
import { PAIR_CODE_TTL_MS, forgetLink, pairingLink } from "./pairing.js";
import {
  elementSchema,
  logEntrySchema,
  screenshotResultSchema,
  treeResultSchema,
  type LogEntry,
  type TreeResult,
  type WireTarget,
} from "./protocol.js";
import { TaplineError, type SessionInfo, type TaplineHost } from "./server.js";

// ---- input schemas ----------------------------------------------------------

export const targetSchema = z
  .object({
    ref: z.string().optional().describe('Element ref from your latest list, e.g. "e12"'),
    id: z.string().optional().describe("Exact identifier (React Native testID, the iOS accessibility identifier)"),
    label: z.string().optional().describe("Accessibility label, exact, ignoring case"),
    text: z.string().optional().describe("Visible text: an exact match first (ignoring case), then a substring"),
    index: z.number().int().min(0).optional().describe("With id, label or text: pick the Nth match (0-based, reading order)"),
    x: z.number().optional().describe("X in points; use together with y"),
    y: z.number().optional().describe("Y in points; use together with x"),
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

const targetField = targetSchema.describe(
  "Which element: exactly one of {ref}, {id}, {label}, {text} or {x, y}; add index to pick among several id, label or text matches. Prefer ref or id from your latest list.",
);
const lookField = z
  .boolean()
  .optional()
  .describe(
    "Set false to skip the element list normally returned after the action (only the changes once you've had a full list; no screenshot, call look for one)",
  );

const screenshotField = z.boolean().optional().describe("Add a screenshot to the answer (default false)");

const forceField = z
  .boolean()
  .optional()
  .describe(
    "Act even when a real touch couldn't: the element is off screen or something covers it. Default false; prefer scrolling or dismissing what covers it, since a person would have to.",
  );

export const toolShapes = {
  apps: {},
  open_app: { app: z.string().describe("The app's session id, app id or name, as apps lists them") },
  pair: {
    scheme: z.string().describe('The app\'s URL scheme ("scheme" in app.json or app.config), e.g. "myapp"'),
  },
  look: {
    screenshot: z.boolean().optional().describe("Include a screenshot (default true)"),
    width: z
      .number()
      .int()
      .min(160)
      .max(1320)
      .optional()
      .describe("Screenshot width in pixels (default 600). Smaller costs fewer image tokens: 300 is enough to check a layout."),
    labels: z
      .boolean()
      .optional()
      .describe("Draw each tappable element's box and ref (e12) on the screenshot, so whoever views it can name elements by ref"),
  },
  check_layout: {},
  tap: { target: targetField, force: forceField, look: lookField, screenshot: screenshotField },
  long_press: {
    target: targetField,
    seconds: z
      .number()
      .min(0.1)
      .max(10)
      .optional()
      .describe("How long to hold (default 1.0). Tapline calls the handler, so it doesn't wait"),
    force: forceField,
    look: lookField,
    screenshot: screenshotField,
  },
  type_text: {
    text: z.string().describe("Text to enter"),
    target: targetField.optional().describe("Input to type into; default: the focused input, else the only input on screen"),
    replace: z.boolean().optional().describe("Replace the current text (default true); false appends"),
    submit: z.boolean().optional().describe("Also submit (like pressing return) after typing (default false)"),
    look: lookField,
    screenshot: screenshotField,
  },
  scroll: {
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction (default down when no `to`)"),
    amount: z.number().min(0.1).max(1).optional().describe("How far: a share of the scroll area, 0.1 to 1 (default 0.8)"),
    to: z.enum(["start", "end"]).optional().describe("Jump to the start or end instead of using direction/amount"),
    target: targetField.optional().describe("Scroll view to scroll; default: the largest one on screen"),
    look: lookField,
    screenshot: screenshotField,
  },
  toggle: {
    target: targetField,
    value: z.boolean().optional().describe("Desired state; omit to flip"),
    force: forceField,
    look: lookField,
    screenshot: screenshotField,
  },
  open_url: {
    url: z.string().describe('URL or deep link to open, e.g. "myapp://settings"'),
    look: lookField,
    screenshot: screenshotField,
  },
  back: { look: lookField, screenshot: screenshotField },
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
      .describe("Screenshot width in pixels (default 600); keep it the same for a name"),
  },
  filmstrip: {
    frames: z.number().int().min(2).max(9).optional().describe("How many frames (default 6)"),
    interval_ms: z.number().int().min(0).max(2000).optional().describe("Time between frames in ms (default 250)"),
    frame_width: z.number().int().min(100).max(400).optional().describe("Width of each frame in pixels (default 200)"),
    tap: targetField.optional().describe("Tap this first, then film what it sets off (an animation, a loading state)"),
  },
  viewer: {},
  record: {
    action: z
      .enum(["start", "stop", "status", "discard"])
      .describe("start a recording (needs name), stop and save it, see the status, or discard it"),
    name: z.string().optional().describe("Script name for start: letters, digits, '.', '_' and '-'"),
  },
  replay: {
    name: z.string().optional().describe("The script to replay; omit to list saved scripts"),
  },
  wait_for: {
    text: z.string().optional().describe("Wait until an element whose text contains this is on screen (or gone)"),
    id: z.string().optional().describe("Wait until the element with this id is on screen (or gone)"),
    label: z.string().optional().describe("Wait until the element with this accessibility label is on screen (or gone)"),
    gone: z.boolean().optional().describe("Wait until it is gone instead, e.g. a spinner"),
    network_idle: z.boolean().optional().describe("Also (or only) wait until no network request is in flight"),
    timeout: z.number().min(0.5).max(30).optional().describe("Seconds to wait at most (default 10)"),
    look: lookField,
    screenshot: screenshotField,
  },
  logs: {
    since: z.number().optional().describe("Only lines after this timestamp (epoch milliseconds)"),
  },
  reload: { look: lookField },
  wait: { seconds: z.number().min(0.1).max(30).describe("How long to wait, 0.1 to 30 seconds"), screenshot: screenshotField },
} as const;

type Shape<K extends keyof typeof toolShapes> = z.infer<z.ZodObject<(typeof toolShapes)[K]>>;

// ---- helpers ----------------------------------------------------------------

export interface ConnectInfo {
  /** Where apps reach this host, e.g. ws://100.64.0.1:7210/ */
  url: string;
  /** This computer's name, shown on the phone before it connects. */
  name: string;
}

export interface ToolsOptions {
  connect: ConnectInfo;
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
  /** Whether the app's frames are on and at which quality, for the `viewer` tool's stats. */
  viewerFeed?: () => { on: boolean; quality: QualityPreset };
}

/** Under this many points, a pointer path is a tap or a hold, not a drag. */
const TAP_SLOP = 12;
/** Held at least this long, a tap is a long press. */
const LONG_PRESS_MS = 500;

const SCRIPT_NAME = /^[A-Za-z0-9][\w.-]{0,60}$/;

/** One recorded request; `route` is the screen it ended on, `fragile` marks a target that only worked that run (a ref). */
interface ScriptStep {
  method: string;
  params: Record<string, unknown>;
  route?: string[];
  fragile?: boolean;
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
    })
    .optional(),
});

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

const NO_SCREENSHOT_NOTE = "Note: no screenshot: this app doesn't support it; add react-native-view-shot.";

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

function toWireTarget(target: Target): WireTarget {
  const withIndex = <T extends object>(t: T): T & { index?: number } =>
    target.index !== undefined ? { ...t, index: target.index } : t;
  if (target.ref !== undefined) return { ref: target.ref };
  if (target.id !== undefined) return withIndex({ testID: target.id });
  if (target.label !== undefined) return withIndex({ label: target.label });
  if (target.text !== undefined) return withIndex({ text: target.text });
  return { x: target.x ?? 0, y: target.y ?? 0 };
}

function candidateLines(details: unknown): string[] {
  const lines: string[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") {
        lines.push(item);
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
  return [...new Set(lines)];
}

export function describeError(error: unknown): string {
  if (error instanceof TaplineError) {
    if (error.code === "ambiguous") {
      const candidates = candidateLines(error.details);
      const list = candidates.length > 0 ? `\nCandidates:\n${candidates.map((c) => `  ${c}`).join("\n")}` : "";
      return `Error ambiguous: ${error.message}${list}\nRetry with one of the refs, or add "index" (0-based).`;
    }
    return `Error ${error.code}: ${error.message}`;
  }
  return `Error internal: ${error instanceof Error ? error.message : String(error)}`;
}

// ---- tool handlers ----------------------------------------------------------

/** The tool handlers behind the MCP server. They only talk to a TaplineHost, so they are easy to test. */
export class TaplineTools {
  private readonly reloadWaitMs: number;
  private readonly reloadSettleMs: number;
  private readonly noScreenshot = new Set<string>();
  private readonly shotFiles: string[] = [];
  /** Sessions this agent has had an element list for (so later lists can be just the changes). */
  private readonly listed = new Set<string>();
  /** The route of the latest element list, for recording and checking replays. */
  private lastLookRoute: string[] | undefined;
  /** A person acted in the viewer since the agent's last full list: `{ref}` targets fail with `stale`. */
  private personActed = false;
  /** The next answer to the agent says a person used the app, once. */
  private personNotePending = false;
  private recording: { name: string; app: { name: string; id?: string }; steps: ScriptStep[] } | null = null;
  private replaying = false;
  /** The screen size in points from the latest list or overlay, for the live viewer's 0..1 positions. */
  private lastScreen: { w: number; h: number } | undefined;
  private shotCount = 0;
  private pairWrites = 0;

  constructor(
    private readonly host: TaplineHost,
    private readonly options: ToolsOptions,
  ) {
    this.reloadWaitMs = options.reloadWaitMs ?? 20_000;
    this.reloadSettleMs = options.reloadSettleMs ?? 1500;
  }

  private notConnected(): CallToolResult {
    return fail(`Error not_connected: ${this.noAppMessage()}`);
  }

  /** How to connect an app, shown when nothing is connected. */
  noAppMessage(): string {
    const { url, name } = this.options.connect;
    const lines: string[] = [];
    const last = this.host.lastDisconnect();
    if (last !== undefined) {
      const when = new Date(last.at).toTimeString().slice(0, 8);
      const state = last.session.appState?.state;
      lines.push(
        state === "background" || state === "inactive"
          ? `${last.session.app.name} disconnected at ${when} after it went to the background (the user switched apps or locked the phone, and iOS paused it). Ask the user to open the app again: it reconnects by itself.`
          : `${last.session.app.name} disconnected at ${when} (${last.reason}). If the app is still open, it reconnects by itself.`,
      );
    }
    return [
      "No app is connected to Tapline.",
      ...lines,
      `This host listens at ${url} on ${name}.`,
      'To connect a phone, call `pair` with the app\'s URL scheme ("scheme" in app.json, e.g. "myapp") and show the user the QR code. They scan it with the phone\'s camera and tap Connect in the app.',
      "The phone needs Tailscale on (the same network as this computer), and the app must be a build with Tapline turned on, open in the foreground.",
      "A phone that paired with this host before reconnects by itself while the app is open; one paired with a host on another port (e.g. before a restart) needs `pair` again. Once it connects, retry.",
    ].join("\n");
  }

  // -- pair

  async pair(args: Shape<"pair">): Promise<CallToolResult> {
    const { url, name } = this.options.connect;
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
      "The phone needs Tailscale on, and the app must be a build with Tapline turned on.",
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
        [
          `Error ambiguous: ${matches.length} connected apps match "${args.app}". Pick one by its session id:`,
          ...matches.map((s) => this.appLine(s, current?.id === s.id, now)),
        ].join("\n"),
      );
    }
    const session = matches[0];
    if (session === undefined) {
      return fail(
        `Error not_connected: ${args.app} isn't connected. Tapline can't launch apps: open it on the phone with Tailscale on (it reconnects by itself), or pair it with pair.`,
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
    const treePromise = this.host.request("tree", askChanges ? { changes: true } : {}, { sessionId: sid });
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
    const changesText = askChanges ? formatChanges(tree) : null;
    // A full list gives every ref a fresh meaning, so refs are trustworthy again.
    if (changesText === null) this.personActed = false;
    const lines = [changesText ?? formatTree(tree, { name: session.app.name, id: session.app.id })];
    const content: CallToolResult["content"] = [];
    // Notes come last (AGENT-TOOLS §3.6), after the list and any `Screenshot:` path line.
    const notes: string[] = [];
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
  ): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (this.personActed) {
      const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
      if (typeof target === "object" && target !== null && "ref" in target) {
        // The error says it already, so the note isn't repeated.
        this.personNotePending = false;
        return fail(
          "Error stale: a person used the app since your last look, so refs from that list may point elsewhere. Look again, or target by id, label or text.",
        );
      }
    }
    let result: unknown;
    try {
      const timeoutMs = answerTimeoutMs(method, params);
      const run = (): Promise<unknown> =>
        this.host.request(method, params, { sessionId: session.id, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      // With the live viewer, a person watching goes first.
      result = this.options.control ? await this.options.control.runAgent(run) : await run();
    } catch (error) {
      this.showAction("agent", method, undefined, params, error instanceof TaplineError ? error.code : "internal");
      return fail(describeError(error));
    }
    this.showAction("agent", method, result, params);
    const line = describe(result);
    let response: CallToolResult;
    this.lastLookRoute = undefined;
    const settledMs =
      typeof result === "object" && result !== null && "settledMs" in result ? (result as { settledMs: unknown }).settledMs : undefined;
    const settled = typeof settledMs === "number" && Number.isFinite(settledMs) && settledMs >= 0
      ? `Settled in ${(settledMs / 1000).toFixed(2)} s.`
      : undefined;
    if (withLook === false) response = text([line, ...this.takePersonNote()].join("\n"));
    else {
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
    if (this.recording !== null && !this.replaying) {
      const { params: stable, fragile } = stableParams(params, result);
      const step: ScriptStep = { method, params: stable };
      if (this.lastLookRoute !== undefined) step.route = this.lastLookRoute;
      if (fragile) step.fragile = true;
      this.recording.steps.push(step);
    }
    return response;
  }

  // -- the live viewer

  /** An element's frame (points) as 0..1 of the screen. */
  private normalized(frame: { x: number; y: number; width: number; height: number } | null | undefined): Rect | undefined {
    const screen = this.lastScreen;
    if (!frame || !screen || screen.w <= 0 || screen.h <= 0) return undefined;
    return { x: frame.x / screen.w, y: frame.y / screen.h, w: frame.width / screen.w, h: frame.height / screen.h };
  }

  /** The viewer's description of an action: its element's name and where it was. */
  private describeAction(method: string, result: unknown, point?: { x: number; y: number }): Omit<ViewerAction, "by" | "ok" | "code"> {
    const element =
      typeof result === "object" && result !== null && "element" in result
        ? elementSchema.safeParse((result as { element: unknown }).element)
        : null;
    const data = element?.success ? element.data : undefined;
    const label = data ? (data.text || data.label || data.testID || undefined) : undefined;
    const rect = this.normalized(data?.frame);
    return {
      kind: method,
      ...(label ? { label: label.slice(0, 80) } : {}),
      ...(rect ? { rect } : {}),
      ...(point ? { point } : {}),
    };
  }

  private showAction(by: "agent" | "person", method: string, result: unknown, params: unknown, code?: string): void {
    const onAction = this.options.onAction;
    if (onAction === undefined) return;
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    const t = typeof target === "object" && target !== null ? (target as { x?: unknown; y?: unknown }) : undefined;
    const screen = this.lastScreen;
    const point =
      t && typeof t.x === "number" && typeof t.y === "number" && screen ? { x: t.x / screen.w, y: t.y / screen.h } : undefined;
    try {
      onAction({ by, ...this.describeAction(method, result, point), ok: code === undefined, ...(code ? { code } : {}) });
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
      await this.host.request("feed", { on, quality }, { sessionId: session.id });
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
      const { method, params, point } = this.mapInput(input, size);
      // The request reaches the app from here on, whether it succeeds or is refused.
      this.personActed = true;
      this.personNotePending = true;
      try {
        const result = await this.host.request(method, params, { sessionId: session.id });
        return { ok: true, action: this.describeAction(method, result, point) };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof TaplineError ? error.code : "internal",
          message: error instanceof Error ? error.message : String(error),
          action: { kind: method, ...(point ? { point } : {}) },
        };
      }
    };
    try {
      return this.options.control ? await this.options.control.runPerson(run) : await run();
    } catch (error) {
      return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private mapInput(
    input: PersonInput,
    size: { w: number; h: number },
  ): { method: string; params: Record<string, unknown>; point?: { x: number; y: number } } {
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
        return { method: "scroll", params: { target, direction, amount: Math.round(Math.abs(vertical ? dy : dx)) }, point };
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
    const lines = [
      "Live viewer (watch the app, see what you do, and let the user tap and type too):",
      ...links.map((link) => `- ${link}`),
      "The link carries a key: give it to the user only. While they use the viewer, their touches go first and your actions wait.",
    ];
    const feed = this.options.viewerFeed?.();
    const session = this.host.current();
    if (feed?.on === true && session !== undefined) {
      try {
        const answer = feedAnswerSchema.safeParse(await this.host.request("feed", { on: true, quality: feed.quality }, { sessionId: session.id }));
        const stats = answer.success ? answer.data.stats : undefined;
        if (stats !== undefined) {
          lines.push(
            `Capture: ${stats.frames} frames, ${Math.round(stats.avgCaptureMs)} ms each on average (longest ${Math.round(stats.maxCaptureMs)} ms). Stutter: ${stats.janky} of ${stats.observedFrames} animation frames were slow, ${stats.jankyWhileCapturing} of them during a capture.`,
          );
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

  async compareScreen(args: Shape<"compare_screen">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const name = args.name.trim();
    if (!SCRIPT_NAME.test(name)) return fail("Error bad_params: name the reference with letters, digits, '.', '_' and '-'.");
    const dir = this.options.baselinesDir;
    if (dir === undefined) return fail("Error internal: no folder for reference pictures is configured.");
    const appFolder = (session.app.id ?? session.app.name).replace(/[^\w.-]/g, "_");
    const path = join(dir, appFolder, `${name}.jpg`);
    let shot: ShotImage;
    try {
      shot = await this.takeShot(session.id, args.width ?? DEFAULT_SCREENSHOT_WIDTH, 0.9);
    } catch (error) {
      return fail(describeError(error));
    }
    if (args.update === true || !existsSync(path)) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, Buffer.from(shot.data, "base64"), { mode: 0o600 });
      } catch (error) {
        return fail(`Error internal: couldn't save the reference: ${error instanceof Error ? error.message : String(error)}`);
      }
      return text(
        `Saved the reference picture "${name}" (${shot.width ?? "?"}x${shot.height ?? "?"}) in ${path}. Next time, compare_screen { name: "${name}" } shows what changed.`,
      );
    }
    let diff: DiffResult;
    try {
      diff = diffImages({ mime: "image/jpeg", data: readFileSync(path).toString("base64") }, shot);
    } catch (error) {
      return fail(
        `Error bad_params: ${error instanceof Error ? error.message : String(error)} To start over, use update: true.`,
      );
    }
    if (diff.changedPixels === 0) return text(`No visible change from the reference "${name}".`);

    // Name the regions in points, with the elements they touch, from a fresh element list.
    let scale = 1;
    let elements: TreeResult["elements"] = [];
    try {
      const tree = treeResultSchema.safeParse(await this.host.request("tree", {}, { sessionId: session.id }));
      if (tree.success && tree.data.screen) {
        scale = diff.width / tree.data.screen.width;
        elements = tree.data.elements;
        this.listed.add(session.id);
      }
    } catch {
      // positions stay in pixels
    }
    const unit = scale === 1 ? "pixels" : "points";
    const lines = [
      `${diff.changedPercent}% of the screen changed from the reference "${name}", in ${diff.boxes.length} region${diff.boxes.length === 1 ? "" : "s"} (${unit}):`,
    ];
    for (const box of diff.boxes) {
      const b = { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale };
      // The smallest named elements there: a page-sized container overlaps every change.
      const near = elements
        .filter((e) => e.frame && e.frame.x < b.x + b.width && e.frame.x + e.frame.width > b.x && e.frame.y < b.y + b.height && e.frame.y + e.frame.height > b.y)
        .filter((e) => (e.text ?? "") !== "" || (e.label ?? "") !== "" || (e.testID ?? "") !== "")
        .map((e) => ({ e, area: (e.frame?.width ?? 0) * (e.frame?.height ?? 0) }))
        .filter(({ area }) => area <= Math.max(b.width * b.height * 4, 2500))
        .sort((x, y) => x.area - y.area)
        .slice(0, 2)
        .map(({ e }) => describeElement(e));
      lines.push(
        `- @${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}${near.length > 0 ? `: ${near.join(", ")}` : ""}`,
      );
    }
    lines.push("The image shows the screen now, faded, with the changed pixels in red.");
    const content: CallToolResult["content"] = [];
    this.deliver(session.id, diff.image, lines, content);
    return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
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
        frames.push(await this.takeShot(session.id, frameWidth, 0.8));
        await this.host.request("press", { target: toWireTarget(args.tap) }, { sessionId: session.id });
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
    switch (args.action) {
      case "start": {
        const name = (args.name ?? "").trim();
        if (this.scriptPath(name) === null) {
          return fail("Error bad_params: give the script a name of letters, digits, '.', '_' and '-' (e.g. \"checkout\").");
        }
        if (this.recording !== null) return fail(`Error bad_params: already recording "${this.recording.name}"; stop it first.`);
        const session = this.host.current();
        if (session === undefined) return this.notConnected();
        this.recording = { name, app: { name: session.app.name, ...(session.app.id ? { id: session.app.id } : {}) }, steps: [] };
        return text(
          `Recording "${name}" on ${session.app.name}. Every action from now on is a step; wait_for steps check the app is where it should be. Prefer testIDs: they replay best. Stop with record { action: "stop" }.`,
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
        if (recording === null) return fail("Error bad_params: not recording; start with record { action: \"start\", name }.");
        const path = this.scriptPath(recording.name);
        if (path === null) return fail("Error internal: no scripts folder is configured.");
        const script: Script = {
          version: 1,
          name: recording.name,
          app: recording.app,
          recordedAt: new Date().toISOString(),
          steps: recording.steps,
        };
        try {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
          return fail(`Error internal: couldn't save the script: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.recording = null;
        const count = script.steps.length;
        const lines = [`Saved "${script.name}": ${count} step${count === 1 ? "" : "s"} in ${path}. Replay it with replay { name: "${script.name}" }.`];
        script.steps.forEach((step, i) => {
          if (step.fragile) {
            const target = step.params["target"] as { ref?: unknown };
            lines.push(
              `Note: step ${i + 1} targets ref ${String(target.ref)}, which won't exist on a new run. Give that element a testID, or record it again by its text or label.`,
            );
          }
        });
        if (script.steps.some((step) => step.method === "type")) {
          lines.push("The script keeps the text typed in it (test passwords too): keep it private.");
        }
        return text(lines.join("\n"));
      }
    }
  }

  private scriptList(): string {
    const dir = this.options.scriptsDir;
    if (dir === undefined || !existsSync(dir)) return "No saved scripts.";
    const lines: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const parsed = scriptSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
        if (!parsed.success) continue;
        const s = parsed.data;
        lines.push(`- ${s.name} (${s.steps.length} step${s.steps.length === 1 ? "" : "s"}, recorded ${s.recordedAt.slice(0, 10)} on ${s.app.name})`);
      } catch {
        // skip unreadable files
      }
    }
    return lines.length === 0 ? "No saved scripts." : ["Saved scripts:", ...lines].join("\n");
  }

  async replay(args: Shape<"replay">): Promise<CallToolResult> {
    const name = (args.name ?? "").trim();
    if (name === "") return text(this.scriptList());
    if (this.recording !== null) return fail(`Error bad_params: stop recording "${this.recording.name}" before replaying.`);
    const path = this.scriptPath(name);
    if (path === null || !existsSync(path)) return fail(`Error not_found: no script "${name}".\n${this.scriptList()}`);
    let script: Script;
    try {
      const parsed = scriptSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) return fail(`Error bad_params: ${path} isn't a Tapline script.`);
      script = parsed.data;
    } catch (error) {
      return fail(`Error internal: couldn't read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = this.host.current();
    if (session === undefined) return this.notConnected();

    const started = Date.now();
    const total = script.steps.length;
    const lines: string[] = [];
    const seconds = (ms: number): string => (Math.round(ms / 100) / 10).toFixed(1);
    this.replaying = true;
    try {
      for (const [i, step] of script.steps.entries()) {
        const at = Date.now();
        const label = `${i + 1} ${describeStep(step)}`;
        if (step.method === "sleep") {
          const s = typeof step.params["seconds"] === "number" ? step.params["seconds"] : 0;
          await sleep(Math.min(30, Math.max(0, s)) * 1000);
          lines.push(`${i + 1} ✓ ${describeStep(step)} (${seconds(Date.now() - at)} s)`);
          continue;
        }
        const result = await this.act(step.method, step.params, () => "", true);
        const problem = result.isError
          ? result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim()
          : step.route !== undefined &&
              this.lastLookRoute !== undefined &&
              step.route.join(" › ") !== this.lastLookRoute.join(" › ")
            ? `It ended on ${this.lastLookRoute.join(" › ")}; the recording ended on ${step.route.join(" › ")}.`
            : null;
        if (problem !== null) {
          return fail(
            [
              `Replay "${script.name}" failed at step ${i + 1} of ${total}: ${describeStep(step)}`,
              problem,
              ...(lines.length > 0 ? ["Steps before it passed:", ...lines] : []),
              ...(step.fragile ? ["Note: this step targets a ref from the recording run; give the element a testID."] : []),
            ].join("\n"),
          );
        }
        lines.push(`${label.replace(/^(\d+) /, "$1 ✓ ")} (${seconds(Date.now() - at)} s)`);
      }
    } finally {
      this.replaying = false;
    }
    return text(
      [`Replayed "${script.name}" on ${session.app.name}: ${total} of ${total} steps passed in ${seconds(Date.now() - started)} s.`, ...lines].join(
        "\n",
      ),
    );
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

  private elementName(result: unknown): string {
    if (typeof result === "object" && result !== null && "element" in result) {
      const element = elementSchema.safeParse((result as { element: unknown }).element);
      if (element.success) return formatElement(element.data, { actions: false });
    }
    return "element";
  }

  tap(args: Shape<"tap">): Promise<CallToolResult> {
    return this.act(
      "press",
      { target: toWireTarget(args.target), ...(args.force === true ? { force: true } : {}) },
      (r) => `Tapped ${this.elementName(r)}.`,
      args.look,
      args.screenshot,
    );
  }

  /** `seconds` is accepted for the shared interface; Tapline calls the handler, so it doesn't hold. */
  longPress(args: Shape<"long_press">): Promise<CallToolResult> {
    return this.act(
      "longPress",
      { target: toWireTarget(args.target), ...(args.force === true ? { force: true } : {}) },
      (r) => `Long-pressed ${this.elementName(r)}.`,
      args.look,
      args.screenshot,
    );
  }

  typeText(args: Shape<"type_text">): Promise<CallToolResult> {
    const params: Record<string, unknown> = {
      text: args.text,
      replace: args.replace ?? true,
      submit: args.submit ?? false,
    };
    if (args.target !== undefined) params["target"] = toWireTarget(args.target);
    return this.act(
      "type",
      params,
      (r) => {
        const value = typeof r === "object" && r !== null && "value" in r ? (r as { value: unknown }).value : undefined;
        const shown = typeof value === "string" ? ` Value is now ${JSON.stringify(value)}.` : "";
        return `Typed into ${this.elementName(r)}${args.submit ? " and submitted" : ""}.${shown}`;
      },
      args.look,
      args.screenshot,
    );
  }

  scroll(args: Shape<"scroll">): Promise<CallToolResult> {
    if (args.to !== undefined && (args.direction !== undefined || args.amount !== undefined)) {
      return Promise.resolve(fail("Error bad_params: use either `to` or `direction`/`amount`, not both."));
    }
    const params: Record<string, unknown> =
      args.to !== undefined ? { to: args.to } : { direction: args.direction ?? "down", fraction: args.amount ?? 0.8 };
    if (args.target !== undefined) params["target"] = toWireTarget(args.target);
    return this.act(
      "scroll",
      params,
      (r) => {
        const offset =
          typeof r === "object" && r !== null && "offset" in r ? (r as { offset: unknown }).offset : undefined;
        const at = offset !== undefined ? ` Offset now ${JSON.stringify(offset)}.` : "";
        return `Scrolled ${this.elementName(r)} ${args.to !== undefined ? `to ${args.to}` : (args.direction ?? "down")}.${at}`;
      },
      args.look,
      args.screenshot,
    );
  }

  toggle(args: Shape<"toggle">): Promise<CallToolResult> {
    const params: Record<string, unknown> = { target: toWireTarget(args.target) };
    if (args.value !== undefined) params["value"] = args.value;
    if (args.force === true) params["force"] = true;
    return this.act(
      "toggle",
      params,
      (r) => {
        const value = typeof r === "object" && r !== null && "value" in r ? (r as { value: unknown }).value : undefined;
        return `Toggled ${this.elementName(r)}${value !== undefined ? ` to ${JSON.stringify(value)}` : ""}.`;
      },
      args.look,
      args.screenshot,
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

  back(args: Shape<"back">): Promise<CallToolResult> {
    return this.act(
      "back",
      {},
      (r) => {
        const route = typeof r === "object" && r !== null && "route" in r ? (r as { route: unknown }).route : undefined;
        const from = Array.isArray(route) && route.every((name) => typeof name === "string") ? ` from ${route.join(" › ")}` : "";
        return `Went back${from}.`;
      },
      args.look,
      args.screenshot,
    );
  }

  openUrl(args: Shape<"open_url">): Promise<CallToolResult> {
    return this.act("openURL", { url: args.url }, () => `Opened ${args.url}.`, args.look, args.screenshot);
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
    const last = entries.reduce<number | undefined>((max, e) => (e.ts !== undefined && (max === undefined || e.ts > max) ? e.ts : max), undefined);
    const footer = last !== undefined ? `\n(latest ts ${last}; pass since=${last} for newer lines)` : "";
    return text(`${formatLogs(entries)}${footer}`);
  }

  async reload(args: Shape<"reload">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    try {
      await this.host.request("reload", {}, { sessionId: session.id, timeoutMs: 5000 });
    } catch (error) {
      // The app dies mid-reload, so a dropped connection or a missing answer means it worked.
      const worked = error instanceof TaplineError && (error.code === "reconnecting" || error.code === "timeout");
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
    await sleep(this.reloadSettleMs);
    return this.withLook(this.host.current() ?? session, "Reloaded; the app reconnected.");
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
