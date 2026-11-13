import { mount, unmountAll, useFrames } from './helpers';
import React, { useState } from 'react';
import { Alert, AppRegistry, Dimensions, PixelRatio, Pressable, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions } from '../src/actions';
import { installAlertTracking, uninstallAlertTracking } from '../src/alerts';
import { setEventSink } from '../src/events';
import { resetRefs, setMeasurer, tree } from '../src/inspect';
import { currentPlace, placeData, routePattern, startPlaceEvents } from '../src/place';
import { looksLikeValue, placeFrom, tabNameFromKey } from '../src/placekey';
import type { RouteFound } from '../src/inspect';

// AGENT-TOOLS 1.13 §18.1 and §18.11: where the app is, as a key. Pattern names only: no param's value, no screen text.

interface FakeNavigation {
  isFocused: () => boolean;
  canGoBack: () => boolean;
  goBack: jest.Mock;
  navigate: jest.Mock;
  getState: () => unknown;
}

function navigation(state?: unknown): FakeNavigation {
  return {
    isFocused: () => true,
    canGoBack: () => false,
    goBack: jest.fn(),
    navigate: jest.fn(),
    getState: () => state ?? { routes: [] },
  };
}

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

/** A native component by name (React Native Screens' screen container); a host element here. */
function Native({ type, children, ...props }: { type: string; children?: React.ReactNode } & Record<string, unknown>) {
  return React.createElement(type, props, children);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));
beforeEach(() => {
  resetRefs();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
});
afterEach(async () => {
  await unmountAll();
  setEventSink(null);
  uninstallAlertTracking();
  setMeasurer(null);
  jest.restoreAllMocks();
});

describe('routePattern', () => {
  test('splits "trips/[id]" and ["trips","[id]"] into the same pattern', () => {
    expect(routePattern(['trips/[id]'])).toEqual(['trips', '[id]']);
    expect(routePattern(['trips', '[id]'])).toEqual(['trips', '[id]']);
    expect(routePattern(['(tabs)', 'settings/language'])).toEqual(['(tabs)', 'settings', 'language']);
  });

  test('drops empty pieces, so a leading or doubled slash makes no phantom name', () => {
    expect(routePattern(['/trips//[id]/', ''])).toEqual(['trips', '[id]']);
  });
});

describe('values are not names (AGENT-TOOLS 1.13 §18.1)', () => {
  const found = (chain: string[], presentation?: string): RouteFound => ({
    key: `k-${chain.join('-')}`,
    name: chain[chain.length - 1] ?? '',
    params: undefined,
    navigation: navigation({ type: 'stack' }) as unknown as RouteFound['navigation'],
    focused: true,
    chain,
    ...(presentation !== undefined ? { presentation } : {}),
  });
  const place = (route: RouteFound) => placeFrom({ routes: [route], tabs: [], modal: null });

  test.each(['1234', '12', 'order-10432', '3fa9c1d2-7b0e-44a8-9c01-e7a5d2b84f36', '3fa9c1d27b0e44a8c1'])('%s looks like a value', (piece) => {
    expect(looksLikeValue(piece)).toBe(true);
  });
  test.each(['[id]', 'settings', 'sheet:Filters', 'tab-2'])('%s is a name', (piece) => {
    expect(looksLikeValue(piece)).toBe(false);
  });

  test('a route piece that is a value leaves no route, so the host uses its signature', () => {
    expect(place(found(['orders', '10432']))).toEqual({ route: [] });
    expect(place(found(['orders/[id]']))).toEqual({ route: ['orders', '[id]'] });
  });

  test('a layer name that is a value keeps only its kind', () => {
    expect(place(found(['trips', 'sheet-98765'], 'formSheet')).layer).toBe('sheet');
    expect(place(found(['trips', 'filters'], 'formSheet')).layer).toBe('sheet:filters');
    expect(place(found(['trips', 'detail-12345'], 'modal')).layer).toBe('modal');
  });
});

describe('currentPlace', () => {
  test('/user/123 and /user/456 give one place', async () => {
    await mount(
      <Screen route={{ key: 'u-1', name: 'user/[id]', params: { id: '123' } }} navigation={navigation()}>
        <Text>Ann</Text>
      </Screen>,
    );
    const first = currentPlace();
    await unmountAll();
    await mount(
      <Screen route={{ key: 'u-2', name: 'user/[id]', params: { id: '456' } }} navigation={navigation()}>
        <Text>Ben</Text>
      </Screen>,
    );
    expect(first).toEqual({ route: ['user', '[id]'] });
    expect(currentPlace()).toEqual(first);
  });

  test('a tab switch changes tab', async () => {
    const tabRoutes = [
      { key: 'home-a', name: 'home' },
      { key: 'settings-b', name: 'settings' },
    ];
    const outer = navigation({ type: 'stack', index: 0, routes: [{ key: 'tabs-1', name: '(tabs)' }] });
    function App({ index }: { index: number }) {
      const nav = navigation({ type: 'tab', index, routes: tabRoutes });
      const shown = tabRoutes[index] ?? tabRoutes[0]!;
      return (
        <Screen route={{ key: 'tabs-1', name: '(tabs)' }} navigation={outer}>
          <Screen route={shown} navigation={nav}>
            <Text>{shown.name}</Text>
          </Screen>
        </Screen>
      );
    }
    const renderer = await mount(<App index={0} />);
    expect(currentPlace()).toEqual({ route: ['(tabs)', 'home'], tab: 'home' });
    await act(async () => {
      renderer.update(<App index={1} />);
    });
    expect(currentPlace()).toEqual({ route: ['(tabs)', 'settings'], tab: 'settings' });
  });

  test('a native tab bar gives the selected tab from the tabs list, by its key and never its title', async () => {
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={navigation()}>
        <Native type="RNSBottomTabsHost">
          <Native type="RNSBottomTabsScreen" title="Heute" isFocused={false} screenKey={`today-${'a'.repeat(21)}`} />
          <Native type="RNSBottomTabsScreen" title="Einstellungen" screenKey={`my-settings-${'Ab-_9'.repeat(4)}x`} isFocused />
        </Native>
      </Screen>,
    );
    const place = currentPlace();
    expect(place?.tab).toBe('my-settings');
    expect(JSON.stringify(place)).not.toContain('Einstellungen');
  });

  test('tabNameFromKey cuts a 21-character id only, so "home-tab" stays whole', () => {
    expect(tabNameFromKey('home-tab')).toBe('home-tab');
    expect(tabNameFromKey('home')).toBe('home');
    expect(tabNameFromKey(`home-${'z'.repeat(21)}`)).toBe('home');
    expect(tabNameFromKey(`my-tab-${'Q-_a'.repeat(5)}1`)).toBe('my-tab');
  });

  test('an open alert makes layer "alert"', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
    installAlertTracking({ standIn: false });
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={navigation()}>
        <Text>Home</Text>
      </Screen>,
    );
    expect(currentPlace()).toEqual({ route: ['home'] });
    Alert.alert('Delete?', 'This cannot be undone');
    expect(currentPlace()).toEqual({ route: ['home'], layer: 'alert' });
  });

  test('a bare Modal is "modal", and its root testID names it', async () => {
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={navigation()}>
        <Text>Home</Text>
        {React.createElement('RCTModalHostView', { visible: true }, <View><Text>sheet</Text></View>)}
      </Screen>,
    );
    expect(currentPlace()).toEqual({ route: ['home'], layer: 'modal' });
    await unmountAll();
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={navigation()}>
        {React.createElement('RCTModalHostView', { visible: true }, <View testID="filters-root"><Text>sheet</Text></View>)}
      </Screen>,
    );
    expect(currentPlace()).toEqual({ route: ['home'], layer: 'modal:filters-root' });
  });

  test('a navigation modal route is "modal:<route name>", a form sheet "sheet:<route name>"', async () => {
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={navigation()}>
        <Native type="RNSScreen" stackPresentation="modal" activityState={2}>
          <Screen route={{ key: 'filters-2', name: 'filters' }} navigation={navigation()}>
            <Text>Filters</Text>
          </Screen>
        </Native>
      </Screen>,
    );
    expect(currentPlace()).toEqual({ route: ['root', 'filters'], layer: 'modal:filters' });
    await unmountAll();
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={navigation()}>
        <Native type="RNSScreen" stackPresentation="formSheet" activityState={2}>
          <Screen route={{ key: 'filters-2', name: 'filters' }} navigation={navigation()}>
            <Text>Filters</Text>
          </Screen>
        </Native>
      </Screen>,
    );
    expect(currentPlace()?.layer).toBe('sheet:filters');
  });

  test('a plain pushed screen has no layer', async () => {
    await mount(
      <Screen route={{ key: 'root-1', name: 'root' }} navigation={navigation()}>
        <Native type="RNSScreen" stackPresentation="push" activityState={2}>
          <Screen route={{ key: 'detail-2', name: 'detail' }} navigation={navigation()}>
            <Text>Detail</Text>
          </Screen>
        </Native>
      </Screen>,
    );
    expect(currentPlace()).toEqual({ route: ['root', 'detail'] });
  });

  test('no router gives route [], and so does no React root at all', async () => {
    expect(placeData().route).toEqual([]);
    await mount(<Text>Hello</Text>);
    expect(currentPlace()).toEqual({ route: [] });
    expect(placeData(() => 42)).toEqual({ route: [], seenAt: 42 });
  });
});

describe('the place event', () => {
  function capture(): Array<{ event: string; data: unknown }> {
    const sent: Array<{ event: string; data: unknown }> = [];
    setEventSink((event, data) => sent.push({ event, data }));
    return sent;
  }

  test('fires once per change, not on repeats', async () => {
    const sent = capture();
    let go: (name: string) => void = () => undefined;
    function App() {
      const [name, setName] = useState('home');
      const [, setCount] = useState(0);
      go = (next) => (next === 'same' ? setCount((c) => c + 1) : setName(next));
      return (
        <Screen route={{ key: `${name}-1`, name }} navigation={navigation()}>
          <Text>{name}</Text>
        </Screen>
      );
    }
    await mount(<App />);
    const stop = startPlaceEvents({ debounceMs: 5, now: () => 1731500000000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ event: 'place', data: { route: ['home'], seenAt: 1731500000000 } });
    await act(async () => go('same'));
    await act(async () => sleep(30));
    expect(sent).toHaveLength(1);
    await act(async () => go('settings'));
    await act(async () => sleep(30));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.data).toEqual({ route: ['settings'], seenAt: 1731500000000 });
    await act(async () => go('same'));
    await act(async () => sleep(30));
    expect(sent).toHaveLength(2);
    stop();
    await act(async () => go('profile'));
    await act(async () => sleep(30));
    expect(sent).toHaveLength(2);
  });

  test('an alert opening and closing is an event with no commit of its own', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
    installAlertTracking({ standIn: false });
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={navigation()}>
        <Text>Home</Text>
      </Screen>,
    );
    const sent = capture();
    const stop = startPlaceEvents({ debounceMs: 5 });
    await act(async () => {
      Alert.alert('Sure?');
      await sleep(30);
    });
    expect(sent.map((s) => (s.data as { layer?: string }).layer)).toEqual([undefined, 'alert']);
    stop();
  });

  test('the event carries no params and no screen text', async () => {
    const sent = capture();
    await mount(
      <Screen route={{ key: 'u-1', name: 'user/[id]', params: { id: 'secret-123', email: 'tester@example.com' } }} navigation={navigation()}>
        <Pressable accessibilityLabel="Order #10432">
          <Text>Chat with Sara</Text>
        </Pressable>
      </Screen>,
    );
    const stop = startPlaceEvents({ debounceMs: 5 });
    const json = JSON.stringify(sent);
    expect(sent).toHaveLength(1);
    for (const secret of ['secret-123', 'tester@example.com', 'Sara', '10432']) expect(json).not.toContain(secret);
    expect(JSON.parse(json)[0].data.route).toEqual(['user', '[id]']);
    stop();
  });
});

describe('tree.place', () => {
  test('the tree carries the place, and no router gives an empty route', async () => {
    await mount(
      <Screen route={{ key: 'home-1', name: 'home' }} navigation={navigation()}>
        <Text>Home</Text>
      </Screen>,
    );
    useFrames({});
    expect((await tree({})).place).toEqual({ route: ['home'] });
  });
});
