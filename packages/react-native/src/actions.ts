import { DevSettings, Keyboard, Linking, Platform, TextInput } from 'react-native';
import {
  closingModalHosts,
  currentInputValue,
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
import { openAlerts } from './alerts';
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

function notActionable(reason: NotActionable, message: string): TaplineError {
  return new TaplineError('not_actionable', `${reason}: ${message}`);
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
function describe(entry: Entry, maxText = 80): string {
  const { info } = entry;
  const flat = (info.text !== '' ? info.text : (info.label ?? '')).replace(/\s+/g, ' ').trim();
  const shown = flat.length > maxText ? `${flat.slice(0, maxText - 1)}…` : flat;
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

function matchEntries(snapshot: Snapshot, target: ParsedTarget): Entry[] {
  const pool = snapshot.entries.filter((entry) => entry.info.interesting);
  switch (target.kind) {
    case 'testID':
      return dedupe(snapshot, pool.filter((e) => e.info.testID === target.value), 'outer');
    case 'label': {
      const wanted = target.value.trim().toLowerCase();
      return dedupe(
        snapshot,
        pool.filter((e) => e.info.label !== null && e.info.label.toLowerCase() === wanted),
        'outer',
      );
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
  const flat = (info.text !== '' ? info.text : (info.label ?? '')).replace(/\s+/g, ' ').trim();
  const shown = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
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
  assertNoOsAlert();
  const front = snapshot.entries.find(
    (entry) => entry.info.interesting && !entry.tab && (entry.info.text.trim() !== '' || entry.info.testID),
  );
  const [hiddenFrame, frontFrame] = await Promise.all([
    measureFiber(hidden.node.fiber),
    front ? measureFiber(front.node.fiber) : Promise.resolve(null),
  ]);
  const inFront = front ? elementLine(front, frontFrame, true) : 'the open sheet';
  throw notActionable('covered', `${elementLine(hidden, hiddenFrame, false)} is behind ${inFront}; close that first.`);
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

  const matches = matchEntries(snapshot, target);
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
  if (!only) throw new TaplineError('not_found', notFoundMessage(target));
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

/** An OS alert sits on top of everything: a person has to answer it first. */
function assertNoOsAlert(): void {
  const blocking = openAlerts().find((alert) => !alert.standIn);
  if (blocking) {
    const buttons = blocking.buttons.map((button) => `[${button.text}]`).join(' ');
    throw notActionable(
      'behind_alert',
      `An alert is open: "${blocking.title}" ${buttons}. A person would have to answer it first, and Tapline can't press OS alerts: ` +
        "ask the user to tap a button, or start Tapline with alerts: 'stand-in' so its buttons can be pressed. force: true acts anyway.",
    );
  }
}

/**
 * Refuses what a person couldn't tap: an element off screen, or one with something else on top
 * at the centre of its visible part (Fabric's hit test). Unknown hit results let it through.
 */
async function assertReachable(snapshot: Snapshot, actor: Entry, frame: Frame | null): Promise<void> {
  assertNoOsAlert();
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
        'Scroll to it first, or pass force: true to call its handler anyway.',
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
          'Scroll it up first, or pass force: true to call its handler anyway.',
      );
    }
    if (underNavBar(y)) {
      return notActionable(
        'covered',
        `${name} is under the navigation bar iOS draws, at (${x}, ${y}): a real tap would hit the bar instead. ` +
          'Scroll it down first, or pass force: true to call its handler anyway.',
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
export async function back(rawParams: unknown): Promise<{ route: string[]; closed?: 'sheet' } & SettleOutcome> {
  paramsOf(rawParams);
  const snapshot = takeSnapshot();
  const current = currentRoute(snapshot.routes);
  // An open sheet is what back closes first (AGENT-TOOLS v1.4): the top Modal's own onRequestClose,
  // which is what the system back gesture or a swipe down calls. One already on its way out is left alone.
  const sheet = openModalHosts().filter((host) => !closingModalHosts().includes(host)).pop();
  if (sheet) {
    const onRequestClose = requestCloseOf(sheet);
    if (!onRequestClose) {
      throw notActionable(
        'no_action',
        'the open sheet has nothing for back to call (its Modal has no onRequestClose); tap its close control.',
      );
    }
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
  callHandler('goBack', nav.goBack as (...args: unknown[]) => unknown, []);
  return { route: current.chain, ...(await settleOutcome()) };
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
function focusInput(entry: Entry, frame: Frame | null): void {
  const instances = [...publicInstancesOf(entry.node.fiber), ...entry.node.owners.map((owner) => owner.stateNode)];
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
    selectTab(snapshot, entry.tab);
    return { element: toElement(entry, null), ...keyboardNote(closeKeyboardFor(entry)), ...(await settleOutcome()) };
  }
  if (entry.navBack) {
    const { route: _route, ...outcome } = await back({});
    return { element: toElement(entry, null), ...outcome };
  }
  const actor = findActionable(snapshot, entry, kind, false);
  const handlerName = kind === 'press' ? 'onPress' : 'onLongPress';
  const actionName = kind === 'press' ? 'tap' : 'long-press';
  if (!actor) {
    if (entry.info.disabled) throw notActionable('disabled', `${describe(entry)} is disabled`);
    throw notActionable('no_action', `${describe(entry)} has no ${actionName} action`);
  }
  if (actor.info.disabled || entry.info.disabled) {
    throw notActionable('disabled', `${describe(actor)} is disabled`);
  }
  // A finger on an input focuses it (AGENT-TOOLS v1.3): an input never answers no_action to a tap.
  const focusing = kind === 'press' && actor.info.actions.includes('type');
  const handler = focusing ? null : findHandler(actor.node, handlerName);
  if (!handler && !focusing) {
    throw notActionable('no_action', `${describe(actor)} has no ${actionName} action`);
  }
  const { element, frame } = await elementFor(actor);
  if (params.force !== true) await assertReachable(snapshot, actor, frame);
  const closedKeyboard = closeKeyboardFor(actor);
  if (handler) callHandler(handlerName, handler, [pressEvent(actor.node.fiber, frame)]);
  else {
    // A finger focuses the input and also fires the input's own onPress (not an ancestor's: the
    // input takes the touch).
    focusInput(actor, frame);
    const own = appHandler(actor, 'onPress');
    if (own) callHandler('onPress', own, [pressEvent(actor.node.fiber, frame)]);
  }
  return { element, ...keyboardNote(closedKeyboard), ...(await settleOutcome()) };
}

/** What `press` and `longPress` answer: the element, and `closedKeyboard: true` when the keyboard was closed first. */
export type PressResult = { element: TaplineElement; closedKeyboard?: true } & SettleOutcome;

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
}

const defaultKeyboard: KeyboardControl = {
  focusedInput: focusedInputInstance,
  visible: () => {
    try {
      const { isVisible } = Keyboard as unknown as { isVisible?: () => boolean };
      return typeof isVisible === 'function' ? isVisible.call(Keyboard) !== false : true;
    } catch {
      return true;
    }
  },
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
): Promise<{ element: TaplineElement; value: string; closedKeyboard?: true } & SettleOutcome> {
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

  const { entry } = await resolveInput(null, params.target);
  if (entry.info.disabled) throw notActionable('disabled', `${describe(entry)} is not editable`);
  // Typing into the input that has focus leaves the keyboard alone; another input closes it first.
  const closedKeyboard = closeKeyboardFor(entry);

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
  return { element: { ...element, value: displayText(next) }, value: displayText(next), ...keyboardNote(closedKeyboard), ...outcome };
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

export async function scroll(
  rawParams: unknown,
): Promise<{ element: TaplineElement; offset: { x: number; y: number }; moved: boolean } & SettleOutcome> {
  const params = paramsOf(rawParams);
  const to = params.to;
  if (to !== undefined && to !== 'start' && to !== 'end') throw badParams('to must be "start" or "end"');
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
async function measureScrollState(entry: Entry): Promise<ScrollState | null> {
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
): Promise<{ element: TaplineElement; value: boolean; closedKeyboard?: true } & SettleOutcome> {
  const params = paramsOf(rawParams);
  if (params.value !== undefined && typeof params.value !== 'boolean') throw badParams('value must be a boolean');
  const { snapshot, entry } = await resolveTarget(params.target, 'toggle');
  const control = findActionable(snapshot, entry, 'toggle', true);
  if (!control) throw notActionable('no_action', `${describe(entry)} is not a switch`);
  if (control.info.disabled) throw notActionable('disabled', `${describe(control)} is disabled`);
  const handler = findHandler(control.node, 'onValueChange');
  if (!handler) throw notActionable('no_action', `${describe(control)} is not a switch`);
  const current = control.info.checked === true;
  const next = typeof params.value === 'boolean' ? params.value : !current;
  if (params.force !== true) await assertReachable(snapshot, control, await measureFiber(control.node.fiber));
  const closedKeyboard = closeKeyboardFor(control);
  callHandler('onValueChange', handler, [next]);
  const outcome = await settleOutcome();
  const { element } = await elementFor(control);
  return { element: { ...element, checked: next }, value: next, ...keyboardNote(closedKeyboard), ...outcome };
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
    /** iOS: draw the layers inside the app instead of asking the system for the screen's picture. */
    useRenderInContext?: boolean;
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
  return loadViewShot() !== null;
}

export async function screenshot(
  rawParams: unknown,
): Promise<{ mime: string; data: string; width: number; height: number }> {
  const params = paramsOf(rawParams);
  const format = params.format === 'png' ? 'png' : 'jpg';
  const quality = typeof params.quality === 'number' && params.quality > 0 && params.quality <= 1 ? params.quality : 0.7;
  const maxWidth = typeof params.maxWidth === 'number' && params.maxWidth > 0 ? Math.round(params.maxWidth) : 600;

  const viewShot = loadViewShot();
  if (!viewShot) {
    throw new TaplineError('unsupported', 'Screenshots need react-native-view-shot in the app (npx expo install react-native-view-shot).');
  }
  const screen = getScreen();
  const nativeWidth = Math.round(screen.width * screen.scale);
  const width = Math.min(maxWidth, nativeWidth);
  const height = Math.round((width * screen.height) / screen.width);
  // iOS renders view-shot's size at the screen scale (400 gives 1200 px on a 3x phone); Android takes pixels.
  const perUnit = Platform.OS === 'ios' && screen.scale > 0 ? screen.scale : 1;
  let data: string;
  try {
    data = await viewShot.captureScreen({
      format,
      quality,
      result: 'base64',
      width: width / perUnit,
      height: height / perUnit,
      // `render: "layers"` (the live feed's experiment): cheaper for the phone, but blurs and system-drawn
      // glass don't show.
      ...(params.render === 'layers' ? { useRenderInContext: true } : {}),
    });
  } catch (error) {
    throw new TaplineError('internal', `captureScreen failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { mime: format === 'png' ? 'image/png' : 'image/jpeg', data, width, height };
}
