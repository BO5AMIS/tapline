import { mount, unmountAll, useFrames } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio, Platform, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions, press } from '../src/actions';
import { nativeNavBar, resetRefs, setMeasurer, takeSnapshot } from '../src/inspect';
import { TaplineError } from '../src/types';

// The safe-area top inset is 47, so a plain navigation bar reaches y 91 (47 + 44).
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

function navigation(canGoBack: boolean): FakeNavigation {
  return { isFocused: () => true, canGoBack: () => canGoBack, goBack: jest.fn(), navigate: jest.fn(), getState: () => ({ routes: [] }) };
}

function Route({ name, nav, children }: { name: string; nav: FakeNavigation; route?: { key: string; name: string }; navigation?: FakeNavigation; children?: React.ReactNode }) {
  void name;
  void nav;
  return <View>{children}</View>;
}

/** A screen component as React Navigation renders it: it receives `route` and `navigation`. */
function Screen({ nav, name = 'screen', children }: { nav: FakeNavigation; name?: string; children?: React.ReactNode }) {
  return (
    <Route name={name} nav={nav} route={{ key: `${name}-1`, name }} navigation={nav}>
      {children}
    </Route>
  );
}

function Native({ type, children, ...props }: { type: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement(type, props, children);
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

async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await fn();
  });
  return result as T;
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

const NO_FRAMES = null;

/** One stack screen with a header config over `content`. */
function oneScreen(header: Record<string, unknown>, content: React.ReactNode, nav = navigation(false)): React.ReactElement {
  return (
    <Native type="RNSScreenStack">
      <Native type="RNSScreen">
        <Native type="RNSScreenStackHeaderConfig" {...header} />
        <Screen nav={nav}>{content}</Screen>
      </Native>
    </Native>
  );
}

describe('an element under the navigation bar iOS draws', () => {
  const lab = (onLab: () => void) => (
    <Pressable testID="lab-under-header" onPress={onLab}>
      <Text>Under header</Text>
    </Pressable>
  );

  test('a translucent header: centre at y 81 is covered; force passes', async () => {
    const onLab = jest.fn();
    await mount(oneScreen({ translucent: true, title: 'Lab' }, lab(onLab)));
    // 6 pt below the bar (it reaches y 91) is too little to touch: refused at the centre, y 77.
    useFrames({ 'lab-under-header': { x: 20, y: 57, width: 360, height: 40 } });
    const error = await failure(press({ target: { testID: 'lab-under-header' } }));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^covered: /);
    expect(error.message).toContain('is under the navigation bar iOS draws, at (200, 77): a real tap would hit the bar instead.');
    expect(error.message).toContain('Scroll it down first, or pass force: true to call its handler anyway.');
    expect(onLab).not.toHaveBeenCalled();
    await run(() => press({ target: { testID: 'lab-under-header' }, force: true }));
    expect(onLab).toHaveBeenCalledTimes(1);
  });

  test('a hidden header draws no bar', async () => {
    const onLab = jest.fn();
    await mount(oneScreen({ hidden: true }, lab(onLab)));
    useFrames({ 'lab-under-header': { x: 20, y: 57, width: 360, height: 48 } });
    expect(nativeNavBar(takeSnapshot())).toBeNull();
    await run(() => press({ target: { testID: 'lab-under-header' } }));
    expect(onLab).toHaveBeenCalledTimes(1);
  });

  test('centred below the bar (y 130) is reachable', async () => {
    const onLab = jest.fn();
    await mount(oneScreen({ translucent: true }, lab(onLab)));
    useFrames({ 'lab-under-header': { x: 20, y: 110, width: 360, height: 40 } });
    await run(() => press({ target: { testID: 'lab-under-header' } }));
    expect(onLab).toHaveBeenCalledTimes(1);
  });

  test('a custom header item inside the header config is reachable', async () => {
    const onItem = jest.fn();
    await mount(
      <Native type="RNSScreenStack">
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig">
            <Native type="RNSScreenStackHeaderSubview">
              <Pressable testID="header-item" onPress={onItem}>
                <Text>Item</Text>
              </Pressable>
            </Native>
          </Native>
          <Screen nav={navigation(false)}>
            <Text>body</Text>
          </Screen>
        </Native>
      </Native>,
    );
    useFrames({ 'header-item': { x: 340, y: 57, width: 44, height: 44 } });
    await run(() => press({ target: { testID: 'header-item' } }));
    expect(onItem).toHaveBeenCalledTimes(1);
    // A point tap on it presses the item too.
    await run(() => press({ target: { x: 362, y: 79 } }));
    expect(onItem).toHaveBeenCalledTimes(2);
  });

  test('an open Modal covers the bar: no navigation bar refusal', async () => {
    const onLab = jest.fn();
    await mount(
      oneScreen(
        { translucent: true },
        <Native type="RCTModalHostView">
          <View>{lab(onLab)}</View>
        </Native>,
      ),
    );
    useFrames({ 'lab-under-header': { x: 20, y: 57, width: 360, height: 48 } });
    expect(nativeNavBar(takeSnapshot())).toBeNull();
    await run(() => press({ target: { testID: 'lab-under-header' } }));
    expect(onLab).toHaveBeenCalledTimes(1);
  });

  test('not on iOS there is no bar', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await mount(oneScreen({ translucent: true }, <Text>x</Text>));
    expect(nativeNavBar(takeSnapshot())).toBeNull();
  });
});

describe('which header is the visible one', () => {
  test('only the top screen of a stack counts: a header on an earlier screen is ignored', async () => {
    const onLab = jest.fn();
    await mount(
      <Native type="RNSScreenStack">
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig" title="Home" />
          <Text>home</Text>
        </Native>
        <Native type="RNSScreen">
          <Screen nav={navigation(true)}>
            <Pressable testID="lab" onPress={onLab}>
              <Text>Lab</Text>
            </Pressable>
          </Screen>
        </Native>
      </Native>,
    );
    useFrames({ lab: { x: 20, y: 57, width: 360, height: 48 } });
    expect(nativeNavBar(takeSnapshot())).toBeNull();
    await run(() => press({ target: { testID: 'lab' } }));
    expect(onLab).toHaveBeenCalledTimes(1);
  });

  test('nested stacks: the deepest header on the top screens wins, with its own title and back', async () => {
    await mount(
      <Native type="RNSScreenStack">
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig" title="old outer" />
        </Native>
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig" title="outer top" />
          <Native type="RNSScreenStack">
            <Native type="RNSScreen">
              <Native type="RNSScreenStackHeaderConfig" title="inner first" />
            </Native>
            <Native type="RNSScreen">
              <Native type="RNSScreenStackHeaderConfig" title="inner top" />
            </Native>
          </Native>
        </Native>
      </Native>,
    );
    expect(nativeNavBar(takeSnapshot())).toMatchObject({ top: 0, bottom: 91, title: 'inner top', canGoBack: true });
  });

  test('canGoBack is false on the first screen or with hideBackButton', async () => {
    await mount(oneScreen({ title: 'First' }, <Text>x</Text>));
    expect(nativeNavBar(takeSnapshot())).toMatchObject({ title: 'First', canGoBack: false });
    await unmountAll();
    await mount(
      <Native type="RNSScreenStack">
        <Native type="RNSScreen" />
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig" hideBackButton />
        </Native>
      </Native>,
    );
    expect(nativeNavBar(takeSnapshot())?.canGoBack).toBe(false);
  });

  test('a large title makes the bar 52 higher', async () => {
    await mount(oneScreen({ largeTitle: true }, <Text>x</Text>));
    expect(nativeNavBar(takeSnapshot())?.bottom).toBe(91 + 52);
  });
});

describe('a point on the navigation bar', () => {
  async function mountPushed(nav: FakeNavigation, canGoBack: boolean): Promise<void> {
    await mount(
      <Native type="RNSScreenStack">
        {canGoBack ? <Native type="RNSScreen" /> : null}
        <Native type="RNSScreen">
          <Native type="RNSScreenStackHeaderConfig" translucent title="Detail" />
          <Screen nav={nav}>
            <Pressable testID="lab" onPress={() => {}}>
              <Text>Lab</Text>
            </Pressable>
          </Screen>
        </Native>
      </Native>,
    );
    useFrames({ lab: { x: 20, y: 57, width: 360, height: 48 } }, NO_FRAMES);
  }

  test('on the back button area, with a screen to go back to, it goes back', async () => {
    const nav = navigation(true);
    await mountPushed(nav, true);
    const result = await run(() => press({ target: { x: 30, y: 80 } }));
    expect(nav.goBack).toHaveBeenCalledTimes(1);
    expect(result.element.text).toBe('Back');
    expect(result.element.role).toBe('button');
  });

  test('elsewhere on the bar it is no_action', async () => {
    const nav = navigation(true);
    await mountPushed(nav, true);
    const error = await failure(press({ target: { x: 215, y: 80 } }));
    expect(error.code).toBe('not_actionable');
    expect(error.message).toMatch(/^no_action: /);
    expect(error.message).toContain("Nothing at (215, 80) takes a tap: it's on the navigation bar iOS draws.");
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  test('with nothing to go back to the back area is no_action too', async () => {
    const nav = navigation(false);
    await mountPushed(nav, false);
    const error = await failure(press({ target: { x: 30, y: 80 } }));
    expect(error.message).toMatch(/^no_action: Nothing at \(30, 80\) takes a tap: it's on the navigation bar iOS draws\./);
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  test('just below the bar the element is pressed as usual', async () => {
    const nav = navigation(true);
    await mountPushed(nav, true);
    useFrames({ lab: { x: 20, y: 95, width: 360, height: 48 } }, NO_FRAMES);
    await run(() => press({ target: { x: 200, y: 120 } }));
    expect(nav.goBack).not.toHaveBeenCalled();
  });
});

describe('only visible screens supply the header', () => {
  const tabs = (selectedHeader: Record<string, unknown>) => (
    <Native type="RNSTabsHostIOS">
      <Native type="RNSTabsScreenIOS" title="A" screenKey="a" pointerEvents="box-none">
        <Native type="RNSScreenStack">
          <Native type="RNSScreen">
            <Native type="RNSScreenStackHeaderConfig" {...selectedHeader} />
          </Native>
        </Native>
      </Native>
      <Native type="RNSTabsScreenIOS" title="B" screenKey="b" pointerEvents="none">
        <Native type="RNSScreenStack">
          <Native type="RNSScreen">
            <Native type="RNSScreenStackHeaderConfig" title="unselected" largeTitle />
          </Native>
        </Native>
      </Native>
    </Native>
  );

  test('native tabs: only the selected tab counts', async () => {
    await mount(tabs({ title: 'selected' }));
    expect(nativeNavBar(takeSnapshot())).toMatchObject({ title: 'selected', bottom: 91 });
  });

  test('native tabs: a hidden header on the selected tab means no bar', async () => {
    await mount(tabs({ hidden: true }));
    expect(nativeNavBar(takeSnapshot())).toBeNull();
  });

  test('an inactive RNSScreen (activityState 0) is ignored', async () => {
    await mount(
      <Native type="RNSScreen" activityState={0}>
        <Native type="RNSScreenStackHeaderConfig" title="inactive" />
      </Native>,
    );
    expect(nativeNavBar(takeSnapshot())).toBeNull();
  });
});
