import { Platform } from 'react-native';
import {
  HOST_SILENCE_MS,
  PING_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  TaplineClient,
  backoffDelay,
  connectTimeoutMs,
  collectDeviceInfo,
  defaultCapabilities,
  normalizeUrl,
  type ClientDeps,
  type WebSocketLike,
} from '../src/client';
import { media, setMediaModules } from '../src/media';
import { installNetworkTracking, networkCondition, setNetworkCondition, uninstallNetworkTracking } from '../src/network';
import { addLog, clearLogs, getLogEntries, uninstallLogs } from '../src/logs';
import type { MethodFn } from '../src/methods';
import { TaplineError, type DeviceInfo } from '../src/types';

class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  throwOnSend = false;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error('socket is closing');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Messages the client sent, parsed. */
  get messages(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  open(): void {
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

const DEVICE: DeviceInfo = { platform: 'ios', osVersion: '26.1', model: 'iPhone18,2', name: 'My iPhone' };
const WELCOME = { type: 'welcome', protocol: 1, session: 's-1' };

function last(): MockSocket {
  const socket = MockSocket.instances[MockSocket.instances.length - 1];
  if (!socket) throw new Error('no socket yet');
  return socket;
}

interface Harness {
  client: TaplineClient;
  lines: string[];
}

function makeClient(overrides: Partial<ClientDeps> = {}, url = 'ws://100.64.0.7:7210'): Harness {
  const lines: string[] = [];
  const client = new TaplineClient(
    { url, token: 'secret-token', app: { name: 'Demo', id: 'com.demo', version: '1.2.0', build: '45' } },
    {
      WebSocketCtor: MockSocket,
      device: DEVICE,
      capabilities: ['tree', 'press'],
      log: (line) => lines.push(line),
      methods: {},
      ...overrides,
    },
  );
  return { client, lines };
}

/** Start, open, and welcome the first socket. */
function connect(harness: Harness): MockSocket {
  harness.client.start();
  const socket = last();
  socket.open();
  socket.receive(WELCOME);
  return socket;
}

beforeEach(() => {
  jest.useFakeTimers();
  MockSocket.instances = [];
  clearLogs();
});

afterEach(() => {
  uninstallLogs();
  jest.useRealTimers();
});

describe('app state and keeping awake', () => {
  function fakeAppState(): { appState: NonNullable<ClientDeps['appState']>; emit: (state: string) => void; removed: () => number } {
    const listeners = new Set<(state: string) => void>();
    let removals = 0;
    return {
      appState: {
        addEventListener: (_type, listener) => {
          listeners.add(listener);
          return {
            remove: () => {
              removals += 1;
              listeners.delete(listener);
            },
          };
        },
      },
      emit: (state) => listeners.forEach((listener) => listener(state)),
      removed: () => removals,
    };
  }

  test('reports going to the background and back as appState events while connected', () => {
    const fake = fakeAppState();
    const harness = makeClient({ appState: fake.appState, keepAwake: () => undefined });
    const socket = connect(harness);
    fake.emit('background');
    fake.emit('active');
    const events = socket.messages.filter((m) => m.type === 'event' && m.event === 'appState');
    expect(events.map((m) => m.data)).toEqual([{ state: 'background' }, { state: 'active' }]);
  });

  test('keeps the screen awake while connected, and lets it sleep after', () => {
    const calls: boolean[] = [];
    const harness = makeClient({ appState: fakeAppState().appState, keepAwake: (on) => calls.push(on) });
    const socket = connect(harness);
    expect(calls).toEqual([true]);
    socket.drop();
    expect(calls).toEqual([true, false]);
    const again = (jest.advanceTimersByTime(backoffDelay(0)), last());
    again.open();
    again.receive(WELCOME);
    harness.client.stop();
    expect(calls).toEqual([true, false, true, false]);
  });

  test('reconnects at once when the app comes back to the front', () => {
    const fake = fakeAppState();
    const harness = makeClient({ appState: fake.appState, keepAwake: () => undefined });
    const socket = connect(harness);
    socket.drop();
    jest.advanceTimersByTime(backoffDelay(0));
    last().drop(); // still unreachable: the next try waits longer
    const before = MockSocket.instances.length;
    fake.emit('active');
    expect(MockSocket.instances.length).toBe(before + 1);
  });

  test('stops listening to app state when stopped', () => {
    const fake = fakeAppState();
    const harness = makeClient({ appState: fake.appState, keepAwake: () => undefined });
    connect(harness);
    harness.client.stop();
    expect(fake.removed()).toBe(1);
  });
});

describe('hello and welcome', () => {
  test('sends hello with token, app, device and capabilities as the first message', () => {
    const harness = makeClient();
    harness.client.start();
    expect(last().url).toBe('ws://100.64.0.7:7210');
    expect(last().sent).toHaveLength(0); // nothing before the socket opens
    last().open();
    expect(last().messages).toEqual([
      {
        type: 'hello',
        protocol: 1,
        token: 'secret-token',
        app: { name: 'Demo', id: 'com.demo', version: '1.2.0', build: '45' },
        device: DEVICE,
        capabilities: ['tree', 'press'],
      },
    ]);
  });

  test('app name falls back to a default when not given', () => {
    const client = new TaplineClient({ url: 'ws://h:1', token: 't' }, { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => {}, methods: {} });
    client.start();
    last().open();
    expect(last().messages[0]?.app).toEqual({ name: 'App' });
  });

  test('welcome marks the client connected and logs exactly one line', () => {
    const harness = makeClient();
    expect(harness.client.connected).toBe(false);
    connect(harness);
    expect(harness.client.connected).toBe(true);
    expect(harness.lines).toEqual(['[tapline] connected']);
  });

  test('sends the install id as device.id', () => {
    const client = new TaplineClient(
      { url: 'ws://h:1', token: 't', deviceId: '3fa2c9d1e5b7' },
      { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => {}, methods: {} },
    );
    client.start();
    last().open();
    expect(last().messages[0]?.device).toEqual({ ...DEVICE, id: '3fa2c9d1e5b7' });
  });

  test('normalizes the url', () => {
    expect(normalizeUrl('100.64.0.7:7210')).toBe('ws://100.64.0.7:7210');
    expect(normalizeUrl('http://host:7210')).toBe('ws://host:7210');
    expect(normalizeUrl('wss://host.example')).toBe('wss://host.example');
    expect(normalizeUrl('  ws://host:1 ')).toBe('ws://host:1');
  });

  test('device info reads Platform (and Android constants when present)', () => {
    const info = collectDeviceInfo();
    expect(info.platform).toBe(Platform.OS);
    expect(typeof info.osVersion).toBe('string');
    const spy = jest.spyOn(Platform, 'constants', 'get').mockReturnValue({ Model: 'Pixel 9', Release: '15' } as never);
    try {
      expect(collectDeviceInfo()).toMatchObject({ model: 'Pixel 9', osVersion: '15' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('pairing', () => {
  function pairingClient(onPaired: (token: string) => void, onRejected: (code: number) => void): TaplineClient {
    return new TaplineClient(
      { url: 'ws://100.64.0.1:7211/', pairCode: 'abc-123', onPaired, onRejected },
      { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => {}, methods: {} },
    );
  }

  test('sends the pairing code instead of a token, then reconnects with the token the host returned', () => {
    const paired: string[] = [];
    const client = pairingClient((token) => paired.push(token), () => {});
    client.start();
    last().open();
    const hello = last().messages[0];
    expect(hello?.pairCode).toBe('abc-123');
    expect(hello).not.toHaveProperty('token');

    last().receive({ ...WELCOME, token: 'host-token' });
    expect(paired).toEqual(['host-token']);
    expect(client.connected).toBe(true);

    last().drop();
    jest.advanceTimersByTime(1000);
    last().open();
    const again = last().messages[0];
    expect(again?.token).toBe('host-token');
    expect(again).not.toHaveProperty('pairCode');
    client.stop();
  });

  test('a refused token during the handshake (4001) stops the client and is reported', () => {
    const rejected: number[] = [];
    const client = new TaplineClient(
      { url: 'ws://h:1', token: 'stale', onRejected: (code) => rejected.push(code) },
      { WebSocketCtor: MockSocket, device: DEVICE, capabilities: [], log: () => {}, methods: {} },
    );
    client.start();
    last().open();
    last().drop(4001);
    expect(rejected).toEqual([4001]);
    jest.advanceTimersByTime(120_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  test('a rejected pairing code (4004) stops the client and is reported, without retrying', () => {
    const rejected: number[] = [];
    const client = pairingClient(() => {}, (code) => rejected.push(code));
    client.start();
    last().open();
    last().drop(4004);
    expect(rejected).toEqual([4004]);
    jest.advanceTimersByTime(120_000);
    expect(MockSocket.instances).toHaveLength(1);
    client.stop();
  });
});

describe('keepalive', () => {
  test('pings every 15 seconds after welcome', () => {
    const socket = connect(makeClient());
    const pings = () => socket.messages.filter((m) => m.type === 'ping').length;
    expect(pings()).toBe(0);
    jest.advanceTimersByTime(PING_INTERVAL_MS - 1);
    expect(pings()).toBe(0);
    socket.receive({ type: 'pong' });
    jest.advanceTimersByTime(1);
    expect(pings()).toBe(1);
    socket.receive({ type: 'pong' });
    jest.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pings()).toBe(2);
  });

  test('answers a host ping with a pong', () => {
    const socket = connect(makeClient());
    socket.receive({ type: 'ping' });
    expect(socket.messages.at(-1)).toEqual({ type: 'pong' });
  });

  test('reconnects when the host goes silent for 45 s', () => {
    const harness = makeClient();
    const first = connect(harness);
    jest.advanceTimersByTime(HOST_SILENCE_MS + PING_INTERVAL_MS);
    expect(first.closed).toBe(true);
    expect(harness.lines).toContain('[tapline] disconnected');
    jest.advanceTimersByTime(1000);
    expect(MockSocket.instances).toHaveLength(2);
  });

  describe('network conditions end with the connection', () => {
    class Xhr {
      open(): void {}
      send(): void {}
    }

    beforeEach(() => installNetworkTracking({ target: { XMLHttpRequest: Xhr } }));
    afterEach(() => uninstallNetworkTracking());

    test('the host dropping the connection puts the network back to normal', () => {
      const socket = connect(makeClient());
      setNetworkCondition('offline');
      socket.drop(1006);
      expect(networkCondition()).toBe('normal');
    });

    test('stopping the client puts the network back to normal', () => {
      const harness = makeClient();
      connect(harness);
      setNetworkCondition('3g');
      harness.client.stop();
      expect(networkCondition()).toBe('normal');
    });

    test('the host going silent puts the network back to normal', () => {
      connect(makeClient());
      setNetworkCondition('lossy');
      jest.advanceTimersByTime(HOST_SILENCE_MS + PING_INTERVAL_MS);
      expect(networkCondition()).toBe('normal');
    });
  });
});

describe('requests', () => {
  function withMethods(methods: Record<string, MethodFn>): { harness: Harness; socket: MockSocket } {
    const harness = makeClient({ methods });
    return { harness, socket: connect(harness) };
  }

  async function flush(): Promise<void> {
    await jest.advanceTimersByTimeAsync(0);
  }

  test('routes a request to its method and replies with the result', async () => {
    const press = jest.fn(async (params: unknown) => ({ element: { ref: 'e1' }, got: params }));
    const { socket } = withMethods({ press });
    socket.receive({ type: 'request', id: 12, method: 'press', params: { target: { testID: 'login-button' } } });
    await flush();
    expect(press).toHaveBeenCalledWith({ target: { testID: 'login-button' } });
    expect(socket.messages.at(-1)).toEqual({
      type: 'response',
      id: 12,
      ok: true,
      result: { element: { ref: 'e1' }, got: { target: { testID: 'login-button' } } },
    });
  });

  test('an undefined result is sent as {}', async () => {
    const { socket } = withMethods({ nothing: async () => undefined });
    socket.receive({ type: 'request', id: 1, method: 'nothing' });
    await flush();
    expect(socket.messages.at(-1)).toMatchObject({ id: 1, ok: true, result: {} });
  });

  test('protocol errors keep their code and message', async () => {
    const { socket } = withMethods({
      press: async () => {
        throw new TaplineError('not_found', 'No element matches testID "login-button"');
      },
      pick: async () => {
        throw new TaplineError('ambiguous', 'Two match', ['e1', 'e2']);
      },
    });
    socket.receive({ type: 'request', id: 2, method: 'press', params: {} });
    socket.receive({ type: 'request', id: 3, method: 'pick', params: {} });
    await flush();
    const responses = socket.messages.filter((m) => m.type === 'response');
    expect(responses[0]).toEqual({
      type: 'response',
      id: 2,
      ok: false,
      error: { code: 'not_found', message: 'No element matches testID "login-button"' },
    });
    expect(responses[1]).toEqual({
      type: 'response',
      id: 3,
      ok: false,
      error: { code: 'ambiguous', message: 'Two match', refs: ['e1', 'e2'] },
    });
  });

  test('unexpected exceptions become internal errors', async () => {
    const { socket } = withMethods({
      boom: async () => {
        throw new Error('kaput');
      },
      syncBoom: () => {
        throw new TypeError('sync kaput');
      },
    });
    socket.receive({ type: 'request', id: 4, method: 'boom' });
    socket.receive({ type: 'request', id: 5, method: 'syncBoom' });
    await flush();
    const responses = socket.messages.filter((m) => m.type === 'response');
    expect(responses[0]).toMatchObject({ id: 4, ok: false, error: { code: 'internal', message: 'kaput' } });
    expect(responses[1]).toMatchObject({ id: 5, ok: false, error: { code: 'internal', message: 'sync kaput' } });
  });

  test('unknown methods (including inherited names) are unsupported', async () => {
    const { socket } = withMethods({});
    socket.receive({ type: 'request', id: 6, method: 'teleport' });
    socket.receive({ type: 'request', id: 7, method: 'toString' });
    socket.receive({ type: 'request', id: 8 });
    await flush();
    const responses = socket.messages.filter((m) => m.type === 'response');
    expect(responses).toHaveLength(3);
    for (const response of responses) {
      expect(response).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    }
  });

  test('requests without a usable id are ignored', async () => {
    const { socket } = withMethods({ ok: async () => ({}) });
    socket.receive({ type: 'request', method: 'ok' });
    socket.receive({ type: 'request', id: { nested: true }, method: 'ok' });
    await flush();
    expect(socket.messages.filter((m) => m.type === 'response')).toHaveLength(0);
  });

  test('requests run one at a time, in order', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const { socket } = withMethods({
      slow: async () => {
        order.push('slow:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('slow:end');
        return { n: 1 };
      },
      fast: async () => {
        order.push('fast');
        return { n: 2 };
      },
    });
    socket.receive({ type: 'request', id: 1, method: 'slow' });
    socket.receive({ type: 'request', id: 2, method: 'fast' });
    await flush();
    expect(order).toEqual(['slow:start']);
    releaseFirst();
    await flush();
    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
    expect(socket.messages.filter((m) => m.type === 'response').map((m) => m.id)).toEqual([1, 2]);
  });

  test('a method that never finishes times out', async () => {
    const { socket } = withMethods({ hang: () => new Promise<unknown>(() => {}) });
    socket.receive({ type: 'request', id: 9, method: 'hang' });
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    expect(socket.messages.at(-1)).toMatchObject({ id: 9, ok: false, error: { code: 'timeout' } });
  });

  test('string ids are echoed back as strings', async () => {
    const { socket } = withMethods({ ok: async () => ({}) });
    socket.receive({ type: 'request', id: 'abc', method: 'ok' });
    await flush();
    expect(socket.messages.at(-1)).toMatchObject({ id: 'abc', ok: true });
  });

  test('garbage and unknown message types are ignored', async () => {
    const { socket } = withMethods({});
    expect(() => {
      socket.receive('not json');
      socket.receive('[1,2,3]');
      socket.receive({ type: 'mystery' });
      socket.onmessage?.({ data: 42 });
    }).not.toThrow();
  });
});

describe('events', () => {
  test('forwards log lines while connected and stops after disconnect', () => {
    const harness = makeClient();
    const socket = connect(harness);
    addLog('warn', 'something odd', 1794115000123);
    expect(socket.messages.at(-1)).toEqual({
      type: 'event',
      event: 'log',
      data: { level: 'warn', message: 'something odd', ts: 1794115000123 },
    });
    const before = socket.sent.length;
    socket.drop();
    addLog('log', 'nobody listening');
    expect(socket.sent).toHaveLength(before);
    expect(getLogEntries().map((e) => e.message)).toContain('nobody listening'); // still buffered for `logs`
  });
});

describe('reconnect', () => {
  test('a new try comes one second after each failed one, so a host that starts is found quickly (S4, S5)', () => {
    expect([0, 1, 2, 3, 10, 50].map(backoffDelay)).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
  });

  test('a try that never opens is dropped after 2 s and a fresh one follows a second later', () => {
    const harness = makeClient();
    harness.client.start();
    const first = last();
    jest.advanceTimersByTime(1999);
    expect(first.closed).toBe(false);
    expect(MockSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1); // the try hung for 2 s
    expect(first.closed).toBe(true);
    jest.advanceTimersByTime(backoffDelay(0));
    expect(MockSocket.instances).toHaveLength(2);
    first.open(); // a late answer on the dropped socket changes nothing
    expect(first.sent).toHaveLength(0);
    harness.client.stop();
  });

  test('a try that opened in time is not dropped', () => {
    const harness = makeClient();
    const socket = connect(harness);
    jest.advanceTimersByTime(10_000);
    expect(socket.closed).toBe(false);
    expect(MockSocket.instances).toHaveLength(1);
    harness.client.stop();
  });

  test('every fourth try may take 4 s to open, for slow links', () => {
    expect([0, 1, 2, 3, 4, 7].map(connectTimeoutMs)).toEqual([2000, 2000, 2000, 4000, 2000, 4000]);
  });

  test('retries a refused connection with growing delays', () => {
    const harness = makeClient();
    harness.client.start();
    const expected = [1000, 1000, 1000, 1000, 1000];
    expected.forEach((delay, i) => {
      expect(MockSocket.instances).toHaveLength(i + 1);
      last().drop(1006);
      jest.advanceTimersByTime(delay - 1);
      expect(MockSocket.instances).toHaveLength(i + 1);
      jest.advanceTimersByTime(1);
      expect(MockSocket.instances).toHaveLength(i + 2);
    });
  });

  test('a successful welcome resets the backoff', () => {
    const harness = makeClient();
    harness.client.start();
    last().drop();
    jest.advanceTimersByTime(1000);
    last().drop();
    jest.advanceTimersByTime(2000);
    expect(MockSocket.instances).toHaveLength(3);
    last().open();
    last().receive(WELCOME);
    last().drop();
    jest.advanceTimersByTime(1000);
    expect(MockSocket.instances).toHaveLength(4);
  });

  test('re-sends hello on every new socket', () => {
    const harness = makeClient();
    const first = connect(harness);
    first.drop(1001);
    jest.advanceTimersByTime(1000);
    const second = last();
    expect(second).not.toBe(first);
    second.open();
    expect(second.messages[0]).toMatchObject({ type: 'hello', token: 'secret-token' });
  });

  test('logs one line per connect/disconnect, not one per failed attempt', () => {
    const harness = makeClient();
    harness.client.start();
    for (let i = 0; i < 5; i++) {
      last().drop();
      jest.advanceTimersByTime(30_000);
    }
    expect(harness.lines).toHaveLength(1);
    expect(harness.lines[0]).toContain('retrying');
    last().open();
    last().receive(WELCOME);
    last().drop(4001);
    expect(harness.lines).toEqual([expect.stringContaining('retrying'), '[tapline] connected', '[tapline] disconnected (code 4001)']);
  });

  test('stop closes the socket and cancels reconnects', () => {
    const harness = makeClient();
    const socket = connect(harness);
    harness.client.stop();
    expect(socket.closed).toBe(true);
    expect(harness.client.connected).toBe(false);
    jest.advanceTimersByTime(120_000);
    expect(MockSocket.instances).toHaveLength(1);
    expect(harness.lines).toEqual(['[tapline] connected', '[tapline] disconnected']);
  });

  test('stop during a backoff wait prevents the next attempt', () => {
    const harness = makeClient();
    harness.client.start();
    last().drop();
    harness.client.stop();
    jest.advanceTimersByTime(60_000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  test('events from a replaced socket are ignored', () => {
    const harness = makeClient({ methods: { ok: async () => ({}) } });
    const first = connect(harness);
    first.drop();
    jest.advanceTimersByTime(1000);
    const second = last();
    first.onmessage?.({ data: JSON.stringify({ type: 'request', id: 1, method: 'ok' }) });
    expect(second.sent).toHaveLength(0);
  });
});

describe('never throws into the app', () => {
  test('a failing send is swallowed', () => {
    const socket = connect(makeClient());
    socket.throwOnSend = true;
    expect(() => {
      socket.receive({ type: 'ping' });
      jest.advanceTimersByTime(PING_INTERVAL_MS);
    }).not.toThrow();
  });

  test('a constructor that throws schedules a retry instead of crashing', () => {
    let attempts = 0;
    class Flaky extends MockSocket {
      constructor(url: string) {
        super(url);
        attempts += 1;
        if (attempts === 1) throw new Error('bad url');
      }
    }
    const harness = makeClient({ WebSocketCtor: Flaky });
    expect(() => harness.client.start()).not.toThrow();
    jest.advanceTimersByTime(1000);
    expect(attempts).toBe(2);
  });

  test('a throwing log callback is swallowed', () => {
    const harness = makeClient({
      log: () => {
        throw new Error('no console');
      },
    });
    expect(() => connect(harness)).not.toThrow();
  });

  test('start is idempotent', () => {
    const harness = makeClient();
    harness.client.start();
    harness.client.start();
    expect(MockSocket.instances).toHaveLength(1);
  });
});

describe('a photo-picker stub ends with the connection', () => {
  const armParams = { op: 'picker', index: 1, total: 1, name: 'a.jpg', mime: 'image/jpeg', data: 'QUJD' };

  test("the app's own picker is back after the connection drops, and after stop", async () => {
    const original = async (): Promise<unknown> => ({ canceled: true });
    const mod: Record<string, unknown> = { launchImageLibraryAsync: original, launchCameraAsync: original };
    setMediaModules({ expo: null, cameraRoll: null, fileSystem: null, imagePicker: mod });
    try {
      const harness = makeClient();
      const socket = connect(harness);
      await media(armParams);
      expect(mod.launchImageLibraryAsync).not.toBe(original);
      socket.drop(1006);
      expect(mod.launchImageLibraryAsync).toBe(original);
      expect(mod.launchCameraAsync).toBe(original);

      jest.advanceTimersByTime(1000);
      const second = last();
      second.open();
      second.receive(WELCOME);
      await media(armParams);
      expect(mod.launchImageLibraryAsync).not.toBe(original);
      harness.client.stop();
      expect(mod.launchImageLibraryAsync).toBe(original);
    } finally {
      setMediaModules(undefined);
    }
  });

  test('media is among the capabilities the app announces', () => {
    expect(defaultCapabilities()).toContain('media');
  });
});
