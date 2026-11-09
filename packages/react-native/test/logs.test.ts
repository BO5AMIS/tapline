import {
  MAX_LOG_ENTRIES,
  addLog,
  clearLogs,
  formatArgs,
  getLogEntries,
  installLogs,
  recordError,
  setLogSink,
  uninstallLogs,
} from '../src/logs';
import type { ErrorEventData, LogEntry } from '../src/types';

type Handler = (error: unknown, isFatal?: boolean) => void;
const holder = globalThis as { ErrorUtils?: { getGlobalHandler: () => Handler | undefined; setGlobalHandler: (handler: Handler) => void } };

let previousHandler: jest.Mock;
let currentHandler: Handler | undefined;
let savedErrorUtils: typeof holder.ErrorUtils;
let consoleOriginals: Record<string, unknown>;

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
  const target = console as unknown as Record<string, unknown>;
  consoleOriginals = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    consoleOriginals[level] = target[level];
    target[level] = jest.fn();
  }
  clearLogs();
});

afterEach(() => {
  uninstallLogs();
  holder.ErrorUtils = savedErrorUtils;
  const target = console as unknown as Record<string, unknown>;
  for (const level of Object.keys(consoleOriginals)) target[level] = consoleOriginals[level];
});

describe('console capture', () => {
  test('records log/info/warn/error and still calls the originals', () => {
    const originalLog = console.log as jest.Mock;
    const originalError = console.error as jest.Mock;
    installLogs();
    console.log('hello', 3, { a: 1 });
    console.info('info line');
    console.warn('careful');
    console.error('bad', new Error('kaput').message);
    expect(getLogEntries().map(({ level, message }) => ({ level, message }))).toEqual([
      { level: 'log', message: 'hello 3 {"a":1}' },
      { level: 'info', message: 'info line' },
      { level: 'warn', message: 'careful' },
      { level: 'error', message: 'bad kaput' },
    ]);
    expect(originalLog).toHaveBeenCalledWith('hello', 3, { a: 1 });
    expect(originalError).toHaveBeenCalledWith('bad', 'kaput');
  });

  test('installing twice does not double-record', () => {
    installLogs();
    installLogs();
    console.log('once');
    expect(getLogEntries()).toHaveLength(1);
  });

  test('uninstall restores the console', () => {
    const before = console.log;
    installLogs();
    expect(console.log).not.toBe(before);
    uninstallLogs();
    expect(console.log).toBe(before);
  });

  test('keeps only the last 500 entries', () => {
    installLogs();
    for (let i = 0; i < MAX_LOG_ENTRIES + 25; i++) console.log(`line ${i}`);
    const entries = getLogEntries();
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries[0]?.message).toBe('line 25');
    expect(entries[MAX_LOG_ENTRIES - 1]?.message).toBe(`line ${MAX_LOG_ENTRIES + 24}`);
  });

  test('since filters by timestamp (exclusive)', () => {
    addLog('log', 'old', 1000);
    addLog('log', 'edge', 2000);
    addLog('log', 'new', 3000);
    expect(getLogEntries(2000).map((e) => e.message)).toEqual(['new']);
    expect(getLogEntries().map((e) => e.message)).toEqual(['old', 'edge', 'new']);
  });

  test('returns copies, so callers cannot rewrite history', () => {
    addLog('log', 'keep');
    const [entry] = getLogEntries();
    if (entry) entry.message = 'tampered';
    expect(getLogEntries()[0]?.message).toBe('keep');
  });

  test('formats errors, circular objects, undefined and long messages', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(formatArgs([cyclic])).toBe('{"name":"loop","self":"[Circular]"}');
    expect(formatArgs([undefined, null])).toBe('undefined null');
    expect(formatArgs([new Error('oops')])).toContain('oops');
    expect(formatArgs(['x'.repeat(5000)]).length).toBeLessThan(4100);
  });

  test('a console call made while recording does not recurse (it reaches the original only)', () => {
    const originalLog = console.log as jest.Mock;
    installLogs();
    setLogSink(() => {
      console.log('from the sink');
    });
    console.log('outer');
    expect(getLogEntries().map((e) => e.message)).toEqual(['outer']);
    expect(originalLog).toHaveBeenCalledWith('from the sink');
  });
});

describe('events', () => {
  test('a connected sink receives log events and error events', () => {
    installLogs();
    const events: Array<{ event: string; data: LogEntry | ErrorEventData }> = [];
    setLogSink((event, data) => events.push({ event, data }));
    console.warn('heads up');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'log', data: { level: 'warn', message: 'heads up' } });

    const error = new Error('exploded');
    currentHandler?.(error, true);
    const errorEvent = events.find((e) => e.event === 'error');
    expect(errorEvent?.data).toMatchObject({ message: 'exploded', fatal: true });
    expect((errorEvent?.data as ErrorEventData).stack).toContain('exploded');
    expect(typeof (errorEvent?.data as ErrorEventData).ts).toBe('number');
  });

  test('nothing is emitted without a sink, but everything is buffered', () => {
    installLogs();
    console.log('quiet');
    expect(getLogEntries()).toHaveLength(1);
  });

  test('a throwing sink never reaches the app', () => {
    installLogs();
    setLogSink(() => {
      throw new Error('socket dead');
    });
    expect(() => console.log('still fine')).not.toThrow();
    expect(() => recordError(new Error('x'), false)).not.toThrow();
  });
});

describe('global error handler', () => {
  test('chains the previous handler and buffers the error as a log entry', () => {
    installLogs();
    const error = new Error('render crash');
    currentHandler?.(error, false);
    expect(previousHandler).toHaveBeenCalledWith(error, false);
    const entry = getLogEntries().find((e) => e.level === 'error');
    expect(entry?.message).toContain('render crash');
  });

  test('handles non-Error throwables', () => {
    installLogs();
    currentHandler?.('a string was thrown', true);
    expect(getLogEntries().some((e) => e.message.includes('a string was thrown'))).toBe(true);
  });

  test('uninstall puts the previous handler back', () => {
    installLogs();
    expect(currentHandler).not.toBe(previousHandler);
    uninstallLogs();
    expect(currentHandler).toBe(previousHandler);
  });

  test('works when ErrorUtils is missing', () => {
    holder.ErrorUtils = undefined;
    expect(() => installLogs()).not.toThrow();
    console.log('still captured');
    expect(getLogEntries()).toHaveLength(1);
  });
});
