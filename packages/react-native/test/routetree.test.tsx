import { mount, unmountAll } from './helpers';
import React from 'react';
import { AppRegistry, View } from 'react-native';
import { knownPlaces, pickPrefix, placesFromExpoTree, placesFromLinking } from '../src/routetree';

// AGENT-TOOLS 1.13 §18.1 "Known before any visit". Expo Router's store is internal, so it is read behind a guard (plan answer 21).

function node(route: string, children: unknown[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { route, children, ...extra };
}

/** A tree shaped like Expo Router's `routeNode`: a root, a tab layout, a stack with a dynamic route. */
const TREE = node('', [
  node('(tabs)', [node('index'), node('settings/language'), node('trips', [node('index'), node('[id]')], { type: 'layout' })], { type: 'layout' }),
  node('+not-found'),
  node('_sitemap'),
], { type: 'layout' });

afterEach(async () => {
  await unmountAll();
  jest.restoreAllMocks();
  jest.resetModules();
  // Virtual mocks stay registered after a reset; a later test that wants no store registers one that is not found.
  jest.doMock(
    'expo-router/build/global-state/router-store.js',
    () => {
      throw new Error("Cannot find module 'expo-router/build/global-state/router-store.js'");
    },
    { virtual: true },
  );
  jest.doMock('expo-constants', () => ({}), { virtual: true });
});

describe('Expo Router', () => {
  test('lists a tree from a stub store with links and param names', () => {
    const places = placesFromExpoTree(TREE, 'wayfare');
    expect(places).toEqual([
      { route: ['(tabs)', 'index'], params: [], link: 'wayfare://' },
      { route: ['(tabs)', 'settings', 'language'], params: [], link: 'wayfare://settings/language' },
      { route: ['(tabs)', 'trips', 'index'], params: [], link: 'wayfare://trips' },
      { route: ['(tabs)', 'trips', '[id]'], params: ['id'], link: 'wayfare://trips/[id]' },
    ]);
  });

  test('a dynamic route has params ["id"] and a [id] link', () => {
    const [place] = placesFromExpoTree(node('', [node('user/[id]')]), 'wayfare');
    expect(place).toEqual({ route: ['user', '[id]'], params: ['id'], link: 'wayfare://user/[id]' });
    const [rest] = placesFromExpoTree(node('', [node('docs/[...slug]')]), 'wayfare');
    expect(rest?.params).toEqual(['slug']);
  });

  test('no scheme means no link, and a layout with no screens is no place', () => {
    expect(placesFromExpoTree(node('', [node('home'), node('(empty)', [], { type: 'layout' })]), undefined)).toEqual([{ route: ['home'], params: [] }]);
  });

  test('a store that is there gives source expo-router with the scheme from the app config', () => {
    jest.doMock('expo-router/build/global-state/router-store.js', () => ({ store: { routeNode: TREE } }), { virtual: true });
    jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { scheme: ['wayfare', 'wf'] } } }), { virtual: true });
    jest.isolateModules(() => {
      const fresh = require('../src/routetree') as typeof import('../src/routetree');
      const known = fresh.knownPlaces();
      expect(known.source).toBe('expo-router');
      expect(known.places.map((p) => p.link)).toContain('wayfare://trips/[id]');
    });
  });

  test('a missing store gives source none, no throw', () => {
    expect(knownPlaces()).toEqual({ source: 'none', places: [] });
  });

  test('a store of another shape, or one that throws, gives source none', () => {
    jest.doMock('expo-router/build/global-state/router-store.js', () => ({ store: { routeNode: 'nope' } }), { virtual: true });
    jest.isolateModules(() => {
      const fresh = require('../src/routetree') as typeof import('../src/routetree');
      expect(fresh.knownPlaces().source).toBe('none');
    });
    jest.resetModules();
    jest.doMock(
      'expo-router/build/global-state/router-store.js',
      () => {
        throw new Error('internal API changed');
      },
      { virtual: true },
    );
    jest.isolateModules(() => {
      const fresh = require('../src/routetree') as typeof import('../src/routetree');
      expect(fresh.knownPlaces()).toEqual({ source: 'none', places: [] });
    });
    jest.resetModules();
    jest.doMock('expo-router/build/global-state/router-store.js', () => ({ store: { get routeNode(): unknown { throw new Error('getter threw'); } } }), { virtual: true });
    jest.isolateModules(() => {
      const fresh = require('../src/routetree') as typeof import('../src/routetree');
      expect(fresh.knownPlaces().source).toBe('none');
    });
  });
});

describe('Expo Router 58 (route tree from the router config context)', () => {
  const RouterConfigContext = React.createContext<unknown>(null);

  test('reads routeNode from the context provider through the fibers', async () => {
    jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
    await mount(
      <RouterConfigContext.Provider value={{ routeNode: TREE, linking: { prefixes: [] } }}>
        <View />
      </RouterConfigContext.Provider>,
    );
    const known = knownPlaces();
    expect(known.source).toBe('expo-router');
    expect(known.places.map((p) => p.route)).toContainEqual(['(tabs)', 'trips', '[id]']);
  });

  test('a context value without a route tree is not mistaken for one', async () => {
    await mount(
      <RouterConfigContext.Provider value={{ routeNode: null }}>
        <View />
      </RouterConfigContext.Provider>,
    );
    expect(knownPlaces().source).toBe('none');
  });

  test('api, redirect and rewrite nodes are not places', () => {
    const tree = node('', [node('home'), node('hook', [], { type: 'api' }), node('old', [], { type: 'redirect' }), node('x', [], { type: 'rewrite' })]);
    expect(placesFromExpoTree(tree, undefined).map((p) => p.route)).toEqual([['home']]);
  });
});

describe('React Navigation', () => {
  const LINKING = {
    prefixes: ['https://wayfare.example.com', 'wayfare://'],
    config: {
      screens: {
        Home: '',
        Profile: { path: 'user/:id' },
        Settings: { path: 'settings', screens: { Language: 'language', Notifications: { path: 'alerts/:kind?' } } },
        Modal: { path: '/modal', exact: true },
        Unlinked: { screens: { Deep: 'deep' } },
      },
    },
  };

  test('linking config gives paths, nested paths and param names', () => {
    expect(placesFromLinking(LINKING)).toEqual([
      { route: ['Home'], params: [], link: 'wayfare://' },
      { route: ['Profile'], params: ['id'], link: 'wayfare://user/[id]' },
      { route: ['Settings', 'Language'], params: [], link: 'wayfare://settings/language' },
      { route: ['Settings', 'Notifications'], params: ['kind'], link: 'wayfare://settings/alerts/[kind]' },
      { route: ['Modal'], params: [], link: 'wayfare://modal' },
      { route: ['Unlinked', 'Deep'], params: [], link: 'wayfare://deep' },
    ]);
  });

  test('an https-only app links through its https prefix', () => {
    const places = placesFromLinking({ prefixes: ['https://wayfare.example.com/'], config: { screens: { Home: '', Profile: 'user/:id' } } });
    expect(places.map((p) => p.link)).toEqual(['https://wayfare.example.com', 'https://wayfare.example.com/user/[id]']);
  });

  test('a custom scheme is preferred over https', () => {
    expect(pickPrefix(['https://wayfare.example.com', 'wayfare://'])).toBe('wayfare://');
    expect(pickPrefix(['https://wayfare.example.com/'])).toBe('https://wayfare.example.com/');
    expect(pickPrefix(['https://*.example.com', 'wayfare://'])).toBe('wayfare://');
    expect(pickPrefix(undefined)).toBeUndefined();
  });

  test('knownPlaces finds the linking prop of the NavigationContainer through the fibers', async () => {
    jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
    function NavigationContainer({ children }: { linking: unknown; children?: React.ReactNode }) {
      return <View>{children}</View>;
    }
    await mount(
      <NavigationContainer linking={LINKING}>
        <View />
      </NavigationContainer>,
    );
    const known = knownPlaces();
    expect(known.source).toBe('react-navigation');
    expect(known.places.map((p) => p.route)).toContainEqual(['Settings', 'Language']);
  });

  test('no linking config gives source none', async () => {
    await mount(<View />);
    expect(knownPlaces()).toEqual({ source: 'none', places: [] });
  });
});
