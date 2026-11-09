import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toBuffer as qrPng } from "qrcode";
import { z } from "zod";
import { annotateScreenshot } from "./annotate.js";
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
    ref: z.string().optional().describe('Element ref from the latest look, e.g. "e12" (refs change after the screen changes)'),
    testID: z.string().optional().describe("Exact testID prop"),
    label: z.string().optional().describe("accessibilityLabel / aria-label (case-insensitive, exact)"),
    text: z.string().optional().describe("Visible text (case-insensitive; exact match preferred, else substring)"),
    index: z.number().int().min(0).optional().describe("With text: pick the Nth match (0-based, tree order) when several match"),
    x: z.number().optional().describe("X in points (window coordinates); use together with y"),
    y: z.number().optional().describe("Y in points (window coordinates); use together with x"),
  })
  .superRefine((value, ctx) => {
    const kinds = [
      value.ref !== undefined,
      value.testID !== undefined,
      value.label !== undefined,
      value.text !== undefined,
      value.x !== undefined || value.y !== undefined,
    ].filter(Boolean).length;
    if (kinds !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Give exactly one kind of target: {ref}, {testID}, {label}, {text, index?} or {x, y}.",
      });
      return;
    }
    if ((value.x === undefined) !== (value.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "A coordinate target needs both x and y." });
    }
    if (value.index !== undefined && value.text === undefined) {
      ctx.addIssue({ code: "custom", message: "index only works together with text." });
    }
  });
export type Target = z.infer<typeof targetSchema>;

const targetField = targetSchema.describe(
  'Which element: exactly one of {ref}, {testID}, {label}, {text, index?} or {x, y}. Prefer ref or testID from the latest look.',
);
const lookField = z
  .boolean()
  .optional()
  .describe(
    "Set false to skip the element list normally returned after the action (only the changes once you've had a full list; no screenshot, call look for one)",
  );

const forceField = z
  .boolean()
  .optional()
  .describe(
    "Act even when a real touch couldn't: the element is off screen or something covers it. Default false; prefer scrolling or dismissing what covers it, since a person would have to.",
  );

export const toolShapes = {
  apps: {},
  select_app: { session: z.string().describe('Session id from "apps", e.g. "s-7f3a"') },
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
  press: { target: targetField, force: forceField, look: lookField },
  long_press: { target: targetField, force: forceField, look: lookField },
  type_text: {
    text: z.string().describe("Text to enter"),
    target: targetField.optional().describe("Input to type into; default: the focused input, else the only input on screen"),
    replace: z.boolean().optional().describe("Replace the current text (default true); false appends"),
    submit: z.boolean().optional().describe("Also submit (like pressing return) after typing (default false)"),
    look: lookField,
  },
  scroll: {
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction (default down when no `to`)"),
    amount: z.number().positive().optional().describe("Distance in points (default: 80% of the scroll view height)"),
    to: z.enum(["start", "end"]).optional().describe("Jump to the start or end instead of using direction/amount"),
    target: targetField.optional().describe("Scroll view to scroll; default: the largest one on screen"),
    look: lookField,
  },
  toggle: {
    target: targetField,
    value: z.boolean().optional().describe("Desired state; omit to flip"),
    force: forceField,
    look: lookField,
  },
  open_url: { url: z.string().describe('URL or deep link to open, e.g. "myapp://settings"'), look: lookField },
  back: { look: lookField },
  logs: {
    since: z.number().optional().describe("Only lines after this timestamp (epoch milliseconds)"),
  },
  reload: { look: lookField },
  wait: { seconds: z.number().min(0.1).max(30).describe("How long to wait, 0.1 to 30 seconds") },
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
  /** Delay between an action and the follow-up look. Default 350 ms. */
  settleMs?: number;
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
}

const findingsSchema = z.object({
  findings: z.array(z.object({ kind: z.string(), ref: z.string(), other: z.string().optional(), message: z.string() })),
});

/** Default screenshot width in pixels: readable, about 1,000 image tokens for a phone screen. */
export const DEFAULT_SCREENSHOT_WIDTH = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toWireTarget(target: Target): WireTarget {
  if (target.ref !== undefined) return { ref: target.ref };
  if (target.testID !== undefined) return { testID: target.testID };
  if (target.label !== undefined) return { label: target.label };
  if (target.text !== undefined) {
    return target.index !== undefined ? { text: target.text, index: target.index } : { text: target.text };
  }
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
      return `Error ambiguous: ${error.message}${list}\nRetry with one of the refs, or add "index" (0-based) to a {text} target.`;
    }
    return `Error ${error.code}: ${error.message}`;
  }
  return `Error internal: ${error instanceof Error ? error.message : String(error)}`;
}

// ---- tool handlers ----------------------------------------------------------

/** The tool handlers behind the MCP server. They only talk to a TaplineHost, so they are easy to test. */
export class TaplineTools {
  private readonly settleMs: number;
  private readonly reloadWaitMs: number;
  private readonly reloadSettleMs: number;
  private readonly noScreenshot = new Set<string>();
  private readonly shotFiles: string[] = [];
  /** Sessions this agent has had an element list for (so later lists can be just the changes). */
  private readonly listed = new Set<string>();
  private shotCount = 0;
  private pairWrites = 0;

  constructor(
    private readonly host: TaplineHost,
    private readonly options: ToolsOptions,
  ) {
    this.settleMs = options.settleMs ?? 350;
    this.reloadWaitMs = options.reloadWaitMs ?? 20_000;
    this.reloadSettleMs = options.reloadSettleMs ?? 1500;
  }

  /** How to connect an app, shown when nothing is connected. */
  noAppMessage(): string {
    const { url, name } = this.options.connect;
    return [
      "No app is connected to Tapline.",
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
    const lines = sessions.map((s) => {
      const version = s.app.version !== undefined ? ` ${s.app.version}${s.app.build !== undefined ? ` (${s.app.build})` : ""}` : "";
      // iPhones send no name, so the install id is what tells two of them apart.
      const install = s.device.name === undefined && s.device.id !== undefined ? `install ${s.device.id.slice(0, 6)}` : undefined;
      const device = [s.device.name, [s.device.platform, s.device.osVersion].filter(Boolean).join(" "), install]
        .filter((p): p is string => typeof p === "string" && p !== "")
        .join(", ");
      const age = Math.max(0, Math.round((now - s.connectedAt) / 1000));
      const marker = current?.id === s.id ? "*" : " ";
      return `${marker} ${s.id}  ${s.app.name}${version} [${s.app.id}] on ${device || "unknown device"}, connected ${age}s ago`;
    });
    const footer = sessions.length > 1 ? '\n* = selected. Use select_app {session} to switch.' : "\n* = selected.";
    return text(`Connected apps:\n${lines.join("\n")}${footer}`);
  }

  selectApp(args: Shape<"select_app">): CallToolResult {
    try {
      const session = this.host.select(args.session);
      return text(`Selected ${session.app.name} (${session.id}) on ${session.device.name ?? session.device.platform}.`);
    } catch (error) {
      return fail(describeError(error));
    }
  }

  // -- look

  async look(args: Shape<"look"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return fail(this.noAppMessage());
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
    if (session === undefined) return fail(this.noAppMessage());
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
            .request("screenshot", { format: "jpg", quality: 0.7, maxWidth: width }, { sessionId: sid })
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
    const lines = [`App: ${session.app.name} [${sid}]`, (askChanges ? formatChanges(tree) : null) ?? formatTree(tree)];
    const content: CallToolResult["content"] = [];
    const shot = await shotPromise;
    if (shot === undefined) {
      if (wantScreenshot) lines.push("(No screenshot: this app does not support it; add react-native-view-shot.)");
    } else if (shot.ok) {
      const parsed = screenshotResultSchema.safeParse(shot.value);
      if (!parsed.success) lines.push("(Screenshot unavailable: unreadable response.)");
      else {
        const screen = tree.screen;
        const image =
          labels && screen !== null && screen !== undefined
            ? annotateScreenshot(parsed.data, tree.elements, screen)
            : parsed.data;
        if (labels) lines.push("(Screenshot labeled with each tappable element's box and ref.)");
        if (this.options.screenshots === "file") {
          const { mime, data, width: w, height: h } = image;
          try {
            const size = w !== undefined && h !== undefined ? ` (${w}x${h})` : "";
            lines.push(`Screenshot: ${this.saveShot(sid, mime, data)}${size}`);
          } catch (error) {
            lines.push(`(Screenshot not saved: ${error instanceof Error ? error.message : String(error)})`);
          }
        } else content.push({ type: "image", data: image.data, mimeType: image.mime });
      }
    } else if (shot.error instanceof TaplineError && shot.error.code === "unsupported") {
      this.noScreenshot.add(sid);
      lines.push("(No screenshot: this app does not support it; add react-native-view-shot.)");
    } else {
      lines.push(`(Screenshot failed: ${shot.error instanceof Error ? shot.error.message : String(shot.error)})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }, ...content], isError: false };
  }

  // -- actions

  /** Runs a request, then (unless disabled) appends the fresh element list after a short settle. */
  private async act(
    method: string,
    params: unknown,
    describe: (result: unknown) => string,
    withLook: boolean | undefined,
  ): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return fail(this.noAppMessage());
    let result: unknown;
    try {
      result = await this.host.request(method, params, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const line = describe(result);
    if (withLook === false) return text(line);
    await sleep(this.settleMs);
    return this.withLook(session, line);
  }

  private async withLook(session: SessionInfo, line: string): Promise<CallToolResult> {
    // The session may have been replaced (app restarted) in the meantime.
    const live = this.host.sessions().some((s) => s.id === session.id) ? session : this.host.current();
    if (live === undefined) return text(`${line}\n\n(The app disconnected, so no fresh element list is available.)`);
    // Text only: a screenshot after every step would cost image tokens the agent rarely needs.
    const parts = await this.lookParts(live, false, DEFAULT_SCREENSHOT_WIDTH, true);
    const [first, ...rest] = parts.content;
    const head = first !== undefined && first.type === "text" ? first.text : "";
    return { content: [{ type: "text", text: `${line}\n\n${head}` }, ...rest] };
  }

  private elementName(result: unknown): string {
    if (typeof result === "object" && result !== null && "element" in result) {
      const element = elementSchema.safeParse((result as { element: unknown }).element);
      if (element.success) return describeElement(element.data);
    }
    return "element";
  }

  press(args: Shape<"press">): Promise<CallToolResult> {
    return this.act(
      "press",
      { target: toWireTarget(args.target), ...(args.force === true ? { force: true } : {}) },
      (r) => `Pressed ${this.elementName(r)}.`,
      args.look,
    );
  }

  longPress(args: Shape<"long_press">): Promise<CallToolResult> {
    return this.act(
      "longPress",
      { target: toWireTarget(args.target), ...(args.force === true ? { force: true } : {}) },
      (r) => `Long-pressed ${this.elementName(r)}.`,
      args.look,
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
    );
  }

  scroll(args: Shape<"scroll">): Promise<CallToolResult> {
    if (args.to !== undefined && (args.direction !== undefined || args.amount !== undefined)) {
      return Promise.resolve(fail("Error bad_params: use either `to` or `direction`/`amount`, not both."));
    }
    const params: Record<string, unknown> =
      args.to !== undefined ? { to: args.to } : { direction: args.direction ?? "down", ...(args.amount !== undefined ? { amount: args.amount } : {}) };
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
    );
  }

  openUrl(args: Shape<"open_url">): Promise<CallToolResult> {
    return this.act("openURL", { url: args.url }, () => `Opened ${args.url}.`, args.look);
  }

  async logs(args: Shape<"logs">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return fail(this.noAppMessage());
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
    if (session === undefined) return fail(this.noAppMessage());
    try {
      await this.host.request("reload", {}, { sessionId: session.id, timeoutMs: 5000 });
    } catch (error) {
      // The app dies mid-reload, so a dropped connection or a missing answer means it worked.
      const worked = error instanceof TaplineError && (error.code === "disconnected" || error.code === "timeout");
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
    if (session === undefined) return fail(this.noAppMessage());
    await sleep(args.seconds * 1000);
    return this.withLook(session, `Waited ${args.seconds}s.`);
  }
}
