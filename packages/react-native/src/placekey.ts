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

export function placeFrom(parts: PlaceParts): PlaceState {
  const current = focusedRoute(parts.routes);
  const chain = current ? current.chain : [];
  const place: PlaceState = { route: routePattern(chain) };
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
    if (selected?.screenKey) {
      const key = selected.screenKey;
      place.tab = key.includes('-') ? key.slice(0, key.lastIndexOf('-')) : key;
    }
  }

  // What lies on top: an alert, else a modal or sheet (a navigation route's name, else a bare Modal's root testID).
  if (openAlerts().length > 0) {
    place.layer = 'alert';
  } else {
    const presented = [...onPath].reverse().find((route) => route.presentation !== undefined);
    if (presented?.presentation !== undefined) {
      place.layer = `${SHEET_PRESENTATIONS.has(presented.presentation) ? 'sheet' : 'modal'}:${plain(presented.name)}`;
    } else if (parts.modal) {
      const name = modalName(parts.modal);
      place.layer = name === undefined ? 'modal' : `modal:${plain(name)}`;
    }
  }
  return place;
}

/** Whether two places are the same key. */
export function samePlace(a: PlaceState | null, b: PlaceState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tab === b.tab && a.layer === b.layer && a.route.length === b.route.length && a.route.every((name, i) => name === b.route[i]);
}
