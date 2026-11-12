/**
 * Network tracking: counts requests in flight (so an agent can wait for loading to finish)
 * and reports failed ones. React Native's fetch is built on XMLHttpRequest, so patching
 * XMLHttpRequest.prototype covers both. Nothing here may ever throw into the app.
 */

export interface NetworkFailure {
  method: string;
  url: string;
  status: number | null;
  error: string | null;
  ms: number;
  at: number;
}

export interface NetworkOptions {
  target?: { XMLHttpRequest?: unknown };
  ignore?: (url: string) => boolean;
}

type AnyFn = (...args: unknown[]) => unknown;
type EventFn = () => void;

interface XhrLike {
  status?: unknown;
  readyState?: unknown;
  addEventListener?: unknown;
  onreadystatechange?: unknown;
}

interface RequestInfo {
  method: string;
  url: string;
  ignored: boolean;
  /** Metro / dev-server traffic: tracked or not, never conditioned. */
  devServer: boolean;
}

interface Installed {
  proto: Record<string, unknown>;
  open: { own: boolean; fn: AnyFn };
  send: { own: boolean; fn: AnyFn };
  abort: { own: boolean; fn: AnyFn | null };
}

/** What Tapline can make the app's requests behave like (`network` app command). */
export type NetworkMode = 'offline' | '3g' | 'lossy' | 'normal';
export const NETWORK_MODES: readonly NetworkMode[] = ['offline', '3g', 'lossy', 'normal'];

const THREE_G_LATENCY_MS = 400;
/** 750 kbit/s in bytes per millisecond. */
const THREE_G_BYTES_PER_MS = 750_000 / 8 / 1000;
const MAX_TRANSFER_MS = 30_000;
const LOSSY_FAIL_SHARE = 0.2;
const LOSSY_FAIL_DELAY_MS: readonly [number, number] = [100, 400];
const LOSSY_SLOW_DELAY_MS: readonly [number, number] = [50, 250];

const MAX_URL_CHARS = 200;
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const DEV_SERVER_SEGMENT = /\/(?:symbolicate|logs|message|status|inspector|hot|open-stack-frame)(?:\/|$)/;

const listeners = new Set<(failure: NetworkFailure) => void>();
const requests = new WeakMap<object, RequestInfo>();
let installed: Installed | null = null;
let customIgnore: ((url: string) => boolean) | null = null;
let pending = 0;
let generation = 0;
let condition: NetworkMode = 'normal';
let random: () => number = Math.random;
/** Requests whose send is delayed (or doomed), so abort() can cancel them. */
const held = new WeakMap<object, { timer: ReturnType<typeof setTimeout>; settle: (() => void) | null }>();

/** scheme://host[:port]/path, query replaced by "?…", no fragment or credentials. */
export function redactUrl(raw: string): string {
  const text = typeof raw === 'string' ? raw : String(raw);
  const match = ABSOLUTE_URL.exec(text);
  if (!match) return text.slice(0, MAX_URL_CHARS);
  const scheme = match[1] ?? '';
  const authority = match[2] ?? '';
  const path = match[3] ?? '';
  const query = match[4];
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const redactedQuery = query !== undefined && query.length > 1 ? '?…' : (query ?? '');
  return `${scheme}${host}${path}${redactedQuery}`.slice(0, MAX_URL_CHARS);
}

function defaultIgnore(url: string): boolean {
  const withoutAuthority = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const path = withoutAuthority.split(/[?#]/, 1)[0] ?? '';
  if (DEV_SERVER_SEGMENT.test(path)) return true;
  const noFragment = url.split('#', 1)[0] ?? url;
  return noFragment.endsWith('.bundle') || noFragment.includes('.bundle?');
}

function isIgnored(url: string): boolean {
  try {
    return (customIgnore ?? defaultIgnore)(url);
  } catch {
    return false;
  }
}

function notify(failure: NetworkFailure): void {
  for (const listener of [...listeners]) {
    try {
      listener(failure);
    } catch {
      // a broken listener must not affect others or the app
    }
  }
}

function isFn(value: unknown): value is AnyFn {
  return typeof value === 'function';
}

function track(xhr: XhrLike & object): (() => void) | null {
  const info = requests.get(xhr);
  if (!info || info.ignored) return null;

  const startedAt = Date.now();
  const forGeneration = generation;
  let done = false;
  let aborted = false;
  let timedOut = false;
  pending += 1;

  /** Stop counting this request; returns false if it was already finished. */
  const settle = (): boolean => {
    if (done) return false;
    done = true;
    if (forGeneration === generation && pending > 0) pending -= 1;
    return true;
  };

  const end = (): void => {
    if (!settle()) return;
    try {
      if (aborted) return;
      const status = typeof xhr.status === 'number' ? xhr.status : 0;
      let error: string | null = null;
      let reported: number | null = null;
      if (timedOut) error = 'timeout';
      else if (status === 0) error = 'network error';
      else if (status >= 400) reported = status;
      else return;
      const at = Date.now();
      notify({ method: info.method, url: info.url, status: reported, error, ms: Math.max(0, at - startedAt), at });
    } catch {
      // never throw into the app
    }
  };

  if (isFn(xhr.addEventListener)) {
    const add = xhr.addEventListener as (type: string, listener: EventFn) => void;
    add.call(xhr, 'abort', () => {
      aborted = true;
    });
    add.call(xhr, 'timeout', () => {
      timedOut = true;
    });
    add.call(xhr, 'loadend', end);
  } else {
    const previous = xhr.onreadystatechange;
    xhr.onreadystatechange = function wrapped(this: unknown, ...args: unknown[]): unknown {
      try {
        if (xhr.readyState === 4) end();
      } catch {
        // ignore
      }
      return isFn(previous) ? previous.apply(this, args) : undefined;
    };
  }
  return settle;
}

function patchedOpen(original: AnyFn): AnyFn {
  return function open(this: unknown, ...args: unknown[]): unknown {
    try {
      if (typeof this === 'object' && this !== null) {
        const rawUrl = String(args[1]);
        requests.set(this, {
          method: String(args[0]).toUpperCase(),
          url: redactUrl(rawUrl),
          ignored: isIgnored(rawUrl),
          devServer: defaultIgnore(rawUrl),
        });
      }
    } catch {
      // never throw into the app
    }
    return original.apply(this, args);
  };
}

function patchedSend(original: AnyFn): AnyFn {
  return function send(this: unknown, ...args: unknown[]): unknown {
    let settle: (() => void) | null = null;
    try {
      if (typeof this === 'object' && this !== null) settle = track(this);
    } catch {
      settle = null;
    }
    try {
      if (condition !== 'normal' && typeof this === 'object' && this !== null) {
        const info = requests.get(this);
        if (info && !info.ignored && !info.devServer && applyCondition(this, condition, original, args, settle)) {
          return undefined;
        }
      }
    } catch {
      // conditioning must never break a request: fall through to a plain send
    }
    try {
      return original.apply(this, args);
    } catch (error) {
      // the request never started: it can't end, so stop counting it
      try {
        settle?.();
      } catch {
        // ignore
      }
      throw error;
    }
  };
}

function patchedAbort(original: AnyFn): AnyFn {
  return function abort(this: unknown, ...args: unknown[]): unknown {
    try {
      if (typeof this === 'object' && this !== null) {
        const entry = held.get(this);
        if (entry) {
          clearTimeout(entry.timer);
          held.delete(this);
          entry.settle?.();
        }
      }
    } catch {
      // never throw into the app
    }
    return original.apply(this, args);
  };
}

function between(range: readonly [number, number]): number {
  return range[0] + random() * (range[1] - range[0]);
}

function assign(target: object, key: string, value: unknown): void {
  try {
    (target as Record<string, unknown>)[key] = value;
  } catch {
    try {
      Object.defineProperty(target, key, { value, configurable: true, writable: true });
    } catch {
      // ignore
    }
  }
}

function makeEvent(type: string): unknown {
  const Ctor = (globalThis as { Event?: unknown }).Event;
  if (isFn(Ctor)) {
    try {
      return new (Ctor as unknown as new (type: string) => unknown)(type);
    } catch {
      // fall back to a plain object
    }
  }
  return { type };
}

/** Fails a request the way React Native does with no connection: status 0, `error`, then `loadend`. */
function failRequest(xhr: object): void {
  try {
    assign(xhr, 'readyState', 4);
    assign(xhr, 'status', 0);
    const target = xhr as { dispatchEvent?: unknown; onreadystatechange?: unknown };
    if (isFn(target.dispatchEvent)) {
      const dispatch = target.dispatchEvent as (event: unknown) => unknown;
      for (const type of ['readystatechange', 'error', 'loadend']) {
        try {
          dispatch.call(xhr, makeEvent(type));
        } catch {
          // a handler's error stays the app's
        }
      }
    } else if (isFn(target.onreadystatechange)) {
      (target.onreadystatechange as AnyFn).call(xhr);
    }
  } catch {
    // never throw into the app
  }
}

function sizeOf(xhr: object): number {
  const x = xhr as { getResponseHeader?: unknown; responseText?: unknown; response?: unknown };
  try {
    if (isFn(x.getResponseHeader)) {
      const length = Number((x.getResponseHeader as (name: string) => unknown).call(xhr, 'content-length'));
      if (Number.isFinite(length) && length > 0) return length;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof x.responseText === 'string') return x.responseText.length;
  } catch {
    // responseText throws for non-text response types
  }
  const response = x.response;
  if (typeof response === 'object' && response !== null) {
    const { byteLength, size } = response as { byteLength?: unknown; size?: unknown };
    if (typeof byteLength === 'number') return byteLength;
    if (typeof size === 'number') return size;
  }
  return 0;
}

function bodyBytes(body: unknown): number {
  if (typeof body === 'string') return body.length;
  if (typeof body === 'object' && body !== null) {
    const { byteLength, size } = body as { byteLength?: unknown; size?: unknown };
    if (typeof byteLength === 'number') return byteLength;
    if (typeof size === 'number') return size;
  }
  return 0;
}

/** Holds back the events that deliver the finished response until the transfer would have taken. */
function holdResponse(xhr: object): void {
  const target = xhr as { dispatchEvent?: unknown };
  if (!isFn(target.dispatchEvent)) return;
  const dispatch = target.dispatchEvent as (event: unknown) => unknown;
  let queue: unknown[] | null = null;
  let released = false;
  assign(xhr, 'dispatchEvent', function dispatchEvent(this: unknown, event: unknown): unknown {
    if (released) return dispatch.call(xhr, event);
    if (queue) {
      queue.push(event);
      return true;
    }
    if ((xhr as { readyState?: unknown }).readyState === 4) {
      const delay = Math.min(MAX_TRANSFER_MS, Math.ceil(sizeOf(xhr) / THREE_G_BYTES_PER_MS));
      if (delay > 0) {
        const events: unknown[] = [event];
        queue = events;
        setTimeout(() => {
          queue = null;
          released = true;
          for (const queued of events) {
            try {
              dispatch.call(xhr, queued);
            } catch {
              // a handler's error stays the app's
            }
          }
        }, delay);
        return true;
      }
      released = true;
    }
    return dispatch.call(xhr, event);
  });
}

/** Returns true when the condition took over the request (the real send happens later, or never). */
function applyCondition(
  xhr: object,
  mode: NetworkMode,
  original: AnyFn,
  args: unknown[],
  settle: (() => void) | null,
): boolean {
  const realSend = (): void => {
    held.delete(xhr);
    if (mode === '3g') holdResponse(xhr);
    try {
      original.apply(xhr, args);
    } catch {
      settle?.();
      failRequest(xhr);
    }
  };
  const fail = (): void => {
    held.delete(xhr);
    failRequest(xhr);
  };
  let timer: ReturnType<typeof setTimeout>;
  if (mode === 'offline') {
    timer = setTimeout(fail, 0);
  } else if (mode === '3g') {
    const upload = bodyBytes(args[0]) / THREE_G_BYTES_PER_MS;
    timer = setTimeout(realSend, Math.min(MAX_TRANSFER_MS, THREE_G_LATENCY_MS + upload));
  } else if (random() < LOSSY_FAIL_SHARE) {
    timer = setTimeout(fail, between(LOSSY_FAIL_DELAY_MS));
  } else {
    timer = setTimeout(realSend, between(LOSSY_SLOW_DELAY_MS));
  }
  held.set(xhr, { timer, settle });
  return true;
}

/** The mode the app's requests are in now. */
export function networkCondition(): NetworkMode {
  return condition;
}

/** Puts the app's requests into a mode; `normal` restores them. Requests already sent are not touched. */
export function setNetworkCondition(mode: NetworkMode): void {
  if (!NETWORK_MODES.includes(mode)) throw new Error(`mode must be one of ${NETWORK_MODES.join(', ')}`);
  if (mode !== 'normal' && !installed) {
    throw new Error('network conditions need Tapline running in the app (the request patch is not installed)');
  }
  condition = mode;
}

/** Back to normal; safe to call any time (host gone, Tapline stopped). */
export function resetNetworkCondition(): void {
  condition = 'normal';
}

/** A seeded random source for `lossy` (tests); `null` goes back to Math.random. */
export function seedNetworkRandom(seed: number | null): void {
  if (seed === null) {
    random = Math.random;
    return;
  }
  let state = seed >>> 0;
  random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function installNetworkTracking(options: NetworkOptions = {}): void {
  if (installed) return;
  try {
    const target: { XMLHttpRequest?: unknown } = options.target ?? (globalThis as { XMLHttpRequest?: unknown });
    const ctor = target.XMLHttpRequest;
    if (!isFn(ctor)) return;
    const proto = (ctor as { prototype?: unknown }).prototype;
    if (typeof proto !== 'object' || proto === null) return;
    const record = proto as Record<string, unknown>;
    const open = record.open;
    const send = record.send;
    const abort = record.abort;
    if (!isFn(open) || !isFn(send)) return;

    installed = {
      proto: record,
      open: { own: Object.prototype.hasOwnProperty.call(record, 'open'), fn: open },
      send: { own: Object.prototype.hasOwnProperty.call(record, 'send'), fn: send },
      abort: { own: Object.prototype.hasOwnProperty.call(record, 'abort'), fn: isFn(abort) ? abort : null },
    };
    customIgnore = options.ignore ?? null;
    record.open = patchedOpen(open);
    record.send = patchedSend(send);
    if (isFn(abort)) record.abort = patchedAbort(abort);
  } catch {
    // never throw into the app
  }
}

export function uninstallNetworkTracking(): void {
  const current = installed;
  installed = null;
  customIgnore = null;
  pending = 0;
  generation += 1;
  condition = 'normal';
  if (!current) return;
  try {
    if (current.open.own) current.proto.open = current.open.fn;
    else delete current.proto.open;
    if (current.send.own) current.proto.send = current.send.fn;
    else delete current.proto.send;
    if (current.abort.fn) {
      if (current.abort.own) current.proto.abort = current.abort.fn;
      else delete current.proto.abort;
    }
  } catch {
    // ignore
  }
}

/** Requests that have been sent and not yet finished (dev-server traffic excluded). */
export function inFlight(): number {
  return pending;
}

/** Be told about every failed request. Returns the unsubscribe function. */
export function onNetworkFailure(listener: (failure: NetworkFailure) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
