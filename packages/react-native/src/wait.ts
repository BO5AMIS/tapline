import { takeSnapshot, type Entry } from './inspect';
import { TaplineError, isRecord } from './types';

/**
 * `waitFor`: polls the screen until an element appears (or is gone) and/or the network is
 * quiet, so an agent waits for loading to finish instead of guessing a delay.
 */

const POLL_MS = 250;
const DEFAULT_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 30;

type IdleProvider = () => boolean;

let networkIdle: IdleProvider = () => true;

/** Where "the network is quiet" comes from (the network tracker; tests). Null restores "always quiet". */
export function setNetworkIdleProvider(provider: IdleProvider | null): void {
  networkIdle = provider ?? (() => true);
}

interface Condition {
  text?: string;
  testID?: string;
  label?: string;
  gone: boolean;
  networkIdle: boolean;
  timeoutMs: number;
}

function parse(raw: unknown): Condition {
  if (!isRecord(raw)) throw new TaplineError('bad_params', 'waitFor needs an object');
  const pick = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  const text = pick('text');
  const testID = pick('testID');
  const label = pick('label');
  const wantsNetwork = raw.networkIdle === true;
  if (text === undefined && testID === undefined && label === undefined && !wantsNetwork) {
    throw new TaplineError('bad_params', 'waitFor needs text, testID, label or networkIdle');
  }
  const timeout = raw.timeout === undefined ? DEFAULT_TIMEOUT_S : raw.timeout;
  if (typeof timeout !== 'number' || !(timeout > 0) || timeout > MAX_TIMEOUT_S) {
    throw new TaplineError('bad_params', `timeout is in seconds, above 0 and at most ${MAX_TIMEOUT_S}`);
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(testID !== undefined ? { testID } : {}),
    ...(label !== undefined ? { label } : {}),
    gone: raw.gone === true,
    networkIdle: wantsNetwork,
    timeoutMs: timeout * 1000,
  };
}

function matches(entry: Entry, condition: Condition): boolean {
  const { info } = entry;
  if (condition.testID !== undefined && info.testID !== condition.testID) return false;
  if (condition.label !== undefined && (info.label ?? '').toLowerCase() !== condition.label.toLowerCase()) return false;
  if (condition.text !== undefined && !info.text.toLowerCase().includes(condition.text.toLowerCase())) return false;
  return true;
}

function satisfied(condition: Condition): boolean {
  if (condition.text !== undefined || condition.testID !== undefined || condition.label !== undefined) {
    const present = takeSnapshot().entries.some((entry) => entry.info.interesting && matches(entry, condition));
    if (present === condition.gone) return false;
  }
  if (condition.networkIdle) {
    try {
      if (!networkIdle()) return false;
    } catch {
      // an unknown network state doesn't block the wait
    }
  }
  return true;
}

function describe(condition: Condition): string {
  const what =
    condition.text !== undefined
      ? `text "${condition.text}"`
      : condition.testID !== undefined
        ? `testID "${condition.testID}"`
        : condition.label !== undefined
          ? `label "${condition.label}"`
          : null;
  const element = what === null ? null : `${what} ${condition.gone ? 'to be gone' : 'to appear'}`;
  return [element, condition.networkIdle ? 'the network to be quiet' : null].filter((part) => part !== null).join(' and ');
}

export async function waitFor(raw: unknown): Promise<{ met: true; waitedMs: number }> {
  const condition = parse(raw);
  const started = Date.now();
  for (;;) {
    if (satisfied(condition)) return { met: true, waitedMs: Date.now() - started };
    const waited = Date.now() - started;
    if (waited >= condition.timeoutMs) {
      throw new TaplineError('timeout', `Waited ${Math.round(waited / 100) / 10} s for ${describe(condition)}; it didn't happen.`);
    }
    await new Promise<void>((resolve) => setTimeout(() => resolve(), Math.min(POLL_MS, condition.timeoutMs - waited)));
  }
}
