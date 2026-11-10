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
    await env.advance(60); // commits within maxWaitMs (400) of the first, so the quiet time decides
    env.commit();
    await env.advance(60);
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

  it('requestFrame waits for the action to be rendered, then captures (fallback after actionWaitMs)', async () => {
    const env = start();
    await env.finish(0);
    await env.advance(1000);
    env.feed.requestFrame();
    await env.advance(0);
    expect(env.captures).toHaveLength(1); // not at once any more
    await env.advance(120);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(100);
    env.feed.requestFrame(); // t=1220: the fallback is due at 1340, the gap allows 1470
    await env.advance(249);
    expect(env.captures).toHaveLength(2);
    await env.advance(1);
    expect(env.captures).toHaveLength(3);
  });

  it('a commit before requestFrame does not count as the action result (falls back after actionWaitMs)', async () => {
    const env = start();
    await env.finish(0);
    await env.advance(1000);
    env.commit();
    env.feed.requestFrame();
    await env.advance(119);
    expect(env.captures).toHaveLength(1);
    await env.advance(1);
    expect(env.captures).toHaveLength(2);
    await env.finish(1);
    await env.advance(5000);
    expect(env.captures).toHaveLength(2);
  });

  it('after requestFrame, keeps capturing every burstIntervalMs for burstMs so a transition shows, then stops', async () => {
    const env = start({ burstMs: 1000 });
    await env.finish(0);
    await env.advance(1000);
    env.feed.requestFrame(); // t=1000: the burst runs until 2000
    await env.advance(119);
    expect(env.captures).toHaveLength(1);
    await env.advance(1); // t=1120: the fallback capture
    expect(env.captures).toHaveLength(2);
    await env.finish(1, 40);
    await env.advance(109);
    expect(env.captures).toHaveLength(2);
    await env.advance(1); // t=1270, burstIntervalMs after the last start
    expect(env.captures).toHaveLength(3);
    await env.finish(2, 40);
    await env.advance(110); // t=1420
    expect(env.captures).toHaveLength(4);
    await env.finish(3, 40);
    await env.advance(110); // t=1570
    expect(env.captures).toHaveLength(5);
    await env.finish(4, 40);
    await env.advance(110); // t=1720
    expect(env.captures).toHaveLength(6);
    await env.finish(5, 40); // the next one starts at 1870, still in the burst
    await env.advance(110);
    expect(env.captures).toHaveLength(7);
    await env.finish(6, 40); // the next one would start at 2020, after the burst
    await env.advance(5000);
    expect(env.captures).toHaveLength(7);
    expect(env.sent).toHaveLength(7);
  });

  describe('requestFrame and the burst', () => {
    /** Resolve each capture 42 ms after it started, stepping the clock 1 ms at a time. */
    async function runWithCaptureTime(env: Env, ms: number, takes = 42): Promise<void> {
      let resolved = env.captures.length - 1; // the capture(s) before this call are done
      for (let i = 0; i < ms; i += 1) {
        await env.advance(1);
        const next = env.captures[resolved + 1];
        if (next && env.clock.now - next.startedAt >= takes) {
          resolved += 1;
          await env.finish(resolved);
        }
      }
    }

    it('captures commitDelayMs after the first commit that follows the request, and not before', async () => {
      const env = start();
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(30);
      env.commit();
      await env.advance(15);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(1046);
    });

    it('captures anyway actionWaitMs after the request when no commit comes', async () => {
      const env = start();
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(119);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(1120);
    });

    it('does not push the fallback deadline later when requested again while waiting', async () => {
      const env = start();
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(100);
      env.feed.requestFrame();
      await env.advance(19);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(1120);
    });

    it('honours custom commitDelayMs and actionWaitMs', async () => {
      const env = start({ commitDelayMs: 5, actionWaitMs: 40 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(10);
      env.commit();
      await env.advance(4);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      await env.finish(1);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(39);
      expect(env.captures).toHaveLength(2);
      await env.advance(1);
      expect(env.captures).toHaveLength(3);
    });

    it('in a 1200 ms burst, captures of 42 ms start 150 ms apart', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame(); // burst until 2200; the fallback capture starts at 1120
      await runWithCaptureTime(env, 1500);
      const starts = env.captures.slice(1).map((capture) => capture.startedAt);
      expect(starts).toEqual([1120, 1270, 1420, 1570, 1720, 1870, 2020, 2170]);
      expect(env.captures).toHaveLength(9);
    });

    it('after the result commit lands during a capture in a burst, the next capture starts as soon as it ends', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120); // capture 1 starts at 1120
      await env.advance(10);
      env.commit(); // t=1130, in flight
      await env.advance(32);
      await env.finish(1); // ends at 1162
      await env.advance(0);
      expect(env.captures).toHaveLength(3); // the result commit ignores the burst gap: 1162, not 1270
      expect(env.captures[2]?.startedAt).toBe(1162);
    });

    it('after a commit during a slow capture in a burst, the next capture starts when it ends', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120); // capture 1 starts at 1120
      await env.advance(10);
      env.commit();
      await env.advance(190);
      expect(env.captures).toHaveLength(2); // t=1320, still in flight
      await env.finish(1);
      await env.advance(0);
      expect(env.captures).toHaveLength(3);
      expect(env.captures[2]?.startedAt).toBe(1320);
    });

    it('during a burst, the result commit captures commitDelayMs later; the next commit respects the burst gap', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120); // capture 1 at 1120
      await env.finish(1);
      await env.advance(5);
      env.commit(); // t=1125: the result commit; 16 ms later is 1141, the gap is ignored
      await env.advance(15);
      expect(env.captures).toHaveLength(2);
      await env.advance(1);
      expect(env.captures).toHaveLength(3);
      expect(env.captures[2]?.startedAt).toBe(1141);
      await env.finish(2);
      await env.advance(9);
      env.commit(); // t=1150: an ordinary commit; 1166, but the gap allows 1291
      await env.advance(140);
      expect(env.captures).toHaveLength(3);
      await env.advance(1);
      expect(env.captures).toHaveLength(4);
      expect(env.captures[3]?.startedAt).toBe(1291);
    });

    describe('the result-commit skip', () => {
      it('a commit at 130 after the fallback capture (120-162) captures at 162, not 270', async () => {
        const env = start({ burstMs: 1200 });
        await env.finish(0);
        await env.advance(1000);
        env.feed.requestFrame();
        await env.advance(120);
        expect(env.captures[1]?.startedAt).toBe(1120);
        await env.advance(10);
        env.commit(); // t=1130
        await env.advance(32); // t=1162
        await env.finish(1);
        await env.advance(0);
        expect(env.captures).toHaveLength(3);
        expect(env.captures[2]?.startedAt).toBe(1162);
      });

      it('a commit at 200 after the fallback capture captures at 216; a second commit at 230 follows the burst gap (366)', async () => {
        const env = start({ burstMs: 1200 });
        await env.finish(0);
        await env.advance(1000);
        env.feed.requestFrame();
        await env.advance(162); // capture 1 runs 1120-1162
        await env.finish(1);
        await env.advance(38);
        env.commit(); // t=1200: the fallback did not use up the skip
        await env.advance(15);
        expect(env.captures).toHaveLength(2);
        await env.advance(1);
        expect(env.captures).toHaveLength(3);
        expect(env.captures[2]?.startedAt).toBe(1216);
        await env.advance(14);
        env.commit(); // t=1230, while capture 2 runs (1216-1258)
        await env.advance(28);
        await env.finish(2);
        await env.advance(107);
        expect(env.captures).toHaveLength(3); // t=1365
        await env.advance(1);
        expect(env.captures).toHaveLength(4);
        expect(env.captures[3]?.startedAt).toBe(1366); // max(1246, 1216 + 150)
      });

      it('a commit at 30, before the fallback, captures at 46; a later commit follows the burst gap', async () => {
        const env = start({ burstMs: 1200 });
        await env.finish(0);
        await env.advance(1000);
        env.feed.requestFrame();
        await env.advance(30);
        env.commit();
        await env.advance(15);
        expect(env.captures).toHaveLength(1);
        await env.advance(1);
        expect(env.captures).toHaveLength(2);
        expect(env.captures[1]?.startedAt).toBe(1046);
        await env.finish(1, 42);
        await env.advance(12);
        env.commit(); // t=1100: 1116, but the gap allows 1196
        await env.advance(95);
        expect(env.captures).toHaveLength(2);
        await env.advance(1);
        expect(env.captures).toHaveLength(3);
        expect(env.captures[2]?.startedAt).toBe(1196);
      });

      it('is used once per request, and a new requestFrame re-arms it', async () => {
        const env = start({ burstMs: 1200 });
        await env.finish(0);
        await env.advance(1000);
        env.feed.requestFrame();
        await env.advance(30);
        env.commit(); // the result commit: capture at 1046
        await env.advance(16);
        expect(env.captures).toHaveLength(2);
        await env.finish(1);
        await env.advance(14);
        env.commit(); // t=1060: skip used up, the burst gap allows 1196
        await env.advance(10);
        env.feed.requestFrame(); // t=1070: re-armed
        await env.advance(10);
        env.commit(); // t=1080: the new result commit, 1096
        await env.advance(15);
        expect(env.captures).toHaveLength(2); // t=1095
        await env.advance(1);
        expect(env.captures).toHaveLength(3);
        expect(env.captures[2]?.startedAt).toBe(1096);
      });

      it('is dropped when the burst has ended: a commit then waits settleMs', async () => {
        const env = start({ burstMs: 100 });
        await env.finish(0);
        await env.advance(1000);
        env.feed.requestFrame(); // burst until 1100; the fallback capture is at 1120
        await env.advance(120);
        await env.finish(1);
        await env.advance(80);
        env.commit(); // t=1200: settled at 1450, the gap allows 1470
        await env.advance(269);
        expect(env.captures).toHaveLength(2);
        await env.advance(1);
        expect(env.captures).toHaveLength(3);
        expect(env.captures[2]?.startedAt).toBe(1470);
      });

      it('a result capture that a heartbeat capture overtook does not go stale after the burst', async () => {
        const env = start({ heartbeatMs: 100, settleMs: 20, minIntervalMs: 40, burstMs: 206 });
        await env.finish(0);
        await env.advance(30);
        env.feed.requestFrame(); // burst until 236
        await env.advance(120); // the fallback capture starts at 150
        await env.finish(1); // the heartbeat is re-armed for 250
        await env.advance(85);
        env.commit(); // t=235, in the burst: the result capture is due at 251
        await env.advance(15); // t=250: the heartbeat capture starts first
        expect(env.captures).toHaveLength(3);
        expect(env.captures[2]?.startedAt).toBe(250);
        await env.advance(50);
        await env.finish(2); // t=300; the burst is over
        await env.advance(5);
        env.commit(); // t=305: an ordinary commit waits settleMs (the old code captured at once)
        await env.advance(0);
        expect(env.captures).toHaveLength(3);
        await env.advance(19);
        expect(env.captures).toHaveLength(3);
        await env.advance(1);
        expect(env.captures).toHaveLength(4);
        expect(env.captures[3]?.startedAt).toBe(325);
      });

      it('stop() clears a scheduled result capture', async () => {
        const env = start({ burstMs: 1200 });
        await env.finish(0);
        await env.advance(1000);
        env.feed.requestFrame();
        await env.advance(30);
        env.commit();
        env.feed.stop();
        expect(env.timers).toHaveLength(0);
        await env.advance(5000);
        expect(env.captures).toHaveLength(1);
      });
    });

    it('after the burst ends, a commit waits settleMs and the gap is 350 again', async () => {
      const env = start({ burstMs: 100 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame(); // burst until 1100, over before the fallback
      await env.advance(120); // capture 1 at 1120
      await env.finish(1);
      await env.advance(380);
      env.commit(); // t=1500
      await env.advance(249);
      expect(env.captures).toHaveLength(2);
      await env.advance(1); // 1750: settleMs of quiet
      expect(env.captures).toHaveLength(3);
      await env.finish(2);
      await env.advance(10);
      env.commit(); // t=1760: settled at 2010, the gap allows 2100
      await env.advance(339);
      expect(env.captures).toHaveLength(3);
      await env.advance(1);
      expect(env.captures).toHaveLength(4);
      expect(env.captures[3]?.startedAt).toBe(2100);
    });

    it('in a burst, a commit at lastStart + 145 delays the follow-up capture to the commit + 16', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120); // capture 1 starts at 1120
      await env.finish(1); // ends at once; the follow-up is due at 1270
      await env.advance(145);
      env.commit(); // t=1265
      await env.advance(5); // t=1270: the old code captured here
      expect(env.captures).toHaveLength(2);
      await env.advance(10);
      expect(env.captures).toHaveLength(2); // t=1280
      await env.advance(1);
      expect(env.captures).toHaveLength(3);
      expect(env.captures[2]?.startedAt).toBe(1281);
    });

    it('the heartbeat starts no capture while an action capture is awaited, and the action capture still happens', async () => {
      const env = start({ heartbeatMs: 100, burstMs: 1200 });
      await env.finish(0);
      await env.advance(50);
      env.feed.requestFrame(); // t=50, fallback at 170; the heartbeat (armed at 0) fires at 100
      await env.advance(69); // t=119: the heartbeat at 100 deferred
      expect(env.captures).toHaveLength(1);
      await env.advance(21); // t=140
      env.commit(); // due at 156 (the burst gap allows 150); the re-armed heartbeat fires at 200
      await env.advance(15);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(156);
    });

    it('a request during a capture that fails for the 3rd time still lets the heartbeat recover', async () => {
      const env = start({ heartbeatMs: 5000, burstMs: 1200 });
      await env.fail(0); // failure 1 at t=0
      await env.advance(1000);
      env.commit();
      await env.advance(250);
      expect(env.captures).toHaveLength(2);
      await env.fail(1); // failure 2 at t=1250
      await env.advance(750);
      env.commit();
      await env.advance(250);
      expect(env.captures).toHaveLength(3); // starts at t=2250
      await env.advance(10);
      env.feed.requestFrame(); // t=2260, during the capture
      await env.advance(10);
      await env.fail(2); // failure 3 at t=2270, the heartbeat is re-armed for 7270
      await env.advance(4999);
      expect(env.captures).toHaveLength(3);
      await env.advance(1);
      expect(env.captures).toHaveLength(4);
      expect(env.captures[3]?.startedAt).toBe(7270);
    });

    it('a request during a capture starts the next at max(capture end, commit + 16, lastStart + gap)', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120); // capture 1 starts at 1120
      await env.advance(20);
      env.feed.requestFrame(); // t=1140, during the capture; the fallback is due at 1260
      await env.advance(60);
      env.commit(); // t=1200: due at 1216, the gap allows 1270
      await env.advance(100); // t=1300
      expect(env.captures).toHaveLength(2); // still in flight
      await env.finish(1); // ends at 1300, after all three
      await env.advance(0);
      expect(env.captures).toHaveLength(3);
      expect(env.captures[2]?.startedAt).toBe(1300);
    });

    it('a request during a fast capture waits for the result commit + 16 only', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120); // capture 1 starts at 1120
      await env.advance(20);
      env.feed.requestFrame(); // t=1140
      await env.finish(1); // ends at 1140
      await env.advance(60);
      env.commit(); // t=1200: the result commit, due at 1216 (the gap would allow 1270)
      await env.advance(15);
      expect(env.captures).toHaveLength(2);
      await env.advance(1);
      expect(env.captures).toHaveLength(3);
      expect(env.captures[2]?.startedAt).toBe(1216);
    });

    it('a commit at the last moment before the actionWaitMs deadline gives one capture at 120', async () => {
      const env = start();
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(119);
      env.commit(); // t=1119: capture due at min(1120, 1135) = 1120
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(1120);
      await env.finish(1);
      await env.advance(5000);
      expect(env.captures).toHaveLength(2);
    });

    it('stop() while waiting for the action commit means no capture ever starts', async () => {
      const env = start({ burstMs: 1200 });
      await env.finish(0);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(30);
      env.feed.stop();
      expect(env.timers).toHaveLength(0);
      env.commit();
      await env.advance(10000);
      expect(env.captures).toHaveLength(1);
      expect(env.timers).toHaveLength(0);
    });
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
    await env.advance(120); // the action-wait fallback starts the capture
    env.setRevision(8); // changes after the capture started do not count
    await env.finish(1, 90);
    expect(env.sent[1]).toMatchObject({ seq: 2, rev: 7, capturedAt: 1160, captureMs: 90 });
    expect(env.sent[1]?.data).toBe('frame-2');
  });

  it('uses the balanced preset by default and follows setQuality', async () => {
    const env = start();
    expect(env.captures[0]?.params).toEqual({ format: 'jpg', quality: 0.6, maxWidth: 660 });
    await env.finish(0);
    env.feed.setQuality('sharp');
    await env.advance(1000);
    env.feed.requestFrame();
    await env.advance(120);
    expect(env.captures[1]?.params).toEqual({ format: 'jpg', quality: 0.75, maxWidth: 880 });
    await env.finish(1);
    env.feed.setQuality('light');
    await env.advance(1000);
    env.feed.requestFrame();
    await env.advance(120);
    expect(env.captures[2]?.params).toEqual({ format: 'jpg', quality: 0.5, maxWidth: 330 });
  });

  it('starts with the preset from the options', () => {
    const env = start({ quality: 'light' });
    expect(env.captures[0]?.params).toEqual({ format: 'jpg', quality: 0.5, maxWidth: 330 });
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

  describe('maxWaitMs (continuous commits outside a burst)', () => {
    it('captures about every 400 ms while commits arrive every 16 ms, not only on the heartbeat', async () => {
      const env = start();
      await env.finish(0);
      let handled = 1;
      for (let i = 0; i < 125; i += 1) {
        await env.advance(16);
        env.commit();
        while (handled < env.captures.length) {
          await env.finish(handled);
          handled += 1;
        }
      }
      const starts = env.captures.map((capture) => capture.startedAt);
      expect(starts.length).toBeGreaterThanOrEqual(5); // the first, plus about one per 400 ms in 2 s
      expect(starts[1]).toBe(416);
      for (let i = 1; i < starts.length; i += 1) {
        const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(350);
        if (i > 1) expect(gap).toBeLessThanOrEqual(450);
      }
    });

    it('a single commit followed by quiet captures at commit + settleMs, as before', async () => {
      const env = start();
      await env.finish(0);
      await env.advance(1000);
      env.commit();
      await env.advance(249);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(1250);
    });

    it('respects a custom maxWaitMs', async () => {
      const env = start({ maxWaitMs: 100, minIntervalMs: 50 });
      await env.finish(0);
      for (let i = 0; i < 6; i += 1) {
        await env.advance(16);
        env.commit();
      }
      expect(env.captures).toHaveLength(1); // t=96
      await env.advance(20); // t=116: the first commit (16) + 100, long before the quiet time (96 + 250)
      expect(env.captures).toHaveLength(2);
      expect(env.captures[1]?.startedAt).toBe(116);
    });
  });

  describe('pacing: dutyCycle and backoffMaxMs', () => {
    const pace = { settleMs: 10, minIntervalMs: 100, maxWaitMs: 100 };

    it('without them, the plain gap holds however long captures take', async () => {
      const env = start(pace);
      await env.finish(0, 60);
      env.commit();
      await env.advance(39); // t=99
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures[1]?.startedAt).toBe(100);
    });

    it('dutyCycle widens the gap to the recent capture time divided by it', async () => {
      const env = start({ ...pace, dutyCycle: 0.25 });
      await env.finish(0, 60); // 60 ms at a quarter of the time: one capture every 240 ms
      env.commit();
      await env.advance(179); // t=239
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures[1]?.startedAt).toBe(240);
    });

    it('dutyCycle follows faster captures back down to the plain gap', async () => {
      const env = start({ ...pace, dutyCycle: 0.5 });
      await env.finish(0, 80); // 160 ms gap
      let handled = 1;
      for (let i = 0; i < 40; i += 1) {
        env.commit();
        await env.advance(20);
        while (handled < env.captures.length) {
          await env.finish(handled, 10);
          handled += 1;
        }
      }
      const starts = env.captures.map((capture) => capture.startedAt);
      expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(160);
      const last = (starts[starts.length - 1] ?? 0) - (starts[starts.length - 2] ?? 0);
      expect(last).toBeLessThanOrEqual(120);
    });

    it('one slow frame near a capture is not enough to back off', async () => {
      const env = start({ ...pace, withRaf: true, backoffMaxMs: 1000 });
      await flush();
      env.frames(0);
      env.frames(100); // 100 ms while capture 0 runs: a first strike only
      await env.finish(0);
      env.commit();
      await env.advance(100);
      expect(env.captures[1]?.startedAt).toBe(100);
    });

    it('slow frames during captures double the gap from the second, and clean captures shrink it again', async () => {
      const env = start({ ...pace, withRaf: true, backoffMaxMs: 1000 });
      await flush();
      env.frames(0);
      env.frames(16);
      env.frames(100); // 84 ms while capture 0 runs: first strike
      env.frames(200); // 100 ms, still during it: second strike, backoff 200
      await env.finish(0);
      env.commit();
      await env.advance(199);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures[1]?.startedAt).toBe(200);
      await env.finish(1); // clean: 200 × 0.85 = 170
      env.commit();
      await env.advance(169);
      expect(env.captures).toHaveLength(2);
      await env.advance(1);
      expect(env.captures[2]?.startedAt).toBe(370);
    });

    it('the backoff stops at backoffMaxMs', async () => {
      const env = start({ ...pace, withRaf: true, backoffMaxMs: 500 });
      await flush();
      for (let i = 0; i < 6; i += 1) env.frames(i * 100); // five slow frames while capture 0 runs
      await env.finish(0);
      env.commit();
      await env.advance(499);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures[1]?.startedAt).toBe(500);
    });

    it('counts a slow frame right after a capture, but not one later', async () => {
      const near = start({ ...pace, withRaf: true, backoffMaxMs: 1000 });
      await flush();
      await near.finish(0);
      await near.advance(30);
      near.frames(0);
      near.frames(80); // 30 ms after the capture ended: first strike
      near.frames(160); // still within 50 ms of it on the clock: second strike, backoff 200
      near.commit();
      await near.advance(169); // t=199: backoff 200 from the start at 0
      expect(near.captures).toHaveLength(1);
      await near.advance(1);
      expect(near.captures).toHaveLength(2);

      const later = start({ ...pace, withRaf: true, backoffMaxMs: 1000 });
      await flush();
      await later.finish(0);
      await later.advance(60);
      later.frames(0);
      later.frames(80); // 60 ms after the capture ended: not the capture's doing
      later.frames(160);
      later.commit();
      await later.advance(10); // t=70: settleMs after the commit; the plain gap (100) decides
      expect(later.captures).toHaveLength(1);
      await later.advance(30);
      expect(later.captures[1]?.startedAt).toBe(100);
    });

    it('keeps the live pace through an action and its answer while the screen keeps changing', async () => {
      const env = start({
        settleMs: 80,
        minIntervalMs: 100,
        burstIntervalMs: 100,
        maxWaitMs: 100,
        burstMs: 1200,
        dutyCycle: 0.33,
        backoffMaxMs: 1000,
        heartbeatMs: 1000,
      });
      await env.finish(0, 30);
      let handled = 1;
      // 120 Hz: a commit every 8 ms, sooner than commitDelayMs (16), so a delay counted from the
      // latest commit would never come due.
      for (let t = 0; t < 6000; t += 8) {
        if (t === 1008) env.feed.requestFrame(); // the handler ran
        if (t === 3008) env.feed.requestFrame(); // the answer, after a 2 s settle
        env.commit();
        await env.advance(8);
        while (handled < env.captures.length) {
          await env.finish(handled, 30);
          handled += 1;
        }
      }
      const starts = env.captures.map((capture) => capture.startedAt);
      let longest = 0;
      for (let i = 1; i < starts.length; i += 1) longest = Math.max(longest, (starts[i] ?? 0) - (starts[i - 1] ?? 0));
      expect(longest).toBeLessThanOrEqual(250);
    });

    it('with backoffSoftMs the first slow frames only widen the gap to it; from the fifth it doubles', async () => {
      const env = start({ ...pace, withRaf: true, backoffMaxMs: 1000, backoffSoftMs: 220 });
      await flush();
      env.frames(0);
      env.frames(100); // strike 1: nothing
      env.frames(200); // strike 2: the soft gap
      await env.finish(0);
      env.commit();
      await env.advance(219);
      expect(env.captures).toHaveLength(1);
      await env.advance(1);
      expect(env.captures[1]?.startedAt).toBe(220);
      expect(env.feed.stats().backoffs).toBe(1);
      env.frames(300); // strike 3, during capture 1: still the soft gap
      env.frames(400); // strike 4: still soft
      env.frames(500); // strike 5: now it doubles (220 x 2)
      await env.finish(1);
      env.commit();
      await env.advance(439);
      expect(env.captures).toHaveLength(2);
      await env.advance(1);
      expect(env.captures[2]?.startedAt).toBe(660);
    });

    it('without backoffMaxMs a slow frame changes nothing', async () => {
      const env = start({ ...pace, withRaf: true });
      await flush();
      env.frames(0);
      env.frames(100);
      await env.finish(0);
      env.commit();
      await env.advance(100);
      expect(env.captures[1]?.startedAt).toBe(100);
    });
  });

  describe('stats', () => {
    it('counts frames and capture times', async () => {
      const env = start();
      expect(env.feed.stats()).toEqual({
        frames: 0,
        avgCaptureMs: 0,
        maxCaptureMs: 0,
        observedFrames: 0,
        janky: 0,
        jankyWhileCapturing: 0,
        failures: 0,
        heartbeats: 0,
        backoffs: 0,
      });
      await env.finish(0, 40);
      await env.advance(1000);
      env.feed.requestFrame();
      await env.advance(120);
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

    it('counts failed captures with the last message, and heartbeat captures', async () => {
      const env = start({ heartbeatMs: 1000 });
      await env.fail(0);
      expect(env.feed.stats()).toMatchObject({ failures: 1, lastFailure: 'capture failed', heartbeats: 0 });
      await env.advance(1000);
      expect(env.captures).toHaveLength(2);
      expect(env.feed.stats().heartbeats).toBe(1);
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
