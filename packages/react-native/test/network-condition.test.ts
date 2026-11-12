import {
  installNetworkTracking,
  networkCondition,
  onNetworkFailure,
  resetNetworkCondition,
  seedNetworkRandom,
  setNetworkCondition,
  uninstallNetworkTracking,
  inFlight,
  type NetworkFailure,
} from '../src/network';
import { listCommands, resetCommands, runCommand } from '../src/commands';

interface FakeEvent {
  type: string;
}

type Handler = (event: FakeEvent) => void;

/** An XMLHttpRequest stand-in that answers when `respond` is called, like React Native's does. */
class FakeXhr {
  status = 0;
  readyState = 0;
  responseText = '';
  opened: unknown[][] = [];
  sent: unknown[][] = [];
  aborted = false;
  headers: Record<string, string> = {};
  seen: string[] = [];
  private handlers = new Map<string, Handler[]>();

  open(...args: unknown[]): void {
    this.opened.push(args);
    this.readyState = 1;
  }

  send(...args: unknown[]): void {
    this.sent.push(args);
  }

  abort(): void {
    this.aborted = true;
  }

  getResponseHeader(name: string): string | null {
    return this.headers[name.toLowerCase()] ?? null;
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  dispatchEvent(event: FakeEvent): boolean {
    this.seen.push(event.type);
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
    return true;
  }

  /** The server answers: what React Native does when the response is complete. */
  respond(status: number, body = '', headers: Record<string, string> = {}): void {
    this.status = status;
    this.responseText = body;
    this.headers = headers;
    this.readyState = 4;
    this.dispatchEvent({ type: 'readystatechange' });
    this.dispatchEvent({ type: 'load' });
    this.dispatchEvent({ type: 'loadend' });
  }
}

function request(method: string, url: string, body?: unknown): FakeXhr {
  const xhr = new FakeXhr();
  xhr.open(method, url, true);
  xhr.send(body);
  return xhr;
}

/** `sent` of the original send, counted before the patch sees it. */
function sentCount(xhr: FakeXhr): number {
  return xhr.sent.length;
}

const originalOpen = FakeXhr.prototype.open;
const originalSend = FakeXhr.prototype.send;
const originalAbort = FakeXhr.prototype.abort;

describe('network conditions', () => {
  let failures: NetworkFailure[];
  let off: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    failures = [];
    off = onNetworkFailure((failure) => failures.push(failure));
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr }, ignore: (url) => url.includes('/tapline-offer') });
    seedNetworkRandom(1);
  });

  afterEach(() => {
    off();
    uninstallNetworkTracking();
    seedNetworkRandom(null);
    jest.useRealTimers();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
    expect(FakeXhr.prototype.abort).toBe(originalAbort);
  });

  test('normal is the default and changes nothing', () => {
    expect(networkCondition()).toBe('normal');
    const xhr = request('GET', 'https://api.example.com/a');
    expect(sentCount(xhr)).toBe(1);
  });

  test('offline: the request never goes out and fails the way React Native fails with no connection', () => {
    setNetworkCondition('offline');
    const xhr = request('GET', 'https://api.example.com/a');
    expect(sentCount(xhr)).toBe(0);
    jest.advanceTimersByTime(1);
    expect(sentCount(xhr)).toBe(0);
    expect(xhr.readyState).toBe(4);
    expect(xhr.status).toBe(0);
    expect(xhr.seen).toEqual(['readystatechange', 'error', 'loadend']);
    // it counts as a failed request in the logs, and nothing stays in flight
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/a', status: null, error: 'network error' });
    expect(inFlight()).toBe(0);
  });

  test('offline: fetch-style handlers on the error event fire (a TypeError "Network request failed" is the app\'s to raise)', () => {
    setNetworkCondition('offline');
    const xhr = new FakeXhr();
    const onError = jest.fn();
    xhr.addEventListener('error', onError);
    xhr.open('POST', 'https://api.example.com/save', true);
    xhr.send('{}');
    jest.advanceTimersByTime(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('offline: a request already sent before the mode changed is left alone', () => {
    const xhr = request('GET', 'https://api.example.com/a');
    setNetworkCondition('offline');
    xhr.respond(200, 'ok');
    expect(failures).toEqual([]);
    expect(xhr.seen).toEqual(['readystatechange', 'load', 'loadend']);
  });

  test('3g: the request goes out about 400 ms late', () => {
    setNetworkCondition('3g');
    const xhr = request('GET', 'https://api.example.com/a');
    expect(sentCount(xhr)).toBe(0);
    jest.advanceTimersByTime(399);
    expect(sentCount(xhr)).toBe(0);
    jest.advanceTimersByTime(1);
    expect(sentCount(xhr)).toBe(1);
    expect(inFlight()).toBe(1);
  });

  test('3g: a request body adds upload time at 750 kbit/s', () => {
    setNetworkCondition('3g');
    const xhr = request('POST', 'https://api.example.com/up', 'x'.repeat(93_750));
    jest.advanceTimersByTime(1399);
    expect(sentCount(xhr)).toBe(0);
    jest.advanceTimersByTime(1);
    expect(sentCount(xhr)).toBe(1);
  });

  test('3g: the response arrives after its transfer time (from content-length, else the body)', () => {
    setNetworkCondition('3g');
    const xhr = request('GET', 'https://api.example.com/big');
    const onLoad = jest.fn();
    xhr.addEventListener('load', onLoad);
    jest.advanceTimersByTime(400);
    xhr.respond(200, '', { 'content-length': String(93_750) });
    // 93,750 bytes at 750 kbit/s is exactly one second
    expect(xhr.seen).toEqual([]);
    jest.advanceTimersByTime(999);
    expect(onLoad).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(xhr.seen).toEqual(['readystatechange', 'load', 'loadend']);
    expect(inFlight()).toBe(0);

    const small = request('GET', 'https://api.example.com/small');
    jest.advanceTimersByTime(400);
    small.respond(200, 'x'.repeat(937));
    jest.advanceTimersByTime(9);
    expect(small.seen).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(small.seen).toEqual(['readystatechange', 'load', 'loadend']);
  });

  test('3g: a response of unknown size is not held', () => {
    setNetworkCondition('3g');
    const xhr = request('GET', 'https://api.example.com/empty');
    jest.advanceTimersByTime(400);
    xhr.respond(204);
    expect(xhr.seen).toEqual(['readystatechange', 'load', 'loadend']);
  });

  test('3g: abort before the delayed send cancels it', () => {
    setNetworkCondition('3g');
    const xhr = request('GET', 'https://api.example.com/a');
    xhr.abort();
    jest.advanceTimersByTime(1000);
    expect(sentCount(xhr)).toBe(0);
    expect(xhr.aborted).toBe(true);
    expect(inFlight()).toBe(0);
  });

  test('lossy: about one request in five fails after a short delay, the rest get a little extra latency', () => {
    setNetworkCondition('lossy');
    const xhrs: FakeXhr[] = [];
    for (let i = 0; i < 200; i += 1) xhrs.push(request('GET', `https://api.example.com/${i}`));
    expect(xhrs.every((xhr) => sentCount(xhr) === 0)).toBe(true);
    jest.advanceTimersByTime(400);
    const failed = xhrs.filter((xhr) => xhr.readyState === 4 && xhr.seen.includes('error')).length;
    const sent = xhrs.filter((xhr) => sentCount(xhr) === 1).length;
    expect(failed + sent).toBe(200);
    expect(failed).toBeGreaterThan(20);
    expect(failed).toBeLessThan(60);
  });

  test('lossy: the same seed gives the same requests failing', () => {
    function run(seed: number): boolean[] {
      uninstallNetworkTracking();
      installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
      seedNetworkRandom(seed);
      setNetworkCondition('lossy');
      const xhrs = Array.from({ length: 30 }, (_, i) => request('GET', `https://api.example.com/${i}`));
      jest.advanceTimersByTime(500);
      return xhrs.map((xhr) => xhr.seen.includes('error'));
    }
    const first = run(7);
    const second = run(7);
    const other = run(8);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(first.some(Boolean)).toBe(true);
  });

  test('Tapline\'s own traffic is never conditioned: the offer path and Metro / dev-server requests', () => {
    setNetworkCondition('offline');
    const offer = request('GET', 'http://192.168.0.2:7210/tapline-offer');
    const bundle = request('GET', 'http://192.168.0.2:8081/index.bundle?platform=ios');
    const symbolicate = request('POST', 'http://192.168.0.2:8081/symbolicate');
    const hot = request('GET', 'http://192.168.0.2:8081/hot');
    for (const xhr of [offer, bundle, symbolicate, hot]) expect(sentCount(xhr)).toBe(1);
    jest.advanceTimersByTime(1000);
    expect(failures).toEqual([]);
    // the app's own request in the same moment is conditioned
    expect(sentCount(request('GET', 'https://api.example.com/a'))).toBe(0);
  });

  test('dev-server requests stay unconditioned even when the app gave its own ignore rule', () => {
    uninstallNetworkTracking();
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr }, ignore: () => false });
    setNetworkCondition('3g');
    expect(sentCount(request('GET', 'http://10.0.0.5:8081/message'))).toBe(1);
  });

  test('normal restores it for new requests', () => {
    setNetworkCondition('offline');
    setNetworkCondition('normal');
    expect(sentCount(request('GET', 'https://api.example.com/a'))).toBe(1);
  });

  test('resetNetworkCondition (host gone) goes back to normal', () => {
    setNetworkCondition('3g');
    resetNetworkCondition();
    expect(networkCondition()).toBe('normal');
    expect(sentCount(request('GET', 'https://api.example.com/a'))).toBe(1);
  });

  test('stopping Tapline (uninstall) goes back to normal', () => {
    setNetworkCondition('offline');
    uninstallNetworkTracking();
    expect(networkCondition()).toBe('normal');
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
  });

  test('a condition needs the patch: without it the mode cannot be set', () => {
    uninstallNetworkTracking();
    expect(() => setNetworkCondition('offline')).toThrow(/not installed/);
    expect(networkCondition()).toBe('normal');
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
  });

  test('a request without open() or an unknown mode never breaks anything', () => {
    // @ts-expect-error a bad mode from outside the types
    expect(() => setNetworkCondition('dial-up')).toThrow(/mode must be/);
  });
});

describe('network command', () => {
  beforeEach(() => {
    installNetworkTracking({ target: { XMLHttpRequest: FakeXhr } });
  });

  afterEach(() => {
    uninstallNetworkTracking();
    resetCommands();
  });

  test('is built in and describes its modes', () => {
    const entry = listCommands().find((command) => command.name === 'network');
    expect(entry?.description).toContain('offline');
    expect(entry?.description).toContain('lossy');
  });

  test('sets the mode and answers it with what is not covered', async () => {
    const answer = await runCommand({ name: 'network', args: { mode: '3g' } });
    expect(networkCondition()).toBe('3g');
    expect(answer.result).toMatchObject({ mode: '3g', covers: expect.stringContaining('WebSockets, images the native side loads and native SDKs') });
    const back = await runCommand({ name: 'network', args: { mode: 'normal' } });
    expect(networkCondition()).toBe('normal');
    expect(back.result).toEqual({ mode: 'normal' });
  });

  test('refuses an unknown mode as an internal failure naming the modes', async () => {
    await expect(runCommand({ name: 'network', args: { mode: 'edge' } })).rejects.toMatchObject({
      message: expect.stringContaining('"offline", "3g", "lossy" or "normal"'),
    });
    expect(networkCondition()).toBe('normal');
  });
});
