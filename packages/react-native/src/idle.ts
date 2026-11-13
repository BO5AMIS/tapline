import { openRequestsSince } from './network';
import { onCommit } from './register';
import { isRecord } from './types';

/**
 * Know, don't watch (AGENT-TOOLS 1.13, F1). Instead of waiting 100 ms without a React commit, the
 * SDK counts what it can see running (Animated, LayoutAnimation, InteractionManager handles and the
 * requests an action started) and answers when all of that is idle, one or two frames later.
 * What it can't see (Reanimated, native work, timers) keeps today's quiet window. Timers are never
 * patched. The patches exist only while this is switched on, and uninstall puts everything back.
 */

type AnyFn = (...args: unknown[]) => unknown;

const FRAME_MS = 16;
/** How often the signals are read while waiting; finer than a frame, so the answer isn't rounded up to one. */
const POLL_MS = 8;
/** A LayoutAnimation's end callback may never come (nothing moved), so a timer releases it. */
const LAYOUT_GRACE_MS = 100;
const LAYOUT_DEFAULT_MS = 500;

export interface IdleReading {
  interactionHandles: number;
  /** Animated animations running now (loops excluded). */
  animations: number;
  layoutAnimating: boolean;
  /** Requests the action started (begun at or after `since`) that are still open. */
  startedRequestsOpen: number;
  /** True when something the SDK can't see may be running: the caller must use the quiet window. */
  blind: boolean;
}

interface Patch {
  target: Record<string, unknown>;
  name: string;
  own: boolean;
  original: unknown;
  patched: unknown;
}

let patches: Patch[] = [];
let installed = false;
/** An API exists but couldn't be patched: animations may run unseen. */
let unpatchable = false;
const handles = new Set<unknown>();
let animations = 0;
let loops = 0;
let layoutAnimations = 0;
const layoutTimers = new Set<ReturnType<typeof setTimeout>>();

/** A react-native export, or undefined: InteractionManager is gone from newer versions and its getter throws. */
function rnExport(name: string): unknown {
  try {
    const rn: unknown = require('react-native');
    return isRecord(rn) ? rn[name] : undefined;
  } catch {
    return undefined;
  }
}

function isFn(value: unknown): value is AnyFn {
  return typeof value === 'function';
}

/** Replaces `target[name]` with `make(original)`; remembers how to put it back. A missing function is skipped. */
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
    if (record[name] !== patched) {
      unpatchable = true;
      return;
    }
    patches.push({ target: record, name, own, original, patched });
  } catch {
    unpatchable = true;
  }
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** Counts an animation from `start` to its end callback (also when it is stopped). */
function track(animation: unknown, kind: 'run' | 'loop'): unknown {
  if (!isRecord(animation) || !isFn(animation.start)) return animation;
  const start = animation.start;
  try {
    animation.start = function (this: unknown, ...args: unknown[]): unknown {
      if (kind === 'loop') loops += 1;
      else animations += 1;
      const release = once(() => {
        if (kind === 'loop') loops = Math.max(0, loops - 1);
        else animations = Math.max(0, animations - 1);
      });
      const callback = args[0];
      const wrapped: AnyFn = (...result) => {
        release();
        return isFn(callback) ? callback(...result) : undefined;
      };
      try {
        return start.apply(this, [wrapped, ...args.slice(1)]);
      } catch (error) {
        release();
        throw error;
      }
    };
  } catch {
    // a frozen animation object: the factory's result is returned as it was
  }
  return animation;
}

const ANIMATED_RUNNERS = ['timing', 'spring', 'decay', 'parallel', 'sequence', 'stagger', 'delay'];

function patchAnimated(): void {
  for (const name of ANIMATED_RUNNERS) {
    patch(rnExport('Animated'), name, (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        return track(original.apply(this, args), 'run');
      },
    );
  }
  patch(rnExport('Animated'), 'loop', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      return track(original.apply(this, args), 'loop');
    },
  );
}

/** Counts a LayoutAnimation from the call to its end or fail callback, or to its duration plus a short grace. */
function layoutTracked(original: AnyFn, args: unknown[], callbackAt: number[], durationOf: (args: unknown[]) => unknown, self: unknown): unknown {
  layoutAnimations += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = once(() => {
    layoutAnimations = Math.max(0, layoutAnimations - 1);
    if (timer !== undefined) {
      clearTimeout(timer);
      layoutTimers.delete(timer);
    }
  });
  const duration = durationOf(args);
  timer = setTimeout(release, (typeof duration === 'number' ? duration : LAYOUT_DEFAULT_MS) + LAYOUT_GRACE_MS);
  layoutTimers.add(timer);
  const next = [...args];
  for (const at of callbackAt) {
    const callback = next[at];
    if (isFn(callback)) {
      next[at] = (...result: unknown[]): unknown => {
        release();
        return callback(...result);
      };
    }
  }
  try {
    return original.apply(self, next);
  } catch (error) {
    release();
    throw error;
  }
}

function patchLayoutAnimation(): void {
  patch(rnExport('LayoutAnimation'), 'configureNext', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const config = args[0];
      return layoutTracked(original, args, [1, 2], () => (isRecord(config) ? config.duration : undefined), this);
    },
  );
  // The preset helpers call the module's own `configureNext`, not the property, so they are counted here.
  for (const name of ['easeInEaseOut', 'linear', 'spring']) {
    patch(rnExport('LayoutAnimation'), name, (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const layout = rnExport('LayoutAnimation');
        const presets = isRecord(layout) ? layout.Presets : undefined;
        const preset = isRecord(presets) ? presets[name] : undefined;
        return layoutTracked(original, args, [0], () => (isRecord(preset) ? preset.duration : undefined), this);
      },
    );
  }
}

function patchInteractions(): void {
  patch(rnExport('InteractionManager'), 'createInteractionHandle', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const handle = original.apply(this, args);
      handles.add(handle);
      return handle;
    },
  );
  patch(rnExport('InteractionManager'), 'clearInteractionHandle', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      handles.delete(args[0]);
      return original.apply(this, args);
    },
  );
}

/** True when Reanimated is in the app: its worklets run on the UI thread, out of the SDK's sight. */
function reanimatedPresent(): boolean {
  const holder = globalThis as { __reanimatedModuleProxy?: unknown; _REANIMATED_VERSION_JS?: unknown };
  return holder.__reanimatedModuleProxy !== undefined || holder._REANIMATED_VERSION_JS !== undefined;
}

/**
 * Patches Animated's runners, LayoutAnimation and InteractionManager handles with counters. Safe to call
 * twice and with a module missing. Returns the function that puts everything back.
 */
export function installIdleSignals(): () => void {
  if (!installed) {
    installed = true;
    unpatchable = false;
    patchAnimated();
    patchLayoutAnimation();
    patchInteractions();
  }
  return uninstallIdleSignals;
}

export function uninstallIdleSignals(): void {
  if (!installed) return;
  installed = false;
  for (const { target, name, own, original, patched } of patches.reverse()) {
    try {
      // The app may have replaced the function since: leave its version alone.
      if (target[name] !== patched) continue;
      if (own) target[name] = original;
      else delete target[name];
    } catch {
      // ignore
    }
  }
  patches = [];
  for (const timer of layoutTimers) clearTimeout(timer);
  layoutTimers.clear();
  handles.clear();
  animations = 0;
  loops = 0;
  layoutAnimations = 0;
  unpatchable = false;
}

/** Whether know-don't-watch is on: the signals are patched. Off by default in 1.6.0 (`knowIdle`). */
export function isKnowIdle(): boolean {
  return installed;
}

export function setKnowIdle(on: boolean): void {
  if (on) installIdleSignals();
  else uninstallIdleSignals();
}

/** What the SDK sees running right now. */
export function readIdle(since: number): IdleReading {
  return {
    interactionHandles: handles.size,
    animations,
    layoutAnimating: layoutAnimations > 0,
    startedRequestsOpen: openRequestsSince(since),
    blind: !installed || unpatchable || loops > 0 || reanimatedPresent(),
  };
}

function idle(reading: IdleReading): boolean {
  return reading.interactionHandles === 0 && reading.animations === 0 && !reading.layoutAnimating && reading.startedRequestsOpen === 0;
}

export interface IdleOutcome {
  settledMs: number;
  /** The SDK was blind to something: the caller runs today's quiet window and position poll. */
  usedFallback: boolean;
  /** The wait ended at the cap with something still running. */
  capped: boolean;
}

/**
 * Resolves once every visible signal has been idle, with no React commit, for `frames` frames of 16 ms,
 * or at `capMs`. Resolves at once with `usedFallback` when the SDK is blind (or `capMs` is 0), and
 * mid-wait if it becomes blind (a loop starts). `since` is when the action began.
 */
export function waitUntilIdle(options: { frames: 1 | 2; capMs: number; since: number }): Promise<IdleOutcome> {
  const started = Date.now();
  if (options.capMs <= 0 || readIdle(options.since).blind) return Promise.resolve({ settledMs: 0, usedFallback: true, capped: false });
  const holdMs = options.frames * FRAME_MS;
  return new Promise((resolve) => {
    let done = false;
    // The last moment anything was busy or committed; the wait ends `holdMs` after it.
    let lastChange = started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopCommits = onCommit(() => {
      lastChange = Date.now();
    });
    const finish = (usedFallback: boolean, capped: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(cap);
      stopCommits();
      resolve({ settledMs: Math.max(0, Math.min(options.capMs, Date.now() - started)), usedFallback, capped });
    };
    const cap = setTimeout(() => finish(false, true), options.capMs);
    const tick = (): void => {
      if (done) return;
      const reading = readIdle(options.since);
      if (reading.blind) return finish(true, false);
      const now = Date.now();
      if (!idle(reading)) lastChange = now;
      if (now - lastChange >= holdMs) return finish(false, false);
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
  });
}
