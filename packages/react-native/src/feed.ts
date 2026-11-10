/**
 * The in-app side of the live viewer: captures the app's own screen when the UI
 * changes (not at a fixed rate), plus a slow heartbeat, and hands each frame to a
 * sender. After an action (`requestFrame`) it waits for the action's commit, captures
 * right after it, and keeps capturing at a shorter gap for a burst so a transition
 * shows. Capturing can make the app stutter, so it also measures animation-frame
 * jank while the feed runs. Everything the feed needs from the outside is injected
 * (`FeedDeps`), so it runs against a fake clock in tests.
 *
 * This file must not import react or react-native.
 */

export type QualityPreset = 'sharp' | 'balanced' | 'light';

interface CaptureParams {
  format: 'jpg';
  quality: number;
  maxWidth: number;
}

// QUALITY-BAR V5: sharp ≥ 2.0, balanced ≥ 1.5, light ≥ 0.75 px per point, met on the widest iPhone
// (440 pt); narrower phones get a little more.
const PRESETS: Record<QualityPreset, CaptureParams> = {
  sharp: { format: 'jpg', quality: 0.75, maxWidth: 880 },
  balanced: { format: 'jpg', quality: 0.6, maxWidth: 660 },
  light: { format: 'jpg', quality: 0.5, maxWidth: 330 },
};

export interface FeedFrame {
  /** 1, 2, 3, ... in the order frames are sent. */
  seq: number;
  /** The commit revision when the capture started. */
  rev: number;
  /** now() when the capture started. */
  capturedAt: number;
  /** How long the capture took, in ms. */
  captureMs: number;
  mime: string;
  /** Base64 image data. */
  data: string;
  width?: number;
  height?: number;
}

export interface FeedStats {
  /** Frames sent. */
  frames: number;
  avgCaptureMs: number;
  maxCaptureMs: number;
  /** Animation frames seen while the feed ran. */
  observedFrames: number;
  /** Animation frames that came more than 50 ms after the previous one. */
  janky: number;
  /** Of those, how many happened while a capture was in flight. */
  jankyWhileCapturing: number;
  /** Captures that failed, and the last failure's message. */
  failures: number;
  lastFailure?: string;
  /** Captures the heartbeat started (nothing else asked for one within heartbeatMs). */
  heartbeats: number;
}

export interface FeedDeps {
  capture: (params: CaptureParams) => Promise<{ mime: string; data: string; width?: number; height?: number }>;
  send: (frame: FeedFrame) => void;
  onCommit: (listener: (revision: number) => void) => () => void;
  commitRevision: () => number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  requestAnimationFrame?: (fn: (t: number) => void) => unknown;
  cancelAnimationFrame?: (handle: unknown) => void;
}

export interface FeedOptions {
  quality?: QualityPreset;
  /** Quiet time to wait after the last commit before capturing (default 250). */
  settleMs?: number;
  /** The least time between the starts of two captures (default 350). */
  minIntervalMs?: number;
  /** Capture a frame if none was sent for this long (default 1000). */
  heartbeatMs?: number;
  /** After requestFrame, keep capturing (every burstIntervalMs) for this long, so a transition shows (default 1200). */
  burstMs?: number;
  /** During a burst, the least time between the starts of two captures (default 150). */
  burstIntervalMs?: number;
  /** After the commit that shows an action's result, wait this long before capturing (default 16). */
  commitDelayMs?: number;
  /** After requestFrame, capture anyway if no commit arrived within this time (default 120). */
  actionWaitMs?: number;
  /** Outside a burst, capture at the latest this long after the first unseen commit, even if commits keep coming (default 400). */
  maxWaitMs?: number;
  /**
   * The largest share of the time captures may take: the gap between capture starts is at least the
   * recent capture time divided by this (0.33: a 30 ms capture allows one every 90 ms). Off when unset.
   */
  dutyCycle?: number;
  /**
   * Back off when capturing makes the app stutter: from the second animation frame slower than 50 ms
   * during or right after a capture (within 20 clean captures), each one doubles the gap (up to this
   * many ms); each clean capture shrinks it again. Off when unset.
   */
  backoffMaxMs?: number;
}

export interface FrameFeed {
  /** Stop everything; nothing fires afterwards. Safe to call twice. */
  stop(): void;
  /** Call right after an action: captures once its result is rendered (or after actionWaitMs), then keeps capturing for a burst. */
  requestFrame(): void;
  setQuality(preset: QualityPreset): void;
  stats(): FeedStats;
}

const DEFAULT_SETTLE_MS = 250;
const DEFAULT_MIN_INTERVAL_MS = 350;
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_BURST_MS = 1200;
const DEFAULT_BURST_INTERVAL_MS = 150;
const DEFAULT_COMMIT_DELAY_MS = 16;
const DEFAULT_ACTION_WAIT_MS = 120;
const DEFAULT_MAX_WAIT_MS = 400;
/** After this many failed captures in a row, only the heartbeat tries again. */
const MAX_FAILURES_IN_A_ROW = 3;
/** An animation frame longer than this counts as a stutter. */
const JANK_MS = 50;
/** Weight of the newest capture in the recent capture time. */
const CAPTURE_TIME_WEIGHT = 0.3;
/** Each clean capture shrinks the backoff to this share; below the plain gap it ends. */
const BACKOFF_DECAY = 0.85;
/** The backoff starts at the second slow frame near a capture... */
const BACKOFF_STRIKES = 2;
/** ...counted since this many clean captures in a row. */
const BACKOFF_FORGET_AFTER = 20;

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // never break the app because of the feed
  }
}

export function startFrameFeed(options: FeedOptions, deps: FeedDeps): FrameFeed {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const burstMs = options.burstMs ?? DEFAULT_BURST_MS;
  const burstIntervalMs = options.burstIntervalMs ?? DEFAULT_BURST_INTERVAL_MS;
  const commitDelayMs = options.commitDelayMs ?? DEFAULT_COMMIT_DELAY_MS;
  const actionWaitMs = options.actionWaitMs ?? DEFAULT_ACTION_WAIT_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const dutyCycle = options.dutyCycle !== undefined && options.dutyCycle > 0 ? options.dutyCycle : undefined;
  const backoffMaxMs = options.backoffMaxMs;
  let preset: QualityPreset = options.quality ?? 'balanced';
  /** Recent capture time in ms (a moving average), or null before the first frame. */
  let recentCaptureMs: number | null = null;
  /** The stutter backoff: the gap between capture starts is at least this (0: none). */
  let backoffMs = 0;
  /** A slow animation frame was seen during (or right after) the current capture. */
  let jankThisCapture = false;
  /** Slow frames near a capture since the last BACKOFF_FORGET_AFTER clean captures in a row. */
  let jankStrikes = 0;
  let cleanInARow = 0;
  let lastFinishAt = Number.NEGATIVE_INFINITY;
  /** The first commit since the last capture started (null: none yet). */
  let pendingSince: number | null = null;
  /** Until when requestFrame's burst keeps capturing. */
  let burstUntil = Number.NEGATIVE_INFINITY;

  let stopped = false;
  let capturing = false;
  /** A change (or request) arrived since the last capture started. */
  let pending = false;
  /** The pending capture follows a burst capture: no settle wait, only the burst gap. */
  let wantNow = false;
  /** requestFrame was called and the action's result has not been captured yet. */
  let waitingForAction = false;
  /** A commit arrived since requestFrame (it already set actionDueAt). */
  let actionCommitSeen = false;
  /** When the action's capture is due: the fallback, or the first commit plus commitDelayMs. */
  let actionDueAt = Number.POSITIVE_INFINITY;
  /** requestFrame armed the once-per-action skip: the first commit after it is the action's result. */
  let resultSkipArmed = false;
  /** When the capture for the action's result commit is due (ignores the burst gap), or null. */
  let resultDueAt: number | null = null;
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let failuresInARow = 0;
  let seq = 0;

  let captureTimer: unknown = null;
  let hasCaptureTimer = false;
  let heartbeatTimer: unknown = null;
  let hasHeartbeatTimer = false;
  let unsubscribe: (() => void) | null = null;
  let rafHandle: unknown = null;
  let hasRafHandle = false;
  let lastFrameTime: number | null = null;

  let frames = 0;
  let totalCaptureMs = 0;
  let maxCaptureMs = 0;
  let observedFrames = 0;
  let janky = 0;
  let jankyWhileCapturing = 0;
  let failures = 0;
  let lastFailure: string | undefined;
  let heartbeats = 0;

  function clearCaptureTimer(): void {
    if (!hasCaptureTimer) return;
    const handle = captureTimer;
    captureTimer = null;
    hasCaptureTimer = false;
    safely(() => deps.clearTimer(handle));
  }

  function clearHeartbeatTimer(): void {
    if (!hasHeartbeatTimer) return;
    const handle = heartbeatTimer;
    heartbeatTimer = null;
    hasHeartbeatTimer = false;
    safely(() => deps.clearTimer(handle));
  }

  function armHeartbeat(): void {
    clearHeartbeatTimer();
    if (stopped) return;
    safely(() => {
      heartbeatTimer = deps.setTimer(onHeartbeat, heartbeatMs);
      hasHeartbeatTimer = true;
    });
  }

  function onHeartbeat(): void {
    heartbeatTimer = null;
    hasHeartbeatTimer = false;
    if (stopped) return;
    // An action's capture is on its way (within actionWaitMs); it will do. The bound
    // keeps a stuck waiting state from blocking the heartbeat for good.
    if (capturing || (waitingForAction && deps.now() <= actionDueAt + heartbeatMs)) {
      armHeartbeat();
      return;
    }
    heartbeats += 1;
    startCapture();
  }

  /** The gap between capture starts: the plain gap, widened by the capture-time budget and the backoff. */
  function paced(base: number): number {
    let gap = base;
    if (dutyCycle !== undefined && recentCaptureMs !== null) gap = Math.max(gap, recentCaptureMs / dutyCycle);
    return Math.max(gap, backoffMs);
  }

  function onCaptureJank(): void {
    jankThisCapture = true;
    cleanInARow = 0;
    jankStrikes += 1;
    // One slow frame can be anything (a GC, the app's own work); stutter that captures cause comes back.
    if (backoffMaxMs === undefined || jankStrikes < BACKOFF_STRIKES) return;
    backoffMs = Math.min(backoffMaxMs, Math.max(backoffMs * 2, minIntervalMs * 2));
  }

  /** (Re)schedule the capture a pending change is waiting for. */
  function reschedule(): void {
    if (stopped || capturing || !pending || failuresInARow >= MAX_FAILURES_IN_A_ROW) return;
    clearCaptureTimer();
    safely(() => {
      const now = deps.now();
      const inBurst = now < burstUntil;
      const gap = paced(inBurst ? burstIntervalMs : minIntervalMs);
      // A result capture that no capture covered (a heartbeat started first) goes stale once the burst ends.
      if (!inBurst) resultDueAt = null;
      if (resultDueAt !== null) {
        // The action's result commit: no burst gap, only the commit delay (and the capture in flight, handled by `capturing`).
        captureTimer = deps.setTimer(onCaptureTimer, Math.max(0, resultDueAt - now));
        hasCaptureTimer = true;
        return;
      }
      // The commit delay counts from the first commit not yet captured: on a 120 Hz screen commits
      // come every 8 ms, so counting from the latest would push the capture back for as long as
      // the screen keeps changing.
      const firstUnseen = pendingSince ?? lastCommitAt;
      let readyAt: number;
      if (waitingForAction) readyAt = actionDueAt;
      else if (wantNow) readyAt = lastCommitAt > lastStartAt ? firstUnseen + commitDelayMs : Number.NEGATIVE_INFINITY;
      else if (inBurst) readyAt = firstUnseen + commitDelayMs;
      // Debounce with a maximum wait: continuous commits still get a capture every maxWaitMs.
      else readyAt = Math.min(lastCommitAt + settleMs, (pendingSince ?? lastCommitAt) + maxWaitMs);
      const due = Math.max(readyAt, lastStartAt + gap);
      captureTimer = deps.setTimer(onCaptureTimer, Math.max(0, due - now));
      hasCaptureTimer = true;
    });
  }

  function onCaptureTimer(): void {
    captureTimer = null;
    hasCaptureTimer = false;
    startCapture();
  }

  function startCapture(): void {
    if (stopped || capturing) return;
    clearCaptureTimer();
    pending = false;
    wantNow = false;
    pendingSince = null;
    waitingForAction = false;
    actionCommitSeen = false;
    capturing = true;
    jankThisCapture = false;

    let startedAt = 0;
    let rev = 0;
    let request: Promise<{ mime: string; data: string; width?: number; height?: number }>;
    try {
      startedAt = deps.now();
      lastStartAt = startedAt;
      // This capture shows the result commit when it starts after the commit delay.
      if (resultDueAt !== null && startedAt >= resultDueAt) resultDueAt = null;
      rev = deps.commitRevision();
      request = deps.capture({ ...PRESETS[preset] });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (result) => finishCapture(startedAt, rev, result),
      (error: unknown) => {
        failures += 1;
        safely(() => {
          lastFailure = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        });
        finishCapture(startedAt, rev, null);
      },
    );
  }

  function finishCapture(
    startedAt: number,
    rev: number,
    result: { mime: string; data: string; width?: number; height?: number } | null,
  ): void {
    capturing = false;
    if (stopped) return;
    safely(() => {
      lastFinishAt = deps.now();
    });
    if (result === null) {
      failuresInARow += 1;
    } else {
      failuresInARow = 0;
      if (!jankThisCapture) {
        cleanInARow += 1;
        if (cleanInARow >= BACKOFF_FORGET_AFTER) jankStrikes = 0;
        if (backoffMs > 0) {
          backoffMs *= BACKOFF_DECAY;
          if (backoffMs < minIntervalMs) backoffMs = 0;
        }
      }
      safely(() => {
        const captureMs = Math.max(0, deps.now() - startedAt);
        recentCaptureMs =
          recentCaptureMs === null ? captureMs : recentCaptureMs * (1 - CAPTURE_TIME_WEIGHT) + captureMs * CAPTURE_TIME_WEIGHT;
        seq += 1;
        frames += 1;
        totalCaptureMs += captureMs;
        maxCaptureMs = Math.max(maxCaptureMs, captureMs);
        const frame: FeedFrame = { seq, rev, capturedAt: startedAt, captureMs, mime: result.mime, data: result.data };
        if (result.width !== undefined) frame.width = result.width;
        if (result.height !== undefined) frame.height = result.height;
        deps.send(frame);
      });
    }
    // A frame was sent, or we gave up for now: either way the heartbeat wait starts over.
    armHeartbeat();
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
      waitingForAction = false;
      resultDueAt = null;
    }
    // During a burst, the next capture follows if it can start before the burst ends.
    safely(() => {
      if (failuresInARow === 0 && burstUntil > Math.max(deps.now(), lastStartAt + burstIntervalMs)) {
        pending = true;
        wantNow = true;
      }
    });
    reschedule();
  }

  function onCommitted(): void {
    if (stopped) return;
    lastCommitAt = deps.now();
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW) return;
    pending = true;
    if (pendingSince === null) pendingSince = lastCommitAt;
    if (resultSkipArmed) {
      // The first commit after a request is the action's result; after the burst the skip is dropped.
      resultSkipArmed = false;
      if (lastCommitAt < burstUntil) resultDueAt = lastCommitAt + commitDelayMs;
    }
    if (waitingForAction && !actionCommitSeen) {
      actionCommitSeen = true;
      actionDueAt = Math.min(actionDueAt, lastCommitAt + commitDelayMs);
    }
    reschedule();
  }

  function watchAnimationFrames(): void {
    const request = deps.requestAnimationFrame;
    if (!request) return;
    const tick = (t: number): void => {
      if (stopped) return;
      observedFrames += 1;
      if (lastFrameTime !== null && t - lastFrameTime > JANK_MS) {
        janky += 1;
        if (capturing) jankyWhileCapturing += 1;
        // A frame held up by a capture can arrive just after it ends.
        let nearCapture = capturing;
        safely(() => {
          if (deps.now() - lastFinishAt <= JANK_MS) nearCapture = true;
        });
        if (nearCapture) onCaptureJank();
      }
      lastFrameTime = t;
      next();
    };
    const next = (): void => {
      safely(() => {
        rafHandle = request(tick);
        hasRafHandle = true;
      });
    };
    next();
  }

  safely(() => {
    unsubscribe = deps.onCommit(onCommitted);
  });
  watchAnimationFrames();
  armHeartbeat();
  startCapture();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      pending = false;
      waitingForAction = false;
      resultSkipArmed = false;
      resultDueAt = null;
      clearCaptureTimer();
      clearHeartbeatTimer();
      const unsub = unsubscribe;
      unsubscribe = null;
      if (unsub) safely(unsub);
      if (hasRafHandle) {
        const handle = rafHandle;
        rafHandle = null;
        hasRafHandle = false;
        const cancel = deps.cancelAnimationFrame;
        if (cancel) safely(() => cancel(handle));
      }
    },

    requestFrame(): void {
      if (stopped || failuresInARow >= MAX_FAILURES_IN_A_ROW) return;
      pending = true;
      safely(() => {
        const now = deps.now();
        burstUntil = Math.max(burstUntil, now + burstMs);
        resultSkipArmed = true;
        // The first request fixes the fallback deadline; later ones do not push it back.
        if (!waitingForAction) {
          waitingForAction = true;
          actionCommitSeen = false;
          actionDueAt = now + actionWaitMs;
        }
      });
      reschedule();
    },

    setQuality(next: QualityPreset): void {
      if (next in PRESETS) preset = next;
    },

    stats(): FeedStats {
      return {
        frames,
        avgCaptureMs: frames === 0 ? 0 : totalCaptureMs / frames,
        maxCaptureMs,
        observedFrames,
        janky,
        jankyWhileCapturing,
        failures,
        ...(lastFailure !== undefined ? { lastFailure } : {}),
        heartbeats,
      };
    },
  };
}
