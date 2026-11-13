import { openAlerts } from './alerts';
import { firstHostChild, propsOf, type Fiber } from './fiber';
import type { RouteFound, TabFound } from './inspect';
import { isRecord, type PlaceState } from './types';

/**
 * AGENT-TOOLS 1.13 §18.1: a place as a route key. Pure: it reads what the tree walk found and
 * nothing else, so `tree` and the `place` event agree. Never a param's value, never screen text.
 */

/** What a walk of the tree found that a place is made of. */
export interface PlaceParts {
  routes: RouteFound[];
  tabs: TabFound[];
  /** The topmost open `Modal`'s host fiber, when one is open. */
  modal: Fiber | null;
}

/** Splits each route name on "/" so "trips/[id]" and ["trips","[id]"] agree (answer 12); empty pieces go. */
export function routePattern(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const piece of name.split('/')) if (piece !== '') out.push(piece);
  }
  return out;
}

const SHEET_PRESENTATIONS = new Set(['formSheet', 'pageSheet', 'sheet']);

/** The deepest focused route, the last on ties (the same rule as `currentRoute`). */
function focusedRoute(routes: RouteFound[]): RouteFound | null {
  let best: RouteFound | null = null;
  for (const route of routes) {
    if (!route.focused) continue;
    if (best === null || route.chain.length >= best.chain.length) best = route;
  }
  return best;
}

/**
 * A native tab's route name from its `screenKey`. React Navigation keys are `<route name>-<21-character id>`, so the
 * id is cut only when it is there; a key such as "home-tab" is a name with no id (and a name may hold a hyphen).
 */
export function tabNameFromKey(key: string): string {
  const match = /^(.+)-[A-Za-z0-9_-]{21}$/.exec(key);
  return match?.[1] ?? key;
}

/** Whether `chain` starts with `prefix`. */
function startsWith(chain: string[], prefix: string[]): boolean {
  return prefix.length <= chain.length && prefix.every((name, i) => chain[i] === name);
}

/** The root `testID` of a bare Modal's content, or undefined. */
function modalName(modal: Fiber): string | undefined {
  const root = firstHostChild(modal);
  const id = root ? propsOf(root).testID : undefined;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** `/` and `:` never appear in a layer name, so a key stays one piece. */
function plain(name: string): string {
  return name.replace(/[:/]/g, '_');
}

/**
 * Whether a piece of a place looks like a value (an id, a number, a UUID, long hex) and not a name. A place holds
 * patterns, never values (AGENT-TOOLS 1.13 §18.1). The host applies the same rule.
 */
export function looksLikeValue(piece: string): boolean {
  return (
    /^\d+$/.test(piece) ||
    /\d{4,}/.test(piece) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(piece) ||
    /[0-9a-f]{16,}/i.test(piece)
  );
}

/** A layer: its kind and, when the name isn't a value, its name. */
function layerOf(kind: 'sheet' | 'modal', name: string | undefined): string {
  return name === undefined || looksLikeValue(name) ? kind : `${kind}:${plain(name)}`;
}

/** Whether `fiber` lies inside `outer` (either copy of it). */
function inside(fiber: Fiber, outer: Fiber): boolean {
  for (let up: Fiber | null = fiber.return; up; up = up.return) {
    if (up === outer || up === outer.alternate) return true;
  }
  return false;
}

/**
 * Whether a bare Modal lies above a presented route: the Modal is inside that route's screen (opened from it) and the
 * route is not inside the Modal. When the order can't be told, the route stays the layer, as before.
 */
function modalAbove(modal: Fiber, route: RouteFound): boolean {
  return route.fiber !== undefined && inside(modal, route.fiber) && !inside(route.fiber, modal);
}

export function placeFrom(parts: PlaceParts): PlaceState {
  const current = focusedRoute(parts.routes);
  const chain = current ? current.chain : [];
  const route = routePattern(chain);
  // A route piece that looks like a value can't be a pattern: no route, and the host falls back to its signature.
  const place: PlaceState = { route: route.some(looksLikeValue) ? [] : route };
  const onPath = parts.routes.filter((route) => route.focused && startsWith(chain, route.chain));

  // The selected tab: a tab navigator's selected route, else a native tab bar's selected tab (by its key, never its title).
  for (const route of onPath) {
    let type: unknown;
    try {
      const state = route.navigation.getState?.();
      type = isRecord(state) ? state.type : undefined;
    } catch {
      type = undefined;
    }
    if (type === 'tab') {
      place.tab = route.name;
      break;
    }
  }
  if (place.tab === undefined) {
    const selected = parts.tabs.find((tab) => tab.selected && tab.screenKey !== null);
    if (selected?.screenKey) place.tab = tabNameFromKey(selected.screenKey);
  }

  // What lies on top: an alert, else a modal or sheet (a navigation route's name, else a bare Modal's root testID).
  if (openAlerts().length > 0) {
    place.layer = 'alert';
  } else {
    const presented = [...onPath].reverse().find((route) => route.presentation !== undefined);
    if (presented?.presentation !== undefined && !(parts.modal && modalAbove(parts.modal, presented))) {
      place.layer = layerOf(SHEET_PRESENTATIONS.has(presented.presentation) ? 'sheet' : 'modal', presented.name);
    } else if (parts.modal) {
      place.layer = layerOf('modal', modalName(parts.modal));
    }
  }
  if (place.tab !== undefined && looksLikeValue(place.tab)) delete place.tab;
  return place;
}

/** Whether two places are the same key. */
export function samePlace(a: PlaceState | null, b: PlaceState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tab === b.tab && a.layer === b.layer && a.route.length === b.route.length && a.route.every((name, i) => name === b.route[i]);
}
