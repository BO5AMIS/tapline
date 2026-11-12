// React Native's own XMLHttpRequest (0.88) with its native networking mocked: the Codex review of 1.4.0 found that a
// held request couldn't be reused after abort, and that the 3G download time never applied, because RN fires its
// events through an inner path, not dispatchEvent. And fetch's held waits must honour the abort signal.

type Listener = (args: unknown[]) => void;
// React Native sends each native event to every XHR that listens: several listeners per name.
const mockListeners = new Map<string, Set<Listener>>();
const mockSent: unknown[][] = [];

jest.mock('react-native/Libraries/Network/RCTNetworking', () => ({
  __esModule: true,
  default: {
    sendRequest: (...args: unknown[]) => {
      mockSent.push(args);
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") Reflect.apply(callback, undefined, [mockSent.length]);
    },
    abortRequest: () => undefined,
    clearCookies: () => undefined,
    addListener: (name: string, fn: (args: unknown[]) => void) => {
      const set = mockListeners.get(name) ?? new Set<Listener>();
      set.add(fn);
      mockListeners.set(name, set);
      return { remove: () => set.delete(fn) };
    },
  },
}));

/** The parts of React Native's XMLHttpRequest these tests use (the module ships no types). */
interface RNXhr {
  readyState: number;
  status: number;
  open(method: string, url: string): void;
  send(body?: unknown): void;
  abort(): void;
  addEventListener(type: string, listener: () => void): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XMLHttpRequest = (require('react-native/Libraries/Network/XMLHttpRequest') as { default: new () => RNXhr }).default;
function emit(name: string, args: unknown[]): void {
  for (const fn of [...(mockListeners.get(name) ?? [])]) fn(args);
}

import { inFlight, installNetworkTracking, setNetworkCondition, uninstallNetworkTracking } from '../src/network';

beforeEach(() => {
  mockListeners.clear();
  mockSent.length = 0;
  installNetworkTracking({ target: { XMLHttpRequest } });
});
afterEach(() => {
  uninstallNetworkTracking();
  jest.useRealTimers();
});

test('a request held by a condition and then aborted can be opened again', () => {
  setNetworkCondition('3g');
  const xhr = new XMLHttpRequest();
  const seen: string[] = [];
  xhr.addEventListener('abort', () => seen.push('abort'));
  xhr.addEventListener('loadend', () => seen.push('loadend'));
  xhr.open('GET', 'https://api.example.com/a');
  xhr.send();
  xhr.abort(); // while held, never really sent
  expect(seen).toEqual(['abort', 'loadend']);
  expect(xhr.readyState).toBe(0);
  expect(() => xhr.open('GET', 'https://api.example.com/b')).not.toThrow();
  expect(inFlight()).toBe(0);
});

test('3g holds the download for its transfer time on React Native\'s XHR', () => {
  jest.useFakeTimers();
  setNetworkCondition('3g');
  const xhr = new XMLHttpRequest();
  let ended = false;
  xhr.addEventListener('loadend', () => {
    ended = true;
  });
  xhr.open('GET', 'https://api.example.com/big');
  xhr.send();
  jest.advanceTimersByTime(500); // the upload latency: now really mockSent
  expect(mockSent).toHaveLength(1);
  const id = mockSent.length;
  const body = 'x'.repeat(937_500); // 10 s at 750 kbit/s
  emit('didReceiveNetworkResponse', [id, 200, { 'Content-Length': String(body.length) }, 'https://api.example.com/big']);
  emit('didReceiveNetworkData', [id, body]);
  emit('didCompleteNetworkResponse', [id, '', false]);
  expect(ended).toBe(false);
  jest.advanceTimersByTime(5_000);
  expect(ended).toBe(false);
  jest.advanceTimersByTime(5_100);
  expect(ended).toBe(true);
  expect(xhr.status).toBe(200);
});

const BIG = 'x'.repeat(937_500); // 10 s at 750 kbit/s

function answer(id: number, url: string): void {
  emit('didReceiveNetworkResponse', [id, 200, { 'Content-Length': String(BIG.length) }, url]);
  emit('didReceiveNetworkData', [id, BIG]);
}

function started(url: string): { xhr: RNXhr; ended: () => boolean } {
  const xhr = new XMLHttpRequest();
  let done = false;
  xhr.addEventListener('loadend', () => {
    done = true;
  });
  xhr.open('GET', url);
  xhr.send();
  return { xhr, ended: () => done };
}

test("another request's completion leaves this request's download hold in place", () => {
  jest.useFakeTimers();
  setNetworkCondition('3g');
  const a = started('https://api.example.com/a');
  const b = started('https://api.example.com/b');
  jest.advanceTimersByTime(500);
  expect(mockSent).toHaveLength(2);
  answer(1, 'https://api.example.com/a');
  answer(2, 'https://api.example.com/b');
  emit('didCompleteNetworkResponse', [1, '', false]); // reaches B's listener too
  emit('didCompleteNetworkResponse', [2, '', false]);
  expect(a.ended()).toBe(false);
  expect(b.ended()).toBe(false);
  jest.advanceTimersByTime(10_100);
  expect(a.ended()).toBe(true);
  expect(b.ended()).toBe(true);
});

test("an abort after the real send removes the hold, so the reused XHR isn't held under normal", () => {
  jest.useFakeTimers();
  setNetworkCondition('3g');
  const first = started('https://api.example.com/a');
  jest.advanceTimersByTime(500);
  answer(1, 'https://api.example.com/a');
  first.xhr.abort();
  expect(first.ended()).toBe(true);
  setNetworkCondition('normal');
  let ended = false;
  first.xhr.addEventListener('loadend', () => {
    ended = true;
  });
  first.xhr.open('GET', 'https://api.example.com/again');
  first.xhr.send();
  expect(mockSent).toHaveLength(2);
  answer(2, 'https://api.example.com/again');
  emit('didCompleteNetworkResponse', [2, '', false]);
  expect(ended).toBe(true);
  expect(first.xhr.status).toBe(200);
});

test('stopping Tapline delivers a held completion at once, and the reused XHR finishes normally', () => {
  jest.useFakeTimers();
  setNetworkCondition('3g');
  const first = started('https://api.example.com/a');
  jest.advanceTimersByTime(500);
  answer(1, 'https://api.example.com/a');
  emit('didCompleteNetworkResponse', [1, '', false]);
  expect(first.ended()).toBe(false);
  uninstallNetworkTracking(); // the held completion comes now, and the hold comes off
  expect(first.ended()).toBe(true);
  expect(first.xhr.status).toBe(200);
  first.xhr.abort();
  let ended = false;
  first.xhr.addEventListener('loadend', () => {
    ended = true;
  });
  first.xhr.open('GET', 'https://api.example.com/again');
  first.xhr.send();
  expect(mockSent).toHaveLength(2);
  answer(2, 'https://api.example.com/again');
  emit('didCompleteNetworkResponse', [2, '', false]);
  expect(ended).toBe(true);
  jest.advanceTimersByTime(20_000);
  expect(first.xhr.status).toBe(200);
});

test('stopping Tapline during the 3G send delay sends the request now, with no hold left behind', () => {
  jest.useFakeTimers();
  setNetworkCondition('3g');
  const first = started('https://api.example.com/a');
  expect(mockSent).toHaveLength(0);
  uninstallNetworkTracking(); // the held send goes out now
  expect(mockSent).toHaveLength(1);
  jest.advanceTimersByTime(1_000); // the old send timer must do nothing
  expect(mockSent).toHaveLength(1);
  answer(1, 'https://api.example.com/a');
  first.xhr.abort();
  let ended = false;
  first.xhr.addEventListener('loadend', () => {
    ended = true;
  });
  first.xhr.open('GET', 'https://api.example.com/again');
  first.xhr.send();
  expect(mockSent).toHaveLength(2);
  answer(2, 'https://api.example.com/again');
  emit('didCompleteNetworkResponse', [2, '', false]);
  expect(ended).toBe(true);
  expect(first.xhr.status).toBe(200);
});

describe('fetch under a condition honours abort', () => {
  const aborted = () => {
    const controller = new AbortController();
    return controller;
  };

  test('an abort during the upload hold rejects at once and stops counting', async () => {
    const target: Record<string, unknown> = { XMLHttpRequest, fetch: () => Promise.resolve({ status: 200, headers: { get: () => null } }) };
    uninstallNetworkTracking();
    installNetworkTracking({ target: target as { XMLHttpRequest?: unknown } });
    setNetworkCondition('3g');
    const controller = aborted();
    const pending = (target.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('https://api.example.com/x', { signal: controller.signal });
    expect(inFlight()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(inFlight()).toBe(0);
  });

  test('an already aborted signal rejects before anything is mockSent', async () => {
    const send = jest.fn(() => Promise.resolve({ status: 200, headers: { get: () => null } }));
    const target: Record<string, unknown> = { XMLHttpRequest, fetch: send };
    uninstallNetworkTracking();
    installNetworkTracking({ target: target as { XMLHttpRequest?: unknown } });
    setNetworkCondition('3g');
    const controller = aborted();
    controller.abort();
    await expect((target.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('https://api.example.com/y', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
  });

  test('an abort during the response hold rejects instead of delivering the response', async () => {
    const big = { status: 200, headers: { get: (name: string) => (name === 'content-length' ? '937500' : null) } };
    const target: Record<string, unknown> = { XMLHttpRequest, fetch: () => Promise.resolve(big) };
    uninstallNetworkTracking();
    installNetworkTracking({ target: target as { XMLHttpRequest?: unknown } });
    setNetworkCondition('3g');
    const controller = aborted();
    const pending = (target.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('https://api.example.com/z', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 600)); // past the upload hold, into the response hold
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(inFlight()).toBe(0);
  });
});
