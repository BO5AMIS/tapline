import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { createPairCode, pairCodeExpiry, verifyPairCode } from "./pairing.js";
import {
  CLOSE_BAD_PAIR_CODE,
  CLOSE_BAD_PROTOCOL,
  CLOSE_BAD_TOKEN,
  CLOSE_NOT_AUTHENTICATED,
  PROTOCOL_VERSION,
  appInfoSchema,
  deviceInfoSchema,
  eventSchema,
  appFrameSchema,
  logEntrySchema,
  responseSchema,
  type AppInfo,
  type DeviceInfo,
  type LogEntry,
} from "./protocol.js";

export const CLOSE_REPLACED = 4010;
export const CLOSE_SILENT = 4011;

export interface SessionInfo {
  id: string;
  app: AppInfo;
  device: DeviceInfo;
  capabilities: string[];
  connectedAt: number;
  lastSeen: number;
  /** The app's last reported state ("active", "background", "inactive"), when it sent one. */
  appState?: { state: string; at: number };
  /** How the app reaches this host, from the address it connected from. */
  via?: "tailscale" | "wifi";
}

/**
 * How a phone at `address` reaches this host: Tailscale hands out 100.64.0.0/10; anything else is
 * the local network.
 */
export function viaOf(address: string | undefined): "tailscale" | "wifi" | undefined {
  if (address === undefined || address === "") return undefined;
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(address);
  if (v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127) return "tailscale";
  // Tailscale's IPv6 range.
  if (/^fd7a:115c:a1e0:/i.test(address)) return "tailscale";
  return "wifi";
}

/** Something that answers some HTTP requests and upgrades before the app connection does (the live viewer). */
export interface HttpExtension {
  /** Return true when it answered the request. */
  onRequest(req: IncomingMessage, res: ServerResponse): boolean;
  /** Return true when it took the upgrade. */
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/** One frame of the app's live picture (the `frame` event). */
export interface AppFrame {
  seq: number;
  rev?: number;
  capturedAt: number;
  captureMs?: number;
  mime: string;
  data: string;
  width?: number;
  height?: number;
}

/** The most recent app that dropped, for explaining "no app is connected". */
export interface LastDisconnect {
  session: SessionInfo;
  reason: string;
  at: number;
  /** Set when the silence sweep dropped an app that wasn't in the background: how long it had sent nothing. */
  silentForMs?: number;
}

export interface TaplineHostOptions {
  token: string;
  /** Port to listen on (0 = random free port). Default 7210. */
  port?: number;
  /** When the port is taken, try up to this many following ports. Default 0. */
  portFallback?: number;
  /** Addresses to bind. Default ["127.0.0.1"]. */
  hosts?: string[];
  /** Default per-request timeout. Default 15 000 ms. */
  requestTimeoutMs?: number;
  /** Drop an app that sends nothing for this long. Default 45 000 ms. */
  silenceTimeoutMs?: number;
  /** How often to check for silent apps. Default 5 000 ms. */
  sweepIntervalMs?: number;
  /** Close a socket that never sends `hello`. Default 10 000 ms. */
  helloTimeoutMs?: number;
  /** Events kept per session. Default 500. */
  logBufferSize?: number;
  /**
   * How long after an announced agent touch ends a touch report still counts as the agent's
   * (the report crosses the network, and the app passes on at most one touch per 500 ms). Default 1500 ms.
   */
  agentTouchSlackMs?: number;
}

/** The longest touch another tool may announce (`POST /agent-touch`), in milliseconds. */
export const MAX_AGENT_TOUCH_MS = 10_000;

/** Whether a socket's peer is this computer. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface RequestOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface ListenResult {
  listening: Array<{ host: string; port: number }>;
  failed: Array<{ host: string; error: string }>;
}

export type TaplineErrorCode =
  | "not_connected"
  | "timeout"
  | "reconnecting"
  | "not_answering"
  | "send_failed"
  | (string & {});

/** An error from the host itself or relayed from the app (`code` is then the app's code). */
export class TaplineError extends Error {
  readonly code: TaplineErrorCode;
  readonly details: unknown;
  constructor(code: TaplineErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TaplineError";
    this.code = code;
    this.details = details;
  }
}

interface HostEvents {
  connect: [session: SessionInfo];
  disconnect: [session: SessionInfo, reason: string];
  log: [session: SessionInfo, entry: LogEntry];
  frame: [session: SessionInfo, frame: AppFrame];
  /** The app went to the background or came back ("background", "active", "inactive"). */
  appState: [session: SessionInfo, state: string];
  /** A person touched the app's screen (the app saw a real touch; at most about two a second). */
  touch: [session: SessionInfo];
  /** A request to a connected app ended with `not_answering`. */
  notAnswering: [session: SessionInfo];
  /** An app that had stopped answering answered again. */
  answering: [session: SessionInfo];
  selected: [session: SessionInfo | undefined];
  warning: [message: string];
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: TaplineError) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  info: SessionInfo;
  socket: WebSocket;
  pending: Map<number, Pending>;
  events: LogEntry[];
  nextId: number;
  /** A request ended with `not_answering` and nothing has come back since. */
  notAnswering: boolean;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identity of "the same app on the same phone", used to replace stale sessions. */
function identityOf(info: Pick<SessionInfo, "app" | "device">): string {
  const device = info.device.id ?? info.device.name ?? info.device.model ?? "";
  return `${info.app.id}\u0000${info.device.platform}\u0000${device}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export class TaplineHost extends EventEmitter<HostEvents> {
  private readonly token: string;
  private readonly port: number;
  private readonly portFallback: number;
  private readonly hosts: string[];
  /** Pairing codes already used, with their expiry, so each works once. */
  private readonly usedCodes = new Map<string, number>();
  private readonly requestTimeoutMs: number;
  private readonly silenceTimeoutMs: number;
  /** The address each app socket connected from, for `via`. */
  private readonly remoteOf = new WeakMap<WebSocket, string>();
  private readonly sweepIntervalMs: number;
  private readonly helloTimeoutMs: number;
  private readonly logBufferSize: number;
  private readonly agentTouchSlackMs: number;
  /** Until when (this computer's clock) touch reports are another tool's agent touches, not a person's. */
  private agentTouchUntil = 0;

  private readonly servers: Array<{ http: HttpServer; wss: WebSocketServer; host: string; port: number }> = [];
  private readonly sessionMap = new Map<string, Session>();
  private selectedId: string | undefined;
  private lastDrop: LastDisconnect | undefined;
  private httpExtension: HttpExtension | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private listenCalled = false;
  private closed = false;

  constructor(options: TaplineHostOptions) {
    super();
    this.token = options.token;
    this.port = options.port ?? 7210;
    this.portFallback = Math.max(0, Math.floor(options.portFallback ?? 0));
    this.hosts = options.hosts ?? ["127.0.0.1"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 45_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.logBufferSize = options.logBufferSize ?? 500;
    this.agentTouchSlackMs = options.agentTouchSlackMs ?? 1500;
  }

  /**
   * Another tool on this computer (Tapwright) is about to touch the phone for an agent, for about
   * `ms`: touch reports that arrive until then (plus the slack) are that agent's, not a person's.
   */
  noteAgentTouch(ms: number): void {
    this.agentTouchUntil = Math.max(this.agentTouchUntil, Date.now() + ms + this.agentTouchSlackMs);
  }

  /**
   * `POST /agent-touch` with `Authorization: Bearer <the host token>` and `{"ms": N}`: only from
   * this computer, answered 204. Returns false for any other path.
   */
  private handleAgentTouch(req: IncomingMessage, res: ServerResponse): boolean {
    if (new URL(req.url ?? "/", "http://host").pathname !== "/agent-touch") return false;
    const answer = (status: number, text?: string): void => {
      res.writeHead(status, text === undefined ? {} : { "content-type": "text/plain" });
      res.end(text === undefined ? undefined : `${text}\n`);
    };
    if (!isLoopback(req.socket.remoteAddress)) {
      answer(403, "Only from this computer.");
      return true;
    }
    if (req.method !== "POST") {
      answer(405, "POST only.");
      return true;
    }
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7).trim(), this.token)) {
      answer(401, "Bearer token required.");
      return true;
    }
    let body = "";
    let tooLong = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1024) tooLong = true;
    });
    req.on("end", () => {
      let ms: unknown;
      try {
        const parsed: unknown = tooLong ? undefined : JSON.parse(body);
        ms = typeof parsed === "object" && parsed !== null ? (parsed as { ms?: unknown }).ms : undefined;
      } catch {
        ms = undefined;
      }
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > MAX_AGENT_TOUCH_MS) {
        answer(400, `Body: {"ms": 0 to ${MAX_AGENT_TOUCH_MS}}.`);
        return;
      }
      this.noteAgentTouch(ms);
      answer(204);
    });
    return true;
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Starts listening on every configured address. When the port is taken and `portFallback`
   * allows it, moves on to the following ports. Rejects only if no address could bind.
   */
  async listen(): Promise<ListenResult> {
    if (this.listenCalled || this.closed) throw new Error("This Tapline host is already listening (or closed).");
    this.listenCalled = true;
    const attempts = this.port === 0 ? 0 : this.portFallback;
    for (let attempt = 0; ; attempt++) {
      const port = this.port === 0 ? 0 : this.port + attempt;
      const result: ListenResult = { listening: [], failed: [] };
      let inUse = false;
      for (const host of this.hosts) {
        try {
          const bound = await this.listenOn(host, port);
          result.listening.push({ host, port: bound });
        } catch (error) {
          if (errorCode(error) === "EADDRINUSE") inUse = true;
          result.failed.push({ host, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (inUse && attempt < attempts && port < 65535) {
        await this.closeServers();
        continue;
      }
      if (result.listening.length === 0) {
        const detail = result.failed.map((f) => `${f.host}: ${f.error}`).join("; ");
        throw new Error(`Could not listen on any address (${detail})`);
      }
      this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs);
      this.sweeper.unref();
      return result;
    }
  }

  /** The first bound port (useful with port 0 or a fallback). */
  boundPort(): number | undefined {
    return this.servers[0]?.port;
  }

  /** A fresh pairing code for a pairing link (valid 10 minutes, accepted once). */
  createPairCode(): string {
    return createPairCode(this.token);
  }

  /** Runs an emit without letting a listener's exception escape into the socket handlers. */
  private safely(emit: () => void): void {
    try {
      emit();
    } catch {
      // a listener's bug must not break the connection
    }
  }

  /** Lets another part (the live viewer) answer HTTP requests and WebSocket upgrades first. */
  setHttpExtension(extension: HttpExtension | undefined): void {
    this.httpExtension = extension;
  }

  private listenOn(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        try {
          if (this.handleAgentTouch(req, res)) return;
          if (this.httpExtension?.onRequest(req, res) === true) return;
        } catch {
          if (!res.headersSent) res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("Tapline host: connect with a WebSocket (ws://).\n");
      });
      http.once("error", reject);
      http.listen(port, host, () => {
        http.off("error", reject);
        http.on("error", (error) => this.safely(() => this.emit("warning", `Server error on ${host}: ${error.message}`)));
        // Attached only once listening, so a bind error reaches `reject` above.
        const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
        wss.on("error", () => {
          // reported by the HTTP server's handler
        });
        wss.on("connection", (socket, req) => {
          this.remoteOf.set(socket, req.socket.remoteAddress ?? "");
          this.onConnection(socket);
        });
        http.on("upgrade", (req, socket, head) => {
          try {
            if (this.httpExtension?.onUpgrade(req, socket, head) === true) return;
          } catch {
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
        });
        const address = http.address();
        const bound = typeof address === "object" && address !== null ? address.port : port;
        this.servers.push({ http, wss, host, port: bound });
        resolve(bound);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    for (const session of [...this.sessionMap.values()]) {
      this.dropSession(session, "host closed");
      session.socket.close(1001, "host closed");
    }
    await this.closeServers();
  }

  private async closeServers(): Promise<void> {
    await Promise.all(
      this.servers.map(
        ({ http, wss }) =>
          new Promise<void>((resolve) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
              http.close(() => resolve());
              http.closeAllConnections();
            });
          }),
      ),
    );
    this.servers.length = 0;
  }

  // ---- sessions -------------------------------------------------------------

  sessions(): SessionInfo[] {
    return [...this.sessionMap.values()].map((s) => ({ ...s.info }));
  }

  /** The most recent app that dropped (its last state included), if any. */
  lastDisconnect(): LastDisconnect | undefined {
    return this.lastDrop === undefined ? undefined : { ...this.lastDrop, session: { ...this.lastDrop.session } };
  }

  /** Whether a request to this session ended with `not_answering` and nothing has come back since. */
  isNotAnswering(sessionId: string): boolean {
    return this.sessionMap.get(sessionId)?.notAnswering === true;
  }

  /** The selected session, else the most recently connected one. */
  current(): SessionInfo | undefined {
    const session = this.currentSession();
    return session === undefined ? undefined : { ...session.info };
  }

  /** Id of the explicitly selected session, if any. */
  selectedSessionId(): string | undefined {
    return this.selectedId;
  }

  select(sessionId: string): SessionInfo {
    const session = this.sessionMap.get(sessionId);
    if (session === undefined) {
      throw new TaplineError(
        "not_connected",
        `No connected session "${sessionId}". Connected: ${this.describeIds()}.`,
      );
    }
    this.selectedId = sessionId;
    this.emit("selected", { ...session.info });
    return { ...session.info };
  }

  /** Buffered log/error events for a session, optionally only those after `since` (epoch ms). */
  logs(sessionId: string, since?: number): LogEntry[] {
    const session = this.sessionMap.get(sessionId);
    if (session === undefined) {
      throw new TaplineError("not_connected", `No connected session "${sessionId}".`);
    }
    return session.events.filter((e) => since === undefined || (e.ts ?? 0) > since).map((e) => ({ ...e }));
  }

  private describeIds(): string {
    const ids = [...this.sessionMap.keys()];
    return ids.length === 0 ? "none" : ids.join(", ");
  }

  private currentSession(): Session | undefined {
    if (this.selectedId !== undefined) {
      const selected = this.sessionMap.get(this.selectedId);
      if (selected !== undefined) return selected;
    }
    let latest: Session | undefined;
    for (const session of this.sessionMap.values()) {
      if (latest === undefined || session.info.connectedAt >= latest.info.connectedAt) latest = session;
    }
    return latest;
  }

  // ---- requests -------------------------------------------------------------

  /** Sends a request to an app and resolves with its `result` (or rejects with a TaplineError). */
  request(method: string, params: unknown = {}, options: RequestOptions = {}): Promise<unknown> {
    const session =
      options.sessionId !== undefined ? this.sessionMap.get(options.sessionId) : this.currentSession();
    if (session === undefined) {
      if (options.sessionId !== undefined) {
        return Promise.reject(
          new TaplineError(
            "not_connected",
            `No connected session "${options.sessionId}". Connected: ${this.describeIds()}.`,
          ),
        );
      }
      return Promise.reject(new TaplineError("not_connected", "No app is connected to the Tapline host."));
    }
    const appState = session.info.appState;
    if (appState?.state === "background") {
      // iOS has paused the app: a request would only time out.
      const since = new Date(appState.at).toTimeString().slice(0, 8);
      return Promise.reject(
        new TaplineError(
          "in_background",
          `${session.info.app.name} is in the background since ${since} (the user switched apps or locked the phone, so iOS paused it). Ask the user to open the app again; it carries on by itself.`,
        ),
      );
    }
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const id = session.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        const seconds = Math.round(timeoutMs / 100) / 10;
        // An app in the background is paused by iOS, which is no fault of the app: that keeps `timeout`.
        if (session.info.appState?.state === "background") {
          reject(new TaplineError("timeout", `The app did not answer "${method}" within ${seconds}s.`));
          return;
        }
        if (this.sessionMap.get(session.info.id) === session && !session.notAnswering) {
          session.notAnswering = true;
          this.safely(() => this.emit("notAnswering", { ...session.info }));
        }
        reject(
          new TaplineError(
            "not_answering",
            `${session.info.app.name} is connected but did not answer "${method}" within ${seconds} s. Try once more; if it repeats, ask the user to close the app and open it again.`,
          ),
        );
      }, timeoutMs);
      session.pending.set(id, { method, resolve, reject, timer });
      const frame = JSON.stringify({ type: "request", id, method, params });
      session.socket.send(frame, (error) => {
        if (error !== undefined && error !== null) {
          const pending = session.pending.get(id);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          session.pending.delete(id);
          reject(new TaplineError("send_failed", `Could not send "${method}" to the app: ${error.message}`));
        }
      });
    });
  }

  // ---- connection handling --------------------------------------------------

  private onConnection(socket: WebSocket): void {
    let session: Session | undefined;
    const helloTimer = setTimeout(() => {
      if (session === undefined) socket.close(CLOSE_NOT_AUTHENTICATED, "hello timeout");
    }, this.helloTimeoutMs);
    helloTimer.unref();

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (session === undefined) socket.close(CLOSE_NOT_AUTHENTICATED, "expected hello");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(rawToString(data));
      } catch {
        if (session === undefined) socket.close(CLOSE_NOT_AUTHENTICATED, "expected hello");
        return;
      }
      if (session === undefined) {
        clearTimeout(helloTimer);
        session = this.handleHello(socket, message);
        return;
      }
      this.handleMessage(session, message);
    });

    socket.on("close", (_code, reason) => {
      clearTimeout(helloTimer);
      if (session !== undefined) this.dropSession(session, reason.toString("utf8") || "disconnected");
    });
    socket.on("error", () => {
      // 'close' follows; nothing else to do.
    });
  }

  private handleHello(socket: WebSocket, message: unknown): Session | undefined {
    if (!isRecord(message) || message["type"] !== "hello") {
      socket.close(CLOSE_NOT_AUTHENTICATED, "expected hello first");
      return undefined;
    }
    const pairCode = message["pairCode"];
    const paired = pairCode !== undefined;
    if (paired) {
      if (typeof pairCode !== "string" || !this.pairCodeUsable(pairCode)) {
        socket.close(CLOSE_BAD_PAIR_CODE, "pairing code invalid, expired or already used");
        return undefined;
      }
    } else {
      const token = message["token"];
      if (typeof token !== "string" || !safeEqual(token, this.token)) {
        socket.close(CLOSE_BAD_TOKEN, "bad token");
        return undefined;
      }
    }
    if (message["protocol"] !== PROTOCOL_VERSION) {
      socket.close(CLOSE_BAD_PROTOCOL, `unsupported protocol (host speaks ${PROTOCOL_VERSION})`);
      return undefined;
    }
    if (typeof pairCode === "string") this.usedCodes.set(pairCode, pairCodeExpiry(pairCode) ?? Date.now());

    const app = appInfoSchema.safeParse(message["app"] ?? {});
    const device = deviceInfoSchema.safeParse(message["device"] ?? {});
    const capabilities = Array.isArray(message["capabilities"])
      ? message["capabilities"].filter((c): c is string => typeof c === "string")
      : [];
    const now = Date.now();
    const info: SessionInfo = {
      id: `s-${randomBytes(2).toString("hex")}`,
      app: app.success ? app.data : appInfoSchema.parse({}),
      device: device.success ? device.data : deviceInfoSchema.parse({}),
      capabilities,
      connectedAt: now,
      lastSeen: now,
    };
    const via = viaOf(this.remoteOf.get(socket));
    if (via !== undefined) info.via = via;
    while (this.sessionMap.has(info.id)) info.id = `s-${randomBytes(2).toString("hex")}`;

    const session: Session = { info, socket, pending: new Map(), events: [], nextId: 1, notAnswering: false };

    // Replace a previous session of the same app on the same device.
    const identity = identityOf(info);
    for (const old of [...this.sessionMap.values()]) {
      if (identityOf(old.info) !== identity) continue;
      session.events = old.events.slice(-this.logBufferSize);
      if (this.selectedId === old.info.id) this.selectedId = info.id;
      this.dropSession(old, "replaced by a new connection");
      old.socket.close(CLOSE_REPLACED, "replaced");
    }

    this.sessionMap.set(info.id, session);
    // A paired app gets the token so it can reconnect later without a new code.
    const welcome = { type: "welcome", protocol: PROTOCOL_VERSION, session: info.id, ...(paired ? { token: this.token } : {}) };
    socket.send(JSON.stringify(welcome));
    this.safely(() => this.emit("connect", { ...info }));
    return session;
  }

  private pairCodeUsable(code: string): boolean {
    const now = Date.now();
    for (const [used, expiresAt] of this.usedCodes) if (expiresAt < now) this.usedCodes.delete(used);
    return !this.usedCodes.has(code) && verifyPairCode(this.token, code, now);
  }

  private handleMessage(session: Session, message: unknown): void {
    if (!isRecord(message)) return;
    session.info.lastSeen = Date.now();
    switch (message["type"]) {
      case "ping":
        session.socket.send(JSON.stringify({ type: "pong" }));
        return;
      case "pong":
        return;
      case "response": {
        const parsed = responseSchema.safeParse(message);
        if (!parsed.success) return;
        // Any answer, even a late one or an error, shows the app is answering again.
        if (session.notAnswering) {
          session.notAnswering = false;
          this.safely(() => this.emit("answering", { ...session.info }));
        }
        const pending = session.pending.get(parsed.data.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        session.pending.delete(parsed.data.id);
        if (parsed.data.ok) {
          pending.resolve(parsed.data.result ?? {});
        } else {
          const error = parsed.data.error;
          pending.reject(
            new TaplineError(
              error?.code ?? "internal",
              error?.message ?? `The app failed "${pending.method}" without a message.`,
              error,
            ),
          );
        }
        return;
      }
      case "event": {
        const parsed = eventSchema.safeParse(message);
        if (!parsed.success) return;
        this.recordEvent(session, parsed.data.event, parsed.data.data);
        return;
      }
      default:
        return;
    }
  }

  private recordEvent(session: Session, event: string, data: unknown): void {
    if (event === "frame") {
      const frame = appFrameSchema.safeParse(data);
      if (frame.success) this.safely(() => this.emit("frame", { ...session.info }, frame.data));
      return;
    }
    if (event === "touch") {
      // Not a log line: touches come as often as twice a second. Listeners decide what it means.
      // One another tool announced for its agent (POST /agent-touch) is no person's.
      if (Date.now() <= this.agentTouchUntil) return;
      this.safely(() => this.emit("touch", { ...session.info }));
      return;
    }
    if (event === "appState") {
      const state = typeof data === "object" && data !== null ? (data as { state?: unknown }).state : undefined;
      if (typeof state !== "string" || state === "") return;
      const at = Date.now();
      session.info.appState = { state, at };
      const where = state === "active" ? "came back to the front" : state === "background" ? "went to the background" : `is ${state}`;
      this.pushEntry(session, { level: "info", message: `[tapline] the app ${where}`, ts: at });
      this.safely(() => this.emit("appState", { ...session.info }, state));
      return;
    }
    if (event !== "log" && event !== "error") return;
    const parsed = logEntrySchema.safeParse(data);
    if (!parsed.success) return;
    this.pushEntry(session, {
      ...parsed.data,
      level: event === "error" ? "error" : (parsed.data.level ?? "log"),
      ts: parsed.data.ts ?? Date.now(),
    });
  }

  private pushEntry(session: Session, entry: LogEntry): void {
    session.events.push(entry);
    if (session.events.length > this.logBufferSize) {
      session.events.splice(0, session.events.length - this.logBufferSize);
    }
    this.safely(() => this.emit("log", { ...session.info }, entry));
  }

  /** Removes a session and rejects its pending requests. Safe to call twice. */
  private dropSession(session: Session, reason: string, silentForMs?: number): void {
    if (this.sessionMap.get(session.info.id) !== session) return;
    this.sessionMap.delete(session.info.id);
    this.lastDrop = {
      session: { ...session.info },
      reason,
      at: Date.now(),
      ...(silentForMs !== undefined ? { silentForMs } : {}),
    };
    if (this.selectedId === session.info.id) this.selectedId = undefined;
    for (const [id, pending] of session.pending) {
      clearTimeout(pending.timer);
      session.pending.delete(id);
      pending.reject(
        silentForMs !== undefined
          ? new TaplineError(
              "not_answering",
              `${session.info.app.name} stopped answering (nothing from it for ${Math.round(silentForMs / 1000)} s while connected). Ask the user to close the app and open it again.`,
            )
          : new TaplineError(
              "reconnecting",
              `The app disconnected before answering "${pending.method}" (${reason}). It reconnects by itself while it's open; look again in a few seconds.`,
            ),
      );
    }
    this.safely(() => this.emit("disconnect", { ...session.info }, reason));
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessionMap.values()]) {
      if (now - session.info.lastSeen > this.silenceTimeoutMs) {
        // An app iOS has paused (background) is silent for a reason; any other silence is the app not answering.
        const silentForMs = session.info.appState?.state === "background" ? undefined : now - session.info.lastSeen;
        this.dropSession(session, "silent too long", silentForMs);
        session.socket.close(CLOSE_SILENT, "silent");
        const socket = session.socket;
        setTimeout(() => socket.terminate(), 1000).unref();
      }
    }
  }
}
