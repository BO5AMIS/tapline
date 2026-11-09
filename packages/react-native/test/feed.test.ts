import { startFrameFeed, type FeedDeps, type FeedFrame, type FeedOptions, type FrameFeed } from '../src/feed';

type CaptureParams = { format: 'jpg'; quality: number; maxWidth: number };
type CaptureResult = { mime: string; data: string; width?: number; height?: number };

interface PendingCapture {
  params: CaptureParams;
  startedAt: number;
  resolve: (result?: CaptureResult) => void;
  reject: (error: Error) => void;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

interface Env {
  feed: FrameFeed;
  sent: FeedFrame[];
  captures: PendingCapture[];
  clock: { now: number };
  timers: Timer[];
  listeners: Set<(revision: number) => void>;
  setRevision: (value: number) => void;
  commit: () => void;
  advance: (ms: number) => Promise<void>;
  /** Resolve capture number `index` (0-based) after `takes` ms of fake time. */
  finish: (index: number, takes?: number) => Promise<void>;
  fail: (index: number) => Promise<void>;
  frames: (t: number) => void;
  pendingFrameCallbacks: () => number;
  cancelledFrames: () => number;
}

interface EnvOptions extends FeedOptions {
  withRaf?: boolean;
  captureThrows?: boolean;
  sendThrows?: boolean;
}

function start(options: EnvOptions = {}): Env {
  const { withRaf = false, captureThrows = false, sendThrows = false, ...feedOptions } = options;
  const clock = { now: 0 };
  const sent: FeedFrame[] = [];
  const captures: PendingCapture[] = [];
  let timers: Timer[] = [];
  let nextTimerId = 1;
  const listeners = new Set<(revision: number) => void>();
  let revision = 0;
  const rafCallbacks = new Map<number, (t: number) => void>();
  let nextRaf = 1;
  let cancelled = 0;

  const deps: FeedDeps = {
    capture: (params) => {
      if (captureThrows) throw new Error('sync boom');
      return new Promise<CaptureResult>((resolve, reject) => {
        captures.push({
          params,
          startedAt: clock.now,
          resolve: (result) => resolve(result ?? { mime: 'image/jpeg', data: `frame-${captures.length}`, width: 400, height: 800 }),
          reject,
        });
      });
    },
    send: (frame) => {
      if (sendThrows) throw new Error('send boom');
      sent.push(frame);
    },
    onCommit: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commitRevision: () => revision,
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const timer: Timer = { id: nextTimerId++, at: clock.now + Math.max(0, ms), fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
  };
  if (withRaf) {
    deps.requestAnimationFrame = (fn) => {
      const id = nextRaf++;
      rafCallbacks.set(id, fn);
      return id;
    };
    deps.cancelAnimationFrame = (handle) => {
      cancelled += 1;
      if (typeof handle === 'number') rafCallbacks.delete(handle);
    };
  }

  const feed = startFrameFeed({ heartbeatMs: 100000, burstMs: 0, ...feedOptions }, deps);

  const advance = async (ms: number): Promise<void> => {
    const target = clock.now + ms;
    await flush();
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer.id !== due.id);
      clock.now = Math.max(clock.now, due.at);
      due.fn();
      await flush();
    }
    clock.now = target;
    await flush();
  };

  return {
    feed,
    sent,
    captures,
    clock,
    get timers() {
      return timers;
    },
    listeners,
    setRevision: (value) => {
      revision = value;
    },
    commit: () => {
      revision += 1;
      for (const listener of [...listeners]) listener(revision);
    },
    advance,
    finish: async (index, takes = 0) => {
      clock.now += takes;
      captures[index]?.resolve();
      await flush();
    },
    fail: async (index) => {
      captures[index]?.reject(new Error('capture failed'));
      await flush();
    },
    frames: (t) => {
      for (const [id, callback] of [...rafCallbacks]) {
        rafCallbacks.delete(id);
        callback(t);
      }
    },
    pendingFrameCallbacks: () => rafCallbacks.size,
    cancelledFrames: () => cancelled,
  };
}

describe('startFrameFeed', () => {
  it('captures one frame right away on start', async () => {
    const env = start();
    await flush();
    expect(env.captures).toHaveLength(1);
    expect(env.sent).toHaveLength(0);
    await env.finish(0);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]).toMatchObject({ seq: 1, mime: 'image/jpeg', width: 400, height: 800 });
  });

  it('gives one frame after settleMs for a burst of commits', async () => {
    const env = start();
    await env.finish(0);
    await env.advance(1000);
    env.commit();
    await env.advance(100);
    env.commit();
    await env.advance(100);
    env.commit();
    await env.advance(249);
    expect(env.captures).toHaveLength(1);
    await env.advance(1);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(5000);
    expect(env.captures).toHaveLength(2);
    expect(env.sent).toHaveLength(2);
  });

  it('respects minIntervalMs between captures', async () => {
    const env = start();
    await env.finish(0);
    await env.advance(10);
    env.commit();
    await env.advance(339);
    expect(env.captures).toHaveLength(1);
    await env.advance(1);
    expect(env.captures).toHaveLength(2);
  });

  it('honours custom settleMs and minIntervalMs', async () => {
    const env = start({ settleMs: 50, minIntervalMs: 100 });
    await env.finish(0);
    await env.advance(500);
    env.commit();
    await env.advance(49);
    expect(env.captures).toHaveLength(1);
    await env.advance(1);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    env.commit();
    await env.advance(99);
    expect(env.captures).toHaveLength(2);
    await env.advance(1);
    expect(env.captures).toHaveLength(3);
  });

  it('coalesces changes during an in-flight capture into exactly one more capture', async () => {
    const env = start();
    await flush();
    env.commit();
    await env.advance(400);
    env.commit();
    await env.advance(400);
    env.commit();
    await env.advance(2000);
    expect(env.captures).toHaveLength(1);
    await env.finish(0);
    await env.advance(5000);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(5000);
    expect(env.captures).toHaveLength(2);
    expect(env.sent).toHaveLength(2);
  });

  it('never runs two captures at once', async () => {
    const env = start({ heartbeatMs: 500 });
    await flush();
    await env.advance(3000);
    env.commit();
    env.feed.requestFrame();
    await env.advance(3000);
    expect(env.captures).toHaveLength(1);
  });

  it('sends a heartbeat frame when nothing was sent for heartbeatMs', async () => {
    const env = start({ heartbeatMs: 2000 });
    await env.finish(0);
    await env.advance(1999);
    expect(env.captures).toHaveLength(1);
    await env.advance(1);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(1999);
    expect(env.captures).toHaveLength(2);
    await env.advance(1);
    expect(env.captures).toHaveLength(3);
  });

  it('restarts the heartbeat wait after a frame is sent', async () => {
    const env = start({ heartbeatMs: 2000 });
    await env.finish(0);
    await env.advance(1500);
    env.commit();
    await env.advance(250);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(1999);
    expect(env.captures).toHaveLength(2);
    await env.advance(1);
    expect(env.captures).toHaveLength(3);
  });

  it('requestFrame captures as soon as allowed', async () => {
    const env = start();
    await env.finish(0);
    await env.advance(1000);
    env.feed.requestFrame();
    await env.advance(0);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(100);
    env.feed.requestFrame();
    await env.advance(249);
    expect(env.captures).toHaveLength(2);
    await env.advance(1);
    expect(env.captures).toHaveLength(3);
  });

  it('requestFrame skips the settle wait of a pending commit', async () => {
    const env = start();
    await env.finish(0);
    await env.advance(1000);
    env.commit();
    env.feed.requestFrame();
    await env.advance(0);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(5000);
    expect(env.captures).toHaveLength(2);
  });

  it('after requestFrame, keeps capturing for burstMs so a transition shows, then stops', async () => {
    const env = start({ burstMs: 1000 });
    await env.finish(0);
    await env.advance(1000);
    env.feed.requestFrame(); // t=1000: the burst runs until 2000
    await env.advance(0);
    expect(env.captures).toHaveLength(2);
    await env.finish(1, 40);
    await env.advance(309);
    expect(env.captures).toHaveLength(2);
    await env.advance(1); // t=1350, minIntervalMs after the last start
    expect(env.captures).toHaveLength(3);
    await env.finish(2, 40);
    await env.advance(310); // t=1700
    expect(env.captures).toHaveLength(4);
    await env.finish(3, 40); // the next one would start at 2050, after the burst
    await env.advance(5000);
    expect(env.captures).toHaveLength(4);
    expect(env.sent).toHaveLength(4);
  });

  it('numbers frames from 1 with the revision and time at capture start and the capture duration', async () => {
    const env = start();
    env.setRevision(5);
    await env.finish(0, 40);
    // the first capture started before setRevision: it saw revision 0
    expect(env.sent[0]).toMatchObject({ seq: 1, rev: 0, capturedAt: 0, captureMs: 40 });
    await env.advance(1000);
    env.setRevision(7);
    env.feed.requestFrame();
    await env.advance(0);
    env.setRevision(8); // changes after the capture started do not count
    await env.finish(1, 90);
    expect(env.sent[1]).toMatchObject({ seq: 2, rev: 7, capturedAt: 1040, captureMs: 90 });
    expect(env.sent[1]?.data).toBe('frame-2');
  });

  it('uses the balanced preset by default and follows setQuality', async () => {
    const env = start();
    expect(env.captures[0]?.params).toEqual({ format: 'jpg', quality: 0.6, maxWidth: 400 });
    await env.finish(0);
    env.feed.setQuality('sharp');
    await env.advance(1000);
    env.feed.requestFrame();
    await env.advance(0);
    expect(env.captures[1]?.params).toEqual({ format: 'jpg', quality: 0.75, maxWidth: 700 });
    await env.finish(1);
    env.feed.setQuality('light');
    await env.advance(1000);
    env.feed.requestFrame();
    await env.advance(0);
    expect(env.captures[2]?.params).toEqual({ format: 'jpg', quality: 0.5, maxWidth: 240 });
  });

  it('starts with the preset from the options', () => {
    const env = start({ quality: 'light' });
    expect(env.captures[0]?.params).toEqual({ format: 'jpg', quality: 0.5, maxWidth: 240 });
  });

  it('skips a failed capture and retries at the next trigger', async () => {
    const env = start();
    await env.fail(0);
    expect(env.sent).toHaveLength(0);
    await env.advance(1000);
    expect(env.captures).toHaveLength(1);
    env.commit();
    await env.advance(250);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.seq).toBe(1);
  });

  it('treats a capture that throws synchronously as a failure', async () => {
    const env = start({ captureThrows: true });
    await flush();
    expect(env.sent).toHaveLength(0);
    env.commit();
    await env.advance(1000);
    expect(env.sent).toHaveLength(0);
  });

  it('waits for the heartbeat after 3 failures in a row', async () => {
    const env = start({ heartbeatMs: 5000 });
    await env.fail(0); // failure 1 at t=0
    await env.advance(1000);
    env.commit();
    await env.advance(250);
    expect(env.captures).toHaveLength(2);
    await env.fail(1); // failure 2
    await env.advance(750);
    env.commit();
    await env.advance(250);
    expect(env.captures).toHaveLength(3);
    await env.fail(2); // failure 3 at t=2250
    await env.advance(500);
    env.commit();
    env.feed.requestFrame();
    await env.advance(3000);
    expect(env.captures).toHaveLength(3);
    await env.advance(1499);
    expect(env.captures).toHaveLength(3);
    await env.advance(1);
    expect(env.captures).toHaveLength(4); // heartbeat at 2250 + 5000
    await env.finish(3);
    expect(env.sent).toHaveLength(1);
    // a success ends the backoff: commits trigger captures again
    await env.advance(500);
    env.commit();
    await env.advance(250);
    expect(env.captures).toHaveLength(5);
  });

  it('keeps waiting for the heartbeat when the heartbeat capture fails too', async () => {
    const env = start({ heartbeatMs: 5000 });
    await env.fail(0);
    env.commit();
    await env.advance(400);
    await env.fail(1);
    await env.advance(1000);
    env.commit();
    await env.advance(400);
    await env.fail(2);
    await env.advance(6000);
    expect(env.captures).toHaveLength(4);
    await env.fail(3);
    env.commit();
    await env.advance(2000);
    expect(env.captures).toHaveLength(4);
  });

  it('never throws into the app when send throws', async () => {
    const env = start({ sendThrows: true });
    await env.finish(0);
    await env.advance(1000);
    env.commit();
    await env.advance(250);
    expect(env.captures).toHaveLength(2);
    expect(env.feed.stats().frames).toBe(1);
  });

  describe('stats', () => {
    it('counts frames and capture times', async () => {
      const env = start();
      expect(env.feed.stats()).toEqual({ frames: 0, avgCaptureMs: 0, maxCaptureMs: 0, observedFrames: 0, janky: 0, jankyWhileCapturing: 0 });
      await env.finish(0, 40);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(0);
      await env.finish(1, 100);
      expect(env.feed.stats()).toMatchObject({ frames: 2, avgCaptureMs: 70, maxCaptureMs: 100 });
    });

    it('counts janky animation frames, including those while capturing', async () => {
      const env = start({ withRaf: true });
      await flush();
      expect(env.pendingFrameCallbacks()).toBe(1);
      env.frames(0);
      env.frames(16);
      env.frames(32);
      env.frames(100); // 68 ms: janky, capture in flight
      await env.finish(0);
      env.frames(116);
      env.frames(200); // 84 ms: janky, no capture
      env.frames(216);
      env.frames(266); // exactly 50 ms: not janky
      expect(env.feed.stats()).toMatchObject({ observedFrames: 8, janky: 2, jankyWhileCapturing: 1 });
    });

    it('observes nothing without requestAnimationFrame', async () => {
      const env = start();
      await flush();
      expect(env.feed.stats()).toMatchObject({ observedFrames: 0, janky: 0, jankyWhileCapturing: 0 });
    });
  });

  describe('stop', () => {
    it('leaves no timers, listeners or animation-frame loop, and sends nothing afterwards', async () => {
      const env = start({ withRaf: true, heartbeatMs: 2000 });
      await env.finish(0);
      await env.advance(1000);
      env.commit();
      expect(env.timers.length).toBeGreaterThan(0);
      expect(env.listeners.size).toBe(1);
      env.feed.stop();
      expect(env.timers).toHaveLength(0);
      expect(env.listeners.size).toBe(0);
      expect(env.pendingFrameCallbacks()).toBe(0);
      expect(env.cancelledFrames()).toBe(1);
      env.commit();
      env.feed.requestFrame();
      await env.advance(10000);
      expect(env.captures).toHaveLength(1);
      expect(env.sent).toHaveLength(1);
      expect(env.timers).toHaveLength(0);
    });

    it('drops a capture that finishes after stop', async () => {
      const env = start();
      await flush();
      env.feed.stop();
      await env.finish(0);
      await env.advance(10000);
      expect(env.sent).toHaveLength(0);
      expect(env.captures).toHaveLength(1);
      expect(env.timers).toHaveLength(0);
    });

    it('is idempotent', async () => {
      const env = start({ withRaf: true });
      await flush();
      env.feed.stop();
      expect(() => env.feed.stop()).not.toThrow();
      expect(env.cancelledFrames()).toBe(1);
      expect(env.timers).toHaveLength(0);
    });

    it('ignores animation frames that arrive after stop', async () => {
      const env = start({ withRaf: true });
      await flush();
      env.frames(0);
      env.feed.stop();
      env.frames(16);
      expect(env.feed.stats().observedFrames).toBe(1);
    });
  });
});
