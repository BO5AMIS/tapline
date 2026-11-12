import { onAlertsChange } from './alerts';
import { emitEvent } from './events';
import { placeParts } from './inspect';
import { placeFrom, samePlace } from './placekey';
import { onCommit } from './register';
import type { PlaceState } from './types';

export { routePattern } from './placekey';
export type { PlaceState } from './types';

/**
 * AGENT-TOOLS 1.13 §18.1 and §18.11. Where the app is, as a route key: pattern names, the selected
 * tab and what lies on top. Never a param's value and never text from the screen.
 */

/** The wire form of a place: the key and when it was read. Answers the `place` request and is the `place` event's data. */
export interface PlaceData extends PlaceState {
  seenAt: number;
}

/** After a commit the app is given this long to finish committing before the place is read (one read per burst). */
const DEBOUNCE_MS = 40;

/** The place now; null when the app has no React roots yet. A walk that fails answers null, never throws. */
export function currentPlace(): PlaceState | null {
  try {
    const parts = placeParts();
    return parts === null ? null : placeFrom(parts);
  } catch {
    return null;
  }
}

/** The `place` request: no router (or no roots) gives an empty route. */
export function placeData(now: () => number = Date.now): PlaceData {
  return { ...(currentPlace() ?? { route: [] }), seenAt: now() };
}

/**
 * Sends a `place` event now and again whenever the route, the tab or the layer changes, after the commit
 * that changed it (one event per burst of commits, none on a repeat). Returns a function that stops it.
 */
export function startPlaceEvents(options: { debounceMs?: number; now?: () => number } = {}): () => void {
  const wait = options.debounceMs ?? DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  let last: PlaceState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const check = (): void => {
    timer = undefined;
    if (stopped) return;
    const place = currentPlace() ?? { route: [] };
    if (last !== null && samePlace(last, place)) return;
    last = place;
    emitEvent('place', { ...place, seenAt: now() });
  };
  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(check, wait);
  };

  const stopCommits = onCommit(schedule);
  const stopAlerts = onAlertsChange(schedule);
  check();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    stopCommits();
    stopAlerts();
  };
}
