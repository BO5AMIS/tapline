import { mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { back, configureActions, press } from '../src/actions';
import { resetRefs, setMeasurer, stableObjectKey, tree } from '../src/inspect';
import { TaplineError } from '../src/types';
import type { Fiber } from '../src/fiber';

// The home-indicator inset the app's safe-area library reports (an optional peer, not installed here).
jest.mock(
  'react-native-safe-area-context',
  () => ({ initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 400, height: 800 } } }),
  { virtual: true },
);

interface FakeNavigation {
  isFocused: () => boolean;
  canGoBack: () => boolean;
  goBack: jest.Mock;
  navigate: jest.Mock;
  getState: () => unknown;
}

function navigation(options: { focused?: boolean; canGoBack?: boolean; state?: unknown } = {}): FakeNavigation {
  return {
    isFocused: () => options.focused ?? true,
    canGoBack: () => options.canGoBack ?? false,
    goBack: jest.fn(),
    navigate: jest.fn(),
    getState: () => options.state ?? { routes: [] },
  };
}

/** A screen component as React Navigation renders it: it receives `route` and `navigation`. */
function Screen({
  route,
  navigation: nav,
  children,
}: {
  route: { key: string; name: string; params?: Record<string, unknown> };
  navigation: FakeNavigation;
  children?: React.ReactNode;
}) {
  void route;
  void nav;
  return <View>{children}</View>;
}

/** A native component by name (React Native Screens' tabs); a host element here. */
function Native({ type, children, ...props }: { type: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement(type, props, children);
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
}

async function failure(promise: Promise<unknown>): Promise<TaplineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaplineError) return error;
    throw error;
  }
  throw new Error('expected a TaplineError');
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
});

afterEach(async () => {
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

describe('route', () => {
  test('tree names the focused route, outer to inner, with simple params', async () => {
    await mount(
      <Screen route={{ key: 'tabs-1', name: '(tabs)' }} navigation={navigation()}>
        <Screen
          route={{ key: 'nutrition-2', name: 'nutrition', params: { day: '2026-11-09', count: 3, onDone: () => undefined } }}
          navigation={navigation()}
        >
          <Text>Food</Text>
        </Screen>
        <Screen route={{ key: 'today-3', name: 'today' }} navigation={navigation({ focused: false })}>
          <Text>Today</Text>
        </Screen>
      </Screen>,
    );
    useFrames({});
    const result = await tree({});
    expect(result.route).toEqual({ names: ['(tabs)', 'nutrition'], params: { day: '2026-11-09', count: 3 } });
  });

  test('a screen component that passes its route on is named once', async () => {
    const nav = navigation();
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={nav}>
        <Screen route={{ key: 'home-1', name: 'home' }} navigation={nav}>
          <Text>Home</Text>
        </Screen>
      </Screen>,
    );
    useFrames({});
    expect((await tree({})).route).toEqual({ names: ['home'] });
  });

  test('no route without React Navigation', async () => {
    await mount(<Text>plain</Text>);
    useFrames({});
    expect((await tree({})).route).toBeUndefined();
  });
});

describe('back', () => {
  test('goes back from the focused screen', async () => {
    const leaf = navigation({ canGoBack: true });
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={navigation({ canGoBack: false })}>
        <Screen route={{ key: 'detail-2', name: 'detail' }} navigation={leaf}>
          <Text>Detail</Text>
        </Screen>
      </Screen>,
    );
    useFrames({});
    await run(() => back({}));
    expect(leaf.goBack).toHaveBeenCalledTimes(1);
  });

  test('is not_actionable when there is nothing to go back to', async () => {
    const leaf = navigation({ canGoBack: false });
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={leaf}>
        <Text>Home</Text>
      </Screen>,
    );
    useFrames({});
    const error = await failure(run(() => back({})));
    expect(error.code).toBe('not_actionable');
    expect(leaf.goBack).not.toHaveBeenCalled();
  });

  test('is unsupported without React Navigation', async () => {
    await mount(<Text>plain</Text>);
    useFrames({});
    expect((await failure(run(() => back({})))).code).toBe('unsupported');
  });
});

describe('stableObjectKey', () => {
  function fiberWith(stateNode: unknown): Fiber {
    return { tag: 5, type: 'View', elementType: 'View', memoizedProps: {}, stateNode, child: null, sibling: null, return: null };
  }

  test('uses Fabric\'s canonical object, which survives the clones made on every update', () => {
    const canonical = { nativeTag: 7 };
    expect(stableObjectKey(fiberWith({ node: {}, canonical }))).toBe(canonical);
    expect(stableObjectKey(fiberWith({ node: {}, canonical }))).toBe(stableObjectKey(fiberWith({ node: {}, canonical })));
  });

  test('falls back to the stateNode, then to the fiber', () => {
    const state = { _nativeTag: 3 };
    expect(stableObjectKey(fiberWith(state))).toBe(state);
    const bare = fiberWith(null);
    expect(stableObjectKey(bare)).toBe(bare);
  });
});

describe('native tabs', () => {
  const tabState = {
    routes: [
      { key: 'today-abc', name: 'today' },
      { key: 'nutrition-def', name: 'nutrition' },
      { key: 'steps-ghi', name: 'steps' },
    ],
  };

  async function mountTabs(): Promise<FakeNavigation> {
    const todayNav = navigation({ state: tabState });
    await mount(
      <Native type="RNSTabsHostIOS">
        <Native type="RNSTabsScreenIOS" title="Today" screenKey="today-abc" pointerEvents="box-none">
          <Screen route={{ key: 'today-abc', name: 'today' }} navigation={todayNav}>
            <Text>Today screen</Text>
          </Screen>
        </Native>
        <Native type="RNSTabsScreenIOS" title="Nutrition" screenKey="nutrition-def" pointerEvents="none">
          <Screen route={{ key: 'nutrition-def', name: 'nutrition' }} navigation={navigation({ focused: false, state: tabState })}>
            <Text>Nutrition screen</Text>
          </Screen>
        </Native>
        <Native type="RNSTabsScreenIOS" screenKey="steps-ghi" pointerEvents="none" />
      </Native>,
    );
    useFrames({});
    return todayNav;
  }

  test('lists every tab as a pressable element, hidden ones included, and the selected one', async () => {
    await mountTabs();
    const { elements } = await tree({});
    const tabs = elements.filter((e) => e.role === 'tab');
    expect(tabs.map((t) => [t.type, t.text, t.selected, t.actions])).toEqual([
      ['Tab', 'Today', true, ['press']],
      ['Tab', 'Nutrition', false, ['press']],
      ['Tab', 'steps', false, ['press']],
    ]);
    expect(elements.some((e) => e.text === 'Nutrition screen')).toBe(false);
  });

  test('pressing a tab switches to it through navigation', async () => {
    const todayNav = await mountTabs();
    await tree({});
    await run(() => press({ target: { text: 'Nutrition' } }));
    expect(todayNav.navigate).toHaveBeenCalledWith('nutrition');
  });

  describe('where iOS draws the tab bar (an iPhone in portrait: 49 pt above the 34 pt inset)', () => {
    // The screen here is 400x800, so the bar is y 717 to 800, three tabs of 133 pt.
    async function mountTabsOver(content: React.ReactNode): Promise<FakeNavigation> {
      const todayNav = navigation({ state: tabState });
      await mount(
        <Native type="RNSTabsHostIOS">
          <Native type="RNSTabsScreenIOS" title="Today" screenKey="today-abc" pointerEvents="box-none">
            <Screen route={{ key: 'today-abc', name: 'today' }} navigation={todayNav}>
              {content}
            </Screen>
          </Native>
          <Native type="RNSTabsScreenIOS" title="Nutrition" screenKey="nutrition-def" pointerEvents="none" />
          <Native type="RNSTabsScreenIOS" title="Steps" screenKey="steps-ghi" pointerEvents="none" />
        </Native>,
      );
      return todayNav;
    }

    test('a tap there switches to the tab under it, never what the app draws behind the bar', async () => {
      const onCard = jest.fn();
      const todayNav = await mountTabsOver(
        <Pressable testID="card" onPress={onCard}>
          <Text>Card</Text>
        </Pressable>,
      );
      useFrames({ card: { x: 0, y: 600, width: 400, height: 200 } });
      await run(() => press({ target: { x: 200, y: 760 } }));
      expect(todayNav.navigate).toHaveBeenCalledWith('nutrition');
      await run(() => press({ target: { x: 390, y: 730 } }));
      expect(todayNav.navigate).toHaveBeenLastCalledWith('steps');
      expect(onCard).not.toHaveBeenCalled();
      // Just above the bar is the card.
      await run(() => press({ target: { x: 200, y: 700 } }));
      expect(onCard).toHaveBeenCalledTimes(1);
    });

    test('an element whose middle is under the bar is covered by it', async () => {
      const onLow = jest.fn();
      await mountTabsOver(
        <Pressable testID="low" onPress={onLow}>
          <Text>Low</Text>
        </Pressable>,
      );
      useFrames({ low: { x: 0, y: 730, width: 400, height: 40 } });
      const error = await failure(press({ target: { testID: 'low' } }));
      expect(error.code).toBe('not_actionable');
      expect(error.message).toContain('tab bar');
      expect(onLow).not.toHaveBeenCalled();
      await run(() => press({ target: { testID: 'low' }, force: true }));
      expect(onLow).toHaveBeenCalledTimes(1);
    });

    test('an open modal covers the bar: a tap there goes to the modal', async () => {
      const onSheet = jest.fn();
      const todayNav = await mountTabsOver(
        <Native type="RCTModalHostView">
          <View>
            <Pressable testID="sheet-button" onPress={onSheet}>
              <Text>Save</Text>
            </Pressable>
          </View>
        </Native>,
      );
      useFrames({ 'sheet-button': { x: 0, y: 730, width: 400, height: 50 } });
      await run(() => press({ target: { x: 200, y: 750 } }));
      expect(onSheet).toHaveBeenCalledTimes(1);
      expect(todayNav.navigate).not.toHaveBeenCalled();
    });
  });
});
