import { openRequestsAfter } from './network';
import { onCommit } from './register';
import { isRecord } from './types';

/**
 * Know, don't watch (AGENT-TOOLS 1.13, F1). Instead of waiting 100 ms without a React commit, the
 * SDK counts what it can see running (Animated, LayoutAnimation, InteractionManager handles and the
 * requests an action started) and answers when all of that is idle, two frames later.
 * What it can't see (Reanimated, native work, timers) keeps today's quiet window, and the caller
 * checks that positions are still before it answers. Timers are never patched, so a handler that
 * waits on a timer before changing the screen is not seen. The patches exist only while this is
 * switched on, and uninstall puts everything back.
 *
 * Not counted: passive effects. React calls `onPostCommitFiberRoot` when they have flushed, but an
 * existing DevTools hook may not forward it, and a lost signal would hold every settle to the cap.
 * The hold after each commit covers effects that flush in the same frame.
 */

type AnyFn = (...args: unknown[]) => unknown;

const FRAME_MS = 16;
/** How often the signals are read while waiting; finer than a frame, so the answer isn't rounded up to one. */
const POLL_MS = 8;
/** An animation nobody told us the end of is counted for its duration plus this. */
const SHORT_GRACE_MS = 50;
/** An animation whose end callback never comes is dropped this long after its expected end. */
const STUCK_GRACE_MS = 1000;
const TIMING_DEFAULT_MS = 500;
/** Spring and decay have no duration, and a composite (stagger) hides its children's timers. */
const ASSUMED_MS = 600;
const LAYOUT_GRACE_MS = 100;

export interface IdleReading {
  interactionHandles: number;
  /** Animated animations running now (loops excluded). */
  animations: number;
  layoutAnimating: boolean;
  /** Requests begun after the action's mark that are still open. */
  startedRequestsOpen: number;
  /** True when something the SDK can't see may be running: the caller must use the quiet window. */
  blind: boolean;
}

/** One thing being counted: it ends when released, expires at `expiresAt`, or is `stuck` after a capped wait. */
interface Counted {
  expiresAt: number | null;
  stuck: boolean;
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
/** Counts installs: a wrapper left under another patch after uninstall passes calls through, and stays dead on a later install. */
let epoch = 0;
/** An API exists but couldn't be patched: animations may run unseen. */
let unpatchable = false;
/** The react-native exports read for this install: InteractionManager's getter throws, so it is read once. */
let exportsRead: Map<string, unknown> | null = null;
const handles = new Map<unknown, Counted>();
const animations = new Map<number, Counted>();
const loops = new Map<number, Counted>();
const layouts = new Map<number, Counted>();
let nextId = 1;
/** Waits still polling; uninstall ends them. */
const activeWaits = new Set<() => void>();

/** A react-native export, or undefined: InteractionManager is gone from newer versions and its getter throws. */
function rnExport(name: string): unknown {
  if (exportsRead?.has(name)) return exportsRead.get(name);
  let found: unknown;
  try {
    const rn: unknown = require('react-native');
    found = isRecord(rn) ? rn[name] : undefined;
  } catch {
    found = undefined;
  }
  exportsRead?.set(name, found);
  return found;
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
    const wrapper = make(original);
    const mine = epoch;
    const patched: AnyFn = function (this: unknown, ...args: unknown[]): unknown {
      return installed && mine === epoch ? wrapper.apply(this, args) : original.apply(this, args);
    };
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

function add<K>(map: Map<K, Counted>, key: K, expiresAt: number | null): () => void {
  map.set(key, { expiresAt, stuck: false });
  return () => {
    map.delete(key);
  };
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** How many entries still count: not released, not stuck, not past their expiry. Expired ones are dropped. */
function live(map: Map<unknown, Counted>): number {
  const now = Date.now();
  let count = 0;
  for (const [key, entry] of map) {
    if (entry.expiresAt !== null && now >= entry.expiresAt) map.delete(key);
    else if (!entry.stuck) count += 1;
  }
  return count;
}

/** A wait ended at its cap with these still held: they are stuck, and don't hold the next settle. */
function markStuck(): void {
  for (const map of [handles, animations, layouts, loops] as Array<Map<unknown, Counted>>) {
    for (const entry of map.values()) entry.stuck = true;
  }
}

/** The milliseconds an Animated runner is expected to take, from its arguments. */
function expectedMs(name: string, args: unknown[]): number {
  const config = args[1];
  if (name === 'timing') {
    const duration = isRecord(config) && typeof config.duration === 'number' ? config.duration : TIMING_DEFAULT_MS;
    const delay = isRecord(config) && typeof config.delay === 'number' ? config.delay : 0;
    return duration + delay;
  }
  if (name === 'delay') return typeof args[0] === 'number' ? args[0] : 0;
  return ASSUMED_MS;
}

/**
 * Counts an animation from `start`. With an end callback it is released when that runs (also on stop);
 * the callback is wrapped only when the app passed one. Without one it is counted for its expected time.
 */
function track(animation: unknown, kind: 'run' | 'loop', expected: number): unknown {
  if (!isRecord(animation) || !isFn(animation.start)) return animation;
  const start = animation.start;
  try {
    animation.start = function (this: unknown, ...args: unknown[]): unknown {
      const callback = args[0];
      const map = kind === 'loop' ? loops : animations;
      const withCallback = isFn(callback);
      const expiresAt = kind === 'loop' ? null : Date.now() + expected + (withCallback ? STUCK_GRACE_MS : SHORT_GRACE_MS);
      const release = once(add(map, nextId++, expiresAt));
      if (!withCallback) return start.apply(this, args);
      const wrapped: AnyFn = (...result) => {
        release();
        return callback(...result);
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
        return track(original.apply(this, args), 'run', expectedMs(name, args));
      },
    );
  }
  patch(rnExport('Animated'), 'loop', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      return track(original.apply(this, args), 'loop', 0);
    },
  );
}

/** Counts a LayoutAnimation to its end or fail callback (wrapped only when the app passed one), else to its duration plus a grace. */
function layoutTracked(original: AnyFn, args: unknown[], callbackAt: number[], duration: unknown, self: unknown): unknown {
  const release = once(add(layouts, nextId++, Date.now() + (typeof duration === 'number' ? duration : TIMING_DEFAULT_MS) + LAYOUT_GRACE_MS));
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
      return layoutTracked(original, args, [1, 2], isRecord(config) ? config.duration : undefined, this);
    },
  );
  // The preset helpers call the module's own `configureNext`, not the property, so they are counted here.
  for (const name of ['easeInEaseOut', 'linear', 'spring']) {
    patch(rnExport('LayoutAnimation'), name, (original) =>
      function (this: unknown, ...args: unknown[]): unknown {
        const layout = rnExport('LayoutAnimation');
        const presets = isRecord(layout) ? layout.Presets : undefined;
        const preset = isRecord(presets) ? presets[name] : undefined;
        return layoutTracked(original, args, [0], isRecord(preset) ? preset.duration : undefined, this);
      },
    );
  }
}

function patchInteractions(): void {
  const manager = rnExport('InteractionManager');
  patch(manager, 'createInteractionHandle', (original) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const handle = original.apply(this, args);
      add(handles, handle, null);
      return handle;
    },
  );
  patch(manager, 'clearInteractionHandle', (original) =>
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
    epoch += 1;
    restoreOwn();
    unpatchable = false;
    exportsRead = new Map();
    patchAnimated();
    patchLayoutAnimation();
    patchInteractions();
  }
  return uninstallIdleSignals;
}

/**
 * Puts back what is still on top. A wrapper something else was stacked on (the fast-animation wrappers) stays: it is
 * dead (it passes calls through) and its record is kept, so a later call restores it once the wrapper above is gone.
 */
function restoreOwn(): void {
  const kept: Patch[] = [];
  for (const record of patches.reverse()) {
    const { target, name, own, original, patched } = record;
    try {
      if (target[name] !== patched) {
        // Replaced by another patch above ours: keep the record. An app's own replacement is dropped with it later.
        kept.push(record);
        continue;
      }
      if (own) target[name] = original;
      else delete target[name];
    } catch {
      // ignore
    }
  }
  patches = kept.reverse();
}

export function uninstallIdleSignals(): void {
  if (!installed) return;
  installed = false;
  restoreOwn();
  exportsRead = null;
  handles.clear();
  animations.clear();
  loops.clear();
  layouts.clear();
  unpatchable = false;
  // A wait still polling ends now, as blind: its caller runs the quiet window.
  for (const stop of [...activeWaits]) stop();
}

/** Whether know-don't-watch is on: the signals are patched. Off by default in 1.6.0 (`knowIdle`). */
export function isKnowIdle(): boolean {
  return installed;
}

export function setKnowIdle(on: boolean): void {
  if (on) installIdleSignals();
  else uninstallIdleSignals();
}

/** The app's own setting (`knowIdle` in `startTapline`); an agent can only switch to quiet for a session. */
let appSetting = false;

/** Sets the app's own choice and applies it. */
export function configureKnowIdle(on: boolean): void {
  appSetting = on;
  setKnowIdle(on);
}

/** A session ended: back to the app's own setting. */
export function resetKnowIdle(): void {
  setKnowIdle(appSetting);
}

/** What the SDK sees running right now. */
export function readIdle(requestMark: number): IdleReading {
  return {
    interactionHandles: live(handles),
    animations: live(animations),
    layoutAnimating: live(layouts) > 0,
    startedRequestsOpen: openRequestsAfter(requestMark),
    blind: !installed || unpatchable || live(loops) > 0 || reanimatedPresent(),
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
 * mid-wait if it becomes blind (a loop starts) or is switched off. `requestMark` is `startedRequests()`
 * from when the action began: only requests begun after it count.
 */
export function waitUntilIdle(options: { frames: 1 | 2; capMs: number; requestMark: number }): Promise<IdleOutcome> {
  const started = Date.now();
  if (options.capMs <= 0 || readIdle(options.requestMark).blind) return Promise.resolve({ settledMs: 0, usedFallback: true, capped: false });
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
      activeWaits.delete(abort);
      if (capped) markStuck();
      resolve({ settledMs: Math.max(0, Math.min(options.capMs, Date.now() - started)), usedFallback, capped });
    };
    const abort = (): void => finish(true, false);
    activeWaits.add(abort);
    const cap = setTimeout(() => finish(false, true), options.capMs);
    const tick = (): void => {
      if (done) return;
      const reading = readIdle(options.requestMark);
      if (reading.blind) return finish(true, false);
      const now = Date.now();
      if (!idle(reading)) lastChange = now;
      if (now - lastChange >= holdMs) return finish(false, false);
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
  });
}
