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
}

interface Installed {
  proto: Record<string, unknown>;
  open: { own: boolean; fn: AnyFn };
  send: { own: boolean; fn: AnyFn };
}

const MAX_URL_CHARS = 200;
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const DEV_SERVER_SEGMENT = /\/(?:symbolicate|logs|message|status|inspector|hot|open-stack-frame)(?:\/|$)/;

const listeners = new Set<(failure: NetworkFailure) => void>();
const requests = new WeakMap<object, RequestInfo>();
let installed: Installed | null = null;
let customIgnore: ((url: string) => boolean) | null = null;
let pending = 0;
let generation = 0;

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
    if (!isFn(open) || !isFn(send)) return;

    installed = {
      proto: record,
      open: { own: Object.prototype.hasOwnProperty.call(record, 'open'), fn: open },
      send: { own: Object.prototype.hasOwnProperty.call(record, 'send'), fn: send },
    };
    customIgnore = options.ignore ?? null;
    record.open = patchedOpen(open);
    record.send = patchedSend(send);
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
  if (!current) return;
  try {
    if (current.open.own) current.proto.open = current.open.fn;
    else delete current.proto.open;
    if (current.send.own) current.proto.send = current.send.fn;
    else delete current.proto.send;
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
