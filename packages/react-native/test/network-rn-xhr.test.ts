// React Native's own XMLHttpRequest (0.88) with its native networking mocked: the Codex review of 1.4.0 found that a
// held request couldn't be reused after abort, and that the 3G download time never applied, because RN fires its
// events through an inner path, not dispatchEvent. And fetch's held waits must honour the abort signal.

type Listener = (args: unknown[]) => void;
const mockListeners = new Map<string, Listener>();
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
      mockListeners.set(name, fn);
      return { remove: () => mockListeners.delete(name) };
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
  mockListeners.get('didReceiveNetworkResponse')?.([id, 200, { 'Content-Length': String(body.length) }, 'https://api.example.com/big']);
  mockListeners.get('didReceiveNetworkData')?.([id, body]);
  mockListeners.get('didCompleteNetworkResponse')?.([id, '', false]);
  expect(ended).toBe(false);
  jest.advanceTimersByTime(5_000);
  expect(ended).toBe(false);
  jest.advanceTimersByTime(5_100);
  expect(ended).toBe(true);
  expect(xhr.status).toBe(200);
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
