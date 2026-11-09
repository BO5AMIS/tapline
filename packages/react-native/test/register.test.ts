import { isRecord } from '../src/types';

type RegisterModule = typeof import('../src/register');
type Hook = Record<string, unknown> & {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: unknown[]) => unknown;
  onCommitFiberUnmount?: (...args: unknown[]) => unknown;
  onPostCommitFiberRoot?: (...args: unknown[]) => unknown;
  checkDCE?: (...args: unknown[]) => unknown;
};

const holder = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };

function fakeFiber(tag: number, child: unknown = null): Record<string, unknown> {
  return { tag, type: null, elementType: null, memoizedProps: null, stateNode: null, child, sibling: null, return: null };
}

function fakeRoot(withChild = true): { current: Record<string, unknown> } {
  return { current: fakeFiber(3, withChild ? fakeFiber(5) : null) };
}

/** Load a fresh copy of register.ts against whatever hook is currently global. */
function loadFresh(): RegisterModule {
  let loaded: RegisterModule | undefined;
  jest.isolateModules(() => {
    loaded = require('../src/register') as RegisterModule;
  });
  if (!loaded) throw new Error('register did not load');
  return loaded;
}

let original: unknown;

beforeEach(() => {
  original = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete holder.__REACT_DEVTOOLS_GLOBAL_HOOK__;
});

afterEach(() => {
  if (original === undefined) delete holder.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  else holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = original;
});

describe('without an existing hook', () => {
  test('installs a hook that satisfies what React expects', () => {
    loadFresh();
    const hook = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook;
    expect(isRecord(hook)).toBe(true);
    expect(hook.supportsFiber).toBe(true);
    expect(hook.renderers).toBeInstanceOf(Map);
    for (const name of ['inject', 'onCommitFiberRoot', 'onCommitFiberUnmount', 'onPostCommitFiberRoot', 'checkDCE']) {
      expect(typeof hook[name]).toBe('function');
    }
  });

  test('inject returns increasing renderer ids and registers the renderer', () => {
    loadFresh();
    const hook = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook;
    const rendererA = { name: 'a' };
    const rendererB = { name: 'b' };
    const idA = hook.inject?.(rendererA);
    const idB = hook.inject?.(rendererB);
    expect(typeof idA).toBe('number');
    expect(idB).not.toBe(idA);
    expect(hook.renderers?.get(idA as number)).toBe(rendererA);
  });

  test('tolerates every other call as a no-op', () => {
    loadFresh();
    const hook = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook;
    expect(() => {
      hook.onPostCommitFiberRoot?.(1, {});
      hook.checkDCE?.(() => {});
      hook.onCommitFiberRoot?.(1, 'not a root');
      hook.onCommitFiberRoot?.(1, null);
      hook.onCommitFiberRoot?.();
      hook.onCommitFiberUnmount?.(1, 'nope');
      hook.onCommitFiberUnmount?.();
    }).not.toThrow();
  });

  test('records roots from onCommitFiberRoot and forgets them when they unmount', () => {
    const register = loadFresh();
    const hook = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook;
    const root = fakeRoot();
    hook.onCommitFiberRoot?.(1, root, 0, false);
    expect(register.getRoots()).toEqual([root]);

    // a second commit of the same root does not duplicate it
    hook.onCommitFiberRoot?.(1, root, 0, false);
    expect(register.getRoots()).toHaveLength(1);

    // React reports an unmounted root as a commit whose HostRoot has no child
    root.current.child = null;
    hook.onCommitFiberRoot?.(1, root, 0, false);
    expect(register.getRoots()).toEqual([]);
  });

  test('forgets a root when its HostRoot fiber is unmounted', () => {
    const register = loadFresh();
    const hook = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook;
    const root = fakeRoot();
    const other = fakeRoot();
    hook.onCommitFiberRoot?.(1, root);
    hook.onCommitFiberRoot?.(2, other);
    hook.onCommitFiberUnmount?.(1, root.current);
    expect(register.getRoots()).toEqual([other]);
  });

  test('installing twice on the same hook records once', () => {
    const register = loadFresh();
    register.installHook();
    register.installHook();
    const hook = holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ as Hook;
    hook.onCommitFiberRoot?.(1, fakeRoot());
    expect(register.getRoots()).toHaveLength(1);
  });
});

describe('with an existing hook (chaining)', () => {
  function previousHook(): Hook {
    return {
      supportsFiber: true,
      renderers: new Map<number, unknown>(),
      inject: jest.fn(() => 7),
      onCommitFiberRoot: jest.fn(() => 'prev-commit'),
      onCommitFiberUnmount: jest.fn(),
      onPostCommitFiberRoot: jest.fn(),
      checkDCE: jest.fn(),
      somethingCustom: 42,
    };
  }

  test('wraps the existing hook in place and keeps its identity and members', () => {
    const previous = previousHook();
    holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    loadFresh();
    expect(holder.__REACT_DEVTOOLS_GLOBAL_HOOK__).toBe(previous);
    expect(previous.somethingCustom).toBe(42);
    expect(previous.inject?.({})).toBe(7);
  });

  test('chains every wrapped call to the previous implementation', () => {
    const previous = previousHook();
    const originalCommit = previous.onCommitFiberRoot as jest.Mock;
    const originalUnmount = previous.onCommitFiberUnmount as jest.Mock;
    holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    const register = loadFresh();

    const root = fakeRoot();
    const result = previous.onCommitFiberRoot?.(3, root, 'priority', false);
    expect(result).toBe('prev-commit');
    expect(originalCommit).toHaveBeenCalledWith(3, root, 'priority', false);
    expect(register.getRoots()).toEqual([root]);

    previous.onCommitFiberUnmount?.(3, root.current);
    expect(originalUnmount).toHaveBeenCalledWith(3, root.current);
    expect(register.getRoots()).toEqual([]);
  });

  test('records the root before the previous handler runs, even if that handler throws', () => {
    const previous = previousHook();
    previous.onCommitFiberRoot = jest.fn(() => {
      throw new Error('devtools broke');
    });
    holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    const register = loadFresh();
    const root = fakeRoot();
    expect(() => previous.onCommitFiberRoot?.(1, root)).toThrow('devtools broke');
    expect(register.getRoots()).toEqual([root]);
  });

  test('works when the previous hook has no onCommit handlers', () => {
    const previous: Hook = { supportsFiber: true, renderers: new Map<number, unknown>(), inject: () => 1 };
    holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    const register = loadFresh();
    const root = fakeRoot();
    expect(() => previous.onCommitFiberRoot?.(1, root)).not.toThrow();
    expect(register.getRoots()).toEqual([root]);
  });

  test('picks up roots the existing hook already knows through getFiberRoots', () => {
    const known = fakeRoot();
    const previous = previousHook();
    previous.renderers = new Map<number, unknown>([[1, {}]]);
    previous.getFiberRoots = (id: number) => (id === 1 ? new Set([known]) : new Set());
    holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    const register = loadFresh();
    expect(register.getRoots()).toEqual([known]);
  });

  test('a second copy of the module does not wrap the hook again', () => {
    const previous = previousHook();
    const originalCommit = previous.onCommitFiberRoot as jest.Mock;
    holder.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    loadFresh();
    const wrapped = previous.onCommitFiberRoot;
    loadFresh();
    expect(previous.onCommitFiberRoot).toBe(wrapped);
    previous.onCommitFiberRoot?.(1, fakeRoot());
    expect(originalCommit).toHaveBeenCalledTimes(1);
  });
});
