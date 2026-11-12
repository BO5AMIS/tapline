import { emitEvent, hasEventSink } from './events';
import { symbolicateStack } from './source';
import type { TaplineStorage } from './storage';
import { isRecord } from './types';

/**
 * A fatal JavaScript error is kept on the phone the moment React Native's global handler sees it, because the
 * app may be gone a moment later. The next connection sends it to the computer (the `crash` event); it forgets
 * it only when the computer acknowledges that crash (`crashAck`). A development build maps the stack to the app's files and lines first. The computer counts a
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
/**
 * Counts the saves. An acknowledgement removes the record only when no save started after it began reading, so it
 * can never remove a newer crash (Codex review of 1.3.0). A save still starts at once: the app may die right after.
 */
let saves = 0;
/** Writes not yet done: a new crash written while one is in flight waits for it, so an older one never lands last. */
let writing = 0;
/** The newest crash written, so one saved while an acknowledgement was removing the older one can be put back. */
let lastJson: string | null = null;

/** Where the crash is kept (null: nowhere). */
export function configureCrash(next: TaplineStorage | null): void {
  storage = next;
  saving = Promise.resolve();
  saves = 0;
  writing = 0;
  lastJson = null;
  delivery = Promise.resolve();
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
    saves += 1;
    lastJson = json;
    // At once when nothing is being written (the app may die right after); after the write in flight otherwise.
    const write = (): Promise<void> => target.setItem(CRASH_KEY, json).catch(() => undefined);
    writing += 1;
    const done = (): void => {
      writing -= 1;
    };
    saving = (writing === 1 ? write() : saving.then(write)).then(done, done);
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

/** Deliveries wait their turn: one at a time, so two of them never read, send and compare in an interleaved way. */
let delivery: Promise<void> = Promise.resolve();

/**
 * Sends the crash kept from an earlier run (or this one) to the computer. The record stays on the phone until
 * the computer says it has it (`crashAck`, see `ackSavedCrash`); until then every connection sends it again, and
 * the computer counts it once. Does nothing while no computer is connected. Never throws.
 */
export function deliverSavedCrash(): Promise<void> {
  const next = delivery.then(deliverOnce);
  delivery = next;
  return next;
}

/**
 * The computer has the crash saved at `ts`: forget it, but only that one. A newer crash saved since (or one
 * the computer has not acknowledged) stays. Never throws.
 */
export async function ackSavedCrash(ts: number): Promise<void> {
  const target = storage;
  if (target === null) return;
  try {
    await saving;
    const before = saves;
    const record = parseSaved(await target.getItem(CRASH_KEY));
    // A crash saved while this was reading is newer than the one acknowledged: it stays.
    if (saves !== before) return;
    if (record !== null && record.ts === ts) {
      await target.removeItem(CRASH_KEY);
      // A crash saved while the removal was on its way may have been erased by it: it is written again.
      if (saves !== before && lastJson !== null) {
        await saving;
        await target.setItem(CRASH_KEY, lastJson);
      }
    }
  } catch {
    // never reaches the app
  }
}

/** The `crashAck` request of the computer. */
export async function crashAck(params: unknown): Promise<Record<string, never>> {
  if (isRecord(params) && typeof params.ts === 'number') await ackSavedCrash(params.ts);
  return {};
}

async function deliverOnce(): Promise<void> {
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
  } catch {
    // never reaches the app
  }
}
