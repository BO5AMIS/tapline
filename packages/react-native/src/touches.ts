// Real touches. Tapline never touches the screen itself (an agent's `tap` calls the element's handler),
// so any touch that reaches the app's root is a person's finger, or another tool that makes real
// touches. The wrapper around the app's root (alerts.tsx) calls `noteRealTouch`; the client listens
// and tells the host, which then warns the agent that a person used the app.
//
// Limit: a React Native `Modal` is its own native window, so touches inside one never reach the
// wrapper and are not seen.

/** At most one touch is passed on per this many milliseconds. */
export const TOUCH_THROTTLE_MS = 500;

export type TouchListener = (at: number) => void;

const listeners = new Set<TouchListener>();
let lastPassedAt: number | null = null;

/** Calls `listener` (with the touch time) for each real touch that passes the throttle; returns the unsubscribe. */
export function onRealTouch(listener: TouchListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) lastPassedAt = null;
  };
}

/**
 * A touch started on the app. Returns true when it was passed on to the listeners; false when
 * nobody listens (Tapline stopped) or it came within `TOUCH_THROTTLE_MS` of the last passed one.
 * Never throws.
 */
export function noteRealTouch(now: number): boolean {
  if (listeners.size === 0) return false;
  // A clock that went backwards must not silence touches until it catches up.
  if (lastPassedAt !== null && now >= lastPassedAt && now - lastPassedAt < TOUCH_THROTTLE_MS) return false;
  lastPassedAt = now;
  for (const listener of [...listeners]) {
    try {
      listener(now);
    } catch {
      // a listener must never reach the app
    }
  }
  return true;
}

/** Forgets the throttle and every listener (tests). */
export function resetTouches(): void {
  listeners.clear();
  lastPassedAt = null;
}
