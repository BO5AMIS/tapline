import { back, longPress, openURL, parseTarget, press, resolveTarget, swipe, toggle } from './actions';
import { toElement } from './inspect';
import { currentPlace } from './place';
import { TaplineError, isRecord, type PlaceState, type TaplineElement, type Target } from './types';

/**
 * AGENT-TOOLS 1.13 §18.4 (F7): one request for one move. Act, then wait until the next move's target is on screen, steady
 * and touchable, and say what it is. The host checks its policy against that answer before it sends the next move, so
 * nothing the app does here decides what a person must OK. A move is only an ordinary call, and never navigates by itself.
 */

type MoveMethod = 'press' | 'longPress' | 'toggle' | 'back' | 'openURL' | 'swipe';

export interface MoveParams {
  method: MoveMethod;
  /** Exactly what the plain method takes. */
  params: Record<string, unknown>;
  /** The host's policy check was made against this element; refuse with `stale` if the target now resolves to another. */
  guard?: { id?: string; label?: string; text?: string };
  /** Wait until this target is on screen, steady (same frame twice) and touchable (the press dry-run's checks pass). */
  next?: { target: Target; capMs: number };
}

export type NextState = 'ready' | 'missing' | 'covered' | 'moving';

export interface MoveResult {
  /** What the plain method returns, settle fields included. */
  done: Record<string, unknown>;
  place: PlaceState | null;
  next?: { state: NextState; element?: TaplineElement; waitedMs: number };
}

const METHODS: Record<MoveMethod, (params: unknown) => Promise<unknown>> = {
  press,
  longPress,
  toggle,
  back,
  openURL,
  swipe,
};

/** The methods that take a `target`, and the action a guard checks the target for. */
const TARGETED: Partial<Record<MoveMethod, 'press' | 'longPress' | 'toggle'>> = {
  press: 'press',
  longPress: 'longPress',
  toggle: 'toggle',
};

/** How often the next target is looked at while it is waited for. */
const POLL_MS = 40;
const MAX_CAP_MS = 10_000;

function bad(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw bad(`${name} must be a string`);
  return value;
}

function parseMove(raw: unknown): MoveParams {
  if (!isRecord(raw)) throw bad('move needs {method, params}');
  const method = raw.method;
  if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(METHODS, method)) {
    throw bad('method must be one of: press, longPress, toggle, back, openURL, swipe');
  }
  const params = raw.params === undefined ? {} : raw.params;
  if (!isRecord(params)) throw bad('params must be an object');
  const parsed: MoveParams = { method: method as MoveMethod, params };
  if (raw.guard !== undefined) {
    if (!isRecord(raw.guard)) throw bad('guard must be an object with id, label or text');
    const guard: NonNullable<MoveParams['guard']> = {};
    if (Object.keys(raw.guard).length === 0) throw bad('guard needs at least one of id, label or text');
    const id = optionalString(raw.guard.id, 'guard.id');
    const label = optionalString(raw.guard.label, 'guard.label');
    const text = optionalString(raw.guard.text, 'guard.text');
    if (id !== undefined) guard.id = id;
    if (label !== undefined) guard.label = label;
    if (text !== undefined) guard.text = text;
    parsed.guard = guard;
  }
  if (raw.next !== undefined) {
    if (!isRecord(raw.next)) throw bad('next must be {target, capMs}');
    parseTarget(raw.next.target); // the same checks as every target
    const cap = raw.next.capMs;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) throw bad('next.capMs must be a number of milliseconds');
    parsed.next = { target: raw.next.target as Target, capMs: Math.min(MAX_CAP_MS, Math.round(cap)) };
  }
  return parsed;
}

/**
 * The host's policy ran against an element the agent named; refuse when the target resolves to another one now (a list
 * recycled a row, a screen changed under it). Nothing is done then.
 */
async function assertGuard(move: MoveParams): Promise<void> {
  const hint = TARGETED[move.method];
  const guard = move.guard;
  if (hint === undefined || guard === undefined || move.params.target === undefined) return;
  // A resolution error is the plain method's own answer (not_found, ambiguous, covered): let it travel, never skip the guard.
  const { entry } = await resolveTarget(move.params.target, hint);
  // What the host saw is `toElement`'s text (cut, display-normalised), so that is what the guard is compared with.
  const info = toElement(entry, null, '');
  const same =
    (guard.id === undefined || guard.id === info.testID) &&
    (guard.label === undefined || guard.label === info.label) &&
    (guard.text === undefined || guard.text === info.text);
  if (!same) {
    throw new TaplineError('stale', 'stale: the target is another element now than the one the policy checked; look again.');
  }
}

function sameFrame(a: TaplineElement['frame'], b: TaplineElement['frame']): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}

type Look = { kind: 'touchable'; element: TaplineElement } | { kind: 'covered' } | { kind: 'missing' };

/** One look at the next target: would a press touch it now? A dry run, so nothing is touched. */
async function look(target: Target): Promise<Look> {
  let refusal: unknown;
  try {
    const result = await press({ target, dryRun: true });
    return { kind: 'touchable', element: result.element };
  } catch (error) {
    refusal = error;
  }
  // A switch takes no tap of its own: the next move may be a toggle.
  if (refusal instanceof TaplineError && refusal.code === 'not_actionable' && refusal.message.startsWith('no_action')) {
    try {
      const result = await toggle({ target, dryRun: true });
      return { kind: 'touchable', element: result.element };
    } catch (error) {
      refusal = error;
    }
  }
  if (refusal instanceof TaplineError && refusal.code === 'not_actionable') {
    const reason = refusal.message.split(':')[0];
    if (reason === 'covered' || reason === 'behind_alert' || reason === 'under_tab_bar') return { kind: 'covered' };
  }
  return { kind: 'missing' };
}

/** Waits for the next target (§18.4). A target below the fold that a scroll reaches counts as on screen, as it does for `if`. */
async function waitForNext(next: NonNullable<MoveParams['next']>): Promise<NonNullable<MoveResult['next']>> {
  const started = Date.now();
  let previous: TaplineElement | null = null;
  let last: Look = { kind: 'missing' };
  for (;;) {
    last = await look(next.target);
    if (last.kind === 'touchable') {
      if (previous !== null && sameFrame(previous.frame, last.element.frame)) {
        return { state: 'ready', element: last.element, waitedMs: Date.now() - started };
      }
      previous = last.element;
    } else {
      previous = null;
    }
    const left = next.capMs - (Date.now() - started);
    if (left <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)));
  }
  const waitedMs = Math.min(next.capMs, Date.now() - started);
  if (last.kind === 'touchable') return { state: 'moving', element: last.element, waitedMs };
  return { state: last.kind, waitedMs };
}

/** The `move` request. */
export async function move(raw: unknown): Promise<MoveResult> {
  const parsed = parseMove(raw);
  await assertGuard(parsed);
  const method = METHODS[parsed.method];
  const done = await method(parsed.params);
  const result: MoveResult = {
    done: isRecord(done) ? done : {},
    place: null,
  };
  if (parsed.next !== undefined && parsed.params.dryRun !== true) result.next = await waitForNext(parsed.next);
  result.place = currentPlace();
  return result;
}
