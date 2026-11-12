import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
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
  crashEventSchema,
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

/** A fatal JS error of an app (AGENT-TOOLS 15.2), kept per app so it outlives the app's session. */
export interface CrashRecord {
  /** When the app says it happened (the phone's clock, epoch ms). */
  ts: number;
  /** The error type, e.g. "TypeError". */
  name: string;
  message: string;
  stack: string;
  componentStack?: string;
  /** `live`: the app sent it as it happened; `saved`: the app kept it on the phone and sent it on a later connection. */
  source: "live" | "saved";
}

/** Which app on which phone an event belongs to (what `identityOf` is made from). */
export type AppIdentity = Pick<SessionInfo, "app" | "device">;

/**
 * Something that stopped an app, in the order the host learned of it. `seq` counts up from 1. `of` says which app
 * it was, so another app's answers don't carry it.
 */
export type CrashEvent =
  | { seq: number; at: number; kind: "crash"; app: string; of: AppIdentity; crash: CrashRecord }
  | { seq: number; at: number; kind: "disconnect"; app: string; of: AppIdentity };

/** Whether two messages are the same one, when the phone may have cut the longer to fit its storage (`fitRecord`). */
function sameMessage(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a) || (a.length >= 200 && b.length >= 200 && a.slice(0, 200) === b.slice(0, 200));
}

/** How many crashes are kept per app. */
const MAX_CRASHES = 20;
/** Close reasons that mean the app (or this host) ended the connection on purpose. */
const ORDERLY_REASONS = new Set(["host closed", "replaced by a new connection", "stopped", "host silent", "replaced"]);

function crashRecordOf(
  data: { name?: string | undefined; message: string; stack?: string | undefined; componentStack?: string | undefined; ts?: number | undefined },
  source: CrashRecord["source"],
): CrashRecord {
  return {
    ts: data.ts ?? Date.now(),
    name: data.name !== undefined && data.name !== "" ? data.name : "Error",
    message: data.message,
    stack: data.stack ?? "",
    ...(data.componentStack !== undefined && data.componentStack !== "" ? { componentStack: data.componentStack } : {}),
    source,
  };
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

/**
 * Whether a peer is on this computer's own local network (or is this computer): private IPv4, link-local, IPv6
 * unique-local. Not Tailscale (100.64.0.0/10) and not the internet: the development offer stays on the Wi-Fi.
 */
export function isLocalNetwork(address: string | undefined): boolean {
  if (address === undefined) return false;
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  if (isLoopback(address) || a === "127.0.0.1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) {
    const x = Number(v4[1]);
    const y = Number(v4[2]);
    return x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254);
  }
  // unique-local IPv6, but not Tailscale's own range (fd7a:115c:a1e0::/48)
  return (/^f[cd][0-9a-f]{2}:/.test(a) && !a.startsWith("fd7a:115c:a1e0:")) || a.startsWith("fe80:");
}

/**
 * A request a web page could have made: it carries an Origin (the app's own fetch sends none), or it names a
 * host that isn't an address (DNS rebinding: a page's own name pointed at this computer). Such requests never
 * get a pairing offer.
 */
export function fromAWebPage(headers: Record<string, string | string[] | undefined>): boolean {
  if (headers["origin"] !== undefined) return true;
  const raw = headers["host"];
  const host = (typeof raw === "string" ? raw : "").toLowerCase().replace(/:\d+$/, "");
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.startsWith("[") && host.endsWith("]");
  return !(ipv4 || ipv6 || host === "localhost" || host.endsWith(".local"));
}

/** One form of a peer's address for comparisons (IPv4-mapped IPv6 → IPv4). */
export function peerAddress(address: string | undefined): string {
  return (address ?? "").toLowerCase().replace(/^::ffff:/, "");
}

/** A development offer (Tapline 1.1, zero-QR pairing): a pairing code a development build may fetch for a while. */
export interface DevOffer {
  code: string;
  name: string;
  until: number;
  /** The device that fetched it first: only it may pair with this code. */
  claimedBy?: string;
  /** The offer file Metro serves it from; Metro writes its claimer there. */
  file?: string;
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
  /** The app's photo picker handed over the armed test pictures (`media` with `picker`). */
  pickerSkipped: [session: SessionInfo, count: number];
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
  /** A fatal JS error arrived live in this session: its end is explained. */
  fatalSeen?: boolean;
  /** The agent asked for this end (a reload): it is no crash. */
  expectedEnd?: boolean;
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
/** How many ended sessions' logs the host keeps. */
const GONE_LOGS_KEPT = 8;

export function identityOf(info: AppIdentity): string {
  const device = info.device.id ?? info.device.name ?? info.device.model ?? "";
  // An app that sends no id (the default "unknown") is told apart by its name, so two such apps never share crashes.
  const app = info.app.id === "unknown" || info.app.id === "" ? `name:${info.app.name}` : info.app.id;
  return `${app}\u0000${info.device.platform}\u0000${device}`;
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
  /** The logs of the last few sessions that ended, so a failure that ended its app still reports that app's lines. */
  private readonly goneLogs = new Map<string, { identity: string; events: LogEntry[] }>();
  private selectedId: string | undefined;
  private lastDrop: LastDisconnect | undefined;
  /** When this host process started (this computer's clock), to tell a crash from an earlier run. */
  readonly startedAt = Date.now();
  /** Fatal JS errors per app (by `identityOf`), newest last. */
  private readonly crashMap = new Map<string, CrashRecord[]>();
  private readonly crashLog: CrashEvent[] = [];
  private crashSeq = 0;
  private httpExtension: HttpExtension | undefined;
  /** Open after `pair`: development builds on the local network may fetch this code (one use, 10 minutes). */
  private devOffer: DevOffer | undefined;
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

  /**
   * Opens the development offer: for `ms` (default 10 minutes), a development build whose JavaScript comes from
   * this computer may fetch a one-use pairing code at `GET /tapline/offer` and ask its person to connect. Only
   * peers on the local network get it; it closes when its code is used.
   */
  openDevOffer(name: string, ms: number = 10 * 60 * 1000): DevOffer {
    // A millisecond earlier: codes come from the time, and a QR link made in the same call must get its own.
    const offer: DevOffer = { code: createPairCode(this.token, Date.now() - 1), name, until: Date.now() + ms };
    this.devOffer = offer;
    return offer;
  }

  /** Where Metro serves the open offer from (the pair tool writes it), so a claim made through Metro counts. */
  setDevOfferFile(file: string): void {
    if (this.devOffer !== undefined) this.devOffer.file = file;
  }

  /** Who claimed the open offer: here, or through Metro's file. */
  private offerClaimer(offer: DevOffer): string | undefined {
    if (offer.claimedBy !== undefined) return offer.claimedBy;
    if (offer.file === undefined) return undefined;
    try {
      const saved: unknown = JSON.parse(readFileSync(offer.file, "utf8"));
      const by = isRecord(saved) ? saved["claimedBy"] : undefined;
      return typeof by === "string" ? by : undefined;
    } catch {
      return undefined;
    }
  }

  /** The open offer, if any (for tests and the pair tool). */
  currentDevOffer(): DevOffer | undefined {
    const offer = this.devOffer;
    if (offer === undefined) return undefined;
    if (offer.until <= Date.now() || this.usedCodes.has(offer.code)) {
      this.devOffer = undefined;
      return undefined;
    }
    return offer;
  }

  /** `GET /tapline/offer`: the open development offer, to the local network only. */
  private handleDevOffer(req: IncomingMessage, res: ServerResponse): boolean {
    if (new URL(req.url ?? "/", "http://host").pathname !== "/tapline/offer") return false;
    const answer = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") {
      answer(405, { error: "GET only" });
      return true;
    }
    // Through a proxy (Tailscale Serve, a tunnel) the peer isn't on the Wi-Fi, whatever the socket says.
    const forwarded = req.headers["x-forwarded-for"] !== undefined || req.headers["tailscale-user-login"] !== undefined;
    if (forwarded || fromAWebPage(req.headers) || !isLocalNetwork(req.socket.remoteAddress)) {
      answer(403, { error: "local network only" });
      return true;
    }
    const offer = this.currentDevOffer();
    const peer = peerAddress(req.socket.remoteAddress);
    const claimer = offer === undefined ? undefined : this.offerClaimer(offer);
    // The first device to fetch it claims it; for any other the offer isn't there.
    if (offer === undefined || (claimer !== undefined && claimer !== peer)) {
      answer(404, { error: "no offer open: call pair on the computer" });
      return true;
    }
    offer.claimedBy = peer;
    answer(200, { code: offer.code, name: offer.name });
    return true;
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
          if (this.handleDevOffer(req, res)) return;
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

  /**
   * A session's lines whether it is connected or ended (the last few ended ones are kept), and its app and device
   * identity; undefined when nothing is known of it.
   */
  sessionRecord(sessionId: string): { identity: string; events: LogEntry[] } | undefined {
    const live = this.sessionMap.get(sessionId);
    if (live !== undefined) return { identity: identityOf(live.info), events: live.events.map((e) => ({ ...e })) };
    const gone = this.goneLogs.get(sessionId);
    return gone === undefined ? undefined : { identity: gone.identity, events: gone.events.map((e) => ({ ...e })) };
  }

  /** The agent is about to end the app's connection on purpose (a reload): that is no crash. */
  expectEnd(sessionId: string, expected = true): void {
    const session = this.sessionMap.get(sessionId);
    if (session !== undefined) session.expectedEnd = expected;
  }

  /** The number of crash events so far; pass it to `crashEventsAfter` later. */
  crashMark(): number {
    return this.crashSeq;
  }

  /** Crash events after `seq`, oldest first; only those of the app `of` when it is given. */
  crashEventsAfter(seq: number, of?: AppIdentity): CrashEvent[] {
    const key = of !== undefined ? identityOf(of) : undefined;
    return this.crashLog.filter((event) => event.seq > seq && (key === undefined || identityOf(event.of) === key));
  }

  /** The newest crash event of any app, if any is still kept. */
  lastCrashEvent(): CrashEvent | undefined {
    return this.crashLog[this.crashLog.length - 1];
  }

  /**
   * Fatal JS errors of the app `of` (or of every app when it is undefined), newest first. They outlive the
   * app's sessions, so a crash that ended the session can still be read.
   */
  crashes(of?: Pick<SessionInfo, "app" | "device">): CrashRecord[] {
    const lists = of !== undefined ? [this.crashMap.get(identityOf(of)) ?? []] : [...this.crashMap.values()];
    return lists.flat().sort((a, b) => b.ts - a.ts).map((c) => ({ ...c }));
  }

  private recordCrash(session: Session, crash: CrashRecord): void {
    const key = identityOf(session.info);
    const list = this.crashMap.get(key) ?? [];
    // The same crash arrives twice: live, and again from the phone's storage on the next connection.
    // The phone cuts a saved message to fit its storage, so one may be the start of the other.
    const known = list.find((c) => c.ts === crash.ts && sameMessage(c.message, crash.message));
    if (known !== undefined) {
      if (crash.stack !== "" && crash.source === "saved") known.stack = crash.stack;
      if (known.componentStack === undefined && crash.componentStack !== undefined) known.componentStack = crash.componentStack;
      return;
    }
    list.push(crash);
    if (list.length > MAX_CRASHES) list.splice(0, list.length - MAX_CRASHES);
    this.crashMap.set(key, list);
    this.pushCrashEvent(session, { kind: "crash", crash });
  }

  private pushCrashEvent(session: Session, event: { kind: "crash"; crash: CrashRecord } | { kind: "disconnect" }): void {
    this.crashSeq += 1;
    const of: AppIdentity = { app: { ...session.info.app }, device: { ...session.info.device } };
    this.crashLog.push({ ...event, app: session.info.app.name, of, seq: this.crashSeq, at: Date.now() });
    if (this.crashLog.length > 50) this.crashLog.splice(0, this.crashLog.length - 50);
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

    socket.on("close", (code, reason) => {
      clearTimeout(helloTimer);
      // A close with a normal code (1000, 1001, or 1005 for a bare close) is the app ending the connection
      // itself (it unpaired, or was stopped); a crash or a lost network closes abnormally (1006).
      if (session !== undefined && (code === 1000 || code === 1001 || code === 1005)) session.expectedEnd = true;
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
      // The development offer's code pairs only the device that fetched it.
      const offer = this.devOffer;
      if (offer !== undefined && offer.code === pairCode && this.offerClaimer(offer) !== peerAddress(this.remoteOf.get(socket))) {
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
    // `frameAcks`: this host answers each live-viewer frame with `frameAck`, so the app can hold back
    // while frames are still on their way (no pile-up on a slow link).
    const welcome = { type: "welcome", protocol: PROTOCOL_VERSION, session: info.id, frameAcks: true, ...(paired ? { token: this.token } : {}) };
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
      // Acknowledged on arrival, valid or not: the app counts frames in flight.
      this.safely(() => session.socket.send(JSON.stringify({ type: "frameAck", seq: frame.success ? frame.data.seq : null })));
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
      // Back in front: an earlier fatal error no longer explains a later end.
      if (state === "active") session.fatalSeen = false;
      const where = state === "active" ? "came back to the front" : state === "background" ? "went to the background" : `is ${state}`;
      this.pushEntry(session, { level: "info", message: `[tapline] the app ${where}`, ts: at });
      this.safely(() => this.emit("appState", { ...session.info }, state));
      return;
    }
    if (event === "pickerSkipped") {
      // The app's photo picker returned the armed test pictures (`media` with `picker`): counted when used, not when armed.
      const count = typeof data === "object" && data !== null ? (data as { count?: unknown }).count : undefined;
      if (typeof count === "number" && Number.isInteger(count) && count > 0 && count <= 100) {
        this.safely(() => this.emit("pickerSkipped", { ...session.info }, count));
      }
      return;
    }
    if (event === "crash") {
      // A fatal error the app kept on the phone and sends after it connects again.
      const saved = crashEventSchema.safeParse(data);
      if (saved.success) {
        this.recordCrash(session, crashRecordOf(saved.data, "saved"));
        // The phone keeps its copy until told it arrived (also when this host already had it).
        const ts = saved.data.ts;
        if (ts !== undefined) {
          this.safely(() => session.socket.send(JSON.stringify({ type: "request", id: session.nextId++, method: "crashAck", params: { ts } })));
        }
      }
      return;
    }
    if (event !== "log" && event !== "error") return;
    const parsed = logEntrySchema.safeParse(data);
    if (!parsed.success) return;
    const ts = parsed.data.ts ?? Date.now();
    this.pushEntry(session, {
      ...parsed.data,
      level: event === "error" ? "error" : (parsed.data.level ?? "log"),
      ts,
    });
    if (event === "error" && parsed.data.fatal === true) {
      session.fatalSeen = true;
      this.recordCrash(session, crashRecordOf({ ...parsed.data, ts }, "live"));
    }
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
    this.goneLogs.set(session.info.id, { identity: identityOf(session.info), events: session.events.map((e) => ({ ...e })) });
    while (this.goneLogs.size > GONE_LOGS_KEPT) {
      const oldest = this.goneLogs.keys().next().value;
      if (oldest === undefined) break;
      this.goneLogs.delete(oldest);
    }
    this.lastDrop = {
      session: { ...session.info },
      reason,
      at: Date.now(),
      ...(silentForMs !== undefined ? { silentForMs } : {}),
    };
    if (this.selectedId === session.info.id) this.selectedId = undefined;
    // An app that went away while a request was in flight, with no JS error to explain it, may have crashed.
    // Not when the agent asked for it (a reload), the app or host ended the connection on purpose, the app had
    // gone to the background (iOS pauses it), or it merely went silent (that is `not_answering`, not a crash).
    const appState = session.info.appState?.state;
    const orderly =
      session.expectedEnd === true ||
      ORDERLY_REASONS.has(reason) ||
      silentForMs !== undefined ||
      appState === "background" ||
      appState === "inactive";
    // Known gap, left as it is: Fast Refresh and dev-menu reloads close the socket with 1006 in the middle of a
    // call, so a request in flight then is noted as a possible crash. Only `reload` (expectEnd) is told apart.
    if (!orderly && session.fatalSeen !== true && session.pending.size > 0) {
      this.pushCrashEvent(session, { kind: "disconnect" });
    }
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
