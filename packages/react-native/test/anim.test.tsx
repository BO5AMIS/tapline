import { Animated, LayoutAnimation } from 'react-native';
import { runCommand } from '../src/commands';
import { animationsFast, resetAnimations, setAnimationSpeed } from '../src/anim';
import { installIdleSignals, uninstallIdleSignals } from '../src/idle';
import { setNativeModule, type TaplineNativeModule } from '../src/native';

// AGENT-TOOLS 1.13 18.12 and PLAN-1.6 F4: fast-forwarded animations in three layers (the native window's speed,
// JavaScript's Animated and LayoutAnimation, Reanimated's reduce-motion). Off by default; reversible; timers untouched.

/** Animated's members are typed read-only; the tests replace them as an app or another patch would. */
const animated = Animated as unknown as Record<string, unknown>;

const holder = globalThis as { __reanimatedModuleProxy?: unknown };

interface TimingCall {
  value: unknown;
  config: Record<string, unknown>;
}

/** Stands in for the real timing and layout configuration so the tests see what the patches pass on. */
function stand(): { timings: TimingCall[]; layouts: Array<Record<string, unknown>>; restore: () => void } {
  const timings: TimingCall[] = [];
  const layouts: Array<Record<string, unknown>> = [];
  const realTiming = Animated.timing;
  const realSpring = Animated.spring;
  const realConfigure = LayoutAnimation.configureNext;
  animated.timing = (value: unknown, config: Record<string, unknown>) => {
    timings.push({ value, config });
    return { start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }), stop: () => undefined };
  };
  LayoutAnimation.configureNext = ((config: Record<string, unknown>) => {
    layouts.push(config);
  }) as unknown as typeof LayoutAnimation.configureNext;
  return {
    timings,
    layouts,
    restore: () => {
      animated.timing = realTiming;
      animated.spring = realSpring;
      LayoutAnimation.configureNext = realConfigure;
    },
  };
}

afterEach(() => {
  resetAnimations();
  uninstallIdleSignals();
  setNativeModule(undefined);
  delete holder.__reanimatedModuleProxy;
});

describe('JavaScript layer', () => {
  test('timing durations scale and restore', async () => {
    const fake = stand();
    const mocked = Animated.timing;
    try {
      const value = new Animated.Value(0);
      await setAnimationSpeed('fast');
      expect(animationsFast()).toBe(true);
      expect(Animated.timing).not.toBe(mocked);
      Animated.timing(value, { toValue: 1, duration: 500, delay: 100, useNativeDriver: false });
      expect(fake.timings[0]?.config).toMatchObject({ toValue: 1, duration: 10, delay: 2, useNativeDriver: false });
      // a timing with no duration uses React Native's 500 ms default: it is scaled too
      Animated.timing(value, { toValue: 2, useNativeDriver: false });
      expect(fake.timings[1]?.config.duration).toBe(10);
      // zero stays zero
      Animated.timing(value, { toValue: 3, duration: 0, useNativeDriver: false });
      expect(fake.timings[2]?.config.duration).toBe(0);
      await setAnimationSpeed('normal');
      expect(animationsFast()).toBe(false);
      expect(Animated.timing).toBe(mocked);
      Animated.timing(value, { toValue: 1, duration: 500, useNativeDriver: false });
      expect(fake.timings[3]?.config.duration).toBe(500);
    } finally {
      fake.restore();
    }
  });

  test('spring ends at once with finished:true, in the same driver mode', async () => {
    jest.useFakeTimers();
    try {
      await setAnimationSpeed('fast');
      const value = new Animated.Value(0);
      const ended: Array<{ finished: boolean }> = [];
      Animated.spring(value, { toValue: 40, useNativeDriver: false, bounciness: 20 }).start((r) => ended.push(r));
      await jest.advanceTimersByTimeAsync(60);
      expect(ended).toEqual([{ finished: true }]);
      expect((value as unknown as { __getValue(): number }).__getValue()).toBe(40);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a spring turns into a one-millisecond timing to the same value with the same driver', async () => {
    const fake = stand();
    try {
      await setAnimationSpeed('fast');
      const value = new Animated.Value(0);
      Animated.spring(value, { toValue: 7, useNativeDriver: true, delay: 300 });
      expect(fake.timings[0]?.value).toBe(value);
      expect(fake.timings[0]?.config).toMatchObject({ toValue: 7, duration: 1, useNativeDriver: true, delay: 6 });
    } finally {
      fake.restore();
    }
  });

  test('spring is back after normal', async () => {
    const before = Animated.spring;
    await setAnimationSpeed('fast');
    expect(Animated.spring).not.toBe(before);
    await setAnimationSpeed('normal');
    expect(Animated.spring).toBe(before);
  });

  test('LayoutAnimation durations scale', async () => {
    const fake = stand();
    try {
      await setAnimationSpeed('fast');
      LayoutAnimation.configureNext({
        duration: 300,
        create: { type: 'easeIn', property: 'opacity', duration: 200 },
        update: { type: 'spring', springDamping: 0.4 },
        delete: { type: 'linear', property: 'opacity', duration: 1000 },
      });
      expect(fake.layouts[0]).toMatchObject({
        duration: 6,
        create: { duration: 4, type: 'easeIn', property: 'opacity' },
        update: { type: 'spring', springDamping: 0.4 },
        delete: { duration: 20 },
      });
    } finally {
      fake.restore();
    }
  });

  test('a preset helper such as easeInEaseOut goes through the scaled configuration', async () => {
    const fake = stand();
    try {
      await setAnimationSpeed('fast');
      LayoutAnimation.easeInEaseOut();
      const sent = fake.layouts[0] as { duration?: number } | undefined;
      expect(sent?.duration).toBeLessThanOrEqual(10);
    } finally {
      fake.restore();
    }
  });

  test('timers are never touched', async () => {
    const before = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, raf: globalThis.requestAnimationFrame };
    await setAnimationSpeed('fast');
    expect(globalThis.setTimeout).toBe(before.setTimeout);
    expect(globalThis.setInterval).toBe(before.setInterval);
    expect(globalThis.requestAnimationFrame).toBe(before.raf);
    await setAnimationSpeed('fast');
    await setAnimationSpeed('normal');
  });

  test('turning it on twice patches once and one normal restores everything', async () => {
    const before = { timing: Animated.timing, spring: Animated.spring, configure: LayoutAnimation.configureNext };
    await setAnimationSpeed('fast');
    const patched = Animated.timing;
    await setAnimationSpeed('fast');
    expect(Animated.timing).toBe(patched);
    await setAnimationSpeed('normal');
    expect({ timing: Animated.timing, spring: Animated.spring, configure: LayoutAnimation.configureNext }).toEqual(before);
  });

  test('coexists with the idle signals, whichever came first, and each puts back what it found', async () => {
    const fake = stand();
    try {
      const base = Animated.timing;
      installIdleSignals();
      const withIdle = Animated.timing;
      expect(withIdle).not.toBe(base);
      await setAnimationSpeed('fast');
      Animated.timing(new Animated.Value(0), { toValue: 1, duration: 500, useNativeDriver: false });
      // the idle patch sits under ours and still hands the scaled config on
      expect(fake.timings[0]?.config.duration).toBe(10);
      resetAnimations();
      expect(Animated.timing).toBe(withIdle);
      uninstallIdleSignals();
      expect(Animated.timing).toBe(base);

      // the other order: ours first, idle on top, then idle goes first
      await setAnimationSpeed('fast');
      const ours = Animated.timing;
      installIdleSignals();
      Animated.timing(new Animated.Value(0), { toValue: 1, duration: 500, useNativeDriver: false });
      expect(fake.timings[1]?.config.duration).toBe(10);
      uninstallIdleSignals();
      expect(Animated.timing).toBe(ours);
      resetAnimations();
      expect(Animated.timing).toBe(base);
    } finally {
      fake.restore();
    }
  });

  test('a wrapper left in the chain when the app or the idle patch changed things around it passes calls through once normal is set', async () => {
    const fake = stand();
    try {
      await setAnimationSpeed('fast');
      const ours = Animated.timing;
      // something else wraps ours, so ours cannot be taken off
      const outer = ((...args: Parameters<typeof Animated.timing>) => ours(...args)) as typeof Animated.timing;
      animated.timing = outer;
      resetAnimations();
      expect(animationsFast()).toBe(false);
      Animated.timing(new Animated.Value(0), { toValue: 1, duration: 500, useNativeDriver: false });
      expect(fake.timings[0]?.config.duration).toBe(500);
    } finally {
      fake.restore();
    }
  });
});

describe('Reanimated layer', () => {
  test('Reanimated absent: no throw, layer 3 reports unavailable', async () => {
    const layers = await setAnimationSpeed('fast');
    expect(layers.reanimated).toBe(false);
    expect(layers.javascript).toBe(true);
  });

  test('Reanimated with a reduce-motion switch: turned on, and put back to what it was', async () => {
    const calls: boolean[] = [];
    jest.doMock('react-native-reanimated', () => ({ ReducedMotionManager: { jsValue: false, setEnabled: (v: boolean) => calls.push(v) } }), { virtual: true });
    try {
      const layers = await setAnimationSpeed('fast');
      expect(layers.reanimated).toBe(true);
      expect(calls).toEqual([true]);
      await setAnimationSpeed('normal');
      expect(calls).toEqual([true, false]);
    } finally {
      jest.dontMock('react-native-reanimated');
    }
  });

  test('Reanimated present but its package cannot be loaded: no throw, unavailable', async () => {
    holder.__reanimatedModuleProxy = {};
    const layers = await setAnimationSpeed('fast');
    expect(layers.reanimated).toBe(false);
  });
});

describe('native layer', () => {
  function nativeWith(calls: number[]): TaplineNativeModule {
    return {
      capture: () => Promise.resolve(''),
      cover: () => Promise.resolve({ kind: '' }),
      setAnimationSpeed: (speed: number) => {
        calls.push(speed);
        return Promise.resolve();
      },
    };
  }

  test('the native bridge is called with the speed and restored on disconnect', async () => {
    const calls: number[] = [];
    setNativeModule(nativeWith(calls));
    const layers = await setAnimationSpeed('fast');
    expect(layers.native).toBe(true);
    expect(calls).toEqual([100]);
    resetAnimations();
    expect(calls).toEqual([100, 1]);
    expect(animationsFast()).toBe(false);
    // already normal: a disconnect sends nothing more
    resetAnimations();
    expect(calls).toEqual([100, 1]);
  });

  test('normal sets the native speed back to 1', async () => {
    const calls: number[] = [];
    setNativeModule(nativeWith(calls));
    await setAnimationSpeed('fast');
    await setAnimationSpeed('normal');
    expect(calls).toEqual([100, 1]);
  });

  test('an older native module without the function leaves layers 2 and 3 working and says which layers are on', async () => {
    setNativeModule({ capture: () => Promise.resolve(''), cover: () => Promise.resolve({ kind: '' }) });
    const answer = await runCommand({ name: 'animations', args: { speed: 'fast' } });
    expect(answer.result).toMatchObject({ speed: 'fast', layers: { native: false, javascript: true, reanimated: false } });
    const said = (answer.result as { say: string }).say;
    expect(said.startsWith('Animations: fast (Tapline).')).toBe(true);
    expect(said).toContain('Animated and LayoutAnimation');
    expect(said).toContain('not on: the native window (this build has no setAnimationSpeed), Reanimated');
    expect(animationsFast()).toBe(true);
  });

  test('a native call that fails does not stop the other layers', async () => {
    setNativeModule({
      capture: () => Promise.resolve(''),
      cover: () => Promise.resolve({ kind: '' }),
      setAnimationSpeed: () => Promise.reject(new Error('no window')),
    });
    const layers = await setAnimationSpeed('fast');
    expect(layers).toMatchObject({ native: false, javascript: true });
    expect(animationsFast()).toBe(true);
  });
});

describe('the animations command', () => {
  test('fast says the line and the layers, normal says it is back', async () => {
    const calls: number[] = [];
    setNativeModule({
      capture: () => Promise.resolve(''),
      cover: () => Promise.resolve({ kind: '' }),
      setAnimationSpeed: (speed: number) => {
        calls.push(speed);
      },
    });
    const fast = await runCommand({ name: 'animations', args: { speed: 'fast' } });
    expect((fast.result as { say: string }).say).toContain('on: the native window, Animated and LayoutAnimation');
    const normal = await runCommand({ name: 'animations', args: { speed: 'normal' } });
    expect(normal.result).toMatchObject({ speed: 'normal', say: 'Animations: normal (Tapline).' });
    expect(calls).toEqual([100, 1]);
  });

  test('a speed that is neither is refused, and nothing changes', async () => {
    await expect(runCommand({ name: 'animations', args: { speed: 'turbo' } })).rejects.toMatchObject({ code: 'internal' });
    expect(animationsFast()).toBe(false);
  });
});
