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
/** The time of the latest touch dropped in the current window; it is reported when the window ends. */
let droppedAt: number | null = null;
let trailing: ReturnType<typeof setTimeout> | null = null;

function cancelTrailing(): void {
  if (trailing !== null) clearTimeout(trailing);
  trailing = null;
  droppedAt = null;
}

function emit(at: number): void {
  for (const listener of [...listeners]) {
    try {
      listener(at);
    } catch {
      // a listener must never reach the app
    }
  }
}

/** The window ended with touches dropped in it: report the latest of them once. */
function flushTrailing(): void {
  trailing = null;
  const at = droppedAt;
  droppedAt = null;
  if (at === null || lastPassedAt === null || listeners.size === 0) return;
  // The trailing report starts the next window, counted from where this one ended, so the rate
  // stays at one per window however late the timer fires.
  lastPassedAt += TOUCH_THROTTLE_MS;
  emit(at);
}

/** Calls `listener` (with the touch time) for each real touch that passes the throttle; returns the unsubscribe. */
export function onRealTouch(listener: TouchListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      lastPassedAt = null;
      cancelTrailing();
    }
  };
}

/**
 * A touch started on the app. Returns true when it was passed on to the listeners; false when
 * nobody listens (Tapline stopped) or it came within `TOUCH_THROTTLE_MS` of the last passed one.
 * A touch that is dropped is not lost: when its window ends, one `touch` report with the time of the
 * latest dropped touch goes out (so a second touch a person made inside the window shows up too).
 * Never throws.
 */
export function noteRealTouch(now: number): boolean {
  if (listeners.size === 0) return false;
  // A clock that went backwards must not silence touches until it catches up.
  if (lastPassedAt !== null && now >= lastPassedAt && now - lastPassedAt < TOUCH_THROTTLE_MS) {
    droppedAt = now;
    if (trailing === null) trailing = setTimeout(flushTrailing, lastPassedAt + TOUCH_THROTTLE_MS - now);
    return false;
  }
  // A touch that passes covers every earlier one: nothing is left to report at the end of a window.
  cancelTrailing();
  lastPassedAt = now;
  emit(now);
  return true;
}

/** Forgets the throttle and every listener (tests). */
export function resetTouches(): void {
  listeners.clear();
  lastPassedAt = null;
  cancelTrailing();
}
