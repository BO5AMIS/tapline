import { DevSettings, Keyboard, Linking, Platform, TextInput } from 'react-native';
import { keyboardState } from './keyboard';
import { nativeModule } from './native';
import {
  closingModalHosts,
  currentInputValue,
  isSecureInput,
  maskSecret,
  cutText,
  MAX_TEXT,
  displayText,
  findHandler,
  findProp,
  frameContains,
  getScreen,
  hitTest,
  isInputNode,
  isWithin,
  isOnScreen,
  measureFiber,
  inNavBarHeader,
  nativeNavBar,
  nativeTabBar,
  openModalHosts,
  publicInstancesOf,
  refFor,
  roleName,
  tabAt,
  rememberTyped,
  fiberForRef,
  takeSnapshot,
  toElement,
  currentRoute,
  type BehindSheet,
  type Entry,
  type HostNode,
  type Snapshot,
  type TabFound,
} from './inspect';
import { sourcesOf, type ElementSource } from './source';
import { closestMatches } from './closest';
import { AUDIT_TYPES, auditScreen, type AuditFinding, type AuditType } from './checks';
import { uxScreen, type UxAction, type UxCheckName, type UxKind } from './uxcheck';
import { isOwnAlert, openAlerts } from './alerts';
import { firstHostChild, hostChildren, isCompositeTag, sameFiber, type Fiber } from './fiber';
import { getLogEntries } from './logs';
import { onCommit } from './register';
import { waitUntilSteady, waitUntilStill } from './settle';
import {
  TaplineError,
  isRecord,
  type Action,
  type Frame,
  type LogEntry,
  type TaplineElement,
} from './types';

export { tree } from './inspect';

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The reasons AGENT-TOOLS §4 names for a `not_actionable` refusal; the message starts with one. */
type NotActionable = 'disabled' | 'off_screen' | 'covered' | 'under_tab_bar' | 'behind_alert' | 'no_action';

/** What follows `disabled`: `force` never acts on a disabled element (the check comes first), so the app has to enable it. */
const ENABLE_FIRST = 'the app has to enable it first (force doesn\'t apply)';

function notActionable(reason: NotActionable, message: string): TaplineError {
  return new TaplineError('not_actionable', `${reason}: ${message}`);
}

/**
 * Runs the checks for what a person could do. Without `force` a refusal is thrown as usual. With
 * it the checks still run, and what they would have refused comes back as `{ forced: <reason> }`,
 * so the answer can say that a person couldn't have done this (AGENT-TOOLS v1.6). Anything else
 * that goes wrong inside a forced check is ignored: `force` means "act anyway".
 */
async function checkedOrForced(force: boolean, check: () => Promise<void> | void): Promise<{ forced?: string }> {
  if (!force) {
    await check();
    return {};
  }
  try {
    await check();
  } catch (error) {
    if (error instanceof TaplineError && error.code === 'not_actionable') {
      return { forced: error.message.slice(0, Math.max(0, error.message.indexOf(':'))) || 'not_actionable' };
    }
  }
  return {};
}

const settings = { quietMs: 100, capMs: 2000 };

/** Tune how long the app must be free of React commits after an action, and the longest wait (AGENT-TOOLS §6). */
export function configureActions(next: { quietMs?: number; capMs?: number }): void {
  if (typeof next.quietMs === 'number') settings.quietMs = next.quietMs;
  if (typeof next.capMs === 'number') settings.capMs = next.capMs;
}

const actedListeners = new Set<() => void>();

/** Runs `listener` when an action's handler has run, before the wait for the app to settle. */
export function onActed(listener: () => void): () => void {
  actedListeners.add(listener);
  return () => {
    actedListeners.delete(listener);
  };
}

/** What an action reports about its settle: the milliseconds, and the cap when the screen never went quiet. */
export interface SettleOutcome {
  settledMs: number;
  /** Set only when the wait ended at the cap with the screen still changing (AGENT-TOOLS v1.3, "The cap"). */
  settleCapMs?: number;
}

function notifyActed(): void {
  for (const listener of [...actedListeners]) {
    try {
      listener();
    } catch {
      // a listener must never break the action
    }
  }
}

/** Waits until the app is still after an action; resolves with the milliseconds that took. */
export async function settle(): Promise<number> {
  notifyActed();
  return (await settleNow()).settledMs;
}

/** Like `settle`, and says when the wait ended at the cap: spread it into an action's result. */
export async function settleOutcome(): Promise<SettleOutcome> {
  notifyActed();
  return settleNow();
}

const SHEET_POLL_MS = 100;

/** Whether `fiber` sits inside `host`. */
function isInside(fiber: Fiber, host: Fiber): boolean {
  for (let up: Fiber | null = fiber.return; up; up = up.return) if (sameFiber(up, host)) return true;
  return false;
}

/** The fiber to watch in the top open modal: its first element with an action, else its first framed host. */
async function sheetProbe(): Promise<Fiber | null> {
  const hosts = openModalHosts();
  const top = hosts[hosts.length - 1];
  if (!top) return null;
  const inside = takeSnapshot().entries.filter((entry) => isInside(entry.node.fiber, top));
  const acting = inside.find((entry) => entry.info.actions.length > 0);
  if (acting) return acting.node.fiber;
  for (const entry of inside) {
    const frame = await measureFiber(entry.node.fiber);
    if (frame && frame.width > 0 && frame.height > 0) return entry.node.fiber;
  }
  return null;
}

async function settleNow(): Promise<SettleOutcome> {
  const started = Date.now();
  let capped = false;
  const onCap = (): void => {
    capped = true;
  };
  await waitUntilStill({
    ...settings,
    onCommit: (listener) => onCommit(() => listener()),
    now: Date.now,
    onCap,
  });
  const left = settings.capMs - (Date.now() - started);
  if (left > 0) {
    // A sheet lifted by a native-driver animation makes no commits: wait for it to stop moving.
    const probe = await sheetProbe().catch(() => null);
    if (probe) await waitUntilSteady(() => measureFiber(probe), { pollMs: SHEET_POLL_MS, capMs: left, now: Date.now, onCap });
  }
  // A sheet being dismissed stays mounted (and covering the screen) until iOS ends the animation.
  if (closingModalHosts().length > 0) {
    while (closingModalHosts().length > 0) {
      const remaining = settings.capMs - (Date.now() - started);
      if (remaining <= 0) {
        capped = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(SHEET_POLL_MS, remaining)));
    }
    // Unmounting the modal commits: let the app go quiet again, within the cap.
    const afterwards = settings.capMs - (Date.now() - started);
    if (afterwards > 0) {
      await waitUntilStill({
        quietMs: settings.quietMs,
        capMs: afterwards,
        onCommit: (listener) => onCommit(() => listener()),
        now: Date.now,
        onCap,
      });
    }
  }
  const settledMs = Math.max(0, Math.min(settings.capMs, Date.now() - started));
  return capped && settings.capMs > 0 ? { settledMs, settleCapMs: settings.capMs } : { settledMs };
}

function badParams(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

function paramsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw badParams('params must be an object');
  return raw;
}

/** An element as element lines name it: `e6 button "Continue"`, or `id=<testID>` without text or label. */
function describe(entry: Entry, maxText = MAX_TEXT): string {
  const { info } = entry;
  const shown = cutText(info.text !== '' ? info.text : (info.label ?? ''), 0, maxText);
  const name = shown !== '' ? `"${shown}"` : info.testID ? `id=${info.testID}` : '';
  return [refFor(entry.node.fiber), roleName(info), name].filter((part) => part !== '').join(' ');
}

/** Call an app handler; sync throws become errors, async rejections are logged not awaited. */
function callHandler(name: string, handler: (...args: unknown[]) => unknown, args: unknown[]): void {
  let result: unknown;
  try {
    result = handler(...args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaplineError('internal', `${name} threw: ${message}`);
  }
  if (isRecord(result) && typeof result.then === 'function') {
    (result as unknown as Promise<unknown>).then(undefined, (error: unknown) => {
      console.error(`[tapline] ${name} rejected:`, error);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Target resolution                                                           */
/* -------------------------------------------------------------------------- */

type ParsedTarget =
  | { kind: 'ref'; ref: string; index?: number }
  | { kind: 'testID'; value: string; index?: number }
  | { kind: 'label'; value: string; index?: number }
  | { kind: 'text'; value: string; index?: number }
  | { kind: 'point'; x: number; y: number; index?: number };

export function parseTarget(raw: unknown): ParsedTarget {
  if (!isRecord(raw)) throw badParams('target must be an object such as {"testID":"login"}');
  let index: number | undefined;
  if (raw.index !== undefined) {
    if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) {
      throw badParams('target.index must be a non-negative integer');
    }
    index = raw.index;
  }
  const kinds: ParsedTarget[] = [];
  const withIndex = <T extends ParsedTarget>(target: T): T => (index === undefined ? target : { ...target, index });
  if (raw.ref !== undefined) {
    if (typeof raw.ref !== 'string') throw badParams('target.ref must be a string');
    kinds.push(withIndex({ kind: 'ref', ref: raw.ref }));
  }
  for (const key of ['testID', 'label', 'text'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw badParams(`target.${key} must be a string`);
    // Invisible direction marks never match: strip them from what the agent typed, as the list does.
    kinds.push(withIndex({ kind: key, value: key === 'testID' ? value : displayText(value) }));
  }
  if (raw.x !== undefined || raw.y !== undefined) {
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number') {
      throw badParams('target.x and target.y must both be numbers');
    }
    kinds.push(withIndex({ kind: 'point', x: raw.x, y: raw.y }));
  }
  const first = kinds[0];
  if (!first) throw badParams('target needs one of: ref, testID, label, text, or x and y');
  if (kinds.length > 1) throw badParams('target must have exactly one of: ref, testID, label, text, x+y');
  return first;
}

function isAncestor(snapshot: Snapshot, ancestor: Entry, descendant: Entry): boolean {
  for (let p = descendant.node.parent; p >= 0; ) {
    if (p === ancestor.node.index) return true;
    const next = snapshot.nodes[p];
    if (!next) return false;
    p = next.parent;
  }
  return false;
}

/**
 * Collapse matches that are the same thing seen at two levels of the host tree.
 * 'outer': props like testID propagate down, keep the outermost.
 * 'text': keep the actionable one, otherwise the innermost.
 */
function dedupe(snapshot: Snapshot, matches: Entry[], mode: 'outer' | 'text'): Entry[] {
  const drop = new Set<Entry>();
  for (const a of matches) {
    for (const b of matches) {
      if (a === b || !isAncestor(snapshot, a, b)) continue;
      if (mode === 'outer') {
        drop.add(b);
      } else {
        // A container that only scrolls is not a target: its text is its children's text joined.
        const aActs = a.info.actions.some((action) => action !== 'scroll');
        const bActs = b.info.actions.some((action) => action !== 'scroll');
        if (aActs && !bActs) drop.add(b);
        else if (!aActs) drop.add(a);
      }
    }
  }
  return matches.filter((match) => !drop.has(match));
}

export interface Resolved {
  snapshot: Snapshot;
  entry: Entry;
}

function describeTarget(target: ParsedTarget): string {
  switch (target.kind) {
    case 'ref':
      return `ref "${target.ref}"`;
    case 'point':
      return `point (${target.x}, ${target.y})`;
    case 'testID':
      return `id "${target.value}"`;
    default:
      return `${target.kind} "${target.value}"`;
  }
}

/** AGENT-TOOLS §4: what a `not_found` says, per kind of target. */
function notFoundMessage(target: ParsedTarget): string {
  switch (target.kind) {
    case 'testID':
      return `nothing on screen has id "${target.value}"; look, then pick another target.`;
    case 'label':
      return `nothing on screen has label "${target.value}"; use {text} for a partial match, or look.`;
    case 'text':
      return `nothing on screen shows "${target.value}"; look, then pick another target.`;
    case 'ref':
      return `${target.ref} isn't on screen any more; look again.`;
    case 'point':
      return `nothing on screen at (${target.x}, ${target.y}); look, then pick another target.`;
  }
}

/** Where an off-screen frame lies from the screen: `above`, `below`, `left` or `right`; null when any of it is on screen. */
function sideOffScreen(frame: Frame, screen: { width: number; height: number }): 'above' | 'below' | 'left' | 'right' | null {
  if (visiblePart(frame, screen) !== null) return null;
  if (frame.y + frame.height <= 0) return 'above';
  if (frame.y >= screen.height) return 'below';
  if (frame.x + frame.width <= 0) return 'left';
  return 'right';
}

/**
 * A `not_found`, with up to 3 closest matches when there are any (AGENT-TOOLS 1.12 §16.2):
 * `Closest: e12 button "Save draft" id=save-draft, e30 text "Saved" (off screen, below).` An element
 * the list doesn't show gets its ref here, so the agent can use it (refs count on from the highest given).
 */
async function notFoundError(snapshot: Snapshot, target: ParsedTarget): Promise<TaplineError> {
  const base = notFoundMessage(target);
  if (target.kind !== 'testID' && target.kind !== 'label' && target.kind !== 'text') return new TaplineError('not_found', base);
  const pool = inFrontLayer(snapshot.entries.filter((entry) => entry.info.interesting && !entry.tab));
  const picks = closestMatches(
    target.kind,
    target.value,
    pool.map((entry) => ({ testID: entry.info.testID, label: entry.info.label, text: entry.info.text })),
  ).map((index) => pool[index]);
  const lines: string[] = [];
  for (const entry of picks) {
    if (!entry) continue;
    const { info } = entry;
    const shown = cutText(info.text !== '' ? info.text : (info.label ?? ''), 0, MAX_TEXT);
    const frame = await measureFiber(entry.node.fiber);
    const side = frame ? sideOffScreen(frame, snapshot.screen) : null;
    const line = [refFor(entry.node.fiber), roleName(info), shown !== '' ? `"${shown}"` : '', info.testID ? `id=${info.testID}` : '']
      .filter((part) => part !== '')
      .join(' ');
    lines.push(side ? `${line} (off screen, ${side})` : line);
  }
  return new TaplineError('not_found', lines.length > 0 ? `${base} Closest: ${lines.join(', ')}.` : base);
}

/**
 * What a `label` target matches: the element's own accessibility label, else its text. iOS forms
 * the label of an element that has none from the text inside it, and Tapwright reads that label, so
 * `{label: "OK"}` finds a button that only shows "OK" in both tools.
 */
export function labelOf(info: { label: string | null; text: string }): string {
  return info.label ?? info.text;
}

function matchEntries(snapshot: Snapshot, target: ParsedTarget): Entry[] {
  const pool = snapshot.entries.filter((entry) => entry.info.interesting);
  switch (target.kind) {
    case 'testID':
      return dedupe(snapshot, pool.filter((e) => e.info.testID === target.value), 'outer');
    case 'label': {
      const wanted = target.value.trim().toLowerCase();
      if (wanted === '') return [];
      return dedupe(snapshot, pool.filter((e) => labelOf(e.info).toLowerCase() === wanted), 'outer');
    }
    case 'text': {
      const wanted = target.value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (wanted === '') return [];
      const exact = pool.filter((e) => e.info.text.toLowerCase() === wanted);
      if (exact.length > 0) return dedupe(snapshot, exact, 'text');
      return dedupe(snapshot, pool.filter((e) => e.info.text.toLowerCase().includes(wanted)), 'text');
    }
    default:
      return [];
  }
}

/** What the caller means to do; a point target then picks only an element that does it. */
type ActionHint = 'press' | 'longPress' | 'toggle' | 'scroll' | 'type';

/** What a point takes, as `Nothing at (x, y) takes <this>.` reads (AGENT-TOOLS §4). */
const HINT_VERBS: Record<ActionHint, string> = {
  press: 'a tap',
  longPress: 'a long press',
  toggle: 'a toggle',
  scroll: 'a scroll',
  type: 'typing',
};

/** The candidates of an `ambiguous` error as full elements, so the agent sees role, id, actions and place. */
async function candidateElements(entries: Entry[]): Promise<TaplineElement[]> {
  const frames = await Promise.all(entries.map((entry) => measureFiber(entry.node.fiber)));
  return entries.map((entry, i) => toElement(entry, entry.tab ? null : (frames[i] ?? null)));
}

/** How far from the left edge the native navigation bar's back button reaches, in points. */
const BACK_BUTTON_WIDTH = 100;

/** A stand-in fiber for the navigation bar's back button, which iOS draws outside React's tree. */
const backButtonFiber: Fiber = {
  tag: -1,
  type: 'BackButton',
  elementType: 'BackButton',
  memoizedProps: {},
  stateNode: null,
  child: null,
  sibling: null,
  return: null,
  alternate: null,
};

function backButtonEntry(snapshot: Snapshot): Entry {
  const node: HostNode = {
    index: snapshot.nodes.length,
    parent: -1,
    fiber: backButtonFiber,
    hostType: 'BackButton',
    owners: [],
    text: 'Back',
    isText: false,
    insideText: false,
  };
  return {
    node,
    navBack: true,
    info: {
      type: 'BackButton',
      role: 'button',
      testID: null,
      label: 'Back',
      text: 'Back',
      value: null,
      placeholder: null,
      actions: ['press'],
      disabled: false,
      selected: false,
      checked: null,
      interesting: true,
    },
  };
}

/** An element as the list words it: `[ref ]role "text" id=… @x,y WxH` (the position only when its frame is known). */
function elementLine(entry: Entry, frame: Frame | null, withRef: boolean): string {
  const { info } = entry;
  const shown = cutText(info.text !== '' ? info.text : (info.label ?? ''));
  return [
    withRef ? refFor(entry.node.fiber) : '',
    roleName(info),
    shown !== '' ? `"${shown}"` : '',
    info.testID ? `id=${info.testID}` : '',
    frame ? `@${Math.round(frame.x)},${Math.round(frame.y)} ${Math.round(frame.width)}x${Math.round(frame.height)}` : '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * AGENT-TOOLS v1.4: a target that matches nothing in the list, but matches an element only hidden
 * because an open sheet covers its screen, is `covered`, not `not_found`. The answer names what is
 * in front (with its ref, so the agent can act on it); `force` doesn't help, the element isn't on
 * the list. An OS alert still answers `behind_alert` first. Returns when nothing hidden matches.
 */
async function refuseBehindSheet(snapshot: Snapshot, target: ParsedTarget): Promise<void> {
  const behind: BehindSheet | undefined = snapshot.behind?.();
  if (!behind) return;
  const matches = matchEntries({ ...snapshot, nodes: behind.nodes, entries: behind.hidden }, target);
  const hidden = matches[target.index ?? 0];
  if (!hidden) return;
  assertNoBlockingAlert();
  const [hiddenFrame, inFront] = await Promise.all([measureFiber(hidden.node.fiber), frontLine(snapshot)]);
  throw notActionable('covered', `${elementLine(hidden, hiddenFrame, false)} is behind ${inFront ?? 'the open sheet'}; close that first.`);
}

/**
 * The line of the first element in front that has a text or an id (with its ref, so the agent can
 * act on it): what names an open sheet in an answer. Undefined when nothing in front has either.
 */
async function frontLine(snapshot: Snapshot): Promise<string | undefined> {
  const front = snapshot.entries.find(
    (entry) => entry.info.interesting && !entry.tab && (entry.info.text.trim() !== '' || entry.info.testID),
  );
  return front ? elementLine(front, await measureFiber(front.node.fiber), true) : undefined;
}

/**
 * AGENT-TOOLS v1.5: when several elements match a target and some of them are in the alert that is
 * in front, only those count; a person sees one "Cancel", not the one behind the alert too. With no
 * match in the alert the list is left alone, so a target behind it still answers `behind_alert`.
 * (What an open sheet hides isn't in the list at all, so a sheet needs no such rule.)
 */
function inFrontLayer(matches: Entry[]): Entry[] {
  if (matches.length < 2 || !openAlerts().some((alert) => alert.standIn)) return matches;
  const inAlert = matches.filter((entry) => inStandInAlert(entry.node.fiber));
  return inAlert.length > 0 ? inAlert : matches;
}

/** Resolve a protocol target to exactly one element, or throw not_found / ambiguous. */
export async function resolveTarget(raw: unknown, hint?: ActionHint): Promise<Resolved> {
  const target = parseTarget(raw);
  const snapshot = takeSnapshot();

  if (target.kind === 'ref') {
    const fiber = fiberForRef(target.ref);
    const entry = fiber ? snapshot.entries.find((e) => sameFiber(e.node.fiber, fiber)) : undefined;
    if (!entry) throw new TaplineError('not_found', notFoundMessage(target));
    return { snapshot, entry };
  }

  if (target.kind === 'point') {
    // iOS draws the native tab bar over the app: a touch there lands on a tab, not on what's behind.
    const bar = nativeTabBar(snapshot);
    const tab = bar && target.y >= bar.top ? tabAt(bar, target.x, snapshot.screen.width) : undefined;
    if (tab) return { snapshot, entry: tab };
    // Likewise the navigation bar at the top: a touch there hits the bar, unless it lands on one of
    // the custom items the app put in the header.
    const navBar = nativeNavBar(snapshot);
    if (navBar && target.y < navBar.bottom) {
      const inHeader = snapshot.entries.filter((e) => !e.tab && inNavBarHeader(navBar, e.node.fiber));
      const headerFrames = await Promise.all(inHeader.map((e) => measureFiber(e.node.fiber)));
      const onItem = headerFrames.some((frame) => frame !== null && frameContains(frame, target.x, target.y));
      if (!onItem) {
        if (navBar.canGoBack && target.x < BACK_BUTTON_WIDTH && (hint === undefined || hint === 'press')) {
          return { snapshot, entry: backButtonEntry(snapshot) };
        }
        throw notActionable('no_action', `Nothing at (${target.x}, ${target.y}) takes ${hint === undefined ? 'a touch' : HINT_VERBS[hint]}: it's on the navigation bar iOS draws.`);
      }
    }
    const actionable = snapshot.entries.filter((e) =>
      hint === undefined ? e.info.actions.length > 0 : e.info.actions.includes(hint),
    );
    const frames = await Promise.all(actionable.map((e) => measureFiber(e.node.fiber)));
    let hit: Entry | undefined;
    actionable.forEach((entry, i) => {
      const frame = frames[i];
      if (frame && frameContains(frame, target.x, target.y)) hit = entry; // later in tree order = in front
    });
    if (!hit) {
      const verb = hint === undefined ? 'a touch' : HINT_VERBS[hint];
      throw notActionable('no_action', `Nothing at (${target.x}, ${target.y}) takes ${verb}.`);
    }
    return { snapshot, entry: hit };
  }

  const matches = inFrontLayer(matchEntries(snapshot, target));
  if (matches.length === 0) await refuseBehindSheet(snapshot, target);
  if (target.index !== undefined) {
    const picked = matches[target.index];
    if (!picked) {
      throw new TaplineError(
        'not_found',
        `Only ${matches.length} element(s) match ${describeTarget(target)}; index ${target.index} is out of range`,
      );
    }
    return { snapshot, entry: picked };
  }
  const [only, ...rest] = matches;
  if (!only) throw await notFoundError(snapshot, target);
  if (rest.length > 0) {
    const shown = matches.slice(0, 5);
    throw new TaplineError(
      'ambiguous',
      `${matches.length} elements match ${describeTarget(target)}.`,
      shown.map((entry) => refFor(entry.node.fiber)),
      await candidateElements(shown),
    );
  }
  return { snapshot, entry: only };
}

/** The entry itself, else the nearest ancestor that offers `action`. */
function selfOrAncestor(snapshot: Snapshot, entry: Entry, action: Action): Entry | null {
  for (let node = entry.node; ; ) {
    const candidate = snapshot.entries[node.index];
    if (candidate?.info.actions.includes(action)) return candidate;
    if (node.parent < 0) return null;
    const parent = snapshot.nodes[node.parent];
    if (!parent) return null;
    node = parent;
  }
}

function descendantsWith(snapshot: Snapshot, entry: Entry, action: Action): Entry[] {
  return snapshot.entries.filter(
    (candidate) => candidate.info.actions.includes(action) && isAncestor(snapshot, entry, candidate),
  );
}

/** Self, then ancestors, then a single descendant offering `action`. */
function findActionable(snapshot: Snapshot, entry: Entry, action: Action, descend: boolean): Entry | null {
  const up = selfOrAncestor(snapshot, entry, action);
  if (up) return up;
  if (!descend) return null;
  const down = descendantsWith(snapshot, entry, action);
  return down.length === 1 ? (down[0] ?? null) : null;
}

async function elementFor(entry: Entry, knownFrame?: Frame | null): Promise<{ element: TaplineElement; frame: Frame | null }> {
  const frame = knownFrame !== undefined ? knownFrame : await measureFiber(entry.node.fiber);
  return { element: toElement(entry, frame), frame };
}

/* -------------------------------------------------------------------------- */
/* press / longPress                                                           */
/* -------------------------------------------------------------------------- */

function nativeTagOf(fiber: Fiber): number {
  const state = fiber.stateNode;
  if (isRecord(state)) {
    if (typeof state._nativeTag === 'number') return state._nativeTag;
    const canonical = state.canonical;
    if (isRecord(canonical) && typeof canonical.nativeTag === 'number') return canonical.nativeTag;
  }
  return 0;
}

function pressEvent(fiber: Fiber, frame: Frame | null): Record<string, unknown> {
  const width = frame?.width ?? 0;
  const height = frame?.height ?? 0;
  const pageX = (frame?.x ?? 0) + width / 2;
  const pageY = (frame?.y ?? 0) + height / 2;
  const timestamp = Date.now();
  const target = nativeTagOf(fiber);
  const nativeEvent = {
    locationX: width / 2,
    locationY: height / 2,
    pageX,
    pageY,
    timestamp,
    target,
    identifier: 0,
    touches: [],
    changedTouches: [],
  };
  return {
    nativeEvent,
    target,
    currentTarget: target,
    type: 'press',
    timeStamp: timestamp,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    persist: () => {},
    preventDefault: () => {},
    stopPropagation: () => {},
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
  };
}

/** The nearest listed element at or above a host fiber, for naming what covers a target. */
export function describeHit(snapshot: Snapshot, hit: Fiber, actor?: Entry): string {
  for (let fiber: Fiber | null = hit; fiber; fiber = fiber.return) {
    const entry = snapshot.entries.find((candidate) => candidate.info.interesting && sameFiber(candidate.node.fiber, fiber));
    if (entry) {
      return describe(entry, 40);
    }
  }
  // Never a native type name ("RCTView"): the agent can't act on it.
  const modal = openModalHosts().find((host) => isWithin(hit, host));
  if (modal && !(actor && isWithin(actor.node.fiber, modal))) {
    const inside = snapshot.entries.filter((e) => e.info.interesting && !e.tab && isWithin(e.node.fiber, modal));
    const named = inside.find((e) => e.info.actions.length > 0) ?? inside[0];
    return named ? `an open modal (${describe(named, 40)})` : 'an open modal';
  }
  return 'another view';
}

/** A rectangle by its edges, in points. */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The part of an element a person can touch must be at least this wide and high. */
const MIN_VISIBLE_PT = 10;
/** How many covers are cut away from an element before giving up. */
const MAX_COVER_CUTS = 4;

/** `box` without `cut`: the largest of the strips above, below, left and right of it; null when nothing is left. */
function withoutBox(box: Box | null, cut: Box): Box | null {
  if (box === null) return null;
  if (cut.right <= box.left || cut.left >= box.right || cut.bottom <= box.top || cut.top >= box.bottom) return box;
  const strips: Box[] = [
    { ...box, bottom: Math.min(box.bottom, cut.top) },
    { ...box, top: Math.max(box.top, cut.bottom) },
    { ...box, right: Math.min(box.right, cut.left) },
    { ...box, left: Math.max(box.left, cut.right) },
  ];
  let best: Box | null = null;
  let bestArea = 0;
  for (const strip of strips) {
    const area = Math.max(0, strip.right - strip.left) * Math.max(0, strip.bottom - strip.top);
    if (area > bestArea) {
      best = strip;
      bestArea = area;
    }
  }
  return best;
}

/** The testID of the view Tapline's in-app alert draws (`TaplineAlertHost`); its buttons and input sit inside it. */
const STAND_IN_ALERT_ID = 'tapline-alert';

/** Whether a fiber is inside the stand-in alert's own view. */
function inStandInAlert(fiber: Fiber): boolean {
  for (let up: Fiber | null = fiber; up; up = up.return) {
    const props = up.memoizedProps;
    if (isRecord(props) && props.testID === STAND_IN_ALERT_ID) return true;
  }
  return false;
}

/**
 * An alert sits on top of everything: a person has to answer it first. An OS alert can't be pressed
 * from here; Tapline's stand-in covers the whole screen, so anything outside it is behind it, and
 * its own buttons are what to tap. `actor` is the element about to be touched, when there is one.
 */
function assertNoBlockingAlert(actor?: Entry): void {
  const blocking = openAlerts().find((alert) => !alert.standIn);
  if (blocking) {
    const buttons = blocking.buttons.map((button) => `[${button.text}]`).join(' ');
    if (isOwnAlert(blocking.id)) {
      throw notActionable(
        'behind_alert',
        `Tapline's own prompt is open: "${blocking.title}" ${buttons}. Only the person holding the phone answers it: ` +
          'ask the user to tap a button. force: true acts anyway.',
      );
    }
    throw notActionable(
      'behind_alert',
      `An alert is open: "${blocking.title}" ${buttons}. A person would have to answer it first, and Tapline can't press OS alerts: ` +
        "ask the user to tap a button, or start Tapline with alerts: 'stand-in' so its buttons can be pressed. force: true acts anyway.",
    );
  }
  const standIn = openAlerts().find((alert) => alert.standIn);
  if (standIn && !(actor && inStandInAlert(actor.node.fiber))) {
    const buttons = standIn.buttons.map((button) => `[${button.text}]`).join(' ');
    throw notActionable('behind_alert', `"${standIn.title}" is open with ${buttons}; tap one of them first.`);
  }
}

/** How a refusal names the one call that brings an element onto the screen (AGENT-TOOLS v1.6, shared with Tapwright). */
const SCROLL_TO_TARGET_HINT = '(scroll with this target and to: "target")';

/**
 * Refuses what a person couldn't tap: an element off screen, or one with something else on top
 * at the centre of its visible part (Fabric's hit test). Unknown hit results let it through.
 */
async function assertReachable(snapshot: Snapshot, actor: Entry, frame: Frame | null): Promise<void> {
  assertNoBlockingAlert(actor);
  if (frame === null) return;
  const { width, height } = snapshot.screen;
  const left = Math.max(frame.x, 0);
  const top = Math.max(frame.y, 0);
  const right = Math.min(frame.x + frame.width, width);
  const bottom = Math.min(frame.y + frame.height, height);
  const name = describe(actor);
  if (right <= left || bottom <= top) {
    throw notActionable(
      'off_screen',
      `${name} is off screen (at ${Math.round(frame.x)},${Math.round(frame.y)}; the screen is ${width}x${height}). ` +
        `Scroll to it first ${SCROLL_TO_TARGET_HINT}, or pass force: true to call its handler anyway.`,
    );
  }
  const bar = nativeTabBar(snapshot);
  const navBar = nativeNavBar(snapshot);
  const underNavBar = (y: number): boolean => navBar !== null && y < navBar.bottom && !inNavBarHeader(navBar, actor.node.fiber);
  // The last hit test, so a point is never asked twice.
  let asked: { x: number; y: number; hit: Fiber | null | undefined } | null = null;
  const hitAt = async (x: number, y: number): Promise<Fiber | null | undefined> => {
    if (asked && asked.x === x && asked.y === y) return asked.hit;
    const hit = await hitTest(x, y);
    asked = { x, y, hit };
    return hit;
  };
  // Why a touch at (x, y) would not reach the actor, or null when it would (an unknown hit lets it through).
  const refusalAt = async (x: number, y: number): Promise<TaplineError | null> => {
    if (bar && y >= bar.top) {
      return notActionable(
        'under_tab_bar',
        `${name} is under the tab bar iOS draws, at (${x}, ${y}): a real tap would switch tabs instead. ` +
          `Scroll it clear of the bar ${SCROLL_TO_TARGET_HINT}, or pass force: true to call its handler anyway.`,
      );
    }
    if (underNavBar(y)) {
      return notActionable(
        'covered',
        `${name} is under the navigation bar iOS draws, at (${x}, ${y}): a real tap would hit the bar instead. ` +
          `Scroll it clear of the bar ${SCROLL_TO_TARGET_HINT}, or pass force: true to call its handler anyway.`,
      );
    }
    const hit = await hitAt(x, y);
    if (!hit || isWithin(hit, actor.node.fiber) || isWithin(actor.node.fiber, hit)) return null;
    return notActionable(
      'covered',
      `${name} is covered at (${x}, ${y}) by ${describeHit(snapshot, hit, actor)}: a real tap would land there instead. ` +
        'Dismiss or scroll it out of the way, or pass force: true to call the handler anyway.',
    );
  };
  const refusal = await refusalAt(Math.round((left + right) / 2), Math.round((top + bottom) / 2));
  if (refusal === null) return;

  // Touch the visible part (AGENT-TOOLS v1.3): what's left of the element outside the bars and
  // covers, if it is at least 10 x 10 pt, is touched at its centre, as a finger would.
  let part: Box | null = { left, top, right, bottom };
  if (bar) part = withoutBox(part, { left: 0, top: bar.top, right: width, bottom: height });
  if (navBar && !inNavBarHeader(navBar, actor.node.fiber)) part = withoutBox(part, { left: 0, top: 0, right: width, bottom: navBar.bottom });
  for (let attempt = 0; attempt < MAX_COVER_CUTS; attempt++) {
    if (part === null || part.right - part.left < MIN_VISIBLE_PT || part.bottom - part.top < MIN_VISIBLE_PT) throw refusal;
    const hit = await hitAt(Math.round((part.left + part.right) / 2), Math.round((part.top + part.bottom) / 2));
    if (!hit || isWithin(hit, actor.node.fiber) || isWithin(actor.node.fiber, hit)) return;
    // Something covers that point: cut its rect away and try what is left.
    const cover = await measureFiber(hit);
    if (!cover) throw refusal;
    part = withoutBox(part, { left: cover.x, top: cover.y, right: cover.x + cover.width, bottom: cover.y + cover.height });
  }
  throw refusal;
}

/** Switches native tabs the way the tab bar does: through the tab navigator that holds the tab. */
function selectTab(snapshot: Snapshot, tab: TabFound): void {
  for (const route of [...snapshot.routes].reverse()) {
    const nav = route.navigation;
    if (typeof nav.getState !== 'function' || typeof nav.navigate !== 'function') continue;
    let state: unknown;
    try {
      state = nav.getState();
    } catch {
      continue;
    }
    if (!isRecord(state) || !Array.isArray(state.routes)) continue;
    const target = state.routes.find(
      (candidate: unknown) =>
        isRecord(candidate) &&
        typeof candidate.name === 'string' &&
        (tab.screenKey !== null ? candidate.key === tab.screenKey : candidate.name === tab.title),
    );
    if (isRecord(target) && typeof target.name === 'string') {
      callHandler('navigate', nav.navigate as (...args: unknown[]) => unknown, [target.name]);
      return;
    }
  }
  throw new TaplineError(
    'unsupported',
    `Can't switch to the "${tab.title}" tab from here; open its deep link with open_url instead.`,
  );
}

/** A Modal's `onRequestClose`: on its host fiber, else on the components that render it (the `Modal` itself). */
function requestCloseOf(host: Fiber): ((...args: unknown[]) => unknown) | null {
  // Up through the composites only: the first host above belongs to something else (maybe another Modal).
  for (let fiber: Fiber | null = host; fiber; fiber = fiber.return) {
    if (fiber !== host && !isCompositeTag(fiber.tag)) break;
    const props = isRecord(fiber.memoizedProps) ? fiber.memoizedProps : {};
    if (typeof props.onRequestClose === 'function') return props.onRequestClose as (...args: unknown[]) => unknown;
  }
  return null;
}

/** `back`: what the back button or gesture does, on the focused screen; with a sheet open, closes the sheet. */
export async function back(rawParams: unknown): Promise<{ route: string[]; closed?: 'sheet'; dryRun?: true } & SettleOutcome> {
  const dry = paramsOf(rawParams).dryRun === true;
  const snapshot = takeSnapshot();
  const current = currentRoute(snapshot.routes);
  // An open sheet is what back closes first (AGENT-TOOLS v1.4): the top Modal's own onRequestClose,
  // which is what the system back gesture or a swipe down calls. One already on its way out is left alone.
  const sheet = openModalHosts().filter((host) => !closingModalHosts().includes(host)).pop();
  if (sheet) {
    const onRequestClose = requestCloseOf(sheet);
    // Most app sheets have no onRequestClose and close on a tap on the dimmed backdrop around them:
    // a person taps that, so back does.
    const backdrop = onRequestClose ? null : await backdropOf(snapshot);
    if (backdrop) {
      if (dry) return { route: current?.chain ?? [], closed: 'sheet', dryRun: true, settledMs: 0 };
      callHandler('onPress', backdrop.onPress, [pressEvent(backdrop.entry.node.fiber, backdrop.frame)]);
      return { route: current?.chain ?? [], closed: 'sheet', ...(await settleOutcome()) };
    }
    if (!onRequestClose) {
      // Named by what it shows, as `covered` names what is in front, so the agent finds its close control.
      const shows = await frontLine(snapshot);
      throw notActionable(
        'no_action',
        `the open sheet${shows !== undefined ? ` (in front: ${shows})` : ''} has nothing for back to call (its Modal has no onRequestClose); tap its close control.`,
      );
    }
    if (dry) return { route: current?.chain ?? [], closed: 'sheet', dryRun: true, settledMs: 0 };
    callHandler('onRequestClose', onRequestClose, []);
    return { route: current?.chain ?? [], closed: 'sheet', ...(await settleOutcome()) };
  }
  if (!current) {
    throw new TaplineError('unsupported', 'This app has no React Navigation screens Tapline can see, so there is no back.');
  }
  const nav = current.navigation;
  let canGoBack = true;
  try {
    if (typeof nav.canGoBack === 'function') canGoBack = nav.canGoBack();
  } catch {
    canGoBack = true;
  }
  if (!canGoBack || typeof nav.goBack !== 'function') {
    throw notActionable('no_action', `Nothing to go back to from ${current.chain.join(' › ')}.`);
  }
  if (dry) return { route: current.chain, dryRun: true, settledMs: 0 };
  callHandler('goBack', nav.goBack as (...args: unknown[]) => unknown, []);
  return { route: current.chain, ...(await settleOutcome()) };
}

/** How much of the screen, across and down, an element in front must cover to count as a sheet's backdrop. */
const BACKDROP_SHARE = 0.9;

/**
 * The backdrop of the open sheet: an element in front that takes a tap, covers (nearly) the whole
 * screen and shows nothing of its own (no text, no label), the dimmed area a person taps to close
 * the sheet. A full-screen control with a text ("Tap to continue") is no backdrop. Null when there is none.
 */
async function backdropOf(
  snapshot: Snapshot,
): Promise<{ entry: Entry; frame: Frame; onPress: (...args: unknown[]) => unknown } | null> {
  const { width, height } = snapshot.screen;
  for (const entry of snapshot.entries) {
    if (entry.tab || entry.info.disabled || entry.info.text.trim() !== '' || (entry.info.label ?? '') !== '') continue;
    const onPress = findHandler(entry.node, 'onPress');
    if (!onPress) continue;
    const frame = await measureFiber(entry.node.fiber);
    if (frame !== null && frame.width >= width * BACKDROP_SHARE && frame.height >= height * BACKDROP_SHARE) {
      return { entry, frame, onPress };
    }
  }
  return null;
}

/** Calls `name()` on the first instance that has it; whether one did. */
function callInstanceMethod(instances: unknown[], name: string): boolean {
  for (const instance of instances) {
    if (!isRecord(instance) || typeof instance[name] !== 'function') continue;
    try {
      (instance[name] as () => unknown).call(instance);
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

/**
 * What a finger does to a text input: focus it. React Native's TextInput puts `focus()` on its host
 * instance (Paper: the fiber's stateNode; Fabric: `stateNode.canonical`), and `TextInput.State.focusTextInput`
 * takes the same instance. Without either, the app's own onPressIn / onFocus handlers run.
 */
/** An input's instances, the host's and its components': the ones a `focus()` may be called on. */
function inputInstances(entry: Entry): unknown[] {
  return [...publicInstancesOf(entry.node.fiber), ...entry.node.owners.map((owner) => owner.stateNode)];
}

function focusInput(entry: Entry, frame: Frame | null): void {
  const instances = inputInstances(entry);
  if (callInstanceMethod(instances, 'focus')) return;
  try {
    const state = (TextInput as unknown as { State?: unknown }).State;
    if (isRecord(state) && typeof state.focusTextInput === 'function') {
      const host = publicInstancesOf(entry.node.fiber).find(isRecord);
      if (host) {
        (state.focusTextInput as (instance: unknown) => void)(host);
        return;
      }
    }
  } catch {
    // fall through to the handlers
  }
  for (const key of ['onPressIn', 'onFocus']) {
    const handler = appHandler(entry, key);
    if (handler) callHandler(key, handler, [pressEvent(entry.node.fiber, frame)]);
  }
}

async function pressLike(
  kind: 'press' | 'longPress',
  rawParams: unknown,
): Promise<PressResult> {
  const params = paramsOf(rawParams);
  const { snapshot, entry } = await resolveTarget(params.target, kind);
  if (entry.tab) {
    if (kind === 'longPress') throw notActionable('no_action', `${describe(entry)} has no long-press action`);
    if (params.dryRun === true) return { element: toElement(entry, null), dryRun: true, settledMs: 0 };
    selectTab(snapshot, entry.tab);
    return { element: toElement(entry, null), ...keyboardNote(closeKeyboardFor(entry)), ...(await settleOutcome()) };
  }
  if (entry.navBack) {
    if (params.dryRun === true) return { element: toElement(entry, null), dryRun: true, settledMs: 0 };
    const { route: _route, ...outcome } = await back({});
    return { element: toElement(entry, null), ...outcome };
  }
  const handlerName = kind === 'press' ? 'onPress' : 'onLongPress';
  const actionName = kind === 'press' ? 'tap' : 'long-press';
  const plan = (snap: Snapshot, picked: Entry): { actor: Entry; handler: ReturnType<typeof findHandler>; focusing: boolean } => {
    const found = findActionable(snap, picked, kind, false);
    if (!found) {
      if (picked.info.disabled) throw notActionable('disabled', `${describe(picked)} is disabled; ${ENABLE_FIRST}.`);
      throw notActionable('no_action', `${describe(picked)} has no ${actionName} action`);
    }
    if (found.info.disabled || picked.info.disabled) {
      throw notActionable('disabled', `${describe(found)} is disabled; ${ENABLE_FIRST}.`);
    }
    // A finger on an input focuses it (AGENT-TOOLS v1.3): an input never answers no_action to a tap.
    const isInput = kind === 'press' && found.info.actions.includes('type');
    const own = isInput ? null : findHandler(found.node, handlerName);
    if (!own && !isInput) {
      throw notActionable('no_action', `${describe(found)} has no ${actionName} action`);
    }
    return { actor: found, handler: own, focusing: isInput };
  };
  let planned = plan(snapshot, entry);
  // Off screen, in the tree: scroll it into view first (AGENT-TOOLS 1.12 §16.2). The policy ran before this call.
  let reach: Reach = {};
  let current = snapshot;
  if (params.force !== true) {
    // What doesn't depend on where the element is comes first: an open alert is answered before anything scrolls.
    assertNoBlockingAlert(planned.actor);
    reach = await scrollIntoReach(snapshot, planned.actor, params.dryRun === true, params.noScroll === true);
    if (reach.scrolled) {
      const again = await reresolve(planned.actor, kind, params.target);
      current = again.snapshot;
      planned = plan(again.snapshot, again.entry);
      await assertRefoundOnScreen(current, planned.actor, reach);
    }
  }
  const { actor, handler, focusing } = planned;
  const { element, frame } = await elementFor(actor);
  if (reach.scrolls) return { element, dryRun: true, scrolls: true, ...(reach.point ? { point: reach.point } : {}), settledMs: 0 };
  const forced = await checkedAfterScroll(params.force === true, reach, () => assertReachable(current, actor, frame));
  // A dry run (AGENT-TOOLS 1.8 §11.4): every check ran; nothing is touched.
  if (params.dryRun === true) return { element, dryRun: true, ...pointOf(frame), ...forced, settledMs: 0 };
  const closedKeyboard = closeKeyboardFor(actor);
  if (handler) callHandler(handlerName, handler, [pressEvent(actor.node.fiber, frame)]);
  else {
    // A finger focuses the input and also fires the input's own onPress (not an ancestor's: the
    // input takes the touch).
    focusInput(actor, frame);
    const own = appHandler(actor, 'onPress');
    if (own) callHandler('onPress', own, [pressEvent(actor.node.fiber, frame)]);
  }
  return { element, ...(reach.scrolled ? { scrolled: true as const } : {}), ...keyboardNote(closedKeyboard), ...forced, ...(await settleOutcome()) };
}

/**
 * What `press` and `longPress` answer: the element, `closedKeyboard: true` when the keyboard was
 * closed first, and `forced` (the reason word) when `force` let through what the checks refuse.
 * `scrolled` says the element was off screen and was scrolled into view first (§16.2); on a dry run,
 * `scrolls` says it would be and `point` is where the touch is expected after the scroll.
 */
export type PressResult = {
  element: TaplineElement;
  closedKeyboard?: true;
  forced?: string;
  dryRun?: true;
  scrolled?: true;
  scrolls?: true;
  point?: { x: number; y: number };
} & SettleOutcome;

/** Where a finger would land: the middle of the element (points, rounded). */
function pointOf(frame: Frame | null): { point?: { x: number; y: number } } {
  return frame ? { point: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) } } : {};
}

export function press(params: unknown): Promise<PressResult> {
  return pressLike('press', params);
}

export function longPress(params: unknown): Promise<PressResult> {
  return pressLike('longPress', params);
}

/* -------------------------------------------------------------------------- */
/* type                                                                        */
/* -------------------------------------------------------------------------- */

/** Props supplied by the app, i.e. everything except the host fiber's own (RN wraps handlers there). */
function appHandler(entry: Entry, key: string): ((...args: unknown[]) => unknown) | null {
  if (entry.node.owners.length === 0) return findHandler(entry.node, key);
  for (const owner of entry.node.owners) {
    const props = isRecord(owner.memoizedProps) ? owner.memoizedProps : {};
    const value = props[key];
    if (typeof value === 'function') return value as (...args: unknown[]) => unknown;
  }
  return null;
}

function focusedInputInstance(): unknown {
  try {
    const state = (TextInput as unknown as { State?: unknown }).State;
    if (isRecord(state) && typeof state.currentlyFocusedInput === 'function') {
      return (state.currentlyFocusedInput as () => unknown)();
    }
  } catch {
    // fall through
  }
  return null;
}

function ownsInstance(entry: Entry, instance: unknown): boolean {
  if (instance == null) return false;
  if (publicInstancesOf(entry.node.fiber).includes(instance)) return true;
  return entry.node.owners.some((owner) => owner.stateNode === instance);
}

/** What the SDK asks of the keyboard and the focused input; replaceable so tests need no native side. */
export interface KeyboardControl {
  /** The instance of the text input that has focus, or null. */
  focusedInput(): unknown;
  /** Whether the software keyboard is up (true when React Native can't say). */
  visible(): boolean;
  /** Closes the keyboard without submitting (`Keyboard.dismiss()`). */
  dismiss(): void;
  /** Takes focus off `input`. */
  blur(input: unknown): void;
  /** The keyboard's top edge in window points, or null when it isn't known. */
  top?(): number | null;
  /**
   * Gives a text input the focus, as a finger on it does. `instances` are the input's instances,
   * public ones and its component's included (see `inputInstances`).
   */
  focus?(instances: unknown[]): void;
}

const defaultKeyboard: KeyboardControl = {
  focusedInput: focusedInputInstance,
  visible: () => keyboardState()?.shown ?? true,
  dismiss: () => {
    try {
      Keyboard.dismiss();
    } catch {
      // nothing to close
    }
  },
  blur: (input) => {
    try {
      const state = (TextInput as unknown as { State?: unknown }).State;
      if (isRecord(state) && typeof state.blurTextInput === 'function') {
        (state.blurTextInput as (instance: unknown) => void)(input);
        return;
      }
    } catch {
      // fall through to the instance's own blur
    }
    callInstanceMethod([input], 'blur');
  },
  top: () => keyboardState()?.top ?? null,
  // The instance's own focus() first: on Fabric only the public instance reaches the native field,
  // and handing TextInputState the internal node moves the focus in JavaScript's books alone.
  focus: (instances) => {
    callInstanceMethod(instances, 'focus');
  },
};

let keyboard: KeyboardControl = defaultKeyboard;

/** Inject the keyboard and focus access (tests); pass null to restore the default. */
export function setKeyboardControl(next: KeyboardControl | null): void {
  keyboard = next ?? defaultKeyboard;
}

/**
 * AGENT-TOOLS v1.4: with the keyboard up, an action on anything but the focused input closes it
 * first, without submitting, as a person would. Call it after every refusal is decided. Returns
 * whether it closed the keyboard (the result then says `closedKeyboard: true`).
 */
function closeKeyboardFor(actor: Entry): boolean {
  const focused = keyboard.focusedInput();
  if (focused == null || !keyboard.visible()) return false;
  if (!actor.tab && !actor.navBack && ownsInstance(actor, focused)) return false;
  keyboard.dismiss();
  // `Keyboard.dismiss()` blurs the focused input itself; when it didn't, do it.
  if (keyboard.focusedInput() != null) keyboard.blur(focused);
  return true;
}

/**
 * AGENT-TOOLS v1.6 §4: typing into another input that shows above the keyboard is what a person
 * does to fill the next field of a form: the tap moves the focus there and the keyboard stays up.
 * Moves the focus and returns true; false when the keyboard covers the input (even in part), when
 * it isn't known where the keyboard is, or when the focus didn't move, and then the caller closes
 * the keyboard the old way.
 */
/** How much of an input must show above the keyboard for a finger to reach it (AGENT-TOOLS v1.6 §4). */
const SHOWS_ABOVE_KEYBOARD_PT = 10;

async function moveFocusAboveKeyboard(entry: Entry): Promise<boolean> {
  const focused = keyboard.focusedInput();
  if (focused == null || !keyboard.visible() || ownsInstance(entry, focused)) return false;
  const top = keyboard.top?.() ?? null;
  if (top === null || keyboard.focus === undefined) return false;
  const frame = await measureFiber(entry.node.fiber);
  if (frame === null || frame.y < 0 || Math.min(frame.y + frame.height, top) - frame.y < SHOWS_ABOVE_KEYBOARD_PT) return false;
  keyboard.focus(inputInstances(entry));
  return ownsInstance(entry, keyboard.focusedInput());
}

/** `{ closedKeyboard: true }` for a result when the keyboard was closed, nothing otherwise. */
function keyboardNote(closed: boolean): { closedKeyboard?: true } {
  return closed ? { closedKeyboard: true } : {};
}

async function resolveInput(snapshot: Snapshot | null, rawTarget: unknown): Promise<Resolved> {
  if (rawTarget !== undefined && rawTarget !== null) {
    const { snapshot: snap, entry } = await resolveTarget(rawTarget, 'type');
    const input = findActionable(snap, entry, 'type', true);
    if (!input) throw notActionable('no_action', `${describe(entry)} is not an input`);
    return { snapshot: snap, entry: input };
  }
  const snap = snapshot ?? takeSnapshot();
  const inputs = snap.entries.filter((entry) => isInputNode(entry.node));
  if (inputs.length === 0) throw new TaplineError('not_found', 'No input on screen');
  const focused = keyboard.focusedInput();
  const focusedEntry = inputs.find((entry) => ownsInstance(entry, focused));
  if (focusedEntry) return { snapshot: snap, entry: focusedEntry };
  const [only, ...rest] = inputs;
  if (only && rest.length === 0) return { snapshot: snap, entry: only };
  const shown = inputs.slice(0, 5);
  throw new TaplineError(
    'ambiguous',
    `${inputs.length} inputs on screen; pass a target to pick one:`,
    shown.map((entry) => refFor(entry.node.fiber)),
    await candidateElements(shown),
  );
}

function setNativeText(entry: Entry, text: string): void {
  for (const instance of publicInstancesOf(entry.node.fiber)) {
    if (isRecord(instance) && typeof instance.setNativeProps === 'function') {
      try {
        (instance.setNativeProps as (props: { text: string }) => void)({ text });
        return;
      } catch {
        // try the next candidate
      }
    }
  }
}

export async function typeText(
  rawParams: unknown,
): Promise<{ element: TaplineElement; value: string; secure?: true; closedKeyboard?: true; forced?: string; dryRun?: true; scrolled?: true; scrolls?: true; point?: { x: number; y: number } } & SettleOutcome> {
  const params = paramsOf(rawParams);
  const submit = params.submit === true;
  if (params.text !== undefined && typeof params.text !== 'string') throw badParams('text must be a string');
  const backspace = params.backspace;
  if (backspace !== undefined && (typeof backspace !== 'number' || !Number.isInteger(backspace) || backspace < 0)) {
    throw badParams('backspace must be a whole number of characters, 0 or more');
  }
  const deleting = typeof backspace === 'number' && backspace > 0;
  if (params.text === undefined && !submit && !deleting) throw badParams('text is required (or pass submit: true)');
  // Deleting from the end edits what is there, so it never replaces the whole text.
  const replace = params.replace !== false && !deleting;

  let { snapshot, entry } = await resolveInput(null, params.target);
  if (entry.info.disabled) throw notActionable('disabled', `${describe(entry)} is not editable; ${ENABLE_FIRST}.`);
  // Off screen, in the tree: scroll it into view first (AGENT-TOOLS 1.12 §16.2; the policy ran before this
  // call). The input that already has focus is typed into without touching it, so it is not scrolled to.
  let reach: Reach = {};
  if (params.force !== true) assertNoBlockingAlert(entry);
  if (params.force !== true && !ownsInstance(entry, keyboard.focusedInput())) {
    reach = await scrollIntoReach(snapshot, entry, params.dryRun === true, params.noScroll === true);
    if (reach.scrolled) {
      let again: Awaited<ReturnType<typeof resolveInput>>;
      try {
        again = await resolveInput(null, { ref: refFor(entry.node.fiber) });
      } catch (error) {
        // a list unmounted the row while scrolling: find it again by the original target
        const refind = error instanceof TaplineError && error.code === 'not_found' ? refindTarget(entry, params.target) : null;
        if (refind === null) throw error;
        again = await resolveInput(null, refind);
      }
      snapshot = again.snapshot;
      entry = again.entry;
      if (entry.info.disabled) throw notActionable('disabled', `${describe(entry)} is not editable; ${ENABLE_FIRST}.`);
      await assertRefoundOnScreen(snapshot, entry, reach);
    }
  }
  if (reach.scrolls) {
    const { element } = await elementFor(entry);
    return { element, value: displayText(currentInputValue(entry.node)), dryRun: true, scrolls: true, ...(reach.point ? { point: reach.point } : {}), settledMs: 0 };
  }
  // Typing is a tap that focuses the input, then keys: a person couldn't do it where they couldn't tap,
  // so the checks are a tap's, with the same reasons and the same `force`. The input that already has
  // focus is the exception: the keyboard is up for it and a person types without touching it.
  const forced = await checkedAfterScroll(params.force === true, reach, async () => {
    if (ownsInstance(entry, keyboard.focusedInput())) {
      // An alert takes the keyboard away even from the focused input: a person answers it first.
      assertNoBlockingAlert(entry);
    } else {
      await assertReachable(snapshot, entry, await measureFiber(entry.node.fiber));
    }
  });
  if (params.dryRun === true) {
    const { element } = await elementFor(entry);
    return { element, value: displayText(currentInputValue(entry.node)), dryRun: true, ...forced, settledMs: 0 };
  }
  // Typing into the input that has focus leaves the keyboard alone. Another input above the keyboard
  // takes the focus with the keyboard up; one the keyboard covers closes it first.
  const closedKeyboard = !(await moveFocusAboveKeyboard(entry)) && closeKeyboardFor(entry);

  const current = currentInputValue(entry.node);
  // Characters, not UTF-16 units: an emoji is one.
  const previous = deleting ? Array.from(current).slice(0, -backspace).join('') : current;
  const typedText = typeof params.text === 'string' ? params.text : undefined;
  const typed = typedText ?? (deleting ? '' : undefined);
  const next = typed === undefined ? previous : replace ? typed : previous + typed;
  const target = nativeTagOf(entry.node.fiber);
  const controlled = typeof findProp(entry.node, 'value') === 'string';

  if (typed !== undefined) {
    const onChange = appHandler(entry, 'onChange');
    const onChangeText = appHandler(entry, 'onChangeText');
    if (!controlled) {
      rememberTyped(entry.node, next);
      setNativeText(entry, next);
    }
    if (onChange) callHandler('onChange', onChange, [{ nativeEvent: { text: next, eventCount: 0, target } }]);
    if (onChangeText) callHandler('onChangeText', onChangeText, [next]);
  }

  if (submit) {
    const event = { nativeEvent: { text: next, target } };
    const onSubmit = appHandler(entry, 'onSubmitEditing');
    const onEnd = appHandler(entry, 'onEndEditing');
    if (onSubmit) callHandler('onSubmitEditing', onSubmit, [event]);
    if (onEnd) callHandler('onEndEditing', onEnd, [event]);
  }

  const outcome = await settleOutcome();
  const { element } = await elementFor(entry);
  // A password field's text never leaves the app: one bullet per character, as iOS draws it.
  const secure = isSecureInput(entry.node);
  const shown = secure ? maskSecret(next) : displayText(next);
  // An input that now holds text shows no placeholder (AGENT-TOOLS v1.7).
  const { placeholder, ...rest } = element;
  return {
    element: { ...rest, ...(next === '' && placeholder !== undefined ? { placeholder } : {}), value: shown },
    value: shown,
    ...(secure ? { secure: true as const } : {}),
    ...(reach.scrolled ? { scrolled: true as const } : {}),
    ...keyboardNote(closedKeyboard),
    ...forced,
    ...outcome,
  };
}

/* -------------------------------------------------------------------------- */
/* scroll                                                                      */
/* -------------------------------------------------------------------------- */

interface ScrollMetrics {
  offset: number;
  visibleLength: number | null;
  contentLength: number | null;
}

type ScrollFn = (arg: Record<string, unknown>) => void;

const rememberedOffsets = new WeakMap<object, { x: number; y: number }>();

/** Objects that may expose scroll methods: host public instances first, then list class instances. */
function scrollCandidates(entry: Entry): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const instance of publicInstancesOf(entry.node.fiber)) if (isRecord(instance)) found.push(instance);
  for (const owner of entry.node.owners) if (isRecord(owner.stateNode)) found.push(owner.stateNode);
  // ScrollView exposes its responder, which can also scrollTo
  for (const candidate of [...found]) {
    if (typeof candidate.getScrollResponder === 'function') {
      try {
        const responder = (candidate.getScrollResponder as () => unknown)();
        if (isRecord(responder)) found.push(responder);
      } catch {
        // ignore
      }
    }
  }
  return found;
}

function method(candidates: Record<string, unknown>[], name: string): ScrollFn | null {
  for (const candidate of candidates) {
    const fn = candidate[name];
    if (typeof fn === 'function') return (arg) => (fn as ScrollFn).call(candidate, arg);
  }
  return null;
}

function readMetrics(candidates: Record<string, unknown>[]): ScrollMetrics | null {
  for (const candidate of candidates) {
    const metrics = candidate._scrollMetrics;
    if (isRecord(metrics) && typeof metrics.offset === 'number') {
      // Lengths of 0 mean "not laid out yet", i.e. unknown.
      return {
        offset: metrics.offset,
        visibleLength: typeof metrics.visibleLength === 'number' && metrics.visibleLength > 0 ? metrics.visibleLength : null,
        contentLength: typeof metrics.contentLength === 'number' && metrics.contentLength > 0 ? metrics.contentLength : null,
      };
    }
  }
  return null;
}

function rememberKey(entry: Entry, candidates: Record<string, unknown>[]): object | null {
  const state = entry.node.fiber.stateNode;
  if (typeof state === 'object' && state !== null) return state;
  return candidates[0] ?? null;
}

const DIRECTIONS = ['down', 'up', 'left', 'right'] as const;
type Direction = (typeof DIRECTIONS)[number];

/** What `scroll` answers; `target`, `reached` and `unchanged` only with `to: "target"`. */
export type ScrollResult = {
  /** The scroll view that was scrolled. */
  element: TaplineElement;
  offset: { x: number; y: number };
  moved: boolean;
  /** The element that was scrolled to, where it is now. */
  target?: TaplineElement;
  /** False when the scroll views are as far as they go and the element still isn't clear. */
  reached?: boolean;
  /** The element was clear already: nothing was scrolled. */
  unchanged?: true;
  /** A dry run (AGENT-TOOLS 1.8 §11.4): resolved and checked, nothing scrolled. */
  dryRun?: true;
} & SettleOutcome;

/** How far inside the clear area a scrolled-to element is placed, in points, when there is room (the same in Tapwright). */
const TARGET_MARGIN = 8;

/**
 * How far content must move along one axis to bring [start, start + size] into [from, until], with
 * the margin when it fits. Positive scrolls forward (down, right). 0 when it is clear already. An
 * element longer than the area is lined up with its start.
 */
function axisShift(start: number, size: number, from: number, until: number): number {
  const room = until - from;
  const margin = Math.min(TARGET_MARGIN, Math.max(0, (room - size) / 2));
  if (start < from) return start - (from + margin);
  if (start + size > until) return Math.min(start + size - (until - margin), start - (from + margin));
  return 0;
}

/**
 * `scroll` with `to: "target"` (AGENT-TOOLS v1.6): scrolls the scroll views that hold the element,
 * innermost first, until it is on screen and clear of the bars iOS draws. One `scrollTo` each, from
 * measured positions; a second round corrects for a list that laid out more rows on the way.
 */
async function scrollToTarget(params: Record<string, unknown>): Promise<ScrollResult> {
  const raw = params.target;
  if (raw === undefined || raw === null) throw badParams('to: "target" needs a target: the element to bring onto the screen');
  if (isRecord(raw) && (raw.x !== undefined || raw.y !== undefined)) {
    throw badParams('to: "target" needs an element (ref, id, label or text), not a point');
  }
  const { snapshot, entry: wanted } = await resolveTarget(raw);
  const scrollers = scrollersOf(snapshot, wanted);
  if (params.dryRun === true) {
    const first = scrollers[0];
    const target = (await elementFor(wanted)).element;
    if (!first) return { element: target, target, offset: { x: 0, y: 0 }, moved: false, dryRun: true, settledMs: 0 };
    return { element: (await elementFor(first)).element, target, offset: { x: 0, y: 0 }, moved: false, dryRun: true, settledMs: 0 };
  }
  return scrollEntryIntoView(snapshot, wanted, scrollers);
}

/** The scroll views that hold an element, innermost first. */
function scrollersOf(snapshot: Snapshot, wanted: Entry): Entry[] {
  const scrollers: Entry[] = [];
  for (let p = wanted.node.parent; p >= 0; ) {
    const candidate = snapshot.entries[p];
    if (candidate?.info.actions.includes('scroll')) scrollers.push(candidate);
    const node = snapshot.nodes[p];
    if (!node) break;
    p = node.parent;
  }
  return scrollers;
}

/**
 * How far the element is from clear inside a scroll view, per axis. The area is the part of the
 * scroll view that is on screen between the bars. A scroll view that is itself out of view (a
 * list further down the page) has no such part: there the element only has to be inside the
 * scroll view, and the outer one brings both onto the screen. Without a scroll view the area is
 * the screen between the bars.
 */
function shiftsFor(snapshot: Snapshot, wanted: Entry): (frame: Frame, area: Frame | null) => { x: number; y: number } {
  const { width, height } = snapshot.screen;
  const navBar = nativeNavBar(snapshot);
  const tabBar = nativeTabBar(snapshot);
  const clearTop = navBar && !inNavBarHeader(navBar, wanted.node.fiber) ? navBar.bottom : 0;
  const clearBottom = tabBar ? tabBar.top : height;
  return (frame, area) => {
    let left = Math.max(area?.x ?? 0, 0);
    let right = Math.min(area ? area.x + area.width : width, width);
    let top = Math.max(area?.y ?? 0, clearTop);
    let bottom = Math.min(area ? area.y + area.height : height, clearBottom);
    if (area && (right - left < 1 || bottom - top < 1)) {
      left = area.x;
      right = area.x + area.width;
      top = area.y;
      bottom = area.y + area.height;
    }
    return { x: axisShift(frame.x, frame.width, left, right), y: axisShift(frame.y, frame.height, top, bottom) };
  };
}

/** The scrolling half of `scroll` with `to: "target"`: scrolls the given scroll views until `wanted` is clear. */
async function scrollEntryIntoView(snapshot: Snapshot, wanted: Entry, scrollers: Entry[]): Promise<ScrollResult> {
  const shiftsIn = shiftsFor(snapshot, wanted);
  let settledMs = 0;
  let settleCapMs: number | undefined;
  let scrolled: { entry: Entry; offset: { x: number; y: number } } | null = null;
  // A list drawn upside down (`inverted`) moves its content the other way: found out from the first move.
  const inverted = new Set<Entry>();
  for (let round = 0; round < 3; round++) {
    let movedThisRound = false;
    for (const scroller of scrollers) {
      const horizontal = findProp(scroller.node, 'horizontal') === true;
      const [targetFrame, scrollFrame, state] = await Promise.all([
        measureFiber(wanted.node.fiber),
        measureFiber(scroller.node.fiber),
        measureScrollState(scroller),
      ]);
      if (!targetFrame || !scrollFrame) continue;
      const shifts = shiftsIn(targetFrame, scrollFrame);
      const wantedShift = horizontal ? shifts.x : shifts.y;
      if (Math.abs(wantedShift) < 1) continue;
      const shift = inverted.has(scroller) ? -wantedShift : wantedShift;
      const candidates = scrollCandidates(scroller);
      const key = rememberKey(scroller, candidates);
      const metrics = readMetrics(candidates);
      const current =
        state?.offset ??
        (metrics ? (horizontal ? { x: metrics.offset, y: 0 } : { x: 0, y: metrics.offset }) : ((key ? rememberedOffsets.get(key) : undefined) ?? { x: 0, y: 0 }));
      // Never further back than the start. A scroll view resting at a negative offset (the system's
      // inset under a large title) can't be asked to go back past where it rests.
      let x = Math.max(Math.min(0, current.x), current.x + (horizontal ? shift : 0));
      let y = Math.max(Math.min(0, current.y), current.y + (horizontal ? 0 : shift));
      if (state) {
        x = Math.min(x, Math.max(state.max.x, current.x));
        y = Math.min(y, Math.max(state.max.y, current.y));
      }
      // At its start or end already: this scroll view can't bring the element any closer.
      if (Math.abs(x - current.x) < 1 && Math.abs(y - current.y) < 1) continue;
      const scrollTo = method(candidates, 'scrollTo');
      const scrollToOffset = method(candidates, 'scrollToOffset');
      if (scrollTo) scrollTo({ x, y, animated: false });
      else if (scrollToOffset) scrollToOffset({ offset: horizontal ? x : y, animated: false });
      else throw new TaplineError('unsupported', 'This scroll view exposes no scrollTo');
      const outcome = await settleOutcome();
      settledMs += outcome.settledMs;
      if (outcome.settleCapMs !== undefined) settleCapMs = outcome.settleCapMs;
      const [after, movedFrame] = await Promise.all([measureScrollState(scroller), measureFiber(wanted.node.fiber)]);
      const offset = after ? after.offset : { x, y };
      if (key) rememberedOffsets.set(key, offset);
      // What the element did, measured: the scroll view may have held it back, or gone the other way.
      // (When it can't be measured now, it is taken to have moved as asked.)
      const asked = horizontal ? x - current.x : y - current.y;
      const travelled = movedFrame ? (horizontal ? movedFrame.x - targetFrame.x : movedFrame.y - targetFrame.y) : -asked;
      if (Math.abs(travelled) < 1) continue;
      if (travelled * asked > 0 && !inverted.has(scroller)) inverted.add(scroller);
      // The answer names the innermost scroll view that moved.
      if (scrolled === null || scrollers.indexOf(scroller) < scrollers.indexOf(scrolled.entry)) scrolled = { entry: scroller, offset };
      else if (scrolled.entry === scroller) scrolled.offset = offset;
      movedThisRound = true;
    }
    if (!movedThisRound) break;
  }

  const finalFrame = await measureFiber(wanted.node.fiber);
  let reached = finalFrame !== null && isOnScreen(finalFrame, snapshot.screen);
  if (finalFrame !== null && reached) {
    // Clear inside every scroll view that holds it, and on the screen between the bars.
    const areas: Array<Frame | null> = scrollers.length > 0 ? await Promise.all(scrollers.map((s) => measureFiber(s.node.fiber))) : [null];
    for (const area of areas) {
      const left = shiftsIn(finalFrame, area);
      if (Math.abs(left.x) >= 1 || Math.abs(left.y) >= 1) reached = false;
    }
    const onScreen = shiftsIn(finalFrame, null);
    if (Math.abs(onScreen.x) >= 1 || Math.abs(onScreen.y) >= 1) reached = false;
  }
  const target = toElement(wanted, finalFrame);
  const settle: SettleOutcome = { settledMs, ...(settleCapMs !== undefined ? { settleCapMs } : {}) };
  if (scrolled === null) {
    if (reached) return { element: target, target, offset: { x: 0, y: 0 }, moved: false, reached: true, unchanged: true, ...settle };
    const first = scrollers[0];
    if (!first) throw notActionable('no_action', `${describe(wanted)} is not inside a scroll view`);
    const state = await measureScrollState(first);
    const { element } = await elementFor(first);
    return { element, target, offset: state?.offset ?? { x: 0, y: 0 }, moved: false, reached: false, ...settle };
  }
  const { element } = await elementFor(scrolled.entry);
  return { element, target, offset: scrolled.offset, moved: true, reached, ...settle };
}

/**
 * What an action did about a target that is off screen (AGENT-TOOLS 1.12 §16.2): `scrolled` when its scroll
 * views brought it on screen first; `scrolls` and `point` on a dry run, which touches nothing.
 */
interface Reach {
  scrolled?: true;
  scrolls?: true;
  point?: { x: number; y: number };
  /** The element could not be measured after the scroll (a list unmounted its row): the caller finds it again and checks it is on screen. */
  unverified?: true;
}

/** The part of a frame that is on the screen, or null when none of it is. */
function visiblePart(frame: Frame, screen: { width: number; height: number }): Frame | null {
  const left = Math.max(frame.x, 0);
  const top = Math.max(frame.y, 0);
  const right = Math.min(frame.x + frame.width, screen.width);
  const bottom = Math.min(frame.y + frame.height, screen.height);
  return right <= left || bottom <= top ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * An action on an element that is in the tree but entirely off screen scrolls it into view first, clear
 * of the bars (§16.2). The caller has run the policy check already. The touch checks (covered, behind an
 * alert, under a bar) run afterwards, as for any element. Refused as `off_screen`, with the reason, when
 * no scroll can bring it on screen. `dry` predicts the point after the scroll and scrolls nothing.
 */
async function scrollIntoReach(snapshot: Snapshot, entry: Entry, dry: boolean, noScroll = false): Promise<Reach> {
  const frame = await measureFiber(entry.node.fiber);
  if (frame === null) return {};
  // A journey in a user's eyes (`noScroll`, §17.1): nothing scrolls by itself. An element wholly off screen is refused.
  if (noScroll) {
    if (visiblePart(frame, snapshot.screen) !== null) return {};
    throw notActionable(
      'off_screen',
      `${describe(entry)} is off screen; in a journey nothing scrolls by itself: scroll the way a person would, then try again.`,
    );
  }
  // Partly on screen (over the edge, or under a bar): scrolled clear too, with one attempt; if that
  // can't be done the action goes on as before and the touch checks decide. Never refused for this.
  const partial = visiblePart(frame, snapshot.screen) !== null;
  if (partial && !isNotClear(snapshot, entry, frame)) return {};
  const { width, height } = snapshot.screen;
  const name = describe(entry);
  const where = `at ${Math.round(frame.x)},${Math.round(frame.y)}; the screen is ${width}x${height}`;
  const scrollers = scrollersOf(snapshot, entry);
  if (scrollers.length === 0 && partial) return {};
  if (scrollers.length === 0) {
    throw notActionable(
      'off_screen',
      `${name} is off screen (${where}). It isn't inside a scroll view, so no scroll can bring it on screen; pass force: true to call its handler anyway.`,
    );
  }
  if (dry) {
    const shiftsIn = shiftsFor(snapshot, entry);
    let predicted = frame;
    for (const scroller of scrollers) {
      const [area, state] = await Promise.all([measureFiber(scroller.node.fiber), measureScrollState(scroller)]);
      if (!area) continue;
      const horizontal = findProp(scroller.node, 'horizontal') === true;
      const shifts = shiftsIn(predicted, area);
      const wanted = horizontal ? shifts.x : shifts.y;
      if (Math.abs(wanted) < 1) continue;
      let delta = wanted;
      if (state) {
        const current = horizontal ? state.offset.x : state.offset.y;
        const max = horizontal ? state.max.x : state.max.y;
        delta = Math.max(Math.min(0, current), Math.min(current + wanted, Math.max(max, current))) - current;
      }
      predicted = horizontal ? { ...predicted, x: predicted.x - delta } : { ...predicted, y: predicted.y - delta };
    }
    if (partial) {
      return predicted.x === frame.x && predicted.y === frame.y ? {} : { scrolls: true, ...pointOf(visiblePart(predicted, snapshot.screen)) };
    }
    const seen = visiblePart(predicted, snapshot.screen);
    if (seen === null) {
      throw notActionable(
        'off_screen',
        `${name} is off screen (${where}), and its scroll view can't bring it on screen: it is as far as it goes; pass force: true to call its handler anyway.`,
      );
    }
    return { scrolls: true, ...pointOf(seen) };
  }
  let outcome: ScrollResult;
  try {
    outcome = await scrollEntryIntoView(snapshot, entry, scrollers);
  } catch (error) {
    if (partial && error instanceof TaplineError) return {};
    throw error;
  }
  const after = await measureFiber(entry.node.fiber);
  if (partial) {
    if (!outcome.moved) return {};
    return after === null ? { scrolled: true, unverified: true } : { scrolled: true };
  }
  // A list may have unmounted the row on the way: the caller finds it again, and checks it is on screen.
  if (after === null && outcome.moved) return { scrolled: true, unverified: true };
  if (after === null || visiblePart(after, snapshot.screen) === null) {
    throw notActionable(
      'off_screen',
      `${name} is off screen (${where}), and scrolling its scroll view${outcome.moved ? '' : ' (already as far as it goes)'} didn't bring it on screen; pass force: true to call its handler anyway.`,
    );
  }
  return outcome.moved ? { scrolled: true } : {};
}

/** Whether a partly visible element is off the screen edge or under a bar, and would fit clear of them if scrolled. */
function isNotClear(snapshot: Snapshot, entry: Entry, frame: Frame): boolean {
  const navBar = nativeNavBar(snapshot);
  const tabBar = nativeTabBar(snapshot);
  const clearTop = navBar && !inNavBarHeader(navBar, entry.node.fiber) ? navBar.bottom : 0;
  const clearBottom = tabBar ? tabBar.top : snapshot.screen.height;
  // Taller or wider than the room there is: no scroll makes it clear, so it is left as it is.
  if (frame.height > clearBottom - clearTop || frame.width > snapshot.screen.width) return false;
  const shift = shiftsFor(snapshot, entry)(frame, null);
  return Math.abs(shift.x) >= 1 || Math.abs(shift.y) >= 1;
}

/** A target that finds an element again by what it shows: the app's own target, else its id, label or text. */
function refindTarget(entry: Entry, original: unknown): Record<string, unknown> | null {
  if (isRecord(original) && original.ref === undefined && original.x === undefined && original.y === undefined) return original;
  const { testID, label, text } = entry.info;
  if (testID) return { testID };
  if (label) return { label };
  if (text !== '') return { text };
  return null;
}

/**
 * The same element after a scroll, from a fresh snapshot (the list may have laid out other rows on the
 * way). When a list unmounted the row, the ref is gone: it is found again by the original target.
 */
async function reresolve(entry: Entry, hint: ActionHint | undefined, original?: unknown): Promise<Resolved> {
  try {
    return await resolveTarget({ ref: refFor(entry.node.fiber) }, hint);
  } catch (error) {
    if (!(error instanceof TaplineError) || error.code !== 'not_found') throw error;
    const again = refindTarget(entry, original);
    if (again === null) throw error;
    return resolveTarget(again, hint);
  }
}

/** After an element was found again because it could not be measured: it must now be on screen. */
async function assertRefoundOnScreen(snapshot: Snapshot, entry: Entry, reach: Reach): Promise<void> {
  if (!reach.unverified) return;
  const frame = await measureFiber(entry.node.fiber);
  if (frame === null || visiblePart(frame, snapshot.screen) === null) {
    throw notActionable(
      'off_screen',
      `${describe(entry)} is off screen, and scrolling its scroll view didn't bring it on screen; pass force: true to call its handler anyway.`,
    );
  }
}

/** `checkedOrForced`, and a refusal that comes after Tapline scrolled to the element says so. */
async function checkedAfterScroll(force: boolean, reach: Reach, check: () => Promise<void> | void): Promise<{ forced?: string }> {
  try {
    return await checkedOrForced(force, check);
  } catch (error) {
    if (reach.scrolled && error instanceof TaplineError && error.code === 'not_actionable') {
      throw new TaplineError(error.code, `${error.message} (after scrolling to it)`, error.refs, error.candidates);
    }
    throw error;
  }
}

export async function scroll(rawParams: unknown): Promise<ScrollResult> {
  const params = paramsOf(rawParams);
  const to = params.to;
  if (to !== undefined && to !== 'start' && to !== 'end' && to !== 'target') throw badParams('to must be "start", "end" or "target"');
  if (to === 'target') {
    if (params.direction !== undefined || params.amount !== undefined || params.fraction !== undefined) {
      throw badParams('to: "target" takes no direction or amount');
    }
    return scrollToTarget(params);
  }
  const direction: Direction = params.direction === undefined ? 'down' : (params.direction as Direction);
  if (!DIRECTIONS.includes(direction)) throw badParams('direction must be down, up, left or right');
  if (params.amount !== undefined && (typeof params.amount !== 'number' || !(params.amount > 0))) {
    throw badParams('amount must be a positive number of points');
  }

  if (params.fraction !== undefined) {
    if (params.amount !== undefined) throw badParams('use fraction or amount, not both');
    if (typeof params.fraction !== 'number' || !(params.fraction >= 0.1 && params.fraction <= 1)) {
      throw badParams('fraction is a share of the scroll area, 0.1 to 1');
    }
  }

  let entry: Entry;
  let frame: Frame | null = null;
  if (params.target !== undefined && params.target !== null) {
    const resolved = await resolveTarget(params.target, 'scroll');
    const scroller = findActionable(resolved.snapshot, resolved.entry, 'scroll', true);
    if (!scroller) throw notActionable('no_action', `${describe(resolved.entry)} is not inside a scroll view`);
    entry = scroller;
    frame = await measureFiber(entry.node.fiber);
  } else {
    const snapshot = takeSnapshot();
    const scrollers = snapshot.entries.filter((e) => e.info.actions.includes('scroll'));
    const frames = await Promise.all(scrollers.map((e) => measureFiber(e.node.fiber)));
    let best: Entry | null = null;
    let bestFrame: Frame | null = null;
    let bestArea = -1;
    for (let i = 0; i < scrollers.length; i++) {
      const candidate = scrollers[i];
      if (!candidate) continue;
      const f = frames[i] ?? null;
      if (f !== null && !isOnScreen(f, snapshot.screen)) continue;
      const area = f ? f.width * f.height : 0;
      if (area > bestArea) {
        best = candidate;
        bestFrame = f;
        bestArea = area;
      }
    }
    if (!best) throw new TaplineError('not_found', 'No scroll view on screen');
    entry = best;
    frame = bestFrame;
  }

  if (params.dryRun === true) {
    const { element } = await elementFor(entry, frame);
    return { element, offset: { x: 0, y: 0 }, moved: false, dryRun: true, settledMs: 0 };
  }
  const candidates = scrollCandidates(entry);
  const key = rememberKey(entry, candidates);
  const horizontal = findProp(entry.node, 'horizontal') === true;
  const metrics = readMetrics(candidates);
  const remembered = key ? rememberedOffsets.get(key) : undefined;
  // The real position first: Tapline's own record is wrong after a person scrolls or the system clamps.
  const measured = await measureScrollState(entry);
  const known = measured !== null || metrics !== null || remembered !== undefined;
  const current = measured
    ? measured.offset
    : metrics
      ? horizontal
        ? { x: metrics.offset, y: 0 }
        : { x: 0, y: metrics.offset }
      : (remembered ?? { x: 0, y: 0 });

  const scrollTo = method(candidates, 'scrollTo');
  const scrollToOffset = method(candidates, 'scrollToOffset');
  const scrollToEnd = method(candidates, 'scrollToEnd');

  let offset = { ...current };
  if (to === 'start') {
    offset = { x: 0, y: 0 };
    if (scrollTo) scrollTo({ x: 0, y: 0, animated: false });
    else if (scrollToOffset) scrollToOffset({ offset: 0, animated: false });
    else throw new TaplineError('unsupported', 'This scroll view exposes no scrollTo');
  } else if (to === 'end') {
    if (!scrollToEnd) throw new TaplineError('unsupported', 'This scroll view exposes no scrollToEnd');
    scrollToEnd({ animated: false });
    if (measured) {
      offset = horizontal ? { x: measured.max.x, y: 0 } : { x: 0, y: measured.max.y };
    } else if (metrics && metrics.contentLength !== null && metrics.visibleLength !== null) {
      const max = Math.max(0, metrics.contentLength - metrics.visibleLength);
      offset = horizontal ? { x: max, y: 0 } : { x: 0, y: max };
    }
  } else {
    const visible =
      (measured ? (horizontal ? measured.visible.x : measured.visible.y) : null) ??
      metrics?.visibleLength ??
      (horizontal ? frame?.width : frame?.height) ??
      getScreen().height;
    const vertical = direction === 'down' || direction === 'up';
    const areaSize = (vertical ? frame?.height : frame?.width) ?? visible;
    const amount =
      typeof params.fraction === 'number'
        ? Math.round(params.fraction * areaSize)
        : typeof params.amount === 'number'
          ? params.amount
          : Math.round(visible * 0.8);
    const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    let x = Math.max(0, current.x + dx);
    let y = Math.max(0, current.y + dy);
    if (measured) {
      // native clamps to [0, max]; the automatic inset (a negative resting offset) is out of reach
      x = Math.min(x, measured.max.x);
      y = Math.min(y, measured.max.y);
    } else if (metrics && metrics.contentLength !== null && metrics.visibleLength !== null) {
      const max = Math.max(0, metrics.contentLength - metrics.visibleLength);
      if (horizontal) x = Math.min(x, max);
      else y = Math.min(y, max);
    }
    offset = { x, y };
    if (scrollTo) scrollTo({ x, y, animated: false });
    else if (scrollToOffset) scrollToOffset({ offset: horizontal ? x : y, animated: false });
    else throw new TaplineError('unsupported', 'This scroll view exposes no scrollTo');
  }

  const outcome = await settleOutcome();
  // Report where the content really is, not where we asked it to go.
  const after = await measureScrollState(entry);
  if (after) offset = after.offset;
  const moved = !known && !after ? true : Math.abs(offset.x - current.x) >= 1 || Math.abs(offset.y - current.y) >= 1;
  if (key) rememberedOffsets.set(key, offset);
  const { element } = await elementFor(entry, frame);
  return { element, offset, moved, ...outcome };
}

interface ScrollState {
  /** The real content offset; negative at rest when the system adds an inset. */
  offset: { x: number; y: number };
  /** The furthest offset a scrollTo can reach. */
  max: { x: number; y: number };
  visible: { x: number; y: number };
}

/** The native type of a scroll view's content container (iOS and Android's horizontal one). */
const SCROLL_CONTENT_HOSTS = new Set(['RCTScrollContentView', 'AndroidHorizontalScrollContentView']);

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The scroll view's real offset, from where its content container sits inside it. On the new
 * architecture `measureInWindow` includes the content offset, so scroll frame minus content frame
 * is the offset. Null when either can't be measured (old architecture, nothing laid out).
 */
export async function measureScrollState(entry: Entry): Promise<ScrollState | null> {
  const scrollFiber = entry.node.fiber;
  const horizontal = findProp(entry.node, 'horizontal') === true;
  const children = hostChildren(scrollFiber);
  // On iOS the RefreshControl is the scroll view's first child, so the first host child is not
  // the content: pick the content container by its native type, else the largest child.
  const typed = children.find((child) => typeof child.type === 'string' && SCROLL_CONTENT_HOSTS.has(child.type));
  const scrollFrame = await measureFiber(scrollFiber);
  if (!scrollFrame) return null;
  let contentFrame: Frame | null = typed ? await measureFiber(typed) : null;
  if (!contentFrame && children.length > 1) {
    const frames = await Promise.all(children.map((child) => measureFiber(child)));
    let bestSize = -1;
    for (const f of frames) {
      if (!f) continue;
      const size = horizontal ? f.width : f.height;
      if (size > bestSize) {
        bestSize = size;
        contentFrame = f;
      }
    }
  }
  if (!contentFrame) {
    const first = firstHostChild(scrollFiber);
    contentFrame = first ? await measureFiber(first) : null;
  }
  if (!contentFrame) return null;
  return {
    offset: { x: round2(scrollFrame.x - contentFrame.x), y: round2(scrollFrame.y - contentFrame.y) },
    max: {
      x: Math.max(0, round2(contentFrame.width - scrollFrame.width)),
      y: Math.max(0, round2(contentFrame.height - scrollFrame.height)),
    },
    visible: { x: scrollFrame.width, y: scrollFrame.height },
  };
}

/* -------------------------------------------------------------------------- */
/* toggle                                                                      */
/* -------------------------------------------------------------------------- */

export async function toggle(
  rawParams: unknown,
): Promise<{ element: TaplineElement; value: boolean; closedKeyboard?: true; unchanged?: true; forced?: string; dryRun?: true; scrolled?: true; scrolls?: true; point?: { x: number; y: number } } & SettleOutcome> {
  const params = paramsOf(rawParams);
  if (params.value !== undefined && typeof params.value !== 'boolean') throw badParams('value must be a boolean');
  const first = await resolveTarget(params.target, 'toggle');
  const plan = (snap: Snapshot, picked: Entry): { control: Entry; handler: NonNullable<ReturnType<typeof findHandler>> } => {
    const found = findActionable(snap, picked, 'toggle', true);
    if (!found) throw notActionable('no_action', `${describe(picked)} is not a switch`);
    if (found.info.disabled) throw notActionable('disabled', `${describe(found)} is disabled; ${ENABLE_FIRST}.`);
    const own = findHandler(found.node, 'onValueChange');
    if (!own) throw notActionable('no_action', `${describe(found)} is not a switch`);
    return { control: found, handler: own };
  };
  let snapshot = first.snapshot;
  let planned = plan(snapshot, first.entry);
  // Off screen, in the tree: scroll it into view first (AGENT-TOOLS 1.12 §16.2). The policy ran before this call.
  let reach: Reach = {};
  if (params.force !== true) {
    assertNoBlockingAlert(planned.control);
    reach = await scrollIntoReach(snapshot, planned.control, params.dryRun === true, params.noScroll === true);
    if (reach.scrolled) {
      const again = await reresolve(planned.control, 'toggle', params.target);
      snapshot = again.snapshot;
      planned = plan(snapshot, again.entry);
      await assertRefoundOnScreen(snapshot, planned.control, reach);
    }
  }
  const { control, handler } = planned;
  const current = control.info.checked === true;
  const next = typeof params.value === 'boolean' ? params.value : !current;
  if (reach.scrolls) {
    const { element } = await elementFor(control);
    return { element, value: next, dryRun: true, scrolls: true, ...(reach.point ? { point: reach.point } : {}), settledMs: 0 };
  }
  const forced = await checkedAfterScroll(params.force === true, reach, async () =>
    assertReachable(snapshot, control, await measureFiber(control.node.fiber)),
  );
  if (params.dryRun === true) {
    const { element, frame } = await elementFor(control);
    return { element, value: next, dryRun: true, ...pointOf(frame), ...forced, settledMs: 0 };
  }
  if (typeof params.value === 'boolean' && control.info.checked === params.value) {
    // Already there: a person wouldn't touch it, so the handler isn't called and the keyboard stays.
    const { element } = await elementFor(control);
    return { element, value: params.value, unchanged: true, ...(reach.scrolled ? { scrolled: true as const } : {}), settledMs: 0 };
  }
  const closedKeyboard = closeKeyboardFor(control);
  callHandler('onValueChange', handler, [next]);
  const outcome = await settleOutcome();
  const { element } = await elementFor(control);
  return { element: { ...element, checked: next }, value: next, ...(reach.scrolled ? { scrolled: true as const } : {}), ...keyboardNote(closedKeyboard), ...forced, ...outcome };
}

/* -------------------------------------------------------------------------- */
/* openURL / logs / reload / screenshot                                        */
/* -------------------------------------------------------------------------- */

const OPEN_URL_TIMEOUT_MS = 5000;

export async function openURL(rawParams: unknown): Promise<SettleOutcome> {
  const params = paramsOf(rawParams);
  if (typeof params.url !== 'string' || params.url === '') throw badParams('url must be a non-empty string');
  const url = params.url;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TaplineError('timeout', `Linking.openURL did not finish in ${OPEN_URL_TIMEOUT_MS} ms`)), OPEN_URL_TIMEOUT_MS);
  });
  try {
    await Promise.race([Linking.openURL(url), timeout]);
  } catch (error) {
    if (error instanceof TaplineError) throw error;
    throw new TaplineError('internal', `Linking.openURL failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return settleOutcome();
}

/**
 * `inspect {target}` (Tapline 1.1, development builds): the element, the components that draw it, the line
 * of the app's code that wrote it, and that component's props in short. From the screen to the code.
 */
export async function inspect(rawParams: unknown): Promise<{ element: TaplineElement; source: ElementSource }> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    throw new TaplineError('unsupported', 'inspect needs a development build: release builds keep no source locations');
  }
  const params = paramsOf(rawParams);
  const { entry } = await resolveTarget(params.target);
  const [source] = await sourcesOf([entry.node.fiber]);
  const { element } = await elementFor(entry);
  return { element, source: source ?? { components: [], location: null, props: {} } };
}

/** What is known about the element of an issue whose full element could not be built: where it is, and what it says. */
export interface AuditWhere {
  frame?: Frame;
  text?: string;
  label?: string;
}

export interface AuditIssue {
  type: AuditType;
  element: TaplineElement | null;
  /** Set when `element` is null but something is known (its frame in points, its text or label). */
  where?: AuditWhere;
  problem: string;
  fix: string;
  /** Where the app's code wrote the element (development builds), as Metro names the file. */
  at?: { file: string; line: number; direct: boolean };
}

/** The frame, text and label a finding knows when its element could not be built; null when it knows none. */
function whereOf(finding: AuditFinding): AuditWhere | null {
  const text = finding.entry?.info.text ?? '';
  const label = finding.entry?.info.label ?? null;
  const where: AuditWhere = {
    ...(finding.frame !== null && [finding.frame.x, finding.frame.y, finding.frame.width, finding.frame.height].every(Number.isFinite)
      ? { frame: finding.frame }
      : {}),
    ...(text !== '' ? { text: text.length > 80 ? `${text.slice(0, 79)}…` : text } : {}),
    ...(label !== null && label !== '' ? { label: label.length > 80 ? `${label.slice(0, 79)}…` : label } : {}),
  };
  return Object.keys(where).length > 0 ? where : null;
}

/** `audit {types?}` (AGENT-TOOLS 1.8 §10): the screen's accessibility problems, each with its source line in development. */
export async function audit(rawParams: unknown): Promise<{ issues: AuditIssue[]; checked: AuditType[] }> {
  const params = paramsOf(rawParams);
  const asked = params.types;
  if (asked !== undefined && (!Array.isArray(asked) || asked.some((t) => typeof t !== 'string'))) {
    throw badParams('types must be a list of audit types');
  }
  const known = new Set<string>(AUDIT_TYPES);
  const types = new Set<AuditType>(
    asked === undefined ? AUDIT_TYPES : AUDIT_TYPES.filter((t) => (asked as string[]).includes(t) && known.has(t)),
  );
  const findings = await auditScreen(types);
  let sources: ElementSource[] = [];
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const fibers = findings.flatMap((f) => (f.entry !== null ? [f.entry.node.fiber] : []));
    try {
      sources = fibers.length > 0 ? await sourcesOf(fibers) : [];
    } catch {
      sources = []; // Metro unreachable: the report still stands, without lines
    }
  }
  let next = 0;
  const issues: AuditIssue[] = [];
  for (const finding of findings) {
    const source = finding.entry !== null ? sources[next++] : undefined;
    let element: TaplineElement | null = null;
    if (finding.entry !== null) {
      try {
        element = (await elementFor(finding.entry, finding.frame)).element;
      } catch {
        element = null; // the finding still says where it is, below
      }
    }
    const where = element === null ? whereOf(finding) : null;
    const location = source?.location ?? null;
    issues.push({
      type: finding.type,
      element,
      ...(where !== null ? { where } : {}),
      problem: finding.problem,
      fix: finding.fix,
      ...(location !== null ? { at: { file: location.file, line: location.line, direct: location.direct } } : {}),
    });
  }
  return { issues, checked: [...types] };
}

export interface UxIssue {
  kind: UxKind;
  element: TaplineElement | null;
  where?: AuditWhere;
  problem: string;
  basis: string;
  at?: { file: string; line: number; direct: boolean };
}

/** `ux_check {wayBack?, earlier?}` (AGENT-TOOLS 1.12 §17.3): the screen against the usability basics. */
export async function uxCheck(
  rawParams: unknown,
): Promise<{ issues: UxIssue[]; checked: UxCheckName[]; choices: number; actions: UxAction[] }> {
  const params = paramsOf(rawParams);
  if (params.wayBack !== undefined && typeof params.wayBack !== 'boolean') throw badParams('wayBack must be true or false');
  const earlierRaw = params.earlier;
  let earlier: UxAction[] | undefined;
  if (earlierRaw !== undefined && earlierRaw !== null) {
    if (!Array.isArray(earlierRaw)) throw badParams('earlier must be a list of {label, id?}');
    earlier = [];
    for (const item of earlierRaw as unknown[]) {
      if (!isRecord(item) || typeof item.label !== 'string') throw badParams('earlier must be a list of {label, id?}');
      earlier.push({ label: item.label, ...(typeof item.id === 'string' && item.id !== '' ? { id: item.id } : {}) });
    }
  }
  const result = await uxScreen({
    ...(params.wayBack === true ? { wayBack: true } : {}),
    ...(earlier !== undefined ? { earlier } : {}),
  });
  let sources: ElementSource[] = [];
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const fibers = result.findings.flatMap((f) => (f.entry !== null ? [f.entry.node.fiber] : []));
    try {
      sources = fibers.length > 0 ? await sourcesOf(fibers) : [];
    } catch {
      sources = []; // Metro unreachable: the report still stands, without lines
    }
  }
  let next = 0;
  const issues: UxIssue[] = [];
  for (const finding of result.findings) {
    const source = finding.entry !== null ? sources[next++] : undefined;
    let element: TaplineElement | null = null;
    if (finding.entry !== null) {
      try {
        element = (await elementFor(finding.entry, finding.frame)).element;
      } catch {
        element = null;
      }
    }
    const where =
      element === null && finding.entry !== null
        ? whereOf({ type: 'description', entry: finding.entry, frame: finding.frame, problem: '', fix: '' })
        : null;
    const location = source?.location ?? null;
    issues.push({
      kind: finding.kind,
      element,
      ...(where !== null ? { where } : {}),
      problem: finding.problem,
      basis: finding.basis,
      ...(location !== null ? { at: { file: location.file, line: location.line, direct: location.direct } } : {}),
    });
  }
  return { issues, checked: result.checked, choices: result.choices, actions: result.actions };
}

export async function getLogs(rawParams: unknown): Promise<{ entries: LogEntry[] }> {
  const params = paramsOf(rawParams);
  if (params.since !== undefined && typeof params.since !== 'number') throw badParams('since must be a number');
  return { entries: getLogEntries(typeof params.since === 'number' ? params.since : undefined) };
}

export async function reload(): Promise<Record<string, never>> {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    throw new TaplineError('unsupported', 'reload is only available in development builds');
  }
  // Reply first: the reload tears the socket down.
  setTimeout(() => {
    try {
      // An Expo app reloads through Expo (what `reloadAppAsync` from 'expo' calls): in Expo Go,
      // DevSettings.reload() starts the bundle without Expo's native modules and it fails to load.
      const expo = (globalThis as { expo?: unknown }).expo;
      const expoReload = isRecord(expo) ? expo.reloadAppAsync : undefined;
      if (typeof expoReload === 'function') {
        void Promise.resolve(expoReload.call(expo, 'Tapline: the agent asked for a reload')).catch(() => DevSettings.reload());
        return;
      }
      DevSettings.reload();
    } catch {
      // nothing to do
    }
  }, 100);
  return {};
}

interface ViewShotModule {
  captureScreen: (options: {
    format: 'jpg' | 'png';
    quality: number;
    result: 'base64';
    width?: number;
    height?: number;
  }) => Promise<string>;
}

function loadViewShot(): ViewShotModule | null {
  try {
    const loaded = require('react-native-view-shot');
    const candidate = isRecord(loaded) && isRecord(loaded.default) && loaded.default.captureScreen ? loaded.default : loaded;
    if (isRecord(candidate) && typeof candidate.captureScreen === 'function') {
      return candidate as unknown as ViewShotModule;
    }
  } catch {
    // not installed
  }
  return null;
}

export function screenshotAvailable(): boolean {
  return (Platform.OS === 'ios' && nativeModule() !== null) || loadViewShot() !== null;
}

export async function screenshot(
  rawParams: unknown,
): Promise<{ mime: string; data: string; width: number; height: number }> {
  const params = paramsOf(rawParams);
  const format = params.format === 'png' ? 'png' : 'jpg';
  const quality = typeof params.quality === 'number' && params.quality > 0 && params.quality <= 1 ? params.quality : 0.7;
  const maxWidth = typeof params.maxWidth === 'number' && params.maxWidth > 0 ? Math.round(params.maxWidth) : 600;
  // `fresh: false` (the live viewer's frames) draws what is on screen without making iOS render a
  // new frame; only Tapline's native module can do that.
  const fresh = params.fresh !== false;

  const screen = getScreen();
  const nativeWidth = Math.round(screen.width * screen.scale);
  // The live viewer sizes frames by the screen's short side, so a turned phone keeps the preset's
  // sharpness in px per point (in landscape the width is the long side); a screenshot keeps its width.
  const shortSide = Math.min(screen.width, screen.height);
  const target = params.fitShortSide === true && shortSide > 0 ? Math.round((maxWidth * screen.width) / shortSide) : maxWidth;
  const width = Math.min(target, nativeWidth);
  const height = Math.round((width * screen.height) / screen.width);
  const native = Platform.OS === 'ios' && format === 'jpg' ? nativeModule() : null;
  if (native !== null) {
    try {
      const data = await native.capture(width, quality, fresh);
      if (data !== '') return { mime: 'image/jpeg', data, width, height };
    } catch {
      // fall back to view-shot below
    }
  }
  const viewShot = loadViewShot();
  if (!viewShot) {
    throw new TaplineError('unsupported', 'Screenshots need react-native-view-shot in the app (npx expo install react-native-view-shot).');
  }
  // iOS renders view-shot's size at the screen scale (400 gives 1200 px on a 3x phone); Android takes pixels.
  const perUnit = Platform.OS === 'ios' && screen.scale > 0 ? screen.scale : 1;
  let data: string;
  try {
    data = await viewShot.captureScreen({ format, quality, result: 'base64', width: width / perUnit, height: height / perUnit });
  } catch (error) {
    throw new TaplineError('internal', `captureScreen failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { mime: format === 'png' ? 'image/png' : 'image/jpeg', data, width, height };
}

/* -------------------------------------------------------------------------- */
/* swipe                                                                        */
/* -------------------------------------------------------------------------- */

/** One finger's record in React Native's touch history (what PanResponder computes gestures from). */
interface TouchRecord {
  touchActive: boolean;
  startPageX: number;
  startPageY: number;
  startTimeStamp: number;
  currentPageX: number;
  currentPageY: number;
  currentTimeStamp: number;
  previousPageX: number;
  previousPageY: number;
  previousTimeStamp: number;
}

interface TouchHistory {
  touchBank: TouchRecord[];
  numberActiveTouches: number;
  indexOfSingleActiveTouch: number;
  mostRecentTimeStamp: number;
}

/** A swipe's moves come about this often, as a finger's do on a 60 Hz screen. */
const SWIPE_STEP_MS = 16;
const SWIPE_DEFAULT_SECONDS = 0.35;
const HOST_COMPONENT_TAG = 5;

/** The host components from `fiber` up to the root, deepest first: where responder handlers live. */
function hostChain(fiber: Fiber): Fiber[] {
  const chain: Fiber[] = [];
  for (let current: Fiber | null = fiber; current; current = current.return) {
    if (current.tag === HOST_COMPONENT_TAG) chain.push(current);
  }
  return chain;
}

function callResponder(fiber: Fiber, name: string, event: unknown): unknown {
  const props = isRecord(fiber.memoizedProps) ? fiber.memoizedProps : {};
  const handler = props[name];
  if (typeof handler !== 'function') return undefined;
  return (handler as (event: unknown) => unknown)(event);
}

/**
 * React Native's negotiation for who handles a touch: the capture phase from the root down, then
 * the bubble phase from the deepest view up; the first view whose handler answers true wins.
 */
function negotiate(chain: Fiber[], capture: string, bubble: string, event: unknown, skip?: Fiber): Fiber | undefined {
  for (const fiber of [...chain].reverse()) {
    if (fiber !== skip && callResponder(fiber, capture, event) === true) return fiber;
  }
  for (const fiber of chain) {
    if (fiber !== skip && callResponder(fiber, bubble, event) === true) return fiber;
  }
  return undefined;
}

function touchEvent(history: TouchHistory, x: number, y: number, at: number, target: Fiber, active: boolean): Record<string, unknown> {
  const tag = nativeTagOf(target);
  const touch = { identifier: 0, pageX: x, pageY: y, locationX: x, locationY: y, timestamp: at, target: tag };
  return {
    nativeEvent: { ...touch, touches: active ? [touch] : [], changedTouches: [touch] },
    touchHistory: history,
    target: tag,
    currentTarget: tag,
    timeStamp: at,
    persist: () => undefined,
    isPersistent: () => true,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
  };
}

function callProp(fiber: Fiber, name: string): unknown {
  return isRecord(fiber.memoizedProps) ? fiber.memoizedProps[name] : undefined;
}

/** A Modal's own window, which takes any touch nobody inside it takes (so it doesn't fall through). */
function isModalHost(fiber: Fiber): boolean {
  return typeof fiber.type === 'string' && /ModalHostView/.test(fiber.type);
}

function isScrollHost(fiber: Fiber): boolean {
  return typeof fiber.type === 'string' && /ScrollView|RCTScroll/.test(fiber.type);
}

/**
 * `swipe`: a finger dragged from (x0, y0) to (x1, y1) over `seconds`, through React Native's own
 * touch system: the views under the start point negotiate for it as they would for a finger
 * (PanResponder, a sheet's swipe to close, a Pressable that gives way once the finger moves), and
 * the winner gets the moves and the release with a real touch history. Gestures that
 * react-native-gesture-handler or a native view handle (sliders, maps) don't go through it: they
 * answer `no_action`, as does a start on a scroll view (`scroll` moves those).
 */
export async function swipe(
  rawParams: unknown,
): Promise<{ element: TaplineElement | null; from: { x: number; y: number }; to: { x: number; y: number }; dryRun?: true } & SettleOutcome> {
  const params = paramsOf(rawParams);
  const numbers = [params.x0, params.y0, params.x1, params.y1];
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw badParams('swipe needs x0, y0, x1 and y1 in points');
  }
  const [x0, y0, x1, y1] = numbers as [number, number, number, number];
  const seconds = typeof params.seconds === 'number' && params.seconds > 0 ? Math.min(params.seconds, 5) : SWIPE_DEFAULT_SECONDS;
  const snapshot = takeSnapshot();
  const screen = snapshot.screen;
  if ([x0, x1].some((x) => x < 0 || x > screen.width) || [y0, y1].some((y) => y < 0 || y > screen.height)) {
    throw badParams(`swipe points must be on the screen (0 to ${screen.width} across, 0 to ${screen.height} down)`);
  }
  assertNoBlockingAlert();

  // What lies under the start point: the hit test, else the frontmost element whose frame holds it.
  let start: Fiber | null | undefined = await hitTest(x0, y0);
  if (!start) {
    const frames = await Promise.all(snapshot.entries.map((entry) => measureFiber(entry.node.fiber)));
    snapshot.entries.forEach((entry, i) => {
      const frame = frames[i];
      if (frame && frameContains(frame, x0, y0)) start = entry.node.fiber;
    });
  }
  if (!start) throw notActionable('no_action', `Nothing at (${x0}, ${y0}) to swipe on.`);
  const origin: Fiber = start;
  const chain = hostChain(origin);
  if (params.dryRun === true) {
    // Who would take the drag is only known by asking the views, which can act on it: a dry run names what lies under the start.
    const under = snapshot.entries.filter((entry) => chain.some((fiber) => sameFiber(fiber, entry.node.fiber))).pop();
    const element = under ? (await elementFor(under)).element : null;
    return { element, from: { x: x0, y: y0 }, to: { x: x1, y: y1 }, dryRun: true, settledMs: 0 };
  }

  const begin = Date.now();
  const record: TouchRecord = {
    touchActive: true,
    startPageX: x0,
    startPageY: y0,
    startTimeStamp: begin,
    currentPageX: x0,
    currentPageY: y0,
    currentTimeStamp: begin,
    previousPageX: x0,
    previousPageY: y0,
    previousTimeStamp: begin,
  };
  const history: TouchHistory = { touchBank: [record], numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: begin };
  const advance = (x: number, y: number, at: number): void => {
    record.previousPageX = record.currentPageX;
    record.previousPageY = record.currentPageY;
    record.previousTimeStamp = record.currentTimeStamp;
    record.currentPageX = x;
    record.currentPageY = y;
    record.currentTimeStamp = at;
    history.mostRecentTimeStamp = at;
  };

  // A native scroll view takes a drag along its axis on the native side, unless a view inside it claims
  // the moves first (a swipeable row): then the swipe is the scroll view's, and `scroll` moves it.
  const scrollHost = chain.find(isScrollHost);
  const alongScroll = scrollHost !== undefined && (callProp(scrollHost, 'horizontal') === true ? Math.abs(x1 - x0) > Math.abs(y1 - y0) : Math.abs(y1 - y0) >= Math.abs(x1 - x0));
  let claimedOnMove: Fiber | undefined;
  let responder = negotiate(chain, 'onStartShouldSetResponderCapture', 'onStartShouldSetResponder', touchEvent(history, x0, y0, begin, origin, true));
  if (responder) callResponder(responder, 'onResponderGrant', touchEvent(history, x0, y0, begin, origin, true));

  const steps = Math.max(3, Math.min(120, Math.round((seconds * 1000) / SWIPE_STEP_MS)));
  for (let i = 1; i <= steps; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, SWIPE_STEP_MS));
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    const at = Math.max(Date.now(), history.mostRecentTimeStamp + 1);
    advance(x, y, at);
    const event = touchEvent(history, x, y, at, origin, true);
    // A view may take the touch over once the finger moves (a sheet's pan over a button inside it).
    const taker = negotiate(responder ? hostChain(responder) : chain, 'onMoveShouldSetResponderCapture', 'onMoveShouldSetResponder', event, responder);
    if (taker) {
      const yields = responder === undefined || callResponder(responder, 'onResponderTerminationRequest', event) !== false;
      if (yields) {
        if (responder) callResponder(responder, 'onResponderTerminate', event);
        responder = taker;
        claimedOnMove = taker;
        callResponder(responder, 'onResponderGrant', event);
      } else {
        callResponder(taker, 'onResponderReject', event);
      }
    }
    if (responder) callResponder(responder, 'onResponderMove', event);
  }
  const end = Math.max(Date.now(), history.mostRecentTimeStamp + 1);
  advance(x1, y1, end);
  record.touchActive = false;
  history.numberActiveTouches = 0;
  const finalEvent = touchEvent(history, x1, y1, end, origin, false);
  const scrollTakesIt =
    alongScroll && scrollHost !== undefined && !(claimedOnMove !== undefined && claimedOnMove !== scrollHost && isWithin(claimedOnMove, scrollHost));
  if (!responder || isScrollHost(responder) || isModalHost(responder) || scrollTakesIt) {
    if (responder) callResponder(responder, 'onResponderTerminate', finalEvent);
    const why =
      responder && isModalHost(responder) && !scrollTakesIt
        ? "only the open sheet's own window took it, so nothing in the sheet handles a swipe (a sheet that closes by a swipe claims the touch when it starts)"
        : responder || scrollTakesIt
          ? 'it starts on a scroll view, which moves natively: use scroll'
          : "nothing there takes a swipe through React Native's touch system";
    throw notActionable(
      'no_action',
      `Nothing took the swipe from (${x0}, ${y0}): ${why}. Gestures that react-native-gesture-handler or a native view handle (sliders, maps) can't be made from inside the app; Tapwright's swipe makes real ones.`,
    );
  }
  callResponder(responder, 'onResponderRelease', finalEvent);

  const owner = [...snapshot.entries].reverse().find((entry) => entry.info.interesting && isWithin(responder as Fiber, entry.node.fiber));
  const element = owner ? (await elementFor(owner)).element : null;
  return { element, from: { x: x0, y: y0 }, to: { x: x1, y: y1 }, ...(await settleOutcome()) };
}
