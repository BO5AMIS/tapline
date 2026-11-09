/**
 * Import this FIRST in the app's entry file, before React / React Native:
 *
 *   import '@tapline/react-native/register';
 *
 * It installs a minimal React DevTools global hook (or wraps the existing one,
 * chaining every call) so Tapline can see the app's fiber roots. This file must
 * not import react or react-native.
 */
import { isFiber, isFiberRoot, HostRoot, type Fiber, type FiberRootLike } from './fiber';
import { isRecord } from './types';

type AnyFn = (...args: unknown[]) => unknown;

interface HookLike {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: AnyFn;
  onCommitFiberRoot?: AnyFn;
  onCommitFiberUnmount?: AnyFn;
  onPostCommitFiberRoot?: AnyFn;
  checkDCE?: AnyFn;
  getFiberRoots?: (rendererId: number) => unknown;
  [key: string]: unknown;
}

type HookGlobal = { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };

const WRAPPED = Symbol.for('tapline.hookWrapped');

/** renderer id -> roots seen via onCommitFiberRoot */
const rootsByRenderer = new Map<number, Set<FiberRootLike>>();
let installedHook: HookLike | null = null;

function record(rendererId: number, root: unknown): void {
  if (!isFiberRoot(root)) return;
  let set = rootsByRenderer.get(rendererId);
  if (!set) {
    set = new Set();
    rootsByRenderer.set(rendererId, set);
  }
  // A root with no children has been unmounted.
  if (root.current.child === null) set.delete(root);
  else set.add(root);
}

function forgetByFiber(fiber: unknown): void {
  if (!isFiber(fiber) || fiber.tag !== HostRoot) return;
  for (const set of rootsByRenderer.values()) {
    for (const root of set) {
      if (root.current === fiber || root.current.alternate === fiber || root === fiber.stateNode) {
        set.delete(root);
      }
    }
  }
}

function numberArg(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // never break React because of Tapline
  }
}

function wrap(hook: HookLike, name: 'onCommitFiberRoot' | 'onCommitFiberUnmount', before: (args: unknown[]) => void): void {
  const previous = hook[name];
  const wrapped: AnyFn = function (this: unknown, ...args: unknown[]): unknown {
    safely(() => before(args));
    return typeof previous === 'function' ? previous.apply(hook, args) : undefined;
  };
  hook[name] = wrapped;
}

function createHook(): HookLike {
  let nextId = 1;
  const hook: HookLike = {
    supportsFiber: true,
    renderers: new Map<number, unknown>(),
    inject(renderer: unknown): number {
      const id = nextId++;
      hook.renderers?.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(): void {},
    onCommitFiberUnmount(): void {},
    onPostCommitFiberRoot(): void {},
    checkDCE(): void {},
    onScheduleFiberRoot(): void {},
    setStrictMode(): void {},
    sub(): () => void {
      return () => {};
    },
    on(): void {},
    off(): void {},
    emit(): void {},
    getFiberRoots(rendererId: number): Set<FiberRootLike> {
      return rootsByRenderer.get(rendererId) ?? new Set();
    },
  };
  return hook;
}

/**
 * Install (or wrap) the hook on `target` (default: globalThis). Idempotent per
 * hook object. Returns the hook in effect.
 */
export function installHook(target: object = globalThis): unknown {
  const holder = target as HookGlobal;
  const existing = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  let hook: HookLike;
  if (isRecord(existing)) {
    hook = existing as HookLike;
    if (Object.prototype.hasOwnProperty.call(hook, WRAPPED)) {
      installedHook = hook;
      return hook;
    }
  } else {
    hook = createHook();
    try {
      Object.defineProperty(target, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: hook,
      });
    } catch {
      holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    }
  }

  wrap(hook, 'onCommitFiberRoot', (args) => record(numberArg(args[0]), args[1]));
  wrap(hook, 'onCommitFiberUnmount', (args) => forgetByFiber(args[1]));
  Object.defineProperty(hook, WRAPPED, { value: true, enumerable: false });
  installedHook = hook;
  return hook;
}

/** All live fiber roots known to Tapline. */
export function getRoots(): FiberRootLike[] {
  const found = new Set<FiberRootLike>();
  for (const set of rootsByRenderer.values()) for (const root of set) found.add(root);

  // An already-present DevTools hook may know roots committed before we wrapped it.
  const hook = installedHook;
  if (hook && hook.renderers instanceof Map && typeof hook.getFiberRoots === 'function') {
    for (const id of hook.renderers.keys()) {
      safely(() => {
        const roots = hook.getFiberRoots?.(id);
        if (roots instanceof Set) {
          for (const root of roots) if (isFiberRoot(root)) found.add(root);
        }
      });
    }
  }
  return [...found].filter((root) => root.current.child !== null);
}

/** Test helper: forget recorded roots and the installed-hook memory. */
export function resetRegistry(): void {
  rootsByRenderer.clear();
  installedHook = null;
}

export type { Fiber };

installHook();
