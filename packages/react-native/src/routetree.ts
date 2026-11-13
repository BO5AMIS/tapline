import { appScheme } from './appinfo';
import { propsOf, type Fiber } from './fiber';
import { routePattern } from './placekey';
import { getRoots } from './register';
import { isRecord, type UnknownRecord } from './types';

/**
 * AGENT-TOOLS 1.13 §18.1 ("Known before any visit"): the places an app has, listed from its own route tree. Expo Router's
 * store is an internal API, so it is read behind a guard and any failure answers `source: "none"` (plan answer 21).
 * Values of params never appear here, only their names.
 */

export interface KnownPlace {
  route: string[];
  /** `<scheme>://<path>`, with `[id]` where a param goes; absent when the app has no scheme or the screen has no path. */
  link?: string;
  /** Param names such as "id"; values never. */
  params: string[];
}

export interface KnownPlaces {
  source: 'expo-router' | 'react-navigation' | 'none';
  places: KnownPlace[];
}

/** Never go deeper than this: a route tree is a few levels; a cycle must not hang the app. */
const MAX_DEPTH = 12;
const MAX_PLACES = 500;

/* -------------------------------------------------------------------------- */
/* Expo Router                                                                 */
/* -------------------------------------------------------------------------- */

const EXPO_PARAM = /^\[(?:\.\.\.)?([^\]]+)\]$/;

/** A group segment such as "(tabs)": part of the route key, not of the path. */
function isGroup(segment: string): boolean {
  return /^\(.*\)$/.test(segment);
}

/** Special files that aren't places a person navigates to: `+not-found`, `_sitemap` and the like. */
function isSpecial(name: string): boolean {
  return name.startsWith('+') || name.startsWith('_');
}

/**
 * The places in an Expo Router route tree (its `routeNode`): every leaf route, keyed by the layout and route names down to
 * it. Exported for tests; the shape is read defensively, since it is Expo Router's own.
 */
export function placesFromExpoTree(root: unknown, scheme: string | undefined): KnownPlace[] {
  const places: KnownPlace[] = [];
  const visit = (node: unknown, names: string[], depth: number): void => {
    if (!isRecord(node) || depth > MAX_DEPTH || places.length >= MAX_PLACES) return;
    const name = typeof node.route === 'string' ? node.route : '';
    if (isSpecial(name) || node.type === 'api' || node.type === 'redirect' || node.type === 'rewrite') return;
    const here = name === '' ? names : [...names, name];
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length > 0) {
      for (const child of children) visit(child, here, depth + 1);
      return;
    }
    if (node.type === 'layout' || here.length === 0) return; // a layout with no screens is not a place
    const route = routePattern(here);
    const params: string[] = [];
    for (const segment of route) {
      const match = EXPO_PARAM.exec(segment);
      if (match?.[1] !== undefined && !params.includes(match[1])) params.push(match[1]);
    }
    const path = route.filter((segment) => !isGroup(segment) && segment !== 'index');
    const place: KnownPlace = { route, params };
    if (scheme !== undefined) place.link = `${scheme}://${path.join('/')}`;
    places.push(place);
  };
  visit(root, [], 0);
  return places;
}

/**
 * Expo Router 58: the route tree is `routerConfig.routeNode`, the value of `RouterConfigContext`'s provider, which sits
 * above the navigation container. Found through the fibers, the way the linking prop is.
 */
function findRouterConfigNode(): unknown {
  return findInFibers((props) => {
    const value = props.value;
    return isRecord(value) && isRecord(value.routeNode) && Array.isArray(value.routeNode.children) ? value.routeNode : undefined;
  });
}

/** Expo Router 55: `routeNode` from its store, or null. Any failure (not installed, another version) is null. */
function expoStoreRouteNode(): unknown {
  try {
    // The `.js` matters: the package's exports map refuses an extensionless deep path.
    const loaded: unknown = require('expo-router/build/global-state/router-store.js');
    const store = isRecord(loaded) ? loaded.store : undefined;
    if (!isRecord(store)) return null;
    return store.routeNode ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* React Navigation                                                            */
/* -------------------------------------------------------------------------- */

const NAVIGATION_PARAM = /^:([A-Za-z0-9_]+)\??$/;

/** A custom scheme beats an `https` prefix (the app opens from it directly); wildcard prefixes can't be used. */
export function pickPrefix(prefixes: unknown): string | undefined {
  if (!Array.isArray(prefixes)) return undefined;
  const usable = prefixes.filter((prefix): prefix is string => typeof prefix === 'string' && prefix !== '' && !prefix.includes('*'));
  const custom = usable.find((prefix) => !/^https?:/i.test(prefix));
  return custom ?? usable[0];
}

/** `<prefix>/<path>`; a prefix that is only a scheme ("wayfare://") takes the path right after it. */
function linkFor(prefix: string, path: string): string {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/*$/.exec(prefix);
  if (scheme) return `${scheme[1]}://${path}`;
  const base = prefix.replace(/\/+$/, '');
  return path === '' ? base : `${base}/${path}`;
}

function joinPath(base: string, next: string, exact: boolean): string {
  const clean = next.replace(/^\/+|\/+$/g, '');
  if (exact || base === '') return clean;
  return clean === '' ? base : `${base}/${clean}`;
}

/** The places in a React Navigation `linking.config`: each leaf screen, keyed by the screen names down to it. Exported for tests. */
export function placesFromLinking(linking: unknown): KnownPlace[] {
  if (!isRecord(linking) || !isRecord(linking.config)) return [];
  const prefix = pickPrefix(linking.prefixes);
  const places: KnownPlace[] = [];
  const visit = (screens: unknown, names: string[], base: string, depth: number): void => {
    if (!isRecord(screens) || depth > MAX_DEPTH) return;
    for (const [name, entry] of Object.entries(screens)) {
      if (places.length >= MAX_PLACES) return;
      const here = [...names, name];
      let path = base;
      let nestedScreens: unknown;
      if (typeof entry === 'string') {
        path = joinPath(base, entry, false);
      } else if (isRecord(entry)) {
        if (typeof entry.path === 'string') path = joinPath(base, entry.path, entry.exact === true);
        nestedScreens = entry.screens;
      }
      if (isRecord(nestedScreens) && Object.keys(nestedScreens).length > 0) {
        visit(nestedScreens, here, path, depth + 1);
        continue;
      }
      const params: string[] = [];
      for (const segment of path.split('/')) {
        const match = NAVIGATION_PARAM.exec(segment);
        if (match?.[1] !== undefined && !params.includes(match[1])) params.push(match[1]);
      }
      const place: KnownPlace = { route: routePattern(here), params };
      // A path that is only the base prefix is the app's root; a screen with no path at all has no link.
      const hasPath = typeof entry === 'string' || (isRecord(entry) && typeof entry.path === 'string');
      if (prefix !== undefined && hasPath) {
        place.link = linkFor(prefix, path.replace(/:([A-Za-z0-9_]+)\??/g, '[$1]'));
      }
      places.push(place);
    }
  };
  visit(linking.config.screens, [], '', 0);
  return places;
}

/** The first thing `pick` returns for a fiber's props, walking the tree from the root, child first; null when none. */
function findInFibers(pick: (props: UnknownRecord) => unknown): unknown {
  for (const root of getRoots()) {
    const stack: Fiber[] = root.current.child ? [root.current.child] : [];
    let visited = 0;
    for (let fiber = stack.pop(); fiber && visited < 5000; fiber = stack.pop()) {
      visited += 1;
      const found = pick(propsOf(fiber));
      if (found !== undefined) return found;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  }
  return null;
}

/** The `linking` prop of the app's `NavigationContainer`, found through the fibers. */
function findLinking(): unknown {
  return findInFibers((props) => (isRecord(props.linking) && isRecord(props.linking.config) ? props.linking : undefined));
}

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

/** The `places` request: what the app's own route tree says it has, before any visit. Never throws. */
export function knownPlaces(): KnownPlaces {
  try {
    const scheme = appScheme();
    for (const read of [findRouterConfigNode, expoStoreRouteNode]) {
      let node: unknown = null;
      try {
        node = read();
      } catch {
        node = null; // an internal API that changed: try the next way
      }
      if (node === null) continue;
      const places = placesFromExpoTree(node, scheme);
      if (places.length > 0) return { source: 'expo-router', places };
    }
  } catch {
    // fall through
  }
  try {
    const places = placesFromLinking(findLinking());
    if (places.length > 0) return { source: 'react-navigation', places };
  } catch {
    // not a navigation app
  }
  return { source: 'none', places: [] };
}
