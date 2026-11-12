import { TaplineClient, type WebSocketLike } from '../src/client';
import { CRASH_KEY, MAX_SAVED_CHARS, configureCrash, crashFromError, deliverSavedCrash, fitRecord } from '../src/crash';
import { setEventSink } from '../src/events';
import { clearLogs, installLogs, recordError, setLogSink, uninstallLogs } from '../src/logs';
import { memoryStorage, type TaplineStorage } from '../src/storage';

type Handler = (error: unknown, isFatal?: boolean) => void;
const holder = globalThis as { ErrorUtils?: { getGlobalHandler: () => Handler | undefined; setGlobalHandler: (handler: Handler) => void } };

let previousHandler: jest.Mock;
let currentHandler: Handler | undefined;
let savedErrorUtils: typeof holder.ErrorUtils;
let sent: Array<{ event: string; data: unknown }>;
let storage: TaplineStorage;

beforeEach(() => {
  savedErrorUtils = holder.ErrorUtils;
  previousHandler = jest.fn();
  currentHandler = previousHandler;
  holder.ErrorUtils = {
    getGlobalHandler: () => currentHandler,
    setGlobalHandler: (handler) => {
      currentHandler = handler;
    },
  };
  sent = [];
  storage = memoryStorage();
  configureCrash(storage);
  clearLogs();
});

afterEach(() => {
  uninstallLogs();
  configureCrash(null);
  setEventSink(null);
  holder.ErrorUtils = savedErrorUtils;
});

function fail(): Error {
  const error = new TypeError('undefined is not an object (evaluating trip.days)');
  error.stack = 'TypeError: undefined is not an object\n    at TripScreen (/app/src/TripScreen.tsx:42:13)\n    at renderWithHooks (/app/node_modules/react/index.js:10:1)';
  return error;
}

describe('a fatal error is kept for the next connection', () => {
  test('saves name, message, stack, component stack and time before the previous handler runs', async () => {
    installLogs();
    const error = Object.assign(fail(), { componentStack: '\n    in TripScreen\n    in App' });
    currentHandler?.(error, true);
    expect(previousHandler).toHaveBeenCalledWith(error, true);
    const saved = JSON.parse((await storage.getItem(CRASH_KEY)) ?? 'null') as Record<string, unknown>;
    expect(saved.name).toBe('TypeError');
    expect(saved.message).toBe('undefined is not an object (evaluating trip.days)');
    expect(String(saved.stack)).toContain('TripScreen.tsx:42');
    expect(String(saved.componentStack)).toContain('in TripScreen');
    expect(typeof saved.ts).toBe('number');
  });

  test('a fatal error is also sent at once, with its type', () => {
    installLogs();
    setLogSink((event, data) => sent.push({ event, data }));
    currentHandler?.(fail(), true);
    const live = sent.find((s) => s.event === 'error');
    expect(live?.data).toMatchObject({ fatal: true, name: 'TypeError', message: 'undefined is not an object (evaluating trip.days)' });
  });

  test('a non-fatal error is not kept', async () => {
    installLogs();
    currentHandler?.(fail(), false);
    expect(await storage.getItem(CRASH_KEY)).toBeNull();
  });

  test('the saved record stays under the storage limit', () => {
    const big = new Error('x'.repeat(5000));
    big.stack = `Error: boom\n${Array.from({ length: 300 }, (_, i) => `    at fn${i} (/app/src/File${i}.tsx:${i}:1)`).join('\n')}`;
    const json = fitRecord(crashFromError(big, 1));
    expect(json.length).toBeLessThanOrEqual(MAX_SAVED_CHARS);
    expect((JSON.parse(json) as { stack: string }).stack.startsWith('Error: boom')).toBe(true);
  });

  test('without storage nothing is kept and nothing throws', () => {
    configureCrash(null);
    expect(() => recordError(fail(), true)).not.toThrow();
  });
});

describe('sending the saved crash', () => {
  test('sends it as a crash event once a computer is connected, then forgets it', async () => {
    recordError(fail(), true);
    setEventSink((event, data) => sent.push({ event, data }));
    await deliverSavedCrash();
    const crash = sent.find((s) => s.event === 'crash');
    expect(crash?.data).toMatchObject({ name: 'TypeError', message: 'undefined is not an object (evaluating trip.days)' });
    expect(await storage.getItem(CRASH_KEY)).toBeNull();
    sent.length = 0;
    await deliverSavedCrash();
    expect(sent).toEqual([]);
  });

  test('keeps it while no computer is connected', async () => {
    recordError(fail(), true);
    await deliverSavedCrash();
    expect(await storage.getItem(CRASH_KEY)).not.toBeNull();
  });

  test('ignores a damaged record', async () => {
    await storage.setItem(CRASH_KEY, '{not json');
    setEventSink((event, data) => sent.push({ event, data }));
    await deliverSavedCrash();
    expect(sent).toEqual([]);
  });

  test('the client sends the crash an earlier run kept when it connects', async () => {
    jest.useFakeTimers();
    try {
      await storage.setItem(CRASH_KEY, JSON.stringify({ name: 'RangeError', message: 'old crash', stack: '', ts: 1700000000000 }));
      class Socket implements WebSocketLike {
        static last: Socket | undefined;
        onopen: ((event: unknown) => void) | null = null;
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        out: string[] = [];
        constructor(readonly url: string) {
          Socket.last = this;
        }
        send(data: string): void {
          this.out.push(data);
        }
        close(): void {}
      }
      const client = new TaplineClient({ url: 'ws://computer:7210', token: 't' }, { WebSocketCtor: Socket, methods: {}, log: () => {}, capabilities: [], keepAwake: () => {}, appState: { addEventListener: () => undefined } });
      client.start();
      Socket.last?.onopen?.({});
      Socket.last?.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, session: 's-1' }) });
      await jest.advanceTimersByTimeAsync(10);
      const events = (Socket.last?.out ?? []).map((line) => JSON.parse(line) as { type: string; event?: string; data?: { message?: string } });
      expect(events.find((m) => m.event === 'crash')?.data?.message).toBe('old crash');
      expect(await storage.getItem(CRASH_KEY)).toBeNull();
      client.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
