import { emitEvent, hasEventSink } from './events';
import { symbolicateStack } from './source';
import type { TaplineStorage } from './storage';
import { isRecord } from './types';

/**
 * A fatal JavaScript error is kept on the phone the moment React Native's global handler sees it, because the
 * app may be gone a moment later. The next connection sends it to the computer (the `crash` event) and then
 * forgets it. A development build maps the stack to the app's files and lines first. The computer counts a
 * crash it already heard live (same time and message) only once.
 */

export interface CrashRecord {
  name: string;
  message: string;
  stack: string;
  componentStack?: string;
  ts: number;
}

export const CRASH_KEY = 'tapline.crash';
/** SecureStore warns above about 2 KB; stay under it. */
export const MAX_SAVED_CHARS = 1800;
const SYMBOLICATE_WAIT_MS = 3000;

let storage: TaplineStorage | null = null;
/** The write in progress, so a delivery right after a crash reads what was written. */
let saving: Promise<void> = Promise.resolve();

/** Where the crash is kept (null: nowhere). */
export function configureCrash(next: TaplineStorage | null): void {
  storage = next;
  saving = Promise.resolve();
}

export function crashFromError(error: unknown, ts: number): CrashRecord {
  if (error instanceof Error) {
    const componentStack = (error as Error & { componentStack?: unknown }).componentStack;
    return {
      name: error.name !== '' ? error.name : 'Error',
      message: error.message,
      stack: typeof error.stack === 'string' ? error.stack : '',
      ...(typeof componentStack === 'string' && componentStack.trim() !== '' ? { componentStack } : {}),
      ts,
    };
  }
  let message: string;
  try {
    message = typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
  } catch {
    message = String(error);
  }
  return { name: 'Error', message, stack: '', ts };
}

/** The record as JSON that fits the storage limit: the stack and component stack lose their tails first. */
export function fitRecord(record: CrashRecord): string {
  const message = cutTo(record.message, 400);
  const componentStack = record.componentStack !== undefined ? cutTo(record.componentStack, 400) : undefined;
  const build = (stack: string): string =>
    JSON.stringify({ ...record, message, stack, ...(componentStack !== undefined ? { componentStack } : {}) });
  let budget = record.stack.length;
  let json = build(cutTo(record.stack, budget));
  while (json.length > MAX_SAVED_CHARS && budget > 0) {
    budget = Math.max(0, budget - Math.max(50, json.length - MAX_SAVED_CHARS));
    json = build(cutTo(record.stack, budget));
  }
  return json;
}

/** The first `max` characters, ending at a whole line when there is one. */
function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const newline = head.lastIndexOf('\n');
  return newline > 0 ? head.slice(0, newline) : head;
}

/** Starts writing a crash to the storage at once; never throws, never waits. */
export function saveCrash(record: CrashRecord): void {
  const target = storage;
  if (target === null) return;
  try {
    const json = fitRecord(record);
    saving = target.setItem(CRASH_KEY, json).catch(() => undefined);
  } catch {
    // the crash is also sent live; losing the copy must not hide the app's own error
  }
}

function parseSaved(raw: string | null): CrashRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.message !== 'string' || typeof value.ts !== 'number') return null;
    return {
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: value.message,
      stack: typeof value.stack === 'string' ? value.stack : '',
      ...(typeof value.componentStack === 'string' ? { componentStack: value.componentStack } : {}),
      ts: value.ts,
    };
  } catch {
    return null;
  }
}

function inDevelopment(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

/**
 * Sends the crash kept from an earlier run (or this one) to the computer, then forgets it. Does nothing
 * while no computer is connected, so the crash stays for the next connection. Never throws.
 */
export async function deliverSavedCrash(): Promise<void> {
  const target = storage;
  if (target === null) return;
  try {
    await saving;
    const record = parseSaved(await target.getItem(CRASH_KEY));
    if (record === null) return;
    let stack = record.stack;
    if (inDevelopment() && stack !== '') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(stack), SYMBOLICATE_WAIT_MS);
      });
      try {
        stack = await Promise.race([symbolicateStack(stack), limit]);
      } catch {
        // keep the raw stack
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (!hasEventSink()) return;
    emitEvent('crash', { ...record, stack });
    await target.removeItem(CRASH_KEY);
  } catch {
    // never reaches the app
  }
}
