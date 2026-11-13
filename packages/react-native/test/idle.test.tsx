import { frame, mount, unmountAll, useFrames } from './helpers';
import React, { useRef, useState } from 'react';
import { Animated, LayoutAnimation, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { runCommand } from '../src/commands';
import { defaultCapabilities } from '../src/client';
import { collectNodes, resetRefs, setMeasurer } from '../src/inspect';
import * as idleModule from '../src/idle';
import { configureKnowIdle, installIdleSignals, isKnowIdle, resetKnowIdle, setKnowIdle, waitUntilIdle } from '../src/idle';
import { installNetworkTracking, startedRequests, uninstallNetworkTracking } from '../src/network';

// AGENT-TOOLS 1.13 (F1, know-don't-watch): answer once every signal the SDK can see says idle, then wait
// one or two frames. A signal it can't see (Reanimated, a sheet, timers) keeps today's 100 ms quiet window.

const holder = globalThis as { __reanimatedModuleProxy?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };

// React Native 0.88 removed InteractionManager (its getter throws), and older versions still have it:
// a stand-in on the module shows the patch works where it exists, and the real getter shows it is safe where it doesn't.
const rn = require('react-native') as Record<string, unknown>;
const realInteractionManager = Object.getOwnPropertyDescriptor(rn, 'InteractionManager');
const InteractionManager = {
  next: 1,
  createInteractionHandle(): number {
    return InteractionManager.next++;
  },
  clearInteractionHandle(_handle: number): void {},
};

beforeAll(() => {
  Object.defineProperty(rn, 'InteractionManager', { configurable: true, value: InteractionManager });
});

afterAll(() => {
  if (realInteractionManager) Object.defineProperty(rn, 'InteractionManager', realInteractionManager);
});

const original = {
  timing: Animated.timing,
  configureNext: LayoutAnimation.configureNext,
  create: InteractionManager.createInteractionHandle,
};

type Fetch =(input: unknown, init?: unknown) => Promise<unknown>;

afterEach(async () => {
  setKnowIdle(false);
  delete holder.__reanimatedModuleProxy;
  uninstallNetworkTracking();
  // Pending Animated frames and polls must not outlive the test ("Jest environment torn down").
  jest.clearAllTimers();
  jest.useRealTimers();
  configureActions({ quietMs: 0, capMs: 0 });
  await unmountAll();
});

describe('waitUntilIdle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    installIdleSignals();
  });

  afterEach(() => setKnowIdle(false));

  /** Resolves once `waitUntilIdle` has answered, or reports it has not after `ms`. */
  async function answersWithin(ms: number, requestMark = startedRequests()): Promise<{ settledMs: number; usedFallback: boolean; capped: boolean } | null> {
    let result: { settledMs: number; usedFallback: boolean; capped: boolean } | null = null;
    void waitUntilIdle({ frames: 2, capMs: 2000, requestMark }).then((r) => {
      result = r;
    });
    await jest.advanceTimersByTimeAsync(ms);
    return result;
  }

  test('idle with nothing pending answers in about 2 frames, not 100 ms', async () => {
    const result = await answersWithin(40);
    expect(result).toEqual({ settledMs: 32, usedFallback: false, capped: false });
  });

  test('one frame answers in about 16 ms', async () => {
    let result: { settledMs: number } | null = null;
    void waitUntilIdle({ frames: 1, capMs: 2000, requestMark: startedRequests() }).then((r) => {
      result = r;
    });
    await jest.advanceTimersByTimeAsync(20);
    expect(result).toEqual({ settledMs: 16, usedFallback: false, capped: false });
  });

  test('each signal holds the answer and releases it when it ends: handle, Animated, LayoutAnimation', async () => {
    // handle
    const handle = InteractionManager.createInteractionHandle();
    let done = false;
    void waitUntilIdle({ frames: 2, capMs: 5000, requestMark: startedRequests() }).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(300);
    expect(done).toBe(false);
    InteractionManager.clearInteractionHandle(handle);
    await jest.advanceTimersByTimeAsync(40);
    expect(done).toBe(true);

    // Animated.timing
    done = false;
    const value = new Animated.Value(0);
    Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: false }).start();
    void waitUntilIdle({ frames: 2, capMs: 5000, requestMark: startedRequests() }).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(200);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);

    // LayoutAnimation (its end callback may never come: a timer at the duration releases it)
    done = false;
    const jsOnly = jest.fn();
    LayoutAnimation.configureNext({ duration: 250, update: { type: 'linear' } }, jsOnly);
    void waitUntilIdle({ frames: 2, capMs: 5000, requestMark: startedRequests() }).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(200);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(300);
    expect(done).toBe(true);
  });

  test('a request the action started holds the answer; one that began before `since` does not', async () => {
    let release: (value: unknown) => void = () => undefined;
    const target: { XMLHttpRequest: unknown; fetch: Fetch } = {
      XMLHttpRequest: class {
        open(): void {}
        send(): void {}
        abort(): void {}
      },
      fetch: () => new Promise((resolve) => (release = resolve)),
    };
    installNetworkTracking({ target });
    const old = target.fetch('https://api.example.com/poll');
    void old;
    await jest.advanceTimersByTimeAsync(50);
    const mark = startedRequests();
    // the poll began before the action: it never holds
    expect(await answersWithin(40, mark)).toEqual({ settledMs: 32, usedFallback: false, capped: false });
    release({ status: 200, headers: { get: () => null } });
    await jest.advanceTimersByTimeAsync(0);

    let finish: (value: unknown) => void = () => undefined;
    target.fetch = () => new Promise((resolve) => (finish = resolve));
    installNetworkTracking({ target });
    uninstallNetworkTracking();
    installNetworkTracking({ target });
    const started = startedRequests();
    const started1 = target.fetch('https://api.example.com/trips');
    void started1;
    let done = false;
    void waitUntilIdle({ frames: 2, capMs: 5000, requestMark: started }).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(400);
    expect(done).toBe(false);
    finish({ status: 200, headers: { get: () => null } });
    await jest.advanceTimersByTimeAsync(40);
    expect(done).toBe(true);
  });

  test('Reanimated present uses the 100 ms window: it says usedFallback at once', async () => {
    holder.__reanimatedModuleProxy = {};
    expect(await answersWithin(0)).toEqual({ settledMs: 0, usedFallback: true, capped: false });
  });

  test('a looping Animated makes it blind (usedFallback)', async () => {
    const value = new Animated.Value(0);
    Animated.loop(Animated.timing(value, { toValue: 1, duration: 300, useNativeDriver: false })).start();
    expect(await answersWithin(0)).toEqual({ settledMs: 0, usedFallback: true, capped: false });
  });

  test('without installed signals it is blind', async () => {
    setKnowIdle(false);
    expect(await answersWithin(0)).toEqual({ settledMs: 0, usedFallback: true, capped: false });
  });

  test('the cap still ends the wait', async () => {
    InteractionManager.createInteractionHandle();
    let result: { settledMs: number; usedFallback: boolean; capped: boolean } | null = null;
    void waitUntilIdle({ frames: 2, capMs: 500, requestMark: startedRequests() }).then((r) => {
      result = r;
    });
    await jest.advanceTimersByTimeAsync(600);
    expect(result).toEqual({ settledMs: 500, usedFallback: false, capped: true });
  });
});

describe('the patches', () => {
  test('the patched APIs behave as before for the app: callbacks run, return values are unchanged', async () => {
    jest.useFakeTimers();
    installIdleSignals();
    const handle = InteractionManager.createInteractionHandle();
    expect(typeof handle).toBe('number');
    InteractionManager.clearInteractionHandle(handle);
    const seen: unknown[] = [];
    const animation = Animated.timing(new Animated.Value(0), { toValue: 1, duration: 50, useNativeDriver: false });
    expect(typeof animation.start).toBe('function');
    expect(typeof animation.stop).toBe('function');
    animation.start((result) => seen.push(result));
    await jest.advanceTimersByTimeAsync(120);
    expect(seen).toEqual([{ finished: true }]);
    const ended = jest.fn();
    LayoutAnimation.configureNext({ duration: 10, update: { type: 'linear' } }, ended);
    await jest.advanceTimersByTimeAsync(300);
  });

  test('uninstall restores every patched function', () => {
    const before = {
      timing: Animated.timing,
      spring: Animated.spring,
      loop: Animated.loop,
      configureNext: LayoutAnimation.configureNext,
      create: InteractionManager.createInteractionHandle,
      clear: InteractionManager.clearInteractionHandle,
    };
    const uninstall = installIdleSignals();
    expect(Animated.timing).not.toBe(before.timing);
    expect(InteractionManager.createInteractionHandle).not.toBe(before.create);
    uninstall();
    expect(Animated.timing).toBe(before.timing);
    expect(Animated.spring).toBe(before.spring);
    expect(Animated.loop).toBe(before.loop);
    expect(LayoutAnimation.configureNext).toBe(before.configureNext);
    expect(InteractionManager.createInteractionHandle).toBe(before.create);
    expect(InteractionManager.clearInteractionHandle).toBe(before.clear);
  });

  test('installing twice patches once; the flag is on while installed', () => {
    const first = Animated.timing;
    installIdleSignals();
    const patched = Animated.timing;
    installIdleSignals();
    expect(Animated.timing).toBe(patched);
    expect(isKnowIdle()).toBe(true);
    setKnowIdle(false);
    expect(Animated.timing).toBe(first);
    expect(isKnowIdle()).toBe(false);
  });

  test('InteractionManager missing (React Native 0.88: the getter throws) is fine', () => {
    if (realInteractionManager) Object.defineProperty(rn, 'InteractionManager', realInteractionManager);
    try {
      const uninstall = installIdleSignals();
      expect(isKnowIdle()).toBe(true);
      uninstall();
    } finally {
      Object.defineProperty(rn, 'InteractionManager', { configurable: true, value: InteractionManager });
    }
  });

  test('a missing function is fine: nothing throws, nothing is patched there', () => {
    const real = LayoutAnimation.configureNext;
    Object.defineProperty(LayoutAnimation, 'configureNext', { value: undefined, configurable: true, writable: true });
    try {
      const uninstall = installIdleSignals();
      uninstall();
    } finally {
      Object.defineProperty(LayoutAnimation, 'configureNext', { value: real, configurable: true, writable: true });
    }
    expect(LayoutAnimation.configureNext).toBe(real);
  });

  test('with the flag off nothing is patched', () => {
    expect(isKnowIdle()).toBe(false);
    expect(Animated.timing).toBe(original.timing);
    expect(LayoutAnimation.configureNext).toBe(original.configureNext);
    expect(InteractionManager.createInteractionHandle).toBe(original.create);
  });
});

describe('the settle command and the capability', () => {
  test('settle {mode: "quiet"} switches the path off for the session', async () => {
    configureKnowIdle(true);
    expect(isKnowIdle()).toBe(true);
    expect((await runCommand({ name: 'settle', args: { mode: 'quiet' } })).result).toEqual({ mode: 'quiet' });
    expect(isKnowIdle()).toBe(false);
  });

  test('settle never switches know on: that comes only from knowIdle in startTapline', async () => {
    await expect(runCommand({ name: 'settle', args: { mode: 'know' } })).rejects.toMatchObject({ code: 'internal' });
    expect(isKnowIdle()).toBe(false);
    await expect(runCommand({ name: 'settle', args: { mode: 'fast' } })).rejects.toMatchObject({ code: 'internal' });
  });

  test("the next session starts from the app's own setting", async () => {
    configureKnowIdle(true);
    await runCommand({ name: 'settle', args: { mode: 'quiet' } });
    resetKnowIdle();
    expect(isKnowIdle()).toBe(true);
    configureKnowIdle(false);
    resetKnowIdle();
    expect(isKnowIdle()).toBe(false);
  });

  test('the app announces the idle capability', () => {
    expect(defaultCapabilities()).toContain('idle');
  });
});

describe('the same final tree as the 100 ms path', () => {
  const okResponse = { status: 200, headers: { get: () => null } };

  interface Fixture {
    net: { XMLHttpRequest: unknown; fetch: Fetch };
  }

  function App({ net }: Fixture): React.ReactElement {
    const [sheet, setSheet] = useState(false);
    const [items, setItems] = useState<string[]>([]);
    const [reply, setReply] = useState('');
    const slide = useRef(new Animated.Value(0)).current;
    return (
      <View>
        <Pressable
          testID="open-sheet"
          onPress={() => {
            Animated.timing(slide, { toValue: 1, duration: 60, useNativeDriver: false }).start(({ finished }) => {
              if (finished) setSheet(true);
            });
          }}
        >
          <Text>Open</Text>
        </Pressable>
        <Pressable
          testID="load-list"
          onPress={() => {
            void net.fetch('https://api.example.com/trips').then(() => setItems(['Paris', 'Rome', 'Oslo']));
          }}
        >
          <Text>Load</Text>
        </Pressable>
        <Pressable
          testID="send"
          onPress={() => {
            void net.fetch('https://api.example.com/send').then(() => setReply('Sent'));
          }}
        >
          <Text>Send</Text>
        </Pressable>
        {sheet ? <Text>Sheet is open</Text> : null}
        {items.map((item) => (
          <Text key={item}>{item}</Text>
        ))}
        {reply !== '' ? <Text>{reply}</Text> : null}
      </View>
    );
  }

  let clock = Date.now();

  async function scenario(testID: string, know: boolean): Promise<{ texts: string[]; settledMs: number }> {
    resetRefs();
    const net = {
      XMLHttpRequest: class {
        open(): void {}
        send(): void {}
        abort(): void {}
      },
      fetch: ((): Promise<unknown> => new Promise((resolve) => setTimeout(() => resolve(okResponse), 70))) as Fetch,
    };
    installNetworkTracking({ target: net });
    useFrames({}, frame(0, 0, 100, 40));
    await mount(<App net={net} />);
    setKnowIdle(know);
    configureActions({ quietMs: 100, capMs: 2000 });
    // A fresh, later fake clock each time, so `lastSettledAt` from an earlier scenario is never ahead of it.
    clock += 1_000_000;
    jest.useFakeTimers({ now: clock });
    let settledMs = -1;
    try {
      // Each millisecond runs inside act, so React's commits are flushed on the fake clock.
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = press({ target: { testID } }).then((r) => {
          settledMs = r.settledMs;
        });
        await jest.advanceTimersByTimeAsync(1);
      });
      for (let i = 0; i < 400 && settledMs < 0; i++) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1);
        });
      }
      await pending;
    } finally {
      jest.useRealTimers();
    }
    const texts = collectNodes()
      .map((node) => node.text)
      .filter((text) => text !== '');
    await unmountAll();
    setKnowIdle(false);
    uninstallNetworkTracking();
    return { texts, settledMs };
  }

  test.each([
    ['a sheet animation', 'open-sheet', 'Sheet is open'],
    ['a list load', 'load-list', 'Oslo'],
    ['a request', 'send', 'Sent'],
  ])('%s: both paths end on the same tree, the know path at least 40 ms sooner', async (_name, testID, shown) => {
    const quiet = await scenario(testID, false);
    const know = await scenario(testID, true);
    expect(quiet.texts).toContain(shown);
    expect(know.texts).toEqual(quiet.texts);
    expect(know.settledMs).toBeLessThanOrEqual(quiet.settledMs - 40);
  });

  test('with Reanimated present the know path takes the 100 ms window too', async () => {
    holder.__reanimatedModuleProxy = {};
    const quiet = await scenario('send', false);
    const know = await scenario('send', true);
    expect(know.texts).toEqual(quiet.texts);
    expect(know.settledMs).toBe(quiet.settledMs);
  });

  test('an open sheet keeps the 100 ms window and the poll even when every signal is idle', async () => {
    resetRefs();
    useFrames({}, frame(0, 0, 100, 40));
    await mount(
      <View>
        {React.createElement(
          'RCTModalHostView',
          null,
          <Pressable testID="close" onPress={() => {}}>
            <Text>Close</Text>
          </Pressable>,
        )}
      </View>,
    );
    setKnowIdle(true);
    configureActions({ quietMs: 100, capMs: 2000 });
    jest.useFakeTimers();
    let settledMs = -1;
    try {
      const pending = press({ target: { testID: 'close' } }).then((r) => {
        settledMs = r.settledMs;
      });
      for (let i = 0; i < 400 && settledMs < 0; i++) await jest.advanceTimersByTimeAsync(1);
      await pending;
    } finally {
      jest.useRealTimers();
    }
    expect(settledMs).toBeGreaterThanOrEqual(100);
  });

  test('with no quiet time and no cap the know path answers at once, like today', async () => {
    resetRefs();
    useFrames({}, frame(0, 0, 100, 40));
    const net = { XMLHttpRequest: class { open(): void {} send(): void {} abort(): void {} }, fetch: (() => Promise.resolve(okResponse)) as Fetch };
    await mount(<App net={net} />);
    setKnowIdle(true);
    configureActions({ quietMs: 0, capMs: 0 });
    let result: { settledMs: number } | undefined;
    await act(async () => {
      result = await press({ target: { testID: 'open-sheet' } });
    });
    expect(result?.settledMs).toBe(0);
  });
});

describe('stuck entries do not hold every later settle (review 1)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    installIdleSignals();
  });

  test('a handle that is never cleared holds one settle to the cap, then is ignored', async () => {
    InteractionManager.createInteractionHandle();
    let first: { capped: boolean } | null = null;
    void waitUntilIdle({ frames: 2, capMs: 500, requestMark: startedRequests() }).then((r) => {
      first = r;
    });
    await jest.advanceTimersByTimeAsync(600);
    expect(first).toMatchObject({ capped: true });
    let second: { settledMs: number; capped: boolean } | null = null;
    void waitUntilIdle({ frames: 2, capMs: 500, requestMark: startedRequests() }).then((r) => {
      second = r;
    });
    await jest.advanceTimersByTimeAsync(40);
    expect(second).toEqual({ settledMs: 32, usedFallback: false, capped: false });
  });

  test('an animation with no end callback is counted for its duration plus a short grace, then released', async () => {
    const value = new Animated.Value(0);
    Animated.timing(value, { toValue: 1, duration: 200, useNativeDriver: false }).start();
    let done = false;
    void waitUntilIdle({ frames: 2, capMs: 5000, requestMark: startedRequests() }).then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(150);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  test("the app's start() gets no callback unless it passed one, and keeps its own callback", () => {
    setKnowIdle(false);
    const innerStart = jest.fn();
    const animated = Animated as unknown as { timing: unknown };
    const real = animated.timing;
    animated.timing = () => ({ start: innerStart, stop: jest.fn() });
    try {
      installIdleSignals();
      const bare = Animated.timing(new Animated.Value(0), { toValue: 1, duration: 50, useNativeDriver: false });
      bare.start();
      expect(innerStart).toHaveBeenLastCalledWith();
      const mine = jest.fn();
      Animated.timing(new Animated.Value(0), { toValue: 1, duration: 50, useNativeDriver: false }).start(mine);
      const passed = innerStart.mock.calls[innerStart.mock.calls.length - 1]?.[0] as (r: unknown) => void;
      passed({ finished: true });
      expect(mine).toHaveBeenCalledWith({ finished: true });
    } finally {
      setKnowIdle(false);
      animated.timing = real;
    }
  });

  test('InteractionManager is read once per install: its getter is not hit again for each patch', () => {
    setKnowIdle(false);
    let reads = 0;
    Object.defineProperty(rn, 'InteractionManager', {
      configurable: true,
      get() {
        reads += 1;
        return InteractionManager;
      },
    });
    try {
      installIdleSignals();
      expect(reads).toBe(1);
    } finally {
      setKnowIdle(false);
      Object.defineProperty(rn, 'InteractionManager', { configurable: true, value: InteractionManager });
    }
  });

  test('uninstalling ends a wait that is still polling, at once', async () => {
    InteractionManager.createInteractionHandle();
    let result: { usedFallback: boolean } | null = null;
    void waitUntilIdle({ frames: 2, capMs: 5000, requestMark: startedRequests() }).then((r) => {
      result = r;
    });
    await jest.advanceTimersByTimeAsync(50);
    expect(result).toBeNull();
    setKnowIdle(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(result).toMatchObject({ usedFallback: true });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('the settle never answers mid-change (review 1)', () => {
  function Screen({ delayedCommit }: { delayedCommit: boolean }): React.ReactElement {
    const [late, setLate] = useState(false);
    return (
      <View>
        <Pressable
          testID="go"
          onPress={() => {
            // A timer before the change: Tapline never patches timers, so the know path can't see it (documented limit).
            if (delayedCommit) setTimeout(() => setLate(true), 50);
          }}
        >
          <Text>Go</Text>
        </Pressable>
        {late ? <Text>Arrived late</Text> : null}
      </View>
    );
  }

  let clockStart = Date.now();

  async function runPress(know: boolean, movement: (elapsed: number) => number, delayedCommit = false): Promise<{ settledMs: number; texts: string[] }> {
    resetRefs();
    await mount(<Screen delayedCommit={delayedCommit} />);
    clockStart += 1_000_000;
    jest.useFakeTimers({ now: clockStart });
    const t0 = Date.now();
    setMeasurer(async () => frame(movement(Date.now() - t0), 0, 100, 40));
    setKnowIdle(know);
    configureActions({ quietMs: 100, capMs: 2000 });
    let settledMs = -1;
    try {
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = press({ target: { testID: 'go' } }).then((r) => {
          settledMs = r.settledMs;
        });
        await jest.advanceTimersByTimeAsync(1);
      });
      for (let i = 0; i < 1500 && settledMs < 0; i++) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1);
        });
      }
      await pending;
    } finally {
      jest.useRealTimers();
    }
    const texts = collectNodes()
      .map((node) => node.text)
      .filter((text) => text !== '');
    await unmountAll();
    setKnowIdle(false);
    return { settledMs, texts };
  }

  test('a slide that starts after every counter is zero (a native push) is waited for', async () => {
    // Still for 20 ms, then slides one point per millisecond until 220 ms.
    const slide = (elapsed: number): number => Math.max(0, Math.min(200, elapsed - 20));
    const result = await runPress(true, slide);
    expect(result.settledMs).toBeGreaterThanOrEqual(220);
  });

  test('a screen that stays still answers in a few frames', async () => {
    const result = await runPress(true, () => 0);
    expect(result.settledMs).toBeLessThan(80);
  });

  test('the documented limit: a handler that waits on a timer before changing the screen is not seen', async () => {
    // A 50 ms timer is invisible to the SDK and fires after its 2-frame hold; the 100 ms window would see it.
    // The device gate must show whether the 2-frame hold is enough for real apps.
    const quiet = await runPress(false, () => 0, true);
    const know = await runPress(true, () => 0, true);
    expect(quiet.texts).toContain('Arrived late');
    expect(know.texts).not.toContain('Arrived late');
  });
});

describe('a sheet already open skips the know path (review 5)', () => {
  test('waitUntilIdle is not called when a modal is open', async () => {
    resetRefs();
    useFrames({}, frame(0, 0, 100, 40));
    await mount(
      <View>
        {React.createElement(
          'RCTModalHostView',
          null,
          <Pressable testID="close" onPress={() => {}}>
            <Text>Close</Text>
          </Pressable>,
        )}
      </View>,
    );
    setKnowIdle(true);
    const spy = jest.spyOn(idleModule, 'waitUntilIdle');
    configureActions({ quietMs: 100, capMs: 2000 });
    jest.useFakeTimers();
    let settledMs = -1;
    try {
      const pending = press({ target: { testID: 'close' } }).then((r) => {
        settledMs = r.settledMs;
      });
      for (let i = 0; i < 400 && settledMs < 0; i++) await jest.advanceTimersByTimeAsync(1);
      await pending;
    } finally {
      jest.useRealTimers();
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
