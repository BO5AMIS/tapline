import {
  inFlight,
  installNetworkTracking,
  onNetworkFailure,
  redactUrl,
  uninstallNetworkTracking,
  type NetworkFailure,
} from '../src/network';

type Listener = () => void;

class FakeXhr {
  status = 0;
  readyState = 0;
  opened: unknown[][] = [];
  sent: unknown[][] = [];
  private listeners = new Map<string, Listener[]>();

  open(...args: unknown[]): void {
    this.opened.push(args);
  }

  send(...args: unknown[]): void {
    this.sent.push(args);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  finish(status: number): void {
    this.status = status;
    this.readyState = 4;
    this.fire('loadend');
  }
}

class NoEventsXhr {
  status = 0;
  readyState = 0;
  onreadystatechange: (() => void) | null = null;
  open(..._args: unknown[]): void {}
  send(..._args: unknown[]): void {}
}

const originalOpen = FakeXhr.prototype.open;
const originalSend = FakeXhr.prototype.send;

function firstOf<T>(list: T[]): T {
  const item = list[0];
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

function request(method: string, url: string): FakeXhr {
  const xhr = new FakeXhr();
  xhr.open(method, url, true);
  xhr.send();
  return xhr;
}

describe('network tracking', () => {
  let failures: NetworkFailure[];
  let off: () => void;

  beforeEach(() => {
    failures = [];
    off = onNetworkFailure((failure) => failures.push(failure));
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
  });

  afterEach(() => {
    off();
    uninstallNetworkTracking();
  });

  it('counts requests in flight: 0 -> 2 -> 0', () => {
    expect(inFlight()).toBe(0);
    const a = request('GET', 'https://api.example.com/a');
    expect(inFlight()).toBe(1);
    const b = request('POST', 'https://api.example.com/b');
    expect(inFlight()).toBe(2);
    a.finish(200);
    expect(inFlight()).toBe(1);
    b.finish(201);
    expect(inFlight()).toBe(0);
    expect(failures).toEqual([]);
  });

  it('decrements exactly once even if loadend fires twice', () => {
    const a = request('GET', 'https://api.example.com/a');
    const b = request('GET', 'https://api.example.com/b');
    a.finish(200);
    a.fire('loadend');
    expect(inFlight()).toBe(1);
    b.finish(200);
    expect(inFlight()).toBe(0);
  });

  it('still passes everything through to the original methods', () => {
    const xhr = new FakeXhr();
    xhr.open('get', 'https://api.example.com/a', true, 'user');
    xhr.send('body');
    expect(xhr.opened).toEqual([['get', 'https://api.example.com/a', true, 'user']]);
    expect(xhr.sent).toEqual([['body']]);
  });

  it('reports a 500 with method, redacted url, status and duration', () => {
    const xhr = request('post', 'https://api.example.com/orders?token=secret#frag');
    xhr.finish(500);
    expect(failures).toHaveLength(1);
    const failure = firstOf(failures);
    expect(failure.method).toBe('POST');
    expect(failure.url).toBe('https://api.example.com/orders?…');
    expect(failure.status).toBe(500);
    expect(failure.error).toBeNull();
    expect(failure.ms).toBeGreaterThanOrEqual(0);
    expect(typeof failure.at).toBe('number');
  });

  it('reports status 400 as a failure but 399 as success', () => {
    request('GET', 'https://api.example.com/a').finish(399);
    expect(failures).toEqual([]);
    request('GET', 'https://api.example.com/b').finish(400);
    expect(failures).toHaveLength(1);
    expect(firstOf(failures).status).toBe(400);
  });

  it('reports status 0 as a network error', () => {
    request('GET', 'https://api.example.com/down').finish(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/down',
      status: null,
      error: 'network error',
    });
    expect(firstOf(failures).ms).toBeGreaterThanOrEqual(0);
  });

  it('does not report an abort', () => {
    const xhr = request('GET', 'https://api.example.com/slow');
    xhr.fire('abort');
    xhr.finish(0);
    expect(failures).toEqual([]);
    expect(inFlight()).toBe(0);
  });

  it('reports a timeout', () => {
    const xhr = request('GET', 'https://api.example.com/slow');
    xhr.fire('timeout');
    xhr.finish(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: null, error: 'timeout', method: 'GET' });
    expect(inFlight()).toBe(0);
  });

  it('ignores dev-server traffic by default', () => {
    const urls = [
      'http://192.168.1.2:8081/symbolicate',
      'http://192.168.1.2:8081/logs',
      'http://192.168.1.2:8081/message',
      'http://192.168.1.2:8081/status',
      'http://192.168.1.2:8081/inspector/device',
      'http://192.168.1.2:8081/hot',
      'http://192.168.1.2:8081/open-stack-frame',
      'http://192.168.1.2:8081/index.bundle',
      'http://192.168.1.2:8081/index.bundle?platform=ios&dev=true',
    ];
    for (const url of urls) {
      const xhr = request('GET', url);
      expect(inFlight()).toBe(0);
      xhr.finish(500);
    }
    expect(failures).toEqual([]);
  });

  it('does not ignore app endpoints that merely resemble dev-server paths', () => {
    const xhr = request('GET', 'https://api.example.com/api/messages');
    expect(inFlight()).toBe(1);
    xhr.finish(200);
  });

  it('lets a custom ignore replace the default', () => {
    uninstallNetworkTracking();
    installNetworkTracking({
      target: { XMLHttpRequest: FakeXhr },
      ignore: (url) => url.includes('analytics'),
    });
    request('GET', 'https://x.example.com/analytics/ping');
    expect(inFlight()).toBe(0);
    const dev = request('GET', 'http://localhost:8081/status');
    expect(inFlight()).toBe(1);
    dev.finish(200);
    expect(inFlight()).toBe(0);
  });

  it('a throwing listener does not stop another', () => {
    const seen: NetworkFailure[] = [];
    const offThrowing = onNetworkFailure(() => {
      throw new Error('boom');
    });
    const offSecond = onNetworkFailure((failure) => seen.push(failure));
    expect(() => request('GET', 'https://api.example.com/a').finish(503)).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(failures).toHaveLength(1);
    offThrowing();
    offSecond();
  });

  it('unsubscribe stops notifications', () => {
    off();
    request('GET', 'https://api.example.com/a').finish(500);
    expect(failures).toEqual([]);
  });

  it('installing twice does not double count', () => {
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
    const xhr = request('GET', 'https://api.example.com/a');
    expect(inFlight()).toBe(1);
    xhr.finish(500);
    expect(inFlight()).toBe(0);
    expect(failures).toHaveLength(1);
    expect(xhr.opened).toHaveLength(1);
    expect(xhr.sent).toHaveLength(1);
  });

  it('uninstall restores the original methods and stops counting', () => {
    expect(FakeXhr.prototype.open).not.toBe(originalOpen);
    expect(FakeXhr.prototype.send).not.toBe(originalSend);
    uninstallNetworkTracking();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
    request('GET', 'https://api.example.com/a');
    expect(inFlight()).toBe(0);
  });

  it('uninstall resets the in-flight count', () => {
    request('GET', 'https://api.example.com/a');
    expect(inFlight()).toBe(1);
    uninstallNetworkTracking();
    expect(inFlight()).toBe(0);
  });

  it('does not decrement below zero when a stale request ends after uninstall', () => {
    const stale = request('GET', 'https://api.example.com/a');
    uninstallNetworkTracking();
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
    const fresh = request('GET', 'https://api.example.com/b');
    stale.finish(200);
    expect(inFlight()).toBe(1);
    fresh.finish(200);
    expect(inFlight()).toBe(0);
  });

  it('stops tracking if the original send throws', () => {
    uninstallNetworkTracking();
    class ThrowingXhr extends FakeXhr {
      override send(): void {
        throw new Error('InvalidStateError');
      }
    }
    installNetworkTracking({ target: { XMLHttpRequest: ThrowingXhr } });
    const xhr = new ThrowingXhr();
    xhr.open('GET', 'https://api.example.com/a');
    expect(() => xhr.send()).toThrow('InvalidStateError');
    expect(inFlight()).toBe(0);
    uninstallNetworkTracking();
  });

  it('does nothing when the target has no XMLHttpRequest constructor', () => {
    uninstallNetworkTracking();
    expect(() => installNetworkTracking({ target: {} })).not.toThrow();
    expect(() => installNetworkTracking({ target: { XMLHttpRequest: 42 } })).not.toThrow();
    expect(inFlight()).toBe(0);
    uninstallNetworkTracking();
  });

  it('falls back to onreadystatechange when addEventListener is missing', () => {
    uninstallNetworkTracking();
    installNetworkTracking({ target: { XMLHttpRequest: NoEventsXhr } });
    const xhr = new NoEventsXhr();
    const calls: number[] = [];
    xhr.onreadystatechange = () => calls.push(xhr.readyState);
    xhr.open('GET', 'https://api.example.com/a');
    xhr.send();
    expect(inFlight()).toBe(1);

    xhr.readyState = 3;
    xhr.onreadystatechange?.();
    expect(inFlight()).toBe(1);

    xhr.readyState = 4;
    xhr.status = 404;
    xhr.onreadystatechange?.();
    expect(inFlight()).toBe(0);
    expect(calls).toEqual([3, 4]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: 404, error: null, url: 'https://api.example.com/a' });
    uninstallNetworkTracking();
  });
});

describe('redactUrl', () => {
  it('keeps scheme, host, port and path', () => {
    expect(redactUrl('https://api.example.com:8443/v1/items')).toBe('https://api.example.com:8443/v1/items');
  });

  it('replaces a non-empty query with an ellipsis', () => {
    expect(redactUrl('https://api.example.com/v1/items?token=abc&x=1')).toBe('https://api.example.com/v1/items?…');
  });

  it('drops the fragment', () => {
    expect(redactUrl('https://api.example.com/page#section')).toBe('https://api.example.com/page');
    expect(redactUrl('https://api.example.com/page?a=1#section')).toBe('https://api.example.com/page?…');
  });

  it('handles a host with no path', () => {
    expect(redactUrl('https://api.example.com')).toBe('https://api.example.com');
    expect(redactUrl('https://api.example.com?a=1')).toBe('https://api.example.com?…');
  });

  it('removes credentials from the authority', () => {
    expect(redactUrl('https://user:pass@api.example.com/x')).toBe('https://api.example.com/x');
  });

  it('leaves anything else unchanged', () => {
    expect(redactUrl('/relative/path?a=1')).toBe('/relative/path?a=1');
    expect(redactUrl('not a url')).toBe('not a url');
    expect(redactUrl('')).toBe('');
  });

  it('cuts to 200 characters', () => {
    const long = `https://api.example.com/${'a'.repeat(300)}`;
    expect(redactUrl(long)).toHaveLength(200);
    expect(redactUrl('b'.repeat(300))).toHaveLength(200);
  });
});
