import { DevSettings, Linking, Platform, TextInput } from 'react-native';
import {
  currentInputValue,
  findHandler,
  findProp,
  frameContains,
  getScreen,
  hitTest,
  isInputNode,
  isWithin,
  isOnScreen,
  measureFiber,
  nativeTabBar,
  openModalHosts,
  publicInstancesOf,
  refFor,
  tabAt,
  rememberTyped,
  fiberForRef,
  takeSnapshot,
  toElement,
  currentRoute,
  type Entry,
  type Snapshot,
  type TabFound,
} from './inspect';
import { openAlerts } from './alerts';
import { firstHostChild, hostChildren, sameFiber, type Fiber } from './fiber';
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

/** Waits until the app is still after an action; resolves with the milliseconds that took. */
export function settle(): Promise<number> {
  for (const listener of [...actedListeners]) {
    try {
      listener();
    } catch {
      // a listener must never break the action
    }
  }
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

async function settleNow(): Promise<number> {
  const started = Date.now();
  await waitUntilStill({
    ...settings,
    onCommit: (listener) => onCommit(() => listener()),
    now: Date.now,
  });
  const left = settings.capMs - (Date.now() - started);
  if (left > 0) {
    // A sheet lifted by a native-driver animation makes no commits: wait for it to stop moving.
    const probe = await sheetProbe().catch(() => null);
    if (probe) await waitUntilSteady(() => measureFiber(probe), { pollMs: SHEET_POLL_MS, capMs: left, now: Date.now });
  }
  return Math.max(0, Math.min(settings.capMs, Date.now() - started));
}

function badParams(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

function paramsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw badParams('params must be an object');
  return raw;
}

/**
 * The shared role vocabulary (AGENT-TOOLS §3.3). A copy of `roleOf` in packages/host/src/format.ts:
 * keep the two tables in step; the packages must not import each other.
 */
const ROLE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['textfield', 'input'],
  ['search', 'input'],
  ['textbox', 'input'],
  ['scrollview', 'scroll'],
  ['imagebutton', 'button'],
  ['togglebutton', 'button'],
  ['adjustable', 'slider'],
  ['img', 'image'],
  ['summary', 'text'],
]);

/** Component types that read as a shared role when the app gives none (copy of `TYPE_ROLES` in the host's format.ts). */
const TYPE_ROLES: ReadonlyMap<string, string> = new Map([
  ['Image', 'image'],
  ['TextInput', 'input'],
  ['Switch', 'switch'],
  ['Text', 'text'],
  ['ScrollView', 'scroll'],
  ['FlatList', 'scroll'],
  ['SectionList', 'scroll'],
  ['VirtualizedList', 'scroll'],
]);

function roleName(info: Entry['info']): string {
  if (info.role !== null && info.role !== '') {
    const lower = info.role.toLowerCase();
    return ROLE_ALIASES.get(lower) ?? lower;
  }
  const byType = TYPE_ROLES.get(info.type);
  if (byType !== undefined) return byType;
  const pressable = info.type === 'Pressable' || info.type === 'Button' || info.type.startsWith('Touchable');
  return pressable && info.actions.includes('press') ? 'button' : 'other';
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
    kinds.push(withIndex({ kind: key, value }));
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
    const list = shown.map((entry) => describe(entry)).join('; ');
    throw new TaplineError(
      'ambiguous',
      `${matches.length} elements match ${describeTarget(target)}: ${list}. Use a ref or "index".`,
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

/**
 * Refuses what a person couldn't tap: an element off screen, or one with something else on top
 * at the centre of its visible part (Fabric's hit test). Unknown hit results let it through.
 */
async function assertReachable(snapshot: Snapshot, actor: Entry, frame: Frame | null): Promise<void> {
  // An OS alert sits on top of everything: a person has to answer it first.
  const blocking = openAlerts().find((alert) => !alert.standIn);
  if (blocking) {
    const buttons = blocking.buttons.map((button) => `[${button.text}]`).join(' ');
    throw notActionable(
      'behind_alert',
      `An alert is open: "${blocking.title}" ${buttons}. A person would have to answer it first, and Tapline can't press OS alerts: ` +
        "ask the user to tap a button, or start Tapline with alerts: 'stand-in' so its buttons can be pressed. force: true acts anyway.",
    );
  }
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
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);
  const bar = nativeTabBar(snapshot);
  if (bar && y >= bar.top) {
    throw notActionable(
      'under_tab_bar',
      `${name} is under the tab bar iOS draws, at (${x}, ${y}): a real tap would switch tabs instead. ` +
        'Scroll it up first, or pass force: true to call its handler anyway.',
    );
  }
  const hit = await hitTest(x, y);
  if (!hit) return;
  if (isWithin(hit, actor.node.fiber) || isWithin(actor.node.fiber, hit)) return;
  throw notActionable(
    'covered',
    `${name} is covered at (${x}, ${y}) by ${describeHit(snapshot, hit, actor)}: a real tap would land there instead. ` +
      'Dismiss or scroll it out of the way, or pass force: true to call the handler anyway.',
  );
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

/** `back`: what the back button or gesture does, on the focused screen. */
export async function back(rawParams: unknown): Promise<{ route: string[]; settledMs: number }> {
  paramsOf(rawParams);
  const snapshot = takeSnapshot();
  const current = currentRoute(snapshot.routes);
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
  const settledMs = await settle();
  return { route: current.chain, settledMs };
}

async function pressLike(
  kind: 'press' | 'longPress',
  rawParams: unknown,
): Promise<{ element: TaplineElement; settledMs: number }> {
  const params = paramsOf(rawParams);
  const { snapshot, entry } = await resolveTarget(params.target, kind);
  if (entry.tab) {
    if (kind === 'longPress') throw notActionable('no_action', `The "${entry.tab.title}" tab has no long press`);
    selectTab(snapshot, entry.tab);
    return { element: toElement(entry, null), settledMs: await settle() };
  }
  const actor = findActionable(snapshot, entry, kind, false);
  const handlerName = kind === 'press' ? 'onPress' : 'onLongPress';
  const actionName = kind === 'press' ? 'tap' : 'long-press';
  if (!actor) {
    throw notActionable('no_action', `${describe(entry)} has no ${actionName} action`);
  }
  if (actor.info.disabled || entry.info.disabled) {
    throw notActionable('disabled', `${describe(actor)} is disabled`);
  }
  const handler = findHandler(actor.node, handlerName);
  if (!handler) {
    throw notActionable('no_action', `${describe(actor)} has no ${actionName} action`);
  }
  const { element, frame } = await elementFor(actor);
  if (params.force !== true) await assertReachable(snapshot, actor, frame);
  callHandler(handlerName, handler, [pressEvent(actor.node.fiber, frame)]);
  return { element, settledMs: await settle() };
}

export function press(params: unknown): Promise<{ element: TaplineElement; settledMs: number }> {
  return pressLike('press', params);
}

export function longPress(params: unknown): Promise<{ element: TaplineElement; settledMs: number }> {
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
  const focused = focusedInputInstance();
  const focusedEntry = inputs.find((entry) => ownsInstance(entry, focused));
  if (focusedEntry) return { snapshot: snap, entry: focusedEntry };
  const [only, ...rest] = inputs;
  if (only && rest.length === 0) return { snapshot: snap, entry: only };
  const shown = inputs.slice(0, 5);
  throw new TaplineError(
    'ambiguous',
    `${inputs.length} inputs on screen; pass a target to pick one, and none is focused:`,
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
): Promise<{ element: TaplineElement; value: string; settledMs: number }> {
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

  const settledMs = await settle();
  const { element } = await elementFor(entry);
  return { element: { ...element, value: next }, value: next, settledMs };
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
): Promise<{ element: TaplineElement; offset: { x: number; y: number }; moved: boolean; settledMs: number }> {
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

  const settledMs = await settle();
  // Report where the content really is, not where we asked it to go.
  const after = await measureScrollState(entry);
  if (after) offset = after.offset;
  const moved = !known && !after ? true : Math.abs(offset.x - current.x) >= 1 || Math.abs(offset.y - current.y) >= 1;
  if (key) rememberedOffsets.set(key, offset);
  const { element } = await elementFor(entry, frame);
  return { element, offset, moved, settledMs };
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
): Promise<{ element: TaplineElement; value: boolean; settledMs: number }> {
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
  callHandler('onValueChange', handler, [next]);
  const settledMs = await settle();
  const { element } = await elementFor(control);
  return { element: { ...element, checked: next }, value: next, settledMs };
}

/* -------------------------------------------------------------------------- */
/* openURL / logs / reload / screenshot                                        */
/* -------------------------------------------------------------------------- */

const OPEN_URL_TIMEOUT_MS = 5000;

export async function openURL(rawParams: unknown): Promise<{ settledMs: number }> {
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
  return { settledMs: await settle() };
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
    data = await viewShot.captureScreen({ format, quality, result: 'base64', width: width / perUnit, height: height / perUnit });
  } catch (error) {
    throw new TaplineError('internal', `captureScreen failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { mime: format === 'png' ? 'image/png' : 'image/jpeg', data, width, height };
}
