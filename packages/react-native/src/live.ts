import { screenshot } from './actions';
import { emitEvent } from './events';
import { startFrameFeed, type FeedDeps, type FeedStats, type FrameFeed, type QualityPreset } from './feed';
import { commitRevision, onCommit } from './register';
import { TaplineError, isRecord } from './types';

/**
 * The app's side of the live viewer: while the host asks for it (someone is watching), frames
 * of the app's window go to the host as `frame` events, captured when the UI changes.
 */

let feed: FrameFeed | null = null;
let overrides: Partial<FeedDeps> = {};

/** Replace parts of what the feed uses (tests). */
export function configureLiveFeed(next: Partial<FeedDeps>): void {
  overrides = next;
}

type Raf = (fn: (t: number) => void) => unknown;

function deps(): FeedDeps {
  const g = globalThis as { requestAnimationFrame?: Raf; cancelAnimationFrame?: (handle: unknown) => void };
  const base: FeedDeps = {
    capture: (params) => screenshot(params),
    send: (frame) => emitEvent('frame', frame),
    onCommit,
    commitRevision,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  if (typeof g.requestAnimationFrame === 'function') base.requestAnimationFrame = (fn) => g.requestAnimationFrame?.(fn);
  if (typeof g.cancelAnimationFrame === 'function') base.cancelAnimationFrame = (handle) => g.cancelAnimationFrame?.(handle);
  const merged: FeedDeps = { ...base, ...overrides };
  // `requestAnimationFrame: undefined` in overrides turns the stutter measurement off.
  if ('requestAnimationFrame' in overrides && overrides.requestAnimationFrame === undefined) {
    delete merged.requestAnimationFrame;
    delete merged.cancelAnimationFrame;
  }
  return merged;
}

function isPreset(value: unknown): value is QualityPreset {
  return value === 'sharp' || value === 'balanced' || value === 'light';
}

/** `feed`: { on, quality? } starts or stops the frames; the answer includes the capture and stutter stats. */
export async function feedMethod(raw: unknown): Promise<{ on: boolean; quality?: QualityPreset; stats?: FeedStats }> {
  if (!isRecord(raw) || typeof raw.on !== 'boolean') throw new TaplineError('bad_params', 'feed needs { on: true | false }');
  if (raw.quality !== undefined && !isPreset(raw.quality)) {
    throw new TaplineError('bad_params', 'quality is "sharp", "balanced" or "light"');
  }
  const quality: QualityPreset = isPreset(raw.quality) ? raw.quality : 'balanced';
  if (raw.on) {
    if (feed) feed.setQuality(quality);
    else feed = startFrameFeed({ quality }, deps());
    return { on: true, quality, stats: feed.stats() };
  }
  const stats = feed?.stats();
  stopLiveFeed();
  return stats ? { on: false, stats } : { on: false };
}

/** After an action: capture soon, so viewers see its result. */
export function frameAfterAction(): void {
  feed?.requestFrame();
}

export function stopLiveFeed(): void {
  const current = feed;
  feed = null;
  current?.stop();
}
