import { screenshot } from './actions';
import { emitEvent } from './events';
import { startFrameFeed, type FeedDeps, type FeedOptions, type FeedStats, type FrameFeed, type QualityPreset } from './feed';
import { nativeModule } from './native';
import { commitRevision, onCommit } from './register';
import { TaplineError, isRecord } from './types';

/**
 * The app's side of the live viewer: while the host asks for it (someone is watching), frames
 * of the app's window go to the host as `frame` events, captured when the UI changes.
 */

let feed: FrameFeed | null = null;
/** The gap override the running feed was started with (undefined: the live pace). */
let feedGapMs: number | undefined;
let overrides: Partial<FeedDeps> = {};

/**
 * The live viewer's pace. After an action or a person's input, a frame every 100 ms for the burst,
 * so a tap shows at once (V1). While the screen changes on its own, a frame every 160 ms: each
 * capture makes iOS render a fresh frame (view-shot's drawViewHierarchy afterScreenUpdates:YES), and
 * the whole phone pays about 4% of a core per frame a second (measured on an iPhone 14 Pro Max:
 * 100 ms +36%, 150 ms +26%, 200 ms +18%), so 160 ms keeps V6 (a) under 30% and the longest gap
 * near 0.2 s (V3 ≤ 0.25). Captures may also take at most a third of the time and must not make the
 * app stutter.
 */
const LIVE_PACE: FeedOptions = {
  settleMs: 80,
  minIntervalMs: 160,
  burstIntervalMs: 100,
  maxWaitMs: 160,
  dutyCycle: 0.33,
  backoffMaxMs: 1000,
  // A few slow frames only widen the gap to 220 ms. (Measured afterwards: the backoff rarely fires, and
  // the viewer's longest gap of 0.25 to 0.28 s comes from single captures that take 60 to 190 ms where
  // 30 ms is usual, since a frame arrives one capture time after its start.)
  backoffSoftMs: 220,
};
/**
 * The pace with Tapline's native module, whose frames draw what is on screen without making iOS
 * render a new one (`fresh: false`): about 15 frames a second (V2) while the screen changes. To be
 * measured on the phone against V6 (a); the duty cycle and the backoff still guard the app.
 */
const NATIVE_PACE: FeedOptions = {
  ...LIVE_PACE,
  settleMs: 40,
  minIntervalMs: 66,
  burstIntervalMs: 66,
  maxWaitMs: 66,
  // A native capture holds the main thread only while it draws (the JPEG is made off it), so its
  // whole time may take a larger share. Measured with the first native build: captures of 42 ms on
  // average with the JPEG on the main thread, 1 slow animation frame of 928 and none during a
  // capture; at a third the feed couldn't go past 7.5 fps.
  dutyCycle: 0.6,
  backoffSoftMs: 120,
};
/** Bounds of the `gapMs` override, which replaces the pace's gaps (for measuring). */
const MIN_GAP_MS = 30;
const MAX_GAP_MS = 2000;

function paceFor(gapMs: number | undefined): FeedOptions {
  const pace = nativeModule() !== null ? NATIVE_PACE : LIVE_PACE;
  if (gapMs === undefined) return pace;
  return { ...pace, minIntervalMs: gapMs, burstIntervalMs: gapMs, maxWaitMs: gapMs };
}

/** Replace parts of what the feed uses (tests). */
export function configureLiveFeed(next: Partial<FeedDeps>): void {
  overrides = next;
}

type Raf = (fn: (t: number) => void) => unknown;

function deps(): FeedDeps {
  const g = globalThis as { requestAnimationFrame?: Raf; cancelAnimationFrame?: (handle: unknown) => void };
  const base: FeedDeps = {
    // A viewer's frame shows what is on screen; it must not make iOS render one (native module only).
    capture: (params) => screenshot({ ...params, fresh: false }),
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

/**
 * `feed`: { on, quality?, gapMs? } starts or stops the frames; the answer includes the capture and
 * stutter stats. `gapMs` (30–2000) replaces the live pace's gaps, for measuring; a different value
 * restarts the feed.
 */
export async function feedMethod(raw: unknown): Promise<{ on: boolean; quality?: QualityPreset; stats?: FeedStats }> {
  if (!isRecord(raw) || typeof raw.on !== 'boolean') throw new TaplineError('bad_params', 'feed needs { on: true | false }');
  if (raw.quality !== undefined && !isPreset(raw.quality)) {
    throw new TaplineError('bad_params', 'quality is "sharp", "balanced" or "light"');
  }
  let gapMs: number | undefined;
  if (raw.gapMs !== undefined) {
    if (typeof raw.gapMs !== 'number' || !(raw.gapMs >= MIN_GAP_MS && raw.gapMs <= MAX_GAP_MS)) {
      throw new TaplineError('bad_params', `gapMs is a number of ms from ${MIN_GAP_MS} to ${MAX_GAP_MS}`);
    }
    gapMs = raw.gapMs;
  }
  const quality: QualityPreset = isPreset(raw.quality) ? raw.quality : 'balanced';
  if (raw.on) {
    if (feed && feedGapMs !== gapMs) stopLiveFeed();
    if (feed) feed.setQuality(quality);
    else {
      feed = startFrameFeed({ quality, ...paceFor(gapMs) }, deps());
      feedGapMs = gapMs;
    }
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
  feedGapMs = undefined;
  current?.stop();
}
