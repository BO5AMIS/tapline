/**
 * The in-app side of the live viewer: captures the app's own screen when the UI
 * changes (not at a fixed rate), plus a slow heartbeat, and hands each frame to a
 * sender. Capturing can make the app stutter, so it also measures animation-frame
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

const PRESETS: Record<QualityPreset, CaptureParams> = {
  sharp: { format: 'jpg', quality: 0.75, maxWidth: 700 },
  balanced: { format: 'jpg', quality: 0.6, maxWidth: 400 },
  light: { format: 'jpg', quality: 0.5, maxWidth: 240 },
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
  /** After requestFrame, keep capturing (every minIntervalMs) for this long, so a transition shows (default 1200). */
  burstMs?: number;
}

export interface FrameFeed {
  /** Stop everything; nothing fires afterwards. Safe to call twice. */
  stop(): void;
  /** Capture as soon as allowed (for example right after an action). */
  requestFrame(): void;
  setQuality(preset: QualityPreset): void;
  stats(): FeedStats;
}

const DEFAULT_SETTLE_MS = 250;
const DEFAULT_MIN_INTERVAL_MS = 350;
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_BURST_MS = 1200;
/** After this many failed captures in a row, only the heartbeat tries again. */
const MAX_FAILURES_IN_A_ROW = 3;
/** An animation frame longer than this counts as a stutter. */
const JANK_MS = 50;

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
  let preset: QualityPreset = options.quality ?? 'balanced';
  /** Until when requestFrame's burst keeps capturing. */
  let burstUntil = Number.NEGATIVE_INFINITY;

  let stopped = false;
  let capturing = false;
  /** A change (or request) arrived since the last capture started. */
  let pending = false;
  /** The pending capture was asked for by requestFrame: skip the settle wait. */
  let wantNow = false;
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
    if (capturing) {
      armHeartbeat();
      return;
    }
    startCapture();
  }

  /** (Re)schedule the capture a pending change is waiting for. */
  function reschedule(): void {
    if (stopped || capturing || !pending || failuresInARow >= MAX_FAILURES_IN_A_ROW) return;
    clearCaptureTimer();
    safely(() => {
      const settledAt = wantNow ? Number.NEGATIVE_INFINITY : lastCommitAt + settleMs;
      const due = Math.max(settledAt, lastStartAt + minIntervalMs);
      captureTimer = deps.setTimer(onCaptureTimer, Math.max(0, due - deps.now()));
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
    capturing = true;

    let startedAt = 0;
    let rev = 0;
    let request: Promise<{ mime: string; data: string; width?: number; height?: number }>;
    try {
      startedAt = deps.now();
      lastStartAt = startedAt;
      rev = deps.commitRevision();
      request = deps.capture({ ...PRESETS[preset] });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (result) => finishCapture(startedAt, rev, result),
      () => finishCapture(startedAt, rev, null),
    );
  }

  function finishCapture(
    startedAt: number,
    rev: number,
    result: { mime: string; data: string; width?: number; height?: number } | null,
  ): void {
    capturing = false;
    if (stopped) return;
    if (result === null) {
      failuresInARow += 1;
    } else {
      failuresInARow = 0;
      safely(() => {
        const captureMs = Math.max(0, deps.now() - startedAt);
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
    // During a burst, the next capture follows if it can start before the burst ends.
    safely(() => {
      if (failuresInARow === 0 && burstUntil > Math.max(deps.now(), lastStartAt + minIntervalMs)) {
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
      wantNow = true;
      safely(() => {
        burstUntil = Math.max(burstUntil, deps.now() + burstMs);
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
      };
    },
  };
}
