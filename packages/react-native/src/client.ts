import { AppState, Platform } from 'react-native';
import { screenshotAvailable } from './actions';
import { keepAwake } from './awake';
import { detectedApp } from './appinfo';
import { deliverSavedCrash } from './crash';
import { emitEvent, setEventSink } from './events';
import { resetMedia } from './media';
import { onRealTouch } from './touches';
import { onFrameAck, setFrameAcks, stopLiveFeed } from './live';
import { forgetLastTree } from './inspect';
import { originalLog, setLogSink } from './logs';
import { methods as defaultMethods, type MethodFn } from './methods';
import { refreshCover } from './native';
import { resetTaplineTextSize } from './locale';
import { resetNetworkCondition } from './network';
import { stopPerf } from './perf';
import { startPlaceEvents } from './place';
import {
  PROTOCOL_VERSION,
  TaplineError,
  isRecord,
  type AppInfo,
  type DeviceInfo,
  type WireError,
} from './types';

export const PING_INTERVAL_MS = 15_000;
export const HOST_SILENCE_MS = 45_000;
export const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 1_000;
/**
 * QUALITY-BAR S4/S5: a host that starts (a new agent session, often long after the app was opened on
 * a dedicated device) is found within about 2 s: a new try one second after each failed one, and a
 * failed try itself takes up to a second on iOS (measured: with a 2 s wait the app was found up to 3 s
 * after the host began listening). A refused connection costs next to nothing; iOS pauses the app in
 * the background, so this only runs while the app is open, and only in builds with Tapline turned on.
 */
const BACKOFF_MAX_MS = 1_000;

/** The slice of the WebSocket API Tapline uses (React Native provides it globally). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

/** WebSocket close code for a token the host refused. */
export const CLOSE_BAD_TOKEN = 4001;
/** WebSocket close code for a pairing code the host refused (invalid, expired or used). */
export const CLOSE_BAD_PAIR_CODE = 4004;

export interface ClientOptions {
  url: string;
  /** The host's token (a paired app, or a direct connection). */
  token?: string;
  /** A one-time code from a pairing link, used instead of `token` until the host answers. */
  pairCode?: string;
  /** Random id of this app install, sent as `device.id`. */
  deviceId?: string;
  app?: AppInfo;
  /** The host accepted `pairCode` and sent its token: remember it for later connections. */
  onPaired?: (token: string) => void;
  /** The host refused the pairing code (4004) or the token during the handshake (4001); the client has stopped. */
  onRejected?: (code: number) => void;
}

export interface ClientDeps {
  WebSocketCtor?: WebSocketCtor;
  methods?: Record<string, MethodFn>;
  device?: DeviceInfo;
  capabilities?: string[];
  /** Receives the one status line per connect/disconnect. */
  log?: (line: string) => void;
  /** Foreground/background changes. Default: React Native's AppState. */
  appState?: AppStateLike;
  /** Keep the screen on while connected. Default: expo-keep-awake when the app has it. */
  keepAwake?: (on: boolean) => void;
}

export interface AppStateLike {
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void } | undefined;
}

/**
 * How long a connection try may take to open before it is dropped for a fresh one: 2 s, and 4 s on
 * every fourth try, so a slow link that needs longer still gets through. iOS repeats an unanswered
 * try after 1 s and 3 s, so with the 1 s wait between tries a host is never left unasked for more
 * than about 2 s.
 */
export function connectTimeoutMs(attempt: number): number {
  return attempt % 4 === 3 ? 4_000 : 2_000;
}

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** attempt);
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  return `ws://${trimmed.replace(/^https?:\/\//i, '')}`;
}

export function collectDeviceInfo(): DeviceInfo {
  const constants: unknown = Platform.constants;
  const info: DeviceInfo = { platform: Platform.OS, osVersion: String(Platform.Version) };
  if (isRecord(constants)) {
    if (typeof constants.osVersion === 'string') info.osVersion = constants.osVersion;
    else if (typeof constants.Release === 'string') info.osVersion = constants.Release;
    if (typeof constants.Model === 'string') info.model = constants.Model;
    else if (typeof constants.model === 'string') info.model = constants.model;
    if (typeof constants.deviceName === 'string') info.name = constants.deviceName;
  }
  return info;
}

export function defaultCapabilities(): string[] {
  const capabilities = ['tree', 'press', 'longPress', 'type', 'scroll', 'toggle', 'openURL', 'back', 'check', 'commands', 'waitFor', 'logs', 'overlay', 'dryRun', 'audit', 'performance', 'uxCheck', 'media', 'place', 'places', 'move'];
  if (screenshotAvailable()) capabilities.push('screenshot', 'feed');
  if (typeof __DEV__ !== 'undefined' && __DEV__) capabilities.push('reload', 'inspect');
  return capabilities;
}

function toWireError(error: unknown): WireError {
  if (error instanceof TaplineError) return error.toWire();
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}

export class TaplineClient {
  private readonly options: ClientOptions;
  private readonly deps: ClientDeps;
  private socket: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Gives up on a connection try that hasn't opened. */
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  /** The current socket has opened. */
  private opened = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private running = false;
  private ready = false;
  private everConnected = false;
  private failureLogged = false;
  private lastHeard = 0;
  private queue: Promise<void> = Promise.resolve();
  private token: string | undefined;
  private pairCode: string | undefined;
  private appStateSubscription: { remove: () => void } | null = null;
  private stopTouchWatch: (() => void) | null = null;
  private stopPlaceWatch: (() => void) | null = null;

  constructor(options: ClientOptions, deps: ClientDeps = {}) {
    this.options = options;
    this.deps = deps;
    this.token = options.token;
    this.pairCode = options.pairCode;
  }

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.watchAppState();
    // A person's finger on the screen: the host tells the agent (the event goes nowhere while disconnected).
    this.stopTouchWatch = onRealTouch((at) => emitEvent('touch', { at }));
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const stopTouchWatch = this.stopTouchWatch;
    this.stopTouchWatch = null;
    if (stopTouchWatch) this.safely(stopTouchWatch);
    const socket = this.socket;
    this.socket = null;
    resetNetworkCondition();
    resetTaplineTextSize();
    resetMedia();
    if (this.ready) this.status('disconnected');
    this.ready = false;
    this.endPlaceWatch();
    setLogSink(null);
    setEventSink(null);
    stopLiveFeed();
    stopPerf();
    this.setAwake(false);
    const subscription = this.appStateSubscription;
    this.appStateSubscription = null;
    if (subscription) this.safely(() => subscription.remove());
    if (socket) {
      detach(socket);
      try {
        socket.close(1000, 'stopped');
      } catch {
        // already closed
      }
    }
  }

  private status(line: string): void {
    const log = this.deps.log ?? originalLog;
    try {
      log(`[tapline] ${line}`);
    } catch {
      // never throw into the app
    }
  }

  private setAwake(on: boolean): void {
    this.safely(() => (this.deps.keepAwake ?? keepAwake)(on));
  }

  private watchAppState(): void {
    if (this.appStateSubscription) return;
    this.safely(() => {
      const source = this.deps.appState ?? (AppState as unknown as AppStateLike);
      const subscription = source.addEventListener('change', (state) => this.safely(() => this.onAppState(state)));
      if (isRecord(subscription) && typeof subscription.remove === 'function') this.appStateSubscription = subscription;
    });
  }

  /** Tells the host when the app goes to the background (iOS then pauses it), and reconnects at once when it's back. */
  private onAppState(state: string): void {
    if (this.ready) this.send({ type: 'event', event: 'appState', data: { state } });
    if (state === 'active' && this.running && !this.ready && this.socket === null) {
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempt = 0;
      this.connect();
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.openTimer = null;
  }

  private connect(): void {
    if (!this.running) return;
    const Ctor = this.deps.WebSocketCtor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (typeof Ctor !== 'function') {
      this.status('no WebSocket available in this environment');
      return;
    }
    let socket: WebSocketLike;
    try {
      socket = new Ctor(normalizeUrl(this.options.url));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.opened = false;
    socket.onopen = () => this.safely(() => this.onOpen(socket));
    socket.onmessage = (event) => this.safely(() => this.onMessage(socket, event.data));
    socket.onerror = () => {
      // onclose follows; nothing to do
    };
    socket.onclose = (event) => this.safely(() => this.onClose(socket, event.code));
    // A host that isn't there may not refuse the connection (a firewall drops it silently): the try
    // then hangs while iOS repeats it at growing intervals, and a host that starts meanwhile is found
    // late (measured: up to 6 s). Give up on a try that hasn't opened and start a fresh one.
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    const attempt = this.attempt;
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.safely(() => {
        if (socket !== this.socket || this.opened) return;
        detach(socket);
        try {
          socket.close();
        } catch {
          // already closed
        }
        this.handleLoss(undefined);
      });
    }, connectTimeoutMs(attempt));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // never throw into the app
    }
  }

  private onOpen(socket: WebSocketLike): void {
    if (socket !== this.socket) return;
    this.opened = true;
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.openTimer = null;
    this.lastHeard = Date.now();
    const device = this.deps.device ?? collectDeviceInfo();
    const deviceId = this.options.deviceId;
    this.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      ...(this.pairCode !== undefined ? { pairCode: this.pairCode } : { token: this.token ?? '' }),
      // The app's own id and build from its config (never Expo Go's); what the app passed wins.
      app: { name: 'App', ...detectedApp(), ...this.options.app },
      device: deviceId === undefined ? device : { ...device, id: deviceId },
      capabilities: this.deps.capabilities ?? defaultCapabilities(),
    });
  }

  private onMessage(socket: WebSocketLike, data: unknown): void {
    if (socket !== this.socket || typeof data !== 'string') return;
    this.lastHeard = Date.now();
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    switch (message.type) {
      case 'welcome':
        setFrameAcks(message.frameAcks === true);
        this.onWelcome(message.token);
        break;
      case 'frameAck':
        onFrameAck();
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      case 'request':
        this.enqueue(message);
        break;
      default:
        break; // pong and unknown types
    }
  }

  private onWelcome(token: unknown): void {
    // A new host session: its agent hasn't seen any list yet, so "changes" start over.
    forgetLastTree();
    if (this.pairCode !== undefined && typeof token === 'string' && token !== '') {
      // Paired: the code was single-use, so later connections use the host's token.
      this.pairCode = undefined;
      this.token = token;
      const onPaired = this.options.onPaired;
      if (onPaired) this.safely(() => onPaired(token));
    }
    this.ready = true;
    this.everConnected = true;
    this.failureLogged = false;
    this.attempt = 0;
    this.status('connected');
    this.setAwake(true);
    setLogSink((event, payload) => this.send({ type: 'event', event, data: payload }));
    setEventSink((event, data) => this.send({ type: 'event', event, data }));
    // The place event (§18.11): the first one now, then one per change.
    this.endPlaceWatch();
    this.stopPlaceWatch = startPlaceEvents();
    // A fatal error the app kept on the phone before it went away, not yet told to this computer.
    void deliverSavedCrash();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.safely(() => this.onPingTick()), PING_INTERVAL_MS);
  }

  private endPlaceWatch(): void {
    const stop = this.stopPlaceWatch;
    this.stopPlaceWatch = null;
    if (stop) this.safely(stop);
  }

  private onPingTick(): void {
    if (Date.now() - this.lastHeard > HOST_SILENCE_MS) {
      // The host stopped answering: drop the socket and reconnect.
      const socket = this.socket;
      if (socket) {
        detach(socket);
        try {
          socket.close(4000, 'host silent');
        } catch {
          // ignore
        }
        this.handleLoss(undefined);
      }
      return;
    }
    this.send({ type: 'ping' });
  }

  private onClose(socket: WebSocketLike, code: number | undefined): void {
    if (socket !== this.socket) return;
    detach(socket);
    if (code === CLOSE_BAD_PAIR_CODE || (code === CLOSE_BAD_TOKEN && !this.ready)) {
      // Retrying a refused code or token can't work: stop and let the owner decide.
      this.socket = null;
      this.stop();
      this.status(code === CLOSE_BAD_PAIR_CODE ? 'the computer refused the pairing code' : 'the computer refused the token');
      const onRejected = this.options.onRejected;
      if (onRejected) this.safely(() => onRejected(code));
      return;
    }
    this.handleLoss(code);
  }

  private handleLoss(code: number | undefined): void {
    this.socket = null;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.endPlaceWatch();
    setLogSink(null);
    setEventSink(null);
    // The phone is never left offline or slow with nobody watching.
    resetNetworkCondition();
    resetTaplineTextSize();
    resetMedia();
    // Nobody can watch while disconnected; the host asks again after it reconnects.
    stopLiveFeed();
    stopPerf();
    this.setAwake(false);
    if (this.ready) {
      this.status(code ? `disconnected (code ${code})` : 'disconnected');
    } else if (!this.failureLogged) {
      this.failureLogged = true;
      this.status(code ? `cannot connect (code ${code}), retrying` : 'cannot reach the host, retrying');
    }
    this.ready = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // a failed send shows up as a close
    }
  }

  /** Requests run one at a time so refs and snapshots never interleave. */
  private enqueue(message: Record<string, unknown>): void {
    this.queue = this.queue.then(() => this.handleRequest(message)).catch(() => undefined);
  }

  private async handleRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (typeof id !== 'number' && typeof id !== 'string') return;
    const respond = (body: Record<string, unknown>): void => this.send({ type: 'response', id, ...body });
    const name = message.method;
    const table = this.deps.methods ?? defaultMethods;
    const method = typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
    if (!method) {
      respond({ ok: false, error: { code: 'unsupported', message: `Unknown method ${String(name)}` } });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TaplineError('timeout', `${String(name)} did not finish in ${REQUEST_TIMEOUT_MS / 1000} s`)),
          REQUEST_TIMEOUT_MS,
        );
      });
      // What UIKit shows over the app (when the app has Tapline's native module), so this request's
      // checks see an alert or the share sheet in front.
      await refreshCover();
      const result = await Promise.race([method(message.params), timeout]);
      respond({ ok: true, result: result === undefined ? {} : result });
    } catch (error) {
      respond({ ok: false, error: toWireError(error) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function detach(socket: WebSocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}
