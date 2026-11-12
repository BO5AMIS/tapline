import {
  ensureFetchWrapped,
  inFlight,
  installNetworkTracking,
  onNetworkFailure,
  setNetworkCondition,
  uninstallNetworkTracking,
  type NetworkFailure,
} from '../src/network';

// Expo SDK 58 replaces the global fetch with expo/fetch, which doesn't use XMLHttpRequest (found on the phone,
// 2026-11-12): the network condition, the requests-in-flight count and the failure log must cover fetch too.

class FakeXhr {
  open(): void {}
  send(): void {}
  abort(): void {}
}

interface Target {
  XMLHttpRequest: unknown;
  fetch: unknown;
  [key: string]: unknown;
}

function makeTarget(fetchImpl: (input: unknown, init?: unknown) => Promise<unknown>): Target {
  return { XMLHttpRequest: FakeXhr, fetch: fetchImpl };
}

const ok = (status = 200): Promise<unknown> => Promise.resolve({ status, headers: { get: () => null } });

afterEach(() => {
  uninstallNetworkTracking();
});

test('an app wrapper around Tapline\'s fetch, wrapped again, counts and reports a request once', async () => {
  let release: (value: unknown) => void = () => undefined;
  const target = makeTarget(() => new Promise((resolve) => (release = resolve)));
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const failures: NetworkFailure[] = [];
  const off = onNetworkFailure((f) => failures.push(f));
  // a logger the app installs after Tapline: it calls the fetch it replaced (Tapline's)
  const previous = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  target.fetch = (input: unknown, init?: unknown) => previous(input, init);
  ensureFetchWrapped(); // Tapline wraps the app's wrapper too
  const app = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  const pending = app('https://api.example.com/trips');
  expect(inFlight()).toBe(1);
  release({ status: 500, headers: { get: () => null } });
  await pending;
  expect(inFlight()).toBe(0);
  expect(failures).toHaveLength(1);
  off();
});

test('an app wrapper that awaits before calling Tapline\'s older fetch: counted and reported once; nothing after uninstall', async () => {
  let release: (value: unknown) => void = () => undefined;
  const target = makeTarget(() => new Promise((resolve) => (release = resolve)));
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const failures: NetworkFailure[] = [];
  const off = onNetworkFailure((f) => failures.push(f));
  const previous = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  target.fetch = async (input: unknown, init?: unknown) => {
    await Promise.resolve(); // e.g. reads a token first
    return previous(input, init);
  };
  ensureFetchWrapped();
  const app = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  const pending = app('https://api.example.com/trips');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(inFlight()).toBe(1);
  release({ status: 500, headers: { get: () => null } });
  await pending;
  expect(inFlight()).toBe(0);
  expect(failures).toHaveLength(1);
  uninstallNetworkTracking();
  const after = (target.fetch as (input: unknown) => Promise<unknown>)('https://api.example.com/later');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  release({ status: 500, headers: { get: () => null } });
  await after;
  expect(failures).toHaveLength(1);
  off();
});

test('an interceptor that puts the earlier global fetch back: that wrapper conditions again, and uninstall undoes it', async () => {
  const sent: string[] = [];
  const own = (input: unknown): Promise<unknown> => {
    sent.push(String(input));
    return ok();
  };
  const target = makeTarget(own);
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  setNetworkCondition('offline');
  const first = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  target.fetch = (input: unknown, init?: unknown) => first(input, init); // an interceptor
  ensureFetchWrapped();
  target.fetch = first; // the interceptor cleans up
  await expect((target.fetch as (input: unknown) => Promise<unknown>)('https://api.example.com/x')).rejects.toThrow('Network request failed');
  expect(sent).toEqual([]);
  uninstallNetworkTracking();
  expect(target.fetch).toBe(own);
});

test('stopping Tapline ends a fetch\'s condition: no 3G delays after it, no made-up offline failure', async () => {
  const sent: string[] = [];
  const big = { status: 200, headers: { get: (name: string) => (name === 'content-length' ? '937500' : null) } };
  const target = makeTarget((input) => {
    sent.push(String(input));
    return Promise.resolve(big);
  });
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const app = target.fetch as (input: unknown) => Promise<unknown>;
  setNetworkCondition('3g');
  const startedAt = Date.now();
  const slow = app('https://api.example.com/big');
  uninstallNetworkTracking(); // during the send delay
  await expect(slow).resolves.toBe(big);
  expect(Date.now() - startedAt).toBeLessThan(300); // not 0.4 s + 10 s
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  setNetworkCondition('offline');
  const offline = (target.fetch as (input: unknown) => Promise<unknown>)('https://api.example.com/later');
  uninstallNetworkTracking();
  await expect(offline).resolves.toBe(big);
  expect(sent).toEqual(['https://api.example.com/big', 'https://api.example.com/later']);
});

test('uninstall right after an interceptor put the earlier wrapper back restores the app\'s own fetch', () => {
  const own = (): Promise<unknown> => ok();
  const target = makeTarget(own);
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const first = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  target.fetch = (input: unknown, init?: unknown) => first(input, init);
  ensureFetchWrapped();
  target.fetch = first; // no fetch before uninstall
  uninstallNetworkTracking();
  expect(target.fetch).toBe(own);
});

test('an interceptor cleaned up while its request waits: the request is still counted and reported once', async () => {
  let release: (value: unknown) => void = () => undefined;
  const seen: unknown[] = [];
  const target = makeTarget((_input, init) => {
    seen.push(init);
    return new Promise((resolve) => (release = resolve));
  });
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const failures: NetworkFailure[] = [];
  const off = onNetworkFailure((f) => failures.push(f));
  const first = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  target.fetch = async (input: unknown, init?: unknown) => {
    await gate;
    return first(input, init);
  };
  ensureFetchWrapped();
  const pending = (target.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('https://api.example.com/trips', { method: 'POST' });
  target.fetch = first; // the interceptor cleans up while its request waits
  open();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(inFlight()).toBe(1);
  release({ status: 500, headers: { get: () => null } });
  await pending;
  expect(inFlight()).toBe(0);
  expect(failures).toHaveLength(1);
  expect(seen[0]).toMatchObject({ method: 'POST' }); // the app's init arrives intact
  off();
});

test('fetch options the app passes inherited or non-enumerable still reach its fetch', async () => {
  const seen: unknown[] = [];
  const target = makeTarget((_input, init) => {
    seen.push(init);
    return ok();
  });
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const init: Record<string, unknown> = Object.create({ method: 'POST', body: 'payload', credentials: 'omit' });
  Object.defineProperty(init, 'cache', { value: 'no-store', enumerable: false });
  await (target.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('https://api.example.com/x', init);
  expect(seen[0]).toMatchObject({ method: 'POST', body: 'payload', credentials: 'omit', cache: 'no-store' });
});

test('offline fails a fetch without sending it, and the failure is reported', async () => {
  const sent: string[] = [];
  const target = makeTarget((input) => {
    sent.push(String(input));
    return ok();
  });
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const failures: NetworkFailure[] = [];
  const off = onNetworkFailure((f) => failures.push(f));
  setNetworkCondition('offline');
  const app = target.fetch as (input: unknown) => Promise<unknown>;
  await expect(app('https://api.example.com/trips?token=secret')).rejects.toThrow('Network request failed');
  expect(sent).toEqual([]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/trips?…', error: 'network error' });
  off();
});

test('a fetch is counted in flight until it ends, and a 500 is reported', async () => {
  let release: (value: unknown) => void = () => undefined;
  const target = makeTarget(() => new Promise((resolve) => (release = resolve)));
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const failures: NetworkFailure[] = [];
  const off = onNetworkFailure((f) => failures.push(f));
  const app = target.fetch as (input: unknown, init?: unknown) => Promise<unknown>;
  const pending = app('https://api.example.com/save', { method: 'post' });
  expect(inFlight()).toBe(1);
  release({ status: 500, headers: { get: () => null } });
  await pending;
  expect(inFlight()).toBe(0);
  expect(failures[0]).toMatchObject({ method: 'POST', status: 500 });
  off();
});

test('3g holds a fetch back before it is sent', async () => {
  const sentAt: number[] = [];
  const target = makeTarget(() => {
    sentAt.push(Date.now());
    return ok();
  });
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  setNetworkCondition('3g');
  const started = Date.now();
  await (target.fetch as (input: unknown) => Promise<unknown>)('https://api.example.com/x');
  expect((sentAt[0] ?? 0) - started).toBeGreaterThanOrEqual(350);
});

test('a fetch the app installs later is wrapped when requests are next counted, and put back on uninstall', async () => {
  const target = makeTarget(() => ok());
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  const later = jest.fn(() => ok());
  target.fetch = later; // as Expo's lazy global does after Tapline started
  ensureFetchWrapped(target);
  setNetworkCondition('offline');
  await expect((target.fetch as (input: unknown) => Promise<unknown>)('https://api.example.com/y')).rejects.toThrow();
  expect(later).not.toHaveBeenCalled();
  uninstallNetworkTracking();
  expect(target.fetch).toBe(later);
});

test('dev-server traffic through fetch is never conditioned or counted', async () => {
  const target = makeTarget(() => ok());
  installNetworkTracking({ target: target as unknown as { XMLHttpRequest?: unknown } });
  setNetworkCondition('offline');
  await expect((target.fetch as (input: unknown) => Promise<unknown>)('http://192.168.1.2:8081/symbolicate')).resolves.toBeDefined();
  expect(inFlight()).toBe(0);
});
