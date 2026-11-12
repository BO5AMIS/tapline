/**
 * Network tracking: counts requests in flight (so an agent can wait for loading to finish)
 * and reports failed ones. React Native's fetch is built on XMLHttpRequest, but Expo SDK 58's
 * expo/fetch is native, so both XMLHttpRequest.prototype and the global fetch are wrapped (a
 * request is counted once). Nothing here may ever throw into the app.
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
const held = new WeakMap<object, { timer: ReturnType<typeof setTimeout>; settle: (() => void) | null; cancel?: () => void }>();
/** Finished 3g responses whose completion events are still held back; `cancel` drops them and says if any were held. */
const responseHolds = new WeakMap<object, { cancel: () => boolean }>();
/** Each response hold still open, as the function that lets it finish now: uninstalling releases them all. */
const openHolds = new Set<() => void>();
/** Each request a condition holds before its send, as the function that sends it now: uninstalling sends them all. */
const heldSends = new Set<() => void>();

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
          // A request that a wrapped fetch opens is counted and conditioned by the fetch wrapper, not twice.
          ignored: insideFetch > 0 || isIgnored(rawUrl),
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
          // never really sent: cancel it here and end it the way React Native does on abort
          clearTimeout(entry.timer);
          held.delete(this);
          if (entry.cancel) heldSends.delete(entry.cancel);
          entry.settle?.();
          abortHeld(this, original, args);
          return undefined;
        }
        const hold = responseHolds.get(this);
        if (hold?.cancel()) {
          // the answer was complete but held back: the app cancelled, so it gets abort and loadend now
          try {
            original.apply(this, args);
          } catch {
            // the request is over either way
          }
          dispatchNow(this, ['abort', 'loadend']);
          return undefined;
        }
      }
    } catch {
      // never throw into the app
    }
    return original.apply(this, args);
  };
}

/**
 * Ends a request that was held (never really sent) as React Native ends an aborted one: readyState 4 and status 0,
 * then readystatechange, abort and loadend, at once; then the XHR's own abort, which resets it to UNSENT so the app
 * can open it again (Codex review of 1.4.0: before, a reused XHR threw "Cannot open, already sending").
 */
function abortHeld(xhr: object, original: AnyFn, args: unknown[]): void {
  // React Native's XHR (it has `_sent`) ends an aborted request itself: marked as sent, its abort fires
  // readystatechange, abort and loadend through its own event path and resets to UNSENT.
  if ('_sent' in xhr) {
    assign(xhr, '_sent', true);
    try {
      original.apply(xhr, args);
      return;
    } catch {
      // fall back to ending it here
    }
  }
  assign(xhr, 'readyState', 4);
  assign(xhr, 'status', 0);
  dispatchNow(xhr, ['readystatechange', 'abort', 'loadend']);
  try {
    // readyState is DONE now, so React Native's abort sends no second set of events; it only resets.
    original.apply(xhr, args);
  } catch {
    // the request is over either way
  }
}

function dispatchNow(xhr: object, types: readonly string[]): void {
  try {
    const target = xhr as { dispatchEvent?: unknown; onreadystatechange?: unknown };
    if (isFn(target.dispatchEvent)) {
      const dispatch = target.dispatchEvent as (event: unknown) => unknown;
      for (const type of types) {
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

function eventType(event: unknown): string {
  const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
  return typeof type === 'string' ? type : '';
}

/**
 * Holds back the events that deliver the finished response (load, loadend, the final readystatechange)
 * until the transfer would have taken. abort, error and timeout are never held: they drop the held
 * completion at once.
 */
function holdResponse(xhr: object): void {
  // React Native's own XMLHttpRequest finishes through __didCompleteResponse and fires its events through an inner
  // path, not dispatchEvent (0.8x), so the transfer time is held there: the completion comes that much later. An
  // abort meanwhile ends the request as usual, and the late completion finds no request to finish (Codex review).
  // React Native sends every completion to every XHR that listens, so one for another request passes straight
  // through and leaves this hold in place; an abort removes the hold and its timer, so a reused XHR isn't held.
  const native = xhr as { __didCompleteResponse?: unknown; _requestId?: unknown };
  if (isFn(native.__didCompleteResponse)) {
    const complete = native.__didCompleteResponse as (...args: unknown[]) => unknown;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let waiting: unknown[] | null = null;
    const restore = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      waiting = null;
      assign(xhr, '__didCompleteResponse', complete);
      responseHolds.delete(xhr);
      openHolds.delete(release);
    };
    // Tapline stopping: the method goes back, and a completion it was holding is delivered now.
    const release = (): void => {
      const args = waiting;
      restore();
      if (!args) return;
      try {
        complete.apply(xhr, args);
      } catch {
        // a handler's error stays the app's
      }
    };
    openHolds.add(release);
    // false: nothing was dropped, so React Native's own abort ends the request and fires its events
    responseHolds.set(xhr, {
      cancel: () => {
        restore();
        return false;
      },
    });
    assign(xhr, '__didCompleteResponse', function __didCompleteResponse(this: unknown, ...args: unknown[]): unknown {
      if (args[0] !== native._requestId) return complete.apply(xhr, args);
      if (timer !== null) return undefined; // already waiting out this request's transfer
      const error = args[1];
      const delay = typeof error === 'string' && error !== '' ? 0 : Math.min(MAX_TRANSFER_MS, Math.ceil(sizeOf(xhr) / THREE_G_BYTES_PER_MS));
      if (delay <= 0) {
        restore();
        return complete.apply(xhr, args);
      }
      waiting = args;
      timer = setTimeout(release, delay);
      return undefined;
    });
    return;
  }
  const target = xhr as { dispatchEvent?: unknown };
  if (!isFn(target.dispatchEvent)) return;
  const dispatch = target.dispatchEvent as (event: unknown) => unknown;
  let queue: unknown[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let released = false;
  const drop = (): unknown[] => {
    const dropped = queue ?? [];
    queue = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    released = true;
    responseHolds.delete(xhr);
    openHolds.delete(release);
    return dropped;
  };
  const release = (): void => {
    for (const queued of drop()) {
      try {
        dispatch.call(xhr, queued);
      } catch {
        // a handler's error stays the app's
      }
    }
  };
  openHolds.add(release);
  responseHolds.set(xhr, { cancel: () => drop().length > 0 });
  assign(xhr, 'dispatchEvent', function dispatchEvent(this: unknown, event: unknown): unknown {
    if (released) return dispatch.call(xhr, event);
    const type = eventType(event);
    if (type === 'abort' || type === 'error' || type === 'timeout') {
      // the app's cancel, or a failure: not part of the completion, so nothing waits. A held
      // readystatechange still goes out first; the held load and loadend are dropped.
      for (const queued of drop()) {
        if (eventType(queued) !== 'readystatechange') continue;
        try {
          dispatch.call(xhr, queued);
        } catch {
          // a handler's error stays the app's
        }
      }
      return dispatch.call(xhr, event);
    }
    const completion =
      type === 'load' ||
      type === 'loadend' ||
      (type === 'readystatechange' && (xhr as { readyState?: unknown }).readyState === 4);
    if (!completion) return dispatch.call(xhr, event);
    if (queue) {
      queue.push(event);
      return true;
    }
    const delay = Math.min(MAX_TRANSFER_MS, Math.ceil(sizeOf(xhr) / THREE_G_BYTES_PER_MS));
    if (delay > 0) {
      const events: unknown[] = [event];
      queue = events;
      timer = setTimeout(release, delay);
      return true;
    }
    released = true;
    responseHolds.delete(xhr);
    openHolds.delete(release);
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
  const forGeneration = generation;
  const send = (hold: boolean): void => {
    held.delete(xhr);
    heldSends.delete(sendNow);
    // a timer from an earlier install never puts a hold on the request: nothing would take it off again
    if (hold && mode === '3g' && installed && forGeneration === generation) holdResponse(xhr);
    try {
      original.apply(xhr, args);
    } catch {
      settle?.();
      failRequest(xhr);
    }
  };
  const realSend = (): void => send(true);
  // Tapline stopping: the request goes out now, as it would with no condition
  const sendNow = (): void => {
    clearTimeout(timer);
    send(false);
  };
  const fail = (): void => {
    held.delete(xhr);
    heldSends.delete(sendNow);
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
  held.set(xhr, { timer, settle, cancel: sendNow });
  heldSends.add(sendNow);
  return true;
}

// ---- fetch ----------------------------------------------------------------------
// Expo SDK 58 replaces the global fetch with expo/fetch, which doesn't go through XMLHttpRequest. So the global fetch
// is wrapped too, whatever it is, and wrapped again when the app replaces it after Tapline started.

const FETCH_MARK = Symbol.for('tapline.fetch');
/**
 * On the init a counting wrapper passes on: the request is already counted and conditioned. Another Tapline wrapper
 * further in (an app's interceptor in between, maybe after an await) passes it straight through. Spreads keep it.
 */
const FETCH_OWNED = Symbol.for('tapline.fetch.owned');

function isOwned(init: unknown): boolean {
  return typeof init === 'object' && init !== null && (init as Record<symbol, unknown>)[FETCH_OWNED] === true;
}

/** The fetch options (RequestInit), read by property access: an init may carry them inherited or non-enumerable. */
const REQUEST_INIT_KEYS = [
  'method', 'headers', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity',
  'keepalive', 'signal', 'priority', 'window', 'duplex',
] as const;

function ownedInit(init: unknown): Record<string | symbol, unknown> {
  const copy: Record<string | symbol, unknown> = {};
  if (typeof init === 'object' && init !== null) {
    Object.assign(copy, init);
    const source = init as Record<string, unknown>;
    for (const key of REQUEST_INIT_KEYS) {
      if (!(key in copy) && key in source) copy[key] = source[key];
    }
  }
  copy[FETCH_OWNED] = true;
  return copy;
}
/** While a wrapped fetch calls the app's own fetch: XHRs opened in that moment belong to that fetch. */
let insideFetch = 0;
let fetchInstalled: { target: Record<string, unknown>; original: AnyFn } | null = null;
/**
 * The one fetch wrapper that counts and conditions requests: the newest. An app's wrapper around an older one (it
 * may call it after an await, so `insideFetch` can't tell) and one left after uninstall pass straight through.
 */
let activeFetchWrapper: AnyFn | null = null;
/** Each wrapper's own fetch, so the one that is active again can be undone at uninstall. */
const wrapperOriginals = new WeakMap<AnyFn, AnyFn>();
/** Where the global fetch lives: the install target (globalThis in an app). */
let fetchTarget: Record<string, unknown> | null = null;

interface SignalLike {
  aborted?: unknown;
  reason?: unknown;
  addEventListener?: unknown;
  removeEventListener?: unknown;
}

/** The request's abort signal: init.signal, else the Request's own. */
function signalOf(input: unknown, init: unknown): SignalLike | null {
  const fromInit = typeof init === 'object' && init !== null ? (init as { signal?: unknown }).signal : undefined;
  const fromInput = typeof input === 'object' && input !== null ? (input as { signal?: unknown }).signal : undefined;
  const signal = fromInit ?? fromInput;
  return typeof signal === 'object' && signal !== null ? (signal as SignalLike) : null;
}

/** What an aborted fetch rejects with: the signal's reason, else an AbortError. */
function abortError(signal: SignalLike): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Waits `ms`, or rejects at once when the request is aborted (also when it already was): a held request never
 * outlives its cancel, and a response held back is not delivered after it (Codex review of 1.4.0).
 */
/** A fetch's condition waits still running, as the function that ends each now: uninstalling ends them all. */
const fetchWaits = new Set<() => void>();

function wait(ms: number, signal: SignalLike | null = null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal !== null && signal.aborted === true) {
      reject(abortError(signal));
      return;
    }
    let onAbort: (() => void) | null = null;
    const finish = (): void => {
      clearTimeout(timer);
      fetchWaits.delete(finish);
      if (onAbort !== null && signal !== null && isFn(signal.removeEventListener)) (signal.removeEventListener as AnyFn).call(signal, 'abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    fetchWaits.add(finish);
    if (signal !== null && isFn(signal.addEventListener)) {
      onAbort = () => {
        clearTimeout(timer);
        fetchWaits.delete(finish);
        reject(abortError(signal));
      };
      (signal.addEventListener as AnyFn).call(signal, 'abort', onAbort);
    }
  });
}

function fetchUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const record = input as { url?: unknown; href?: unknown };
    if (typeof record.url === 'string') return record.url;
    if (typeof record.href === 'string') return record.href;
  }
  return String(input);
}

function fetchMethod(input: unknown, init: unknown): string {
  const fromInit = typeof init === 'object' && init !== null ? (init as { method?: unknown }).method : undefined;
  if (typeof fromInit === 'string') return fromInit.toUpperCase();
  const fromInput = typeof input === 'object' && input !== null ? (input as { method?: unknown }).method : undefined;
  return typeof fromInput === 'string' ? fromInput.toUpperCase() : 'GET';
}

function responseStatus(response: unknown): number | null {
  const status = typeof response === 'object' && response !== null ? (response as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : null;
}

function responseLength(response: unknown): number {
  try {
    const headers = typeof response === 'object' && response !== null ? (response as { headers?: unknown }).headers : undefined;
    const get = typeof headers === 'object' && headers !== null ? (headers as { get?: unknown }).get : undefined;
    const raw = isFn(get) ? get.call(headers, 'content-length') : null;
    const n = typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function wrapFetch(original: AnyFn): AnyFn {
  const wrapped = async function fetch(this: unknown, input: unknown, init?: unknown): Promise<unknown> {
    let rawUrl = '';
    try {
      rawUrl = fetchUrl(input);
    } catch {
      rawUrl = '';
    }
    const call = (forward: unknown = init): unknown => {
      insideFetch += 1;
      try {
        return original.call(this, input, forward);
      } finally {
        insideFetch -= 1;
      }
    };
    // The global fetch may be an earlier wrapper again; the wrapper that is global then counts. Called from inside
    // another Tapline-wrapped fetch (an app's wrapper in between), or not the active wrapper: it passes through.
    followGlobalWrapper();
    if (isOwned(init) || wrapped !== activeFetchWrapper || insideFetch > 0 || rawUrl === '' || isIgnored(rawUrl)) return call();
    const devServer = defaultIgnore(rawUrl);
    const signal = signalOf(input, init);
    const method = fetchMethod(input, init);
    const url = redactUrl(rawUrl);
    const startedAt = Date.now();
    const forGeneration = generation;
    pending += 1;
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = true;
      if (forGeneration === generation && pending > 0) pending -= 1;
    };
    const failed = (status: number | null, error: string | null): void => {
      const at = Date.now();
      notify({ method, url, status, error, ms: Math.max(0, at - startedAt), at });
    };
    // Tapline stopped since the request started: no more delays or made-up failures, it goes out as normal
    const live = (): boolean => forGeneration === generation;
    try {
      const mode = devServer ? 'normal' : condition;
      if (mode === 'offline' || (mode === 'lossy' && random() < LOSSY_FAIL_SHARE)) {
        await wait(mode === 'offline' ? 0 : between(LOSSY_FAIL_DELAY_MS), signal);
        if (live()) {
          failed(null, 'network error');
          throw new TypeError('Network request failed');
        }
      } else if (mode === '3g') {
        const body = typeof init === 'object' && init !== null ? (init as { body?: unknown }).body : undefined;
        await wait(Math.min(MAX_TRANSFER_MS, THREE_G_LATENCY_MS + bodyBytes(body) / THREE_G_BYTES_PER_MS), signal);
      } else if (mode === 'lossy') {
        await wait(between(LOSSY_SLOW_DELAY_MS), signal);
      }
      let response: unknown;
      try {
        response = await call(ownedInit(init));
      } catch (error) {
        if (!isAbort(error)) failed(null, 'network error');
        throw error;
      }
      if (mode === '3g' && live()) await wait(Math.min(MAX_TRANSFER_MS, responseLength(response) / THREE_G_BYTES_PER_MS), signal);
      const status = responseStatus(response);
      if (status !== null && status >= 400) failed(status, null);
      return response;
    } finally {
      settle();
    }
  };
  (wrapped as unknown as Record<symbol, boolean>)[FETCH_MARK] = true;
  return wrapped as AnyFn;
}

function isFetchWrapper(fn: unknown): fn is AnyFn {
  return isFn(fn) && (fn as unknown as Record<symbol, unknown>)[FETCH_MARK] === true;
}

/** The app put an earlier wrapper back as the global fetch (an interceptor cleaning up): that one counts again. */
function reactivate(target: Record<string, unknown>, wrapper: AnyFn): void {
  const original = wrapperOriginals.get(wrapper);
  if (wrapper === activeFetchWrapper || original === undefined) return;
  activeFetchWrapper = wrapper;
  fetchInstalled = { target, original };
}

/** At each fetch: when the global fetch is a Tapline wrapper again, it is the active one. Wraps nothing new. */
function followGlobalWrapper(): void {
  if (!installed || fetchTarget === null) return;
  try {
    const current = fetchTarget.fetch;
    if (isFetchWrapper(current)) reactivate(fetchTarget, current);
  } catch {
    // never throw into the app
  }
}

/**
 * Wraps the app's global fetch, once per function: a fetch replaced after Tapline started (Expo installs its own
 * lazily) is wrapped when this runs next. Called on install, on each condition change and whenever requests are
 * counted. Never throws into the app.
 */
export function ensureFetchWrapped(given?: Record<string, unknown>): void {
  if (!installed) return;
  const target = given ?? fetchTarget;
  if (target === null) return;
  try {
    const current = target.fetch;
    if (!isFn(current)) return;
    if (isFetchWrapper(current)) {
      reactivate(target, current);
      return;
    }
    const wrapper = wrapFetch(current);
    wrapperOriginals.set(wrapper, current);
    target.fetch = wrapper;
    activeFetchWrapper = wrapper;
    fetchInstalled = { target, original: current };
  } catch {
    // never throw into the app
  }
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
  ensureFetchWrapped();
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
  if (!installed) return;
  fetchTarget = (options.target ?? globalThis) as unknown as Record<string, unknown>;
  ensureFetchWrapped();
}

export function uninstallNetworkTracking(): void {
  const current = installed;
  installed = null;
  customIgnore = null;
  pending = 0;
  generation += 1;
  condition = 'normal';
  // Held responses finish now and their wrappers come off: once the patched abort is gone, nothing else would clean
  // them up, and a reused XHR would stay held (Codex review of 1.4.0).
  for (const release of [...heldSends, ...openHolds, ...fetchWaits]) {
    try {
      release();
    } catch {
      // ignore
    }
  }
  heldSends.clear();
  openHolds.clear();
  fetchWaits.clear();
  activeFetchWrapper = null;
  const wrappedFetch = fetchInstalled;
  fetchInstalled = null;
  fetchTarget = null;
  try {
    // Put the app's fetch back, unless the app replaced it again since: the own fetch of whichever wrapper is global
    // now (an interceptor may have put an earlier one back since the last fetch).
    const now = wrappedFetch?.target.fetch;
    if (wrappedFetch && isFetchWrapper(now)) wrappedFetch.target.fetch = wrapperOriginals.get(now) ?? wrappedFetch.original;
  } catch {
    // ignore
  }
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
  ensureFetchWrapped();
  return pending;
}

/** Be told about every failed request. Returns the unsubscribe function. */
export function onNetworkFailure(listener: (failure: NetworkFailure) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
