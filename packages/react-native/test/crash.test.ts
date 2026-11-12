import { TaplineClient, type WebSocketLike } from '../src/client';
import { CRASH_KEY, MAX_SAVED_CHARS, ackSavedCrash, configureCrash, crashFromError, deliverSavedCrash, fitRecord } from '../src/crash';
import { methods } from '../src/methods';
import { setEventSink } from '../src/events';
import { clearLogs, getLogEntries, installLogs, recordError, setLogSink, uninstallLogs } from '../src/logs';
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

/** The global handler as it is now (a function, so TypeScript doesn't remember an earlier assignment). */
function globalHandler(): Handler | undefined {
  return currentHandler;
}

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

  test('installing again after an uninstall with no previous handler does not record an error twice', () => {
    currentHandler = undefined;
    installLogs();
    uninstallLogs();
    installLogs();
    clearLogs();
    globalHandler()?.(new Error('once'), false);
    expect(getLogEntries().filter((entry) => entry.message.includes('once'))).toHaveLength(1);
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
  test('sends it as a crash event once a computer is connected, and forgets it only when the computer acknowledges it', async () => {
    recordError(fail(), true);
    setEventSink((event, data) => sent.push({ event, data }));
    await deliverSavedCrash();
    const crash = sent.find((s) => s.event === 'crash');
    expect(crash?.data).toMatchObject({ name: 'TypeError', message: 'undefined is not an object (evaluating trip.days)' });
    // sent is not delivered: the record stays, and the next connection sends it again
    expect(await storage.getItem(CRASH_KEY)).not.toBeNull();
    sent.length = 0;
    await deliverSavedCrash();
    expect(sent.filter((s) => s.event === 'crash')).toHaveLength(1);
    const ts = (crash?.data as { ts: number }).ts;
    await methods.crashAck?.({ ts });
    expect(await storage.getItem(CRASH_KEY)).toBeNull();
    sent.length = 0;
    await deliverSavedCrash();
    expect(sent).toEqual([]);
  });

  test('an acknowledgement for another crash leaves the stored one alone', async () => {
    await storage.setItem(CRASH_KEY, JSON.stringify({ name: 'Error', message: 'newer', stack: '', ts: 2000 }));
    await ackSavedCrash(1000);
    expect(await storage.getItem(CRASH_KEY)).not.toBeNull();
    await methods.crashAck?.({ ts: 'x' });
    await methods.crashAck?.(null);
    expect(await storage.getItem(CRASH_KEY)).not.toBeNull();
    await ackSavedCrash(2000);
    expect(await storage.getItem(CRASH_KEY)).toBeNull();
  });

  test('overlapping deliveries run one after the other, and a crash saved meanwhile survives the older one being acknowledged', async () => {
    let reading = 0;
    let mostAtOnce = 0;
    const inner = memoryStorage();
    configureCrash({
      getItem: async (key) => {
        reading += 1;
        mostAtOnce = Math.max(mostAtOnce, reading);
        await new Promise((resolve) => setTimeout(resolve, 5));
        reading -= 1;
        return inner.getItem(key);
      },
      setItem: (key, value) => inner.setItem(key, value),
      removeItem: (key) => inner.removeItem(key),
    });
    await inner.setItem(CRASH_KEY, JSON.stringify({ name: 'Error', message: 'first', stack: '', ts: 1000 }));
    setEventSink((event, data) => sent.push({ event, data }));
    const both = Promise.all([deliverSavedCrash(), deliverSavedCrash()]);
    await inner.setItem(CRASH_KEY, JSON.stringify({ name: 'Error', message: 'second', stack: '', ts: 2000 }));
    await both;
    expect(mostAtOnce).toBe(1);
    await ackSavedCrash(1000);
    expect(JSON.parse((await inner.getItem(CRASH_KEY)) ?? 'null')).toMatchObject({ message: 'second', ts: 2000 });
  });

  test('a crash saved while an older acknowledgement is reading survives it (Codex review of 1.3.0)', async () => {
    const inner = memoryStorage();
    let releaseRead: () => void = () => undefined;
    let firstRead = true;
    configureCrash({
      getItem: async (key) => {
        // the first read takes what is stored now (crash A) and answers only later, after B was saved
        const value = await inner.getItem(key);
        if (firstRead) {
          firstRead = false;
          await new Promise<void>((resolve) => (releaseRead = resolve));
        }
        return value;
      },
      setItem: (key, value) => inner.setItem(key, value),
      removeItem: (key) => inner.removeItem(key),
    });
    await inner.setItem(CRASH_KEY, JSON.stringify({ name: 'Error', message: 'A', stack: '', ts: 1000 }));
    const ack = ackSavedCrash(1000); // reads A, and waits
    await new Promise((resolve) => setTimeout(resolve, 0));
    recordError(Object.assign(new Error('B'), {}), true); // crash B is saved meanwhile
    releaseRead();
    await ack;
    await deliverSavedCrash();
    expect(JSON.parse((await inner.getItem(CRASH_KEY)) ?? 'null')).toMatchObject({ message: 'B' });
  });

  test('a crash saved while the older one is being removed is written back (Codex re-review, PR #4)', async () => {
    const inner = memoryStorage();
    let releaseRemove: () => void = () => undefined;
    let removing = false;
    configureCrash({
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) => inner.setItem(key, value),
      // the removal lands only when the test says so, after B was saved
      removeItem: (key) => {
        removing = true;
        return new Promise<void>((resolve) => (releaseRemove = () => void inner.removeItem(key).then(resolve)));
      },
    });
    await inner.setItem(CRASH_KEY, JSON.stringify({ name: 'Error', message: 'A', stack: '', ts: 1000 }));
    const ack = ackSavedCrash(1000);
    while (!removing) await new Promise((resolve) => setTimeout(resolve, 0));
    installLogs();
    currentHandler?.(new Error('B'), true); // B is saved while A's removal is on its way
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseRemove();
    await ack;
    expect(JSON.parse((await inner.getItem(CRASH_KEY)) ?? 'null')).toMatchObject({ message: 'B' });
  });

  test('a newer crash is never overwritten by an older write that finishes late (CodeRabbit, PR #4)', async () => {
    const inner = memoryStorage();
    const writes: Array<() => Promise<void>> = [];
    configureCrash({
      getItem: (key) => inner.getItem(key),
      // every write waits until the test lets it finish
      setItem: (key, value) => new Promise<void>((resolve) => writes.push(() => inner.setItem(key, value).then(resolve))),
      removeItem: (key) => inner.removeItem(key),
    });
    installLogs();
    currentHandler?.(new Error('A'), true);
    currentHandler?.(new Error('B'), true);
    expect(writes).toHaveLength(1); // B waits for A
    await writes[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toHaveLength(2);
    await writes[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse((await inner.getItem(CRASH_KEY)) ?? 'null')).toMatchObject({ message: 'B' });
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
      // sent, not yet acknowledged by the computer: still kept
      expect(await storage.getItem(CRASH_KEY)).not.toBeNull();
      client.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
