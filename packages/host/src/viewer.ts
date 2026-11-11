import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ControlQueue } from "./control.js";
import { isLoopback, type AppFrame, type HttpExtension, type TaplineHost } from "./server.js";

/**
 * The live viewer, server side, as docs/VIEWER-PROTOCOL.md describes: `/viewer` (the page),
 * `/stream` (multipart JPEG, newest frame wins) and `/ws` (status, overlay, actions, input).
 * It rides on the host's own port through the host's HTTP extension.
 */

export type QualityPreset = "sharp" | "balanced" | "light";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A person's input from the viewer (only the kinds the page sends). */
export type PersonInput =
  | { type: "gesture"; points: Array<[number, number, number]> }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  | { type: "text"; text: string }
  | { type: "key"; key: "backspace" | "enter" };

/** What was just done, for every viewer to see; `rect` / `point` in 0..1. */
export interface ViewerAction {
  by: "agent" | "person";
  kind: string;
  label?: string;
  rect?: Rect;
  point?: { x: number; y: number };
  ok?: boolean;
  code?: string;
}

export interface InputOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  action?: Omit<ViewerAction, "by" | "ok" | "code">;
}

export interface OverlayRead {
  rev?: number;
  /** The screen in points, which the element rects use. */
  size: { w: number; h: number };
  elements: Array<{ ref: string | null; type: string | null; label: string | null; id: string | null; rect: Rect }>;
}

export interface ViewerHubOptions {
  token: string;
  html: string;
  /** Host header values to accept (e.g. "127.0.0.1:7210"); checked on every request. */
  allowedHosts: () => string[];
  /** Serve to other machines (the tailnet); otherwise loopback only. */
  allowRemote: boolean;
  accepts: string[];
  control: ControlQueue;
  /** Start or stop the app's capture, at a quality. */
  setFeed: (on: boolean, quality: QualityPreset) => void;
  readOverlay: () => Promise<OverlayRead | null>;
  runInput: (input: PersonInput) => Promise<InputOutcome>;
  /** Stop the app's capture this long after the last viewer leaves. Default 30 000 ms. */
  idleStopMs?: number;
  /** How often to resend the status when the measured frame rate changed. Default 2000 ms. */
  statusEveryMs?: number;
}

interface StatusFields {
  state: "live" | "connecting" | "reconnecting" | "locked" | "no-device" | "not-answering";
  detail?: string;
  via: string;
  size?: { w: number; h: number };
}

/** What `viewerStatusFor` knows besides the current session. */
export interface ViewerStatusContext {
  /** A request to the current app ended with `not_answering` and nothing has come back since. */
  notAnswering?: boolean;
  /** The app that dropped last (`silentForMs` is set when the host dropped it for silence). */
  lastDrop?: { session: { app: { name: string } }; silentForMs?: number } | undefined;
}

/**
 * The viewer's state for the current app: live; `locked` while iOS has it paused in the
 * background (only a person on the phone can bring it back); `not-answering` (detail: the app's
 * name) while it is connected but doesn't answer, or the host dropped it for silence and no app
 * has connected since; no-device without an app.
 */
export function viewerStatusFor(
  session: { app: { name: string }; appState?: { state: string; at: number } } | undefined,
  context: ViewerStatusContext = {},
): { state: StatusFields["state"]; detail: string | undefined } {
  if (session === undefined) {
    const dropped = context.lastDrop;
    if (dropped?.silentForMs !== undefined) return { state: "not-answering", detail: dropped.session.app.name };
    return { state: "no-device", detail: "The app isn't connected: open it on the phone, on the same Wi-Fi as this computer." };
  }
  if (session.appState?.state === "background") {
    return {
      state: "locked",
      // The page words the state "Phone locked" and appends this.
      detail: "the app is in the background",
    };
  }
  if (context.notAnswering === true) return { state: "not-answering", detail: session.app.name };
  return { state: "live", detail: undefined };
}

/** The viewer's state for a host's current app, with the not-answering facts read from the host. */
export function viewerStatusForHost(
  host: Pick<TaplineHost, "current" | "lastDisconnect" | "isNotAnswering">,
): { state: StatusFields["state"]; detail: string | undefined; via?: string } {
  const session = host.current();
  const status = viewerStatusFor(session, {
    notAnswering: session !== undefined && host.isNotAnswering(session.id),
    lastDrop: host.lastDisconnect(),
  });
  // How the connected app reaches the host (Tailscale or the local network); kept as it was otherwise.
  return session?.via !== undefined ? { ...status, via: session.via } : status;
}

interface StreamClient {
  res: ServerResponse;
  busy: boolean;
  sentSeq: number;
  /** The opening "--frame" boundary has been sent (later parts open with the previous part's closing boundary). */
  opened: boolean;
}

interface WsClient {
  ws: WebSocket;
  overlay: boolean;
}

const COOKIE = "tapline_viewer";

/** The name the page shows in its title and heading ("Tapline live view"): `tool` in every status. */
export const VIEWER_TOOL = "Tapline";

/** The input this host takes from the viewer page (`overlay`: it answers the Boxes control). */
export const VIEWER_ACCEPTS: readonly string[] = ["tap", "longPress", "scroll", "text", "enter", "backspace", "overlay", "quality"];

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return out;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A person's input, validated; null for anything else (unknown types are ignored). */
function parseInput(message: Record<string, unknown>): PersonInput | null {
  switch (message["type"]) {
    case "gesture": {
      const points = message["points"];
      if (!Array.isArray(points) || points.length === 0 || points.length > 2000) return null;
      const clean: Array<[number, number, number]> = [];
      for (const p of points) {
        if (!Array.isArray(p) || p.length !== 3) return null;
        const [t, x, y]: unknown[] = p;
        if (!isNumber(t) || !isNumber(x) || !isNumber(y)) return null;
        clean.push([t, x, y]);
      }
      return { type: "gesture", points: clean };
    }
    case "scroll": {
      const { x, y, dx, dy } = message;
      return isNumber(x) && isNumber(y) && isNumber(dx) && isNumber(dy) ? { type: "scroll", x, y, dx, dy } : null;
    }
    case "text":
      return typeof message["text"] === "string" && message["text"] !== "" ? { type: "text", text: message["text"].slice(0, 2000) } : null;
    case "key":
      return message["key"] === "backspace" || message["key"] === "enter" ? { type: "key", key: message["key"] } : null;
    default:
      return null;
  }
}

export class ViewerHub implements HttpExtension {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private readonly streams = new Set<StreamClient>();
  private readonly sockets = new Set<WsClient>();
  private latest: { seq: number; at: number; rev?: number; mime: string; bytes: Buffer; width?: number; height?: number } | null = null;
  private seq = 0;
  private readonly frameTimes: number[] = [];
  private quality: QualityPreset = "balanced";
  private feedOn = false;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private status: StatusFields = { state: "no-device", via: "tailscale" };
  private overlayRev: number | undefined;
  private overlayReading = false;
  private overlayAgain = false;
  private readonly unsubscribe: () => void;
  private closed = false;
  private sentFps = 0;
  private fpsTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: ViewerHubOptions) {
    this.unsubscribe = options.control.onChange(() => this.broadcastStatus());
  }

  /** While anyone is connected, resend the status when the measured frame rate changes. */
  private watchFps(): void {
    if (this.sockets.size === 0) {
      if (this.fpsTimer !== undefined) clearInterval(this.fpsTimer);
      this.fpsTimer = undefined;
      return;
    }
    if (this.fpsTimer !== undefined) return;
    this.fpsTimer = setInterval(() => {
      if (this.fps() !== this.sentFps) this.broadcastStatus();
    }, this.options.statusEveryMs ?? 2000);
    this.fpsTimer.unref();
  }

  viewers(): number {
    return this.streams.size + this.sockets.size;
  }

  /** Whether the app's frames are on, and at which quality. */
  feed(): { on: boolean; quality: QualityPreset } {
    return { on: this.feedOn, quality: this.quality };
  }

  // ---- access ---------------------------------------------------------------

  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host ?? "";
    return this.options.allowedHosts().includes(host);
  }

  private addressAllowed(req: IncomingMessage): boolean {
    return this.options.allowRemote || isLoopback(req.socket.remoteAddress);
  }

  private matches(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.options.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * How a request shows it knows the token: a Bearer header (scripts, adapters), the URL (only
   * the page load that sets the cookie), or the cookie (the page's own requests). Null if none.
   */
  private credential(req: IncomingMessage, url: URL, allowQuery: boolean): "bearer" | "query" | "cookie" | null {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) return this.matches(auth.slice(7).trim()) ? "bearer" : null;
    const query = allowQuery ? url.searchParams.get("token") : null;
    if (query !== null && this.matches(query)) return "query";
    const cookie = parseCookies(req.headers.cookie).get(COOKIE);
    return cookie !== undefined && this.matches(cookie) ? "cookie" : null;
  }

  /** Cookies are shared across ports and SameSite ignores them: a cookie must come from this page. */
  private cookieFromElsewhere(req: IncomingMessage, credential: string | null): boolean {
    const site = req.headers["sec-fetch-site"];
    return credential === "cookie" && typeof site === "string" && site !== "same-origin" && site !== "none";
  }

  // ---- HTTP -----------------------------------------------------------------

  onRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://viewer");
    // The page answers at `/` as well as `/viewer`, with the same token and cookie rules.
    const isPage = url.pathname === "/viewer" || url.pathname === "/";
    if (!isPage && url.pathname !== "/stream") return false;
    if (!this.hostAllowed(req) || !this.addressAllowed(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Not allowed from here.\n");
      return true;
    }
    const credential = this.credential(req, url, isPage);
    if (credential === null) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Open the viewer link the agent gave you (it has the token).\n");
      return true;
    }
    if (this.cookieFromElsewhere(req, credential)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Not from another site.\n");
      return true;
    }
    if (isPage) {
      // The link's load gets the page itself plus the cookie, not a redirect: after a click on
      // another site, the browser would send the redirected request without the Strict cookie.
      // The page then takes the token out of the address bar.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        ...(credential === "query"
          ? { "set-cookie": `${COOKIE}=${encodeURIComponent(this.options.token)}; HttpOnly; SameSite=Strict; Path=/` }
          : {}),
      });
      res.end(this.options.html);
      return true;
    }
    this.openStream(res);
    return true;
  }

  private openStream(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "multipart/x-mixed-replace; boundary=frame",
      "cache-control": "no-store",
      connection: "close",
    });
    res.flushHeaders(); // answer now: the first frame may take a while
    const client: StreamClient = { res, busy: false, sentSeq: 0, opened: false };
    this.streams.add(client);
    res.on("close", () => {
      this.streams.delete(client);
      this.viewersChanged();
    });
    res.on("drain", () => {
      client.busy = false;
      this.sendLatest(client);
    });
    this.viewersChanged();
    this.sendLatest(client);
  }

  private sendLatest(client: StreamClient): void {
    const frame = this.latest;
    if (frame === null || client.busy || client.sentSeq >= frame.seq) return;
    const headers = [
      `Content-Type: ${frame.mime}`,
      `Content-Length: ${frame.bytes.length}`,
      `X-Seq: ${frame.seq}`,
      `X-Captured-At: ${frame.at}`,
      "X-Coverage: app-window",
      "X-Source: viewshot",
      ...(frame.rev !== undefined ? [`X-Tree-Rev: ${frame.rev}`] : []),
      ...(this.status.size ? [`X-Size: ${Math.round(this.status.size.w)}x${Math.round(this.status.size.h)}`] : []),
      "",
      "",
    ].join("\r\n");
    // One buffer per part, closed at once by the next boundary (as mjpg-streamer does), so a
    // browser shows the frame as soon as it arrives instead of when the next one starts.
    const opening = client.opened ? "" : "--frame\r\n";
    client.opened = true;
    const part = Buffer.concat([Buffer.from(opening + headers, "latin1"), frame.bytes, Buffer.from("\r\n--frame\r\n", "latin1")]);
    client.sentSeq = frame.seq;
    client.busy = !client.res.write(part); // newest frame wins: the next one goes out after "drain"
  }

  // ---- WebSocket --------------------------------------------------------------

  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://viewer");
    if (url.pathname !== "/ws") return false;
    const origin = req.headers.origin;
    const host = req.headers.host ?? "";
    const originOk = origin === undefined || origin === `http://${host}` || origin === `https://${host}`;
    const credential = this.credential(req, url, false);
    if (
      !this.hostAllowed(req) ||
      !this.addressAllowed(req) ||
      !originOk ||
      credential === null ||
      this.cookieFromElsewhere(req, credential)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    return true;
  }

  private onSocket(ws: WebSocket): void {
    const client: WsClient = { ws, overlay: false };
    this.sockets.add(client);
    ws.on("close", () => {
      this.sockets.delete(client);
      this.viewersChanged();
    });
    ws.on("error", () => undefined);
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message === "object" && message !== null && !Array.isArray(message)) {
        void this.onMessage(client, message as Record<string, unknown>);
      }
    });
    this.viewersChanged();
    this.send(client, this.statusMessage());
  }

  private async onMessage(client: WsClient, message: Record<string, unknown>): Promise<void> {
    switch (message["type"]) {
      case "pause":
        if (typeof message["on"] === "boolean") this.options.control.setPaused(message["on"]);
        return;
      case "overlay":
        if (typeof message["on"] === "boolean") {
          client.overlay = message["on"];
          if (client.overlay) {
            this.overlayRev = undefined;
            void this.refreshOverlay();
          }
        }
        return;
      case "quality": {
        const preset = message["preset"];
        if (preset === "sharp" || preset === "balanced" || preset === "light") {
          this.quality = preset;
          if (this.feedOn) this.safely(() => this.options.setFeed(true, preset));
          this.broadcastStatus();
        }
        return;
      }
      default: {
        const input = parseInput(message);
        if (input === null) return;
        let outcome: InputOutcome;
        try {
          outcome = await this.options.runInput(input);
        } catch (error) {
          outcome = { ok: false, code: "unsupported", message: error instanceof Error ? error.message : String(error) };
        }
        if (outcome.action) this.pushAction({ ...outcome.action, by: "person", ok: outcome.ok, ...(outcome.code ? { code: outcome.code } : {}) });
        if (!outcome.ok) {
          this.send(client, { type: "error", message: outcome.message ?? "That didn't work.", ...(outcome.code ? { code: outcome.code } : {}) });
        }
      }
    }
  }

  private send(client: WsClient, message: Record<string, unknown>): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(message));
  }

  private broadcast(message: Record<string, unknown>, only?: (client: WsClient) => boolean): void {
    for (const client of this.sockets) if (only === undefined || only(client)) this.send(client, message);
  }

  // ---- status, frames, overlays, actions ------------------------------------------

  private fps(): number {
    const now = Date.now();
    while (this.frameTimes.length > 0 && (this.frameTimes[0] ?? 0) < now - 5000) this.frameTimes.shift();
    return Math.round((this.frameTimes.length / 5) * 10) / 10;
  }

  private statusMessage(): Record<string, unknown> {
    return {
      type: "status",
      protocol: 1,
      tool: VIEWER_TOOL,
      state: this.status.state,
      ...(this.status.detail ? { detail: this.status.detail } : {}),
      via: this.status.via,
      fps: this.fps(),
      driver: this.options.control.driver(),
      paused: this.options.control.paused(),
      ...(this.status.size ? { size: this.status.size } : {}),
      accepts: this.options.accepts,
      quality: this.quality,
    };
  }

  private broadcastStatus(): void {
    const message = this.statusMessage();
    this.sentFps = this.fps();
    this.broadcast(message);
  }

  /** Update what the status line says (app connected or not, the screen size …). */
  setStatus(update: Partial<StatusFields>): void {
    const before = this.status.state;
    this.status = { ...this.status, ...update };
    if (update.detail === undefined && "detail" in update) delete this.status.detail;
    // The app (re)connected while people watch: its capture has to start again.
    if (before !== "live" && this.status.state === "live" && this.viewers() > 0) {
      this.feedOn = true;
      this.safely(() => this.options.setFeed(true, this.quality));
    }
    this.broadcastStatus();
  }

  /** A frame from the app. */
  pushFrame(frame: AppFrame): void {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(frame.data, "base64");
    } catch {
      return;
    }
    this.seq += 1;
    const now = Date.now();
    this.latest = {
      seq: this.seq,
      at: now,
      mime: frame.mime,
      bytes,
      ...(frame.rev !== undefined ? { rev: frame.rev } : {}),
      ...(frame.width !== undefined ? { width: frame.width } : {}),
      ...(frame.height !== undefined ? { height: frame.height } : {}),
    };
    this.frameTimes.push(now);
    for (const client of this.streams) this.sendLatest(client);
    if (frame.rev === undefined || frame.rev !== this.overlayRev) void this.refreshOverlay();
  }

  /** Show what was just done to everyone watching. */
  pushAction(action: ViewerAction): void {
    this.broadcast({ type: "action", at: Date.now(), ...action });
  }

  private async refreshOverlay(): Promise<void> {
    if (![...this.sockets].some((c) => c.overlay)) return;
    if (this.overlayReading) {
      this.overlayAgain = true;
      return;
    }
    this.overlayReading = true;
    try {
      const read = await this.options.readOverlay();
      if (read !== null && read.size.w > 0 && read.size.h > 0) {
        this.overlayRev = read.rev;
        if (this.status.size === undefined) this.status.size = read.size;
        const { w, h } = read.size;
        this.broadcast(
          {
            type: "overlay",
            ...(read.rev !== undefined ? { rev: read.rev } : {}),
            at: Date.now(),
            elements: read.elements.map((e) => ({
              ref: e.ref,
              type: e.type,
              label: e.label,
              id: e.id,
              rect: { x: e.rect.x / w, y: e.rect.y / h, w: e.rect.w / w, h: e.rect.h / h },
            })),
          },
          (c) => c.overlay,
        );
      }
    } catch {
      // the next frame tries again
    } finally {
      this.overlayReading = false;
      if (this.overlayAgain) {
        this.overlayAgain = false;
        void this.refreshOverlay();
      }
    }
  }

  // ---- the app's capture ------------------------------------------------------

  private viewersChanged(): void {
    if (this.closed) return;
    this.watchFps();
    if (this.viewers() > 0) {
      if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
      if (!this.feedOn) {
        this.feedOn = true;
        this.safely(() => this.options.setFeed(true, this.quality));
      }
      return;
    }
    if (this.feedOn && this.stopTimer === undefined) {
      this.stopTimer = setTimeout(() => {
        this.stopTimer = undefined;
        if (this.viewers() === 0 && this.feedOn) {
          this.feedOn = false;
          this.safely(() => this.options.setFeed(false, this.quality));
        }
      }, this.options.idleStopMs ?? 30_000);
      this.stopTimer.unref();
    }
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // the app may be gone; the next viewer change tries again
    }
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    if (this.stopTimer !== undefined) clearTimeout(this.stopTimer);
    if (this.fpsTimer !== undefined) clearInterval(this.fpsTimer);
    for (const client of this.streams) client.res.destroy();
    for (const client of this.sockets) client.ws.terminate();
    this.streams.clear();
    this.sockets.clear();
    this.wss.close();
  }
}
