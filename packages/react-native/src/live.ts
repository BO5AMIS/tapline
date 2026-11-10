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
  minIntervalMs: 60,
  burstIntervalMs: 60,
  // While the screen keeps changing, the wait counts from the first commit after the last capture
  // started (about 8 ms in), so 66 here (with a 66 ms gap) gave a frame every 74 to 80 ms: 12 fps,
  // and 50 gave 14. 44 lets the 60 ms gap between capture starts decide.
  maxWaitMs: 44,
  // A native capture holds the main thread only while it draws (the JPEG is made off it), so its
  // whole time may take a larger share. Measured with the first native build: captures of 42 ms on
  // average with the JPEG on the main thread, 1 slow animation frame of 928 and none during a
  // capture; at a third the feed couldn't go past 7.5 fps, at 0.6 it gave 12 fps (V6 (a) 23.5%).
  // With the JPEG off the main thread (the second native build) a capture's 46 ms are mostly
  // off it, so the share counts less against the app's own frames.
  dutyCycle: 0.75,
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

/**
 * Flow control with a host that acknowledges frames (`frameAcks` in its welcome): at most
 * `MAX_IN_FLIGHT` frames on their way. On a link slower than the feed, frames would otherwise pile
 * up and arrive in bunches with long gaps between them (V3); held back, the frame rate follows the
 * link and every frame that arrives is recent. Measured on the phone over Wi-Fi at 15 fps: 100 KB
 * frames arrived with gaps up to 300 ms, 35 KB frames with none over 80 ms.
 */
const MAX_IN_FLIGHT = 2;
/** An acknowledgement that doesn't come within this long is taken as lost (the link moves on). */
const ACK_TIMEOUT_MS = 2000;
let frameAcks = false;
let inFlight = 0;
let lastFlowAt = 0;

/** Whether the host acknowledges frames (from its welcome); resets the count either way. */
export function setFrameAcks(on: boolean): void {
  frameAcks = on;
  resetLink();
}

/**
 * Adaptive quality (with acknowledgements): when frames take long to reach the host, the feed
 * steps down a preset (smaller frames), and steps back up to the chosen one once the link is quick
 * again, as video players do. Measured on the phone over Wi-Fi: at 15 fps, balanced frames (about
 * 100 KB) arrived with gaps near 300 ms even with flow control, light frames (35 KB) with none over
 * 80 ms. The chosen preset stays the ceiling; a still screen soon gets it back.
 */
const LADDER: QualityPreset[] = ['light', 'balanced', 'sharp'];
/** A smoothed send-to-acknowledgement time above this steps the quality down. */
const SLOW_LINK_MS = 150;
/** Below this, held for `RECOVER_AFTER_MS`, the quality steps back up. */
const QUICK_LINK_MS = 70;
const RECOVER_AFTER_MS = 2000;
/**
 * Stepping back up waits until the screen is nearly still (at most this many frames sent in the
 * last second): during motion the link already showed it can't carry the bigger frames, and going
 * up and down every few seconds brought back the long gaps (measured: 17 gaps over 150 ms in 20 s).
 */
const STILL_FRAMES_PER_S = 3;
const LATENCY_WEIGHT = 0.3;
let chosenQuality: QualityPreset = 'balanced';
let appliedQuality: QualityPreset = 'balanced';
let sentAt: number[] = [];
/** When the latest frames were sent (the last second's worth): how much the screen is moving. */
let recentSends: number[] = [];
let latencyMs: number | null = null;
let lastQualityChangeAt = 0;

function resetLink(): void {
  inFlight = 0;
  sentAt = [];
  recentSends = [];
  latencyMs = null;
}

/** The host received a frame. */
export function onFrameAck(): void {
  inFlight = Math.max(0, inFlight - 1);
  const now = Date.now();
  lastFlowAt = now;
  const sent = sentAt.shift();
  if (sent === undefined) return;
  const latency = now - sent;
  latencyMs = latencyMs === null ? latency : latencyMs * (1 - LATENCY_WEIGHT) + latency * LATENCY_WEIGHT;
  adaptQuality(now);
}

/**
 * The adaptive step: one preset down while the link is slow, one up (to at most `chosen`) once it
 * has been quick for a while and the screen is nearly still; else `applied` as it is.
 */
export function nextQuality(
  applied: QualityPreset,
  chosen: QualityPreset,
  link: { latencyMs: number; sinceChangeMs: number; framesLastSecond: number },
): QualityPreset {
  const step = LADDER.indexOf(applied);
  const ceiling = LADDER.indexOf(chosen);
  if (step > ceiling) return chosen;
  if (link.latencyMs > SLOW_LINK_MS && step > 0) return LADDER[step - 1] ?? applied;
  if (
    link.latencyMs < QUICK_LINK_MS &&
    step < ceiling &&
    link.sinceChangeMs >= RECOVER_AFTER_MS &&
    link.framesLastSecond <= STILL_FRAMES_PER_S
  ) {
    return LADDER[step + 1] ?? applied;
  }
  return applied;
}

function adaptQuality(now: number): void {
  if (feed === null || latencyMs === null) return;
  const next = nextQuality(appliedQuality, chosenQuality, {
    latencyMs,
    sinceChangeMs: now - lastQualityChangeAt,
    framesLastSecond: recentSends.filter((t) => now - t <= 1000).length,
  });
  if (next === appliedQuality) return;
  appliedQuality = next;
  lastQualityChangeAt = now;
  feed.setQuality(next);
}

function canSend(): boolean {
  if (!frameAcks || inFlight < MAX_IN_FLIGHT) return true;
  if (Date.now() - lastFlowAt > ACK_TIMEOUT_MS) {
    resetLink();
    return true;
  }
  return false;
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
    send: (frame) => {
      if (frameAcks) {
        inFlight += 1;
        lastFlowAt = Date.now();
        sentAt.push(lastFlowAt);
        recentSends = [...recentSends.filter((t) => lastFlowAt - t <= 1000), lastFlowAt];
      }
      emitEvent('frame', frame);
    },
    canSend,
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
    // The viewer's choice is the ceiling of the adaptive quality, and applies at once.
    chosenQuality = quality;
    appliedQuality = quality;
    lastQualityChangeAt = Date.now();
    latencyMs = null;
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
