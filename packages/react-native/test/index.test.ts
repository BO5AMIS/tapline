import { Linking } from 'react-native';
import { startTapline, stopTapline, type TaplineOptions } from '../src/index';
import { getLogEntries } from '../src/logs';
import { memoryStorage } from '../src/storage';

type Handler = ((event: unknown) => void) | null;

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

const holder = globalThis as { WebSocket?: unknown };
let savedWebSocket: unknown;
let logSpy: jest.SpyInstance;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const direct = (url: string): TaplineOptions => ({ enabled: true, url, token: 'abc', storage: memoryStorage() });

beforeEach(() => {
  savedWebSocket = holder.WebSocket;
  holder.WebSocket = FakeSocket;
  FakeSocket.instances = [];
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  stopTapline();
  holder.WebSocket = savedWebSocket;
  jest.restoreAllMocks();
});

describe('startTapline / stopTapline', () => {
  test('stays completely off unless enabled is true (a store build)', async () => {
    const before = console.log;
    startTapline({ enabled: false, url: 'ws://100.64.0.7:7210', token: 'abc' });
    startTapline({ enabled: undefined as unknown as boolean });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(console.log).toBe(before); // console was not patched
    expect(logSpy).not.toHaveBeenCalled();
  });

  test('enabled without a url waits for a pairing link and does not connect', async () => {
    const listen = jest.spyOn(Linking, 'addEventListener');
    startTapline({ enabled: true, storage: memoryStorage() });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(listen).toHaveBeenCalledWith('url', expect.any(Function));
  });

  test('a direct url and token connect with the global WebSocket', async () => {
    startTapline(direct('ws://100.64.0.7:7210'));
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0]?.url).toBe('ws://100.64.0.7:7210');
  });

  test('only one of url and token: says so once and waits for pairing instead', async () => {
    startTapline({ enabled: true, url: 'ws://h:1', storage: memoryStorage() });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  test('without expo-secure-store, says the pairing lasts until the app restarts', async () => {
    startTapline({ enabled: true });
    await flush();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('expo-secure-store');
  });

  test('calling start again replaces the connection', async () => {
    startTapline(direct('ws://one:1'));
    await flush();
    startTapline(direct('ws://two:2'));
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0]?.closed).toBe(true);
    expect(FakeSocket.instances[1]?.closed).toBe(false);
  });

  test('stopTapline closes the socket and restores the console; extra calls are harmless', async () => {
    const before = console.warn;
    startTapline(direct('ws://one:1'));
    await flush();
    expect(console.warn).not.toBe(before);
    stopTapline();
    expect(FakeSocket.instances[0]?.closed).toBe(true);
    expect(console.warn).toBe(before);
    expect(() => stopTapline()).not.toThrow();
  });

  test('console output is captured once started', () => {
    startTapline(direct('ws://one:1'));
    console.log('from the app');
    expect(getLogEntries().some((entry) => entry.message === 'from the app')).toBe(true);
  });

  test('never throws, even without a WebSocket', async () => {
    holder.WebSocket = undefined;
    expect(() => startTapline(direct('ws://one:1'))).not.toThrow();
    await flush();
  });
});
