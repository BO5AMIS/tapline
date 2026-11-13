import { Animated, LayoutAnimation } from 'react-native';
import { nativeModule } from './native';
import { isRecord } from './types';

/**
 * Fast-forwarded animations (AGENT-TOOLS 1.13 18.12, PLAN-1.6 F4), in three layers, only while an agent asks for them:
 * 1. the native module sets the window's layer speed (UIKit and native-stack transitions, sheets, alerts);
 * 2. JavaScript: `Animated.timing` and `LayoutAnimation` durations are scaled and springs end at once;
 * 3. Reanimated, when the app has it: its reduce-motion switch.
 * Timers are never touched, so app logic that waits on a timer runs as before. Everything is put back by `normal`,
 * and by a disconnect (`resetAnimations`), so the phone is never left fast with nobody watching.
 */

type AnyFn = (...args: unknown[]) => unknown;

export type AnimationSpeed = 'fast' | 'normal';

export interface AnimationLayers {
  native: boolean;
  javascript: boolean;
  reanimated: boolean;
}

/** Why a layer is not on, for the answer's sentence. Only layers that are off have one. */
export interface AnimationWhy {
  native?: string;
  reanimated?: string;
}

/** A JavaScript duration or delay keeps this share of itself. */
export const FAST_SCALE = 0.02;
/** The window's layer speed while fast (EarlGrey and KIF use the same trick): a 0.3 s transition takes 3 ms. */
export const NATIVE_FAST_SPEED = 100;
const TIMING_DEFAULT_MS = 500;
const PRESETS = ['easeInEaseOut', 'linear', 'spring'] as const;

interface Patch {
  target: Record<string, unknown>;
  name: string;
  own: boolean;
  original: unknown;
  patched: unknown;
}

interface ReducedMotionManager {
  setEnabled(enabled: boolean): void;
  jsValue?: unknown;
}

let fast = false;
let patches: Patch[] = [];
let layers: AnimationLayers = { native: false, javascript: false, reanimated: false };
let why: AnimationWhy = {};
let reanimatedBefore: boolean | null = null;
/** Counts switches and resets: a native call that comes back after a later one must not write its result. */
let generation = 0;
/** The native module was asked for fast speed since the last time it was put back. */
let nativeAsked = false;

/** Whether fast animations are on now. */
export function animationsFast(): boolean {
  return fast;
}

function isFn(value: unknown): value is AnyFn {
  return typeof value === 'function';
}

/** A duration or delay as it runs while fast: at least 1 ms, and 0 stays 0. Anything else is left as it was. */
function scaled(ms: unknown): unknown {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ms;
  return Math.max(1, Math.round(ms * FAST_SCALE));
}

/** Replaces `target[name]` with `make(original)` and remembers how to put it back. A missing function is skipped. */
function patch(target: unknown, name: string, make: (original: AnyFn) => AnyFn): void {
  if (typeof target !== 'object' && typeof target !== 'function') return;
  if (target === null) return;
  const record = target as Record<string, unknown>;
  let original: unknown;
  try {
    original = record[name];
  } catch {
    return;
  }
  if (!isFn(original)) return;
  try {
    const patched = make(original);
    const own = Object.prototype.hasOwnProperty.call(record, name);
    record[name] = patched;
    if (record[name] !== patched) return;
    patches.push({ target: record, name, own, original, patched });
  } catch {
    // a frozen module: this layer simply has less to speed up
  }
}

/** Puts back what is still ours. A wrapper something else was stacked on stays, and passes calls through (`fast` is false). */
function unpatch(): void {
  for (const { target, name, own, original, patched } of patches.reverse()) {
    try {
      if (target[name] !== patched) continue;
      if (own) target[name] = original;
      else delete target[name];
    } catch {
      // ignore
    }
  }
  patches = [];
}

/** One frame: the shortest an animation inside a loop or a spring may take, so a loop never spins without yielding. */
const FRAME_MS = 16;

/** Makes the same animation again, with durations floored at one frame; remembered per animation made while fast. */
const rebuilders = new WeakMap<object, (floored: boolean) => unknown>();
/** While set, the timing wrapper keeps the duration it is given (a spring's own one frame). */
let exactDuration = false;

function remember(animation: unknown, rebuild: (floored: boolean) => unknown): unknown {
  if (typeof animation === 'object' && animation !== null) rebuilders.set(animation, rebuild);
  return animation;
}

/** The animation as it should run inside a loop: floored at one frame when it was made while fast. */
function floored(animation: unknown): unknown {
  const rebuild = typeof animation === 'object' && animation !== null ? rebuilders.get(animation) : undefined;
  return rebuild ? rebuild(true) : animation;
}

function timingFast(original: AnyFn, self: unknown, args: unknown[], floor: boolean): unknown {
  const config = args[1];
  if (!isRecord(config)) return original.apply(self, args);
  const given = typeof config.duration === 'number' ? config.duration : TIMING_DEFAULT_MS;
  const duration = exactDuration ? given : scaled(given);
  const next: Record<string, unknown> = {
    ...config,
    duration: floor && typeof duration === 'number' ? Math.max(FRAME_MS, duration) : duration,
    ...(config.delay !== undefined ? { delay: scaled(config.delay) } : {}),
  };
  return original.apply(self, [args[0], next, ...args.slice(2)]);
}

function patchAnimated(): void {
  patch(Animated, 'timing', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      if (!fast) return original.apply(this, args);
      return remember(timingFast(original, this, args, false), (floor) => timingFast(original, this, args, floor));
    },
  );
  // A spring has no duration to scale: it becomes a one-frame timing to the same value in the same driver mode
  // (never shorter, so a spring inside a loop still yields). Its delay is scaled by the timing patch it goes through.
  // It goes through `Animated.timing` as the app sees it now, so whatever else wraps timing (the idle signals) sees it.
  patch(Animated, 'spring', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const config = args[1];
      if (!fast || !isRecord(config) || !isFn(Animated.timing)) return original.apply(this, args);
      const timing: Record<string, unknown> = { toValue: config.toValue, duration: FRAME_MS };
      for (const key of ['useNativeDriver', 'delay', 'isInteraction']) if (config[key] !== undefined) timing[key] = config[key];
      const make = (): unknown => {
        exactDuration = true;
        try {
          return Animated.timing(args[0] as never, timing as never);
        } finally {
          exactDuration = false;
        }
      };
      return remember(make(), make);
    },
  );
  // Composites and loops: a loop repeats what it is given, so what it holds is rebuilt with durations of at least one frame.
  for (const [name, at] of [['sequence', 0], ['parallel', 0], ['stagger', 1]] as const) {
    patch(Animated, name, (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const children = args[at];
        if (!fast || !Array.isArray(children)) return original.apply(this, args);
        const build = (floor: boolean): unknown => {
          const next = [...args];
          next[at] = floor ? children.map(floored) : children;
          return original.apply(this, next);
        };
        return remember(build(false), build);
      },
    );
  }
  patch(Animated, 'loop', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      return fast ? original.apply(this, [floored(args[0]), ...args.slice(1)]) : original.apply(this, args);
    },
  );
}

function scaledLayout(config: unknown): unknown {
  if (!isRecord(config)) return config;
  const out: Record<string, unknown> = { ...config };
  if (config.duration !== undefined) out.duration = scaled(config.duration);
  for (const key of ['create', 'update', 'delete']) {
    const part = config[key];
    if (isRecord(part) && part.duration !== undefined) out[key] = { ...part, duration: scaled(part.duration) };
  }
  return out;
}

function patchLayoutAnimation(): void {
  patch(LayoutAnimation, 'configureNext', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      return original.apply(this, fast ? [scaledLayout(args[0]), ...args.slice(1)] : args);
    },
  );
  // The preset helpers call the module's own `configureNext`, not the property, so they are sent through it here.
  for (const name of PRESETS) {
    patch(LayoutAnimation, name, (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const presets = isRecord(LayoutAnimation) ? LayoutAnimation.Presets : undefined;
        const preset = isRecord(presets) ? presets[name] : undefined;
        if (!fast || preset === undefined || !isFn(LayoutAnimation.configureNext)) return original.apply(this, args);
        return LayoutAnimation.configureNext(preset as never, ...(args as []));
      },
    );
  }
}

/** Reanimated's reduce-motion switch, when the app has Reanimated and this version offers one; else null. */
function reducedMotion(): ReducedMotionManager | null {
  let loaded: unknown;
  try {
    loaded = require('react-native-reanimated');
  } catch {
    return null;
  }
  const holders = [loaded, isRecord(loaded) ? loaded.default : undefined];
  for (const holder of holders) {
    const manager = isRecord(holder) ? holder.ReducedMotionManager : undefined;
    if (isRecord(manager) && isFn(manager.setEnabled)) return manager as unknown as ReducedMotionManager;
  }
  return null;
}

function reanimatedOn(): { on: boolean; reason?: string } {
  const manager = reducedMotion();
  if (manager === null) {
    const present = (globalThis as { __reanimatedModuleProxy?: unknown; _REANIMATED_VERSION_JS?: unknown });
    const there = present.__reanimatedModuleProxy !== undefined || present._REANIMATED_VERSION_JS !== undefined;
    return { on: false, reason: there ? 'this Reanimated has no global reduce-motion switch' : 'not in this app' };
  }
  try {
    reanimatedBefore = typeof manager.jsValue === 'boolean' ? manager.jsValue : false;
    manager.setEnabled(true);
    return { on: true };
  } catch {
    return { on: false, reason: 'its switch failed' };
  }
}

function reanimatedBack(): void {
  const before = reanimatedBefore;
  reanimatedBefore = null;
  if (before === null) return;
  try {
    reducedMotion()?.setEnabled(before);
  } catch {
    // ignore
  }
}

/** Sets the window's layer speed. Resolves false when this build has no such function or the call failed. */
async function nativeSpeed(speed: number): Promise<{ ok: boolean; reason?: string }> {
  const module = nativeModule();
  if (module === null || typeof module.setAnimationSpeed !== 'function') {
    return { ok: false, reason: 'this build has no setAnimationSpeed' };
  }
  try {
    await module.setAnimationSpeed(speed);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'the call failed' };
  }
}

/** Switches the layers on or off. Returns which are on after the call. */
export async function setAnimationSpeed(speed: AnimationSpeed): Promise<AnimationLayers> {
  if (speed === 'normal') {
    generation += 1;
    const sent = nativeAsked;
    fast = false;
    unpatch();
    reanimatedBack();
    nativeAsked = false;
    if (sent) await nativeSpeed(1);
    layers = { native: false, javascript: false, reanimated: false };
    why = {};
    return layers;
  }
  if (fast) return layers;
  fast = true;
  generation += 1;
  const mine = generation;
  patchAnimated();
  patchLayoutAnimation();
  const reanimated = reanimatedOn();
  nativeAsked = true;
  const native = await nativeSpeed(NATIVE_FAST_SPEED);
  if (generation !== mine) {
    // Normal or a disconnect came while the native call was out: it may have landed after that reset, so put 1 back.
    await nativeSpeed(1);
    return layers;
  }
  layers = { native: native.ok, javascript: true, reanimated: reanimated.on };
  why = { ...(native.reason !== undefined ? { native: native.reason } : {}), ...(reanimated.reason !== undefined ? { reanimated: reanimated.reason } : {}) };
  return layers;
}

/** Why the layers that are off are off (for the answer). */
export function animationLayerReasons(): AnimationWhy {
  return why;
}

/** The disconnect and stop path: everything back to normal now, without waiting for the native call. */
export function resetAnimations(): void {
  generation += 1;
  fast = false;
  unpatch();
  reanimatedBack();
  layers = { native: false, javascript: false, reanimated: false };
  why = {};
  // After any fast request, whether or not its native call has answered: 1 is idempotent.
  if (nativeAsked) {
    nativeAsked = false;
    void nativeSpeed(1);
  }
}

/** The sentence a switch answers with: the line every answer carries, then which layers are on. */
export function animationsSaid(speed: AnimationSpeed): string {
  if (speed === 'normal') return 'Animations: normal (Tapline).';
  const on = [layers.native ? 'the native window' : null, layers.javascript ? 'Animated and LayoutAnimation' : null, layers.reanimated ? 'Reanimated' : null].filter(
    (part): part is string => part !== null,
  );
  const off = [
    layers.native ? null : `the native window${why.native !== undefined ? ` (${why.native})` : ''}`,
    layers.reanimated ? null : `Reanimated${why.reanimated !== undefined ? ` (${why.reanimated})` : ''}`,
  ].filter((part): part is string => part !== null);
  return `Animations: fast (Tapline). Layers on: ${on.join(', ')}${off.length > 0 ? `; not on: ${off.join(', ')}` : ''}. Timers are not touched.`;
}
