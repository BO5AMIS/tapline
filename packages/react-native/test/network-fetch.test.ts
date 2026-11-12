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
