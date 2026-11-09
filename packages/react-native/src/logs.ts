import { isRecord, type ErrorEventData, type LogEntry, type LogLevel } from './types';

export const MAX_LOG_ENTRIES = 500;
const MAX_MESSAGE_CHARS = 4000;

export type LogSink = (event: 'log' | 'error', data: LogEntry | ErrorEventData) => void;

type ConsoleFn = (...args: unknown[]) => void;
type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => ErrorHandler | undefined;
  setGlobalHandler?: (handler: ErrorHandler) => void;
}

const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error'];

const buffer: LogEntry[] = [];
let sink: LogSink | null = null;
let installed = false;
let reentrant = false;
const originals = new Map<LogLevel, ConsoleFn>();
let previousHandler: ErrorHandler | undefined;
let ourHandler: ErrorHandler | null = null;

function consoleOf(): Record<string, unknown> {
  return console as unknown as Record<string, unknown>;
}

function errorUtils(): ErrorUtilsLike | null {
  const utils = (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  return isRecord(utils) ? (utils as ErrorUtilsLike) : null;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      if (typeof item === 'bigint') return item.toString();
      return item;
    });
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatArgs(args: unknown[]): string {
  const text = args.map(stringify).join(' ');
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function push(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_LOG_ENTRIES) buffer.splice(0, buffer.length - MAX_LOG_ENTRIES);
}

function emit(event: 'log' | 'error', data: LogEntry | ErrorEventData): void {
  const target = sink;
  if (!target) return;
  try {
    target(event, data);
  } catch {
    // a broken socket must never reach the app
  }
}

/** Record a log line (also what the console patch calls). */
export function addLog(level: LogLevel, message: string, ts: number = Date.now()): LogEntry {
  const entry: LogEntry = { level, message, ts };
  push(entry);
  emit('log', entry);
  return entry;
}

export function recordError(error: unknown, fatal: boolean): void {
  const ts = Date.now();
  const message = error instanceof Error ? error.message : stringify(error);
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  push({ level: 'error', message: stack || message, ts });
  emit('error', { message, stack, fatal, ts });
}

/** Buffered entries, optionally only those newer than `since` (ms epoch). */
export function getLogEntries(since?: number): LogEntry[] {
  const list = typeof since === 'number' ? buffer.filter((entry) => entry.ts > since) : buffer;
  return list.map((entry) => ({ ...entry }));
}

export function clearLogs(): void {
  buffer.length = 0;
}

/** Route new entries to the connected client (null while disconnected). */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/** The unpatched console.log, for Tapline's own one-line status messages. */
export function originalLog(...args: unknown[]): void {
  const log = originals.get('log') ?? (consoleOf().log as ConsoleFn | undefined);
  if (typeof log === 'function') log.apply(console, args);
}

export function installLogs(): void {
  if (installed) return;
  installed = true;

  const target = consoleOf();
  for (const level of LEVELS) {
    const original = target[level];
    if (typeof original !== 'function') continue;
    const originalFn = original as ConsoleFn;
    originals.set(level, originalFn);
    const patched: ConsoleFn = (...args: unknown[]): void => {
      if (!reentrant) {
        reentrant = true;
        try {
          addLog(level, formatArgs(args));
        } catch {
          // ignore
        } finally {
          reentrant = false;
        }
      }
      originalFn.apply(console, args);
    };
    target[level] = patched;
  }

  const utils = errorUtils();
  if (utils && typeof utils.setGlobalHandler === 'function') {
    previousHandler = typeof utils.getGlobalHandler === 'function' ? utils.getGlobalHandler() : undefined;
    ourHandler = (error: unknown, isFatal?: boolean): void => {
      try {
        recordError(error, isFatal === true);
      } catch {
        // ignore
      }
      if (previousHandler) previousHandler(error, isFatal);
    };
    utils.setGlobalHandler(ourHandler);
  }
}

export function uninstallLogs(): void {
  if (!installed) return;
  installed = false;
  const target = consoleOf();
  for (const [level, original] of originals) target[level] = original;
  originals.clear();
  const utils = errorUtils();
  if (utils && typeof utils.setGlobalHandler === 'function' && ourHandler) {
    if (previousHandler) utils.setGlobalHandler(previousHandler);
  }
  previousHandler = undefined;
  ourHandler = null;
  sink = null;
}
