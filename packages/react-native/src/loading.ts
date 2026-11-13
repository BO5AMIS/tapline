import { StyleSheet } from 'react-native';
import { findProp, measureFiber, takeSnapshot } from './inspect';
import { inFlight, startedRequests } from './network';

// "Loading means wait, not `not_found`" (AGENT-TOOLS 1.13 §18.7, F7). While a request is in flight, or an ActivityIndicator is
// showing, a target that isn't there yet is waited for, up to the settle cap, before the app answers `not_found`.

const POLL_MS = 50;
/** After the last request ends, React needs a commit or two before what arrived is on screen. */
const GRACE_MS = 150;
/** A spinner alone (no request in flight) holds the wait this long at most: a decorative one must not cost the whole cap. */
const SPINNER_ONLY_MS = 1000;

/**
 * Whether an ActivityIndicator a person could see is turning: `animating` is not false, its frame lies on the screen, and its
 * style doesn't make it clear (opacity 0). A stopped one hides itself unless the app says `hidesWhenStopped={false}`, and
 * either way it is not loading.
 */
async function spinnerShowing(): Promise<boolean> {
  try {
    const snapshot = takeSnapshot();
    for (const entry of snapshot.entries) {
      if (entry.info.type !== 'ActivityIndicator' || findProp(entry.node, 'animating') === false) continue;
      const style: unknown = findProp(entry.node, 'style');
      const flat: unknown = style === undefined || style === null ? undefined : StyleSheet.flatten(style as Parameters<typeof StyleSheet.flatten>[0]);
      const opacity = typeof flat === 'object' && flat !== null && 'opacity' in flat ? (flat as { opacity: unknown }).opacity : undefined;
      if (opacity === 0) continue;
      const frame = await measureFiber(entry.node.fiber);
      if (frame === null) continue;
      const { width, height } = snapshot.screen;
      if (frame.x < width && frame.x + frame.width > 0 && frame.y < height && frame.y + frame.height > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** What the screen is waiting for: requests in flight, or (with none) a spinner a person could see. */
async function loadingNow(): Promise<{ requests: boolean; spinner: boolean }> {
  const requests = inFlight() > 0;
  return { requests, spinner: requests ? false : await spinnerShowing() };
}

export interface LoadingOptions {
  /** `startedRequests()` when the action began: a request begun since is one the action started, even if it has ended already. */
  requestMark: number;
  /** The settle cap: the most this waits. */
  capMs: number;
  /** Whether what is being waited for is there now. */
  isThere: () => Promise<boolean>;
}

/**
 * Waits while the screen is loading. Answers `found: true` as soon as `isThere` says so, and `found: false` when nothing is
 * loading any more (after a short grace for the last commit), at the cap, or after 1 s of a spinner with no request. With nothing
 * loading and no request begun since the mark it answers at once, so a really missing target costs no time.
 */
export async function waitWhileLoading(options: LoadingOptions): Promise<{ waitedMs: number; found: boolean }> {
  const began = Date.now();
  const done = (found: boolean): { waitedMs: number; found: boolean } => ({ waitedMs: Date.now() - began, found });
  if (options.capMs <= 0) return done(false);
  const startedByAction = startedRequests() > options.requestMark;
  const first = await loadingNow();
  if (!startedByAction && !first.requests && !first.spinner) return done(false);
  const deadline = began + options.capMs;
  let seenStarted = startedRequests();
  let quietSince: number | null = null;
  let spinnerSince: number | null = null;
  for (;;) {
    if (await options.isThere()) return done(true);
    const now = Date.now();
    if (now >= deadline) return done(false);
    // A request that begins while waiting (a chain of loads) is loading too.
    const started = startedRequests();
    const chained = started !== seenStarted;
    seenStarted = started;
    const state = await loadingNow();
    if (chained || state.requests) {
      quietSince = null;
      spinnerSince = null;
    } else if (state.spinner) {
      quietSince = null;
      spinnerSince ??= now;
      if (now - spinnerSince >= SPINNER_ONLY_MS) return done(false);
    } else {
      spinnerSince = null;
      quietSince ??= now;
      if (now - quietSince >= GRACE_MS) return done(false);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_MS, deadline - now)));
  }
}
