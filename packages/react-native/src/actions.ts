import { DevSettings, Linking, TextInput } from 'react-native';
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
  publicInstancesOf,
  refFor,
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
import { sameFiber, type Fiber } from './fiber';
import { getLogEntries } from './logs';
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

const settings = { settleMs: 30 };

/** Tune how long to wait after an action so React can flush resulting renders. */
export function configureActions(next: { settleMs?: number }): void {
  if (typeof next.settleMs === 'number') settings.settleMs = next.settleMs;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, settings.settleMs));
}

function badParams(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

function paramsOf(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw badParams('params must be an object');
  return raw;
}

function describe(entry: Entry): string {
  const { info } = entry;
  const name = info.testID ?? info.label ?? (info.text ? `"${info.text}"` : null);
  return name ? `${info.type} ${name}` : info.type;
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
        const aActs = a.info.actions.length > 0;
        const bActs = b.info.actions.length > 0;
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
    default:
      return `${target.kind} "${target.value}"`;
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

/** Resolve a protocol target to exactly one element, or throw not_found / ambiguous. */
export async function resolveTarget(raw: unknown): Promise<Resolved> {
  const target = parseTarget(raw);
  const snapshot = takeSnapshot();

  if (target.kind === 'ref') {
    const fiber = fiberForRef(target.ref);
    const entry = fiber ? snapshot.entries.find((e) => sameFiber(e.node.fiber, fiber)) : undefined;
    if (!entry) {
      throw new TaplineError(
        'not_found',
        `Element ${target.ref} is not on screen (refs last until the next tree call); call tree again.`,
      );
    }
    return { snapshot, entry };
  }

  if (target.kind === 'point') {
    const actionable = snapshot.entries.filter((e) => e.info.actions.length > 0);
    const frames = await Promise.all(actionable.map((e) => measureFiber(e.node.fiber)));
    let hit: Entry | undefined;
    actionable.forEach((entry, i) => {
      const frame = frames[i];
      if (frame && frameContains(frame, target.x, target.y)) hit = entry; // later in tree order = in front
    });
    if (!hit) {
      throw new TaplineError('not_found', `No actionable element at (${target.x}, ${target.y})`);
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
  if (!only) throw new TaplineError('not_found', `No element matches ${describeTarget(target)}`);
  if (rest.length > 0) {
    const shown = matches.slice(0, 5);
    const refs = shown.map((entry) => refFor(entry.node.fiber));
    const list = shown.map((entry, i) => `${refs[i]} ${describe(entry)}`).join('; ');
    throw new TaplineError(
      'ambiguous',
      `${matches.length} elements match ${describeTarget(target)}: ${list}. Use a ref or "index".`,
      refs,
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
function describeHit(snapshot: Snapshot, hit: Fiber): string {
  for (let fiber: Fiber | null = hit; fiber; fiber = fiber.return) {
    const entry = snapshot.entries.find((candidate) => candidate.info.interesting && sameFiber(candidate.node.fiber, fiber));
    if (entry) {
      const named = describe(entry);
      const text = entry.info.text.length > 40 ? `${entry.info.text.slice(0, 40)}…` : entry.info.text;
      return `${refFor(entry.node.fiber)} ${named}${text && !named.includes(text) ? ` "${text}"` : ''}`;
    }
  }
  return typeof hit.type === 'string' ? `a ${hit.type}` : 'another view';
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
    throw new TaplineError(
      'not_actionable',
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
  const name = `${refFor(actor.node.fiber)} ${describe(actor)}`;
  if (right <= left || bottom <= top) {
    throw new TaplineError(
      'not_actionable',
      `${name} is off screen (at ${Math.round(frame.x)},${Math.round(frame.y)}; the screen is ${width}x${height}). ` +
        'Scroll to it first, or pass force: true to call its handler anyway.',
    );
  }
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);
  const hit = await hitTest(x, y);
  if (!hit) return;
  if (isWithin(hit, actor.node.fiber) || isWithin(actor.node.fiber, hit)) return;
  throw new TaplineError(
    'not_actionable',
    `${name} is covered at (${x}, ${y}) by ${describeHit(snapshot, hit)}: a real tap would land there instead. ` +
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
export async function back(rawParams: unknown): Promise<{ route: string[] }> {
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
    throw new TaplineError('not_actionable', `Nothing to go back to from ${current.chain.join(' › ')}.`);
  }
  callHandler('goBack', nav.goBack as (...args: unknown[]) => unknown, []);
  await settle();
  return { route: current.chain };
}

async function pressLike(kind: 'press' | 'longPress', rawParams: unknown): Promise<{ element: TaplineElement }> {
  const params = paramsOf(rawParams);
  const { snapshot, entry } = await resolveTarget(params.target);
  if (entry.tab) {
    if (kind === 'longPress') throw new TaplineError('not_actionable', `The "${entry.tab.title}" tab has no long press`);
    selectTab(snapshot, entry.tab);
    await settle();
    return { element: toElement(entry, null) };
  }
  const actor = findActionable(snapshot, entry, kind, false);
  const handlerName = kind === 'press' ? 'onPress' : 'onLongPress';
  if (!actor) {
    throw new TaplineError('not_actionable', `${describe(entry)} has no ${handlerName} handler`);
  }
  if (actor.info.disabled || entry.info.disabled) {
    throw new TaplineError('not_actionable', `${describe(actor)} is disabled`);
  }
  const handler = findHandler(actor.node, handlerName);
  if (!handler) {
    throw new TaplineError('not_actionable', `${describe(actor)} has no ${handlerName} handler`);
  }
  const { element, frame } = await elementFor(actor);
  if (params.force !== true) await assertReachable(snapshot, actor, frame);
  callHandler(handlerName, handler, [pressEvent(actor.node.fiber, frame)]);
  await settle();
  return { element };
}

export function press(params: unknown): Promise<{ element: TaplineElement }> {
  return pressLike('press', params);
}

export function longPress(params: unknown): Promise<{ element: TaplineElement }> {
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
    const { snapshot: snap, entry } = await resolveTarget(rawTarget);
    const input = findActionable(snap, entry, 'type', true);
    if (!input) throw new TaplineError('not_actionable', `${describe(entry)} is not a text input`);
    return { snapshot: snap, entry: input };
  }
  const snap = snapshot ?? takeSnapshot();
  const inputs = snap.entries.filter((entry) => isInputNode(entry.node));
  if (inputs.length === 0) throw new TaplineError('not_found', 'No TextInput on screen');
  const focused = focusedInputInstance();
  const focusedEntry = inputs.find((entry) => ownsInstance(entry, focused));
  if (focusedEntry) return { snapshot: snap, entry: focusedEntry };
  const [only, ...rest] = inputs;
  if (only && rest.length === 0) return { snapshot: snap, entry: only };
  const shown = inputs.slice(0, 5);
  const refs = shown.map((entry) => refFor(entry.node.fiber));
  throw new TaplineError(
    'ambiguous',
    `${inputs.length} TextInputs on screen and none is focused: ${shown
      .map((entry, i) => `${refs[i]} ${describe(entry)}`)
      .join('; ')}. Pass a target.`,
    refs,
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
): Promise<{ element: TaplineElement; value: string }> {
  const params = paramsOf(rawParams);
  const submit = params.submit === true;
  if (params.text !== undefined && typeof params.text !== 'string') throw badParams('text must be a string');
  if (params.text === undefined && !submit) throw badParams('text is required (or pass submit: true)');
  const replace = params.replace !== false;

  const { entry } = await resolveInput(null, params.target);
  if (entry.info.disabled) throw new TaplineError('not_actionable', `${describe(entry)} is not editable`);

  const previous = currentInputValue(entry.node);
  const typed = typeof params.text === 'string' ? params.text : undefined;
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

  await settle();
  const { element } = await elementFor(entry);
  return { element: { ...element, value: next }, value: next };
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
): Promise<{ element: TaplineElement; offset: { x: number; y: number } }> {
  const params = paramsOf(rawParams);
  const to = params.to;
  if (to !== undefined && to !== 'start' && to !== 'end') throw badParams('to must be "start" or "end"');
  const direction: Direction = params.direction === undefined ? 'down' : (params.direction as Direction);
  if (!DIRECTIONS.includes(direction)) throw badParams('direction must be down, up, left or right');
  if (params.amount !== undefined && (typeof params.amount !== 'number' || !(params.amount > 0))) {
    throw badParams('amount must be a positive number of points');
  }

  let entry: Entry;
  let frame: Frame | null = null;
  if (params.target !== undefined && params.target !== null) {
    const resolved = await resolveTarget(params.target);
    const scroller = findActionable(resolved.snapshot, resolved.entry, 'scroll', true);
    if (!scroller) throw new TaplineError('not_actionable', `${describe(resolved.entry)} is not inside a scroll view`);
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
  const current = metrics
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
    if (metrics && metrics.contentLength !== null && metrics.visibleLength !== null) {
      const max = Math.max(0, metrics.contentLength - metrics.visibleLength);
      offset = horizontal ? { x: max, y: 0 } : { x: 0, y: max };
    }
  } else {
    const visible = metrics?.visibleLength ?? (horizontal ? frame?.width : frame?.height) ?? getScreen().height;
    const amount = typeof params.amount === 'number' ? params.amount : Math.round(visible * 0.8);
    const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    let x = Math.max(0, current.x + dx);
    let y = Math.max(0, current.y + dy);
    if (metrics && metrics.contentLength !== null && metrics.visibleLength !== null) {
      const max = Math.max(0, metrics.contentLength - metrics.visibleLength);
      if (horizontal) x = Math.min(x, max);
      else y = Math.min(y, max);
    }
    offset = { x, y };
    if (scrollTo) scrollTo({ x, y, animated: false });
    else if (scrollToOffset) scrollToOffset({ offset: horizontal ? x : y, animated: false });
    else throw new TaplineError('unsupported', 'This scroll view exposes no scrollTo');
  }

  if (key) rememberedOffsets.set(key, offset);
  await settle();
  const { element } = await elementFor(entry, frame);
  return { element, offset };
}

/* -------------------------------------------------------------------------- */
/* toggle                                                                      */
/* -------------------------------------------------------------------------- */

export async function toggle(rawParams: unknown): Promise<{ element: TaplineElement; value: boolean }> {
  const params = paramsOf(rawParams);
  if (params.value !== undefined && typeof params.value !== 'boolean') throw badParams('value must be a boolean');
  const { snapshot, entry } = await resolveTarget(params.target);
  const control = findActionable(snapshot, entry, 'toggle', true);
  if (!control) throw new TaplineError('not_actionable', `${describe(entry)} is not a toggle`);
  if (control.info.disabled) throw new TaplineError('not_actionable', `${describe(control)} is disabled`);
  const handler = findHandler(control.node, 'onValueChange');
  if (!handler) throw new TaplineError('not_actionable', `${describe(control)} has no onValueChange handler`);
  const current = control.info.checked === true;
  const next = typeof params.value === 'boolean' ? params.value : !current;
  if (params.force !== true) await assertReachable(snapshot, control, await measureFiber(control.node.fiber));
  callHandler('onValueChange', handler, [next]);
  await settle();
  const { element } = await elementFor(control);
  return { element: { ...element, checked: next }, value: next };
}

/* -------------------------------------------------------------------------- */
/* openURL / logs / reload / screenshot                                        */
/* -------------------------------------------------------------------------- */

const OPEN_URL_TIMEOUT_MS = 5000;

export async function openURL(rawParams: unknown): Promise<Record<string, never>> {
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
  return {};
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
  let data: string;
  try {
    data = await viewShot.captureScreen({ format, quality, result: 'base64', width, height });
  } catch (error) {
    throw new TaplineError('internal', `captureScreen failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { mime: format === 'png' ? 'image/png' : 'image/jpeg', data, width, height };
}
