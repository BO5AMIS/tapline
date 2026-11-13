import { findProp, takeSnapshot } from './inspect';
import { inFlight, startedRequests } from './network';

// "Loading means wait, not `not_found`" (AGENT-TOOLS 1.13 §18.7, F7). While a request is in flight, or an ActivityIndicator is
// showing, a target that isn't there yet is waited for, up to the settle cap, before the app answers `not_found`.

const POLL_MS = 50;
/** After the last request ends, React needs a commit or two before what arrived is on screen. */
const GRACE_MS = 150;

/** Whether an ActivityIndicator is on screen and turning (`animating` is true unless the app says false). */
function spinnerShowing(): boolean {
  try {
    return takeSnapshot().entries.some((entry) => entry.info.type === 'ActivityIndicator' && findProp(entry.node, 'animating') !== false);
  } catch {
    return false;
  }
}

/** Something the screen is still waiting for: a request in flight, or a spinner. */
function loading(): boolean {
  return inFlight() > 0 || spinnerShowing();
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
 * loading any more (after a short grace for the last commit) or at the cap. With nothing loading and no request begun since
 * the mark it answers at once, so a really missing target costs no time.
 */
export async function waitWhileLoading(options: LoadingOptions): Promise<{ waitedMs: number; found: boolean }> {
  const began = Date.now();
  const done = (found: boolean): { waitedMs: number; found: boolean } => ({ waitedMs: Date.now() - began, found });
  if (options.capMs <= 0) return done(false);
  const startedByAction = startedRequests() > options.requestMark;
  if (!startedByAction && !loading()) return done(false);
  const deadline = began + options.capMs;
  let seenStarted = startedRequests();
  let quietSince: number | null = null;
  for (;;) {
    if (await options.isThere()) return done(true);
    const now = Date.now();
    if (now >= deadline) return done(false);
    // A request that begins while waiting (a chain of loads) is loading too.
    const started = startedRequests();
    const chained = started !== seenStarted;
    seenStarted = started;
    if (chained || loading()) quietSince = null;
    else {
      quietSince ??= now;
      if (now - quietSince >= GRACE_MS) return done(false);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_MS, deadline - now)));
  }
}
