import { measureScrollers, visiblePartOnGlass } from './glassclip';
import { measureFiber, takeSnapshot, type Entry } from './inspect';
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
  /** Only elements that show on the glass count (a journey in a user's eyes, AGENT-TOOLS 1.12 §17.1). */
  glass: boolean;
  networkIdle: boolean;
  /** One read, no poll and no timeout: the check behind `if` and `optional` (AGENT-TOOLS 1.13 §9.1). */
  once: boolean;
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
    once: raw.once === true,
    ...(text !== undefined ? { text } : {}),
    ...(testID !== undefined ? { testID } : {}),
    ...(label !== undefined ? { label } : {}),
    gone: raw.gone === true,
    glass: raw.glass === true,
    networkIdle: wantsNetwork,
    timeoutMs: timeout * 1000,
  };
}

function matches(entry: Entry, condition: Condition): boolean {
  const { info } = entry;
  if (condition.testID !== undefined && info.testID !== condition.testID) return false;
  // As a `label` target matches: the element's own label, else its text.
  if (condition.label !== undefined && (info.label ?? info.text).toLowerCase() !== condition.label.toLowerCase()) return false;
  if (condition.text !== undefined && !info.text.toLowerCase().includes(condition.text.toLowerCase())) return false;
  return true;
}

/** Whether an element matching the condition is there now (and, with `glass`, shows on the glass). */
async function presentNow(condition: Condition): Promise<boolean> {
  const snapshot = takeSnapshot();
  const found = snapshot.entries.filter((entry) => entry.info.interesting && matches(entry, condition));
  if (!condition.glass) return found.length > 0;
  // A container's text holds everything inside it, clipped or not: only the innermost matches say what shows.
  const innermost = found.filter(
    (entry) =>
      !found.some((other) => {
        if (other === entry) return false;
        for (let p = other.node.parent; p >= 0; p = snapshot.nodes[p]?.parent ?? -1) if (p === entry.node.index) return true;
        return false;
      }),
  );
  // The scroll views are measured once for this poll, not once per candidate.
  const scrollers = innermost.length > 0 ? await measureScrollers(snapshot) : new Map();
  for (const entry of innermost) {
    // A native tab has no frame to measure: it is on the glass.
    const frame = entry.tab ? null : await measureFiber(entry.node.fiber);
    if (visiblePartOnGlass(snapshot, entry, frame, scrollers) !== null) return true;
  }
  return false;
}

async function satisfied(condition: Condition): Promise<boolean> {
  if (condition.text !== undefined || condition.testID !== undefined || condition.label !== undefined) {
    const present = await presentNow(condition);
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
        ? `id "${condition.testID}"`
        : condition.label !== undefined
          ? `label "${condition.label}"`
          : null;
  // The words Tapwright uses too (AGENT-TOOLS §5): `id` as the agent writes it, "to disappear".
  const element = what === null ? null : `${what} ${condition.gone ? 'to disappear' : 'to appear'}`;
  return [element, condition.networkIdle ? 'the network to be quiet' : null].filter((part) => part !== null).join(' and ');
}

export async function waitFor(raw: { once: true } & Record<string, unknown>): Promise<{ found: boolean }>;
export async function waitFor(raw: unknown): Promise<{ met: true; waitedMs: number }>;
export async function waitFor(raw: unknown): Promise<{ met: true; waitedMs: number } | { found: boolean }> {
  const condition = parse(raw);
  // Same matching as the polling path below, so the two never disagree about one screen.
  if (condition.once) return { found: await satisfied(condition) };
  const started = Date.now();
  for (;;) {
    if (await satisfied(condition)) return { met: true, waitedMs: Date.now() - started };
    const waited = Date.now() - started;
    if (waited >= condition.timeoutMs) {
      throw new TaplineError('timeout', `Waited ${Math.round(waited / 100) / 10} s for ${describe(condition)}; it didn't happen.`);
    }
    await new Promise<void>((resolve) => setTimeout(() => resolve(), Math.min(POLL_MS, condition.timeoutMs - waited)));
  }
}
