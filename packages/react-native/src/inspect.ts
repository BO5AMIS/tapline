import { Dimensions, PixelRatio, Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import {
  HostComponent,
  HostText,
  fiberName,
  isCompositeTag,
  propsOf,
  sameFiber,
  type Fiber,
  type FiberRootLike,
} from './fiber';
import { openAlerts } from './alerts';
import { keyboardState } from './keyboard';
import { refreshCover } from './native';
import { inFlight } from './network';
import { commitRevision, getRoots } from './register';
import {
  TaplineError,
  isRecord,
  type Action,
  type Frame,
  type ScreenInfo,
  type TaplineElement,
  type TreeResult,
  type ChangedFields,
  type TreeChanges,
} from './types';

/* -------------------------------------------------------------------------- */
/* Host-node collection                                                        */
/* -------------------------------------------------------------------------- */

const TEXT_HOSTS = new Set(['Text', 'RCTText', 'RCTVirtualText', 'AndroidTextView', 'ReactTextView']);

/** How much of an element's text a line shows (AGENT-TOOLS v1.5); a cut ends with `…(+N)`, the count left out. */
export const MAX_TEXT = 200;

/**
 * How much text a container keeps for matching, and how much of any text goes over the wire. A Text
 * host keeps all of its own text, so `wait_for` and `{text}` targets check all of it.
 */
export const MAX_KEPT_TEXT = 2000;

/** The first `max` UTF-16 units of a text, one fewer when that would cut a character (an emoji) in half. */
export function sliceWhole(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Text as a line quotes it: whitespace flattened, cut at `max` with `…(+N)` (N counts `more` too: what was cut off before). */
export function cutText(raw: string, more = 0, max = MAX_TEXT): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  const shown = flat.length > max ? sliceWhole(flat, max) : flat;
  const missing = flat.length - shown.length + more;
  return missing > 0 ? `${shown}…(+${missing})` : shown;
}

/** One host component (View, Text, TextInput, ...) in the current fiber tree. */
export interface HostNode {
  /** Position in document order. */
  index: number;
  /** Index of the nearest host ancestor, -1 for top-level. */
  parent: number;
  fiber: Fiber;
  hostType: string;
  /** Composite fibers between this host and the previous host, innermost first. */
  owners: Fiber[];
  /** Descendant text, whitespace-collapsed and trimmed: all of it for a Text host, at most MAX_KEPT_TEXT chars otherwise. */
  text: string;
  isText: boolean;
  insideText: boolean;
}

/** Invisible direction marks (AGENT-TOOLS v1.3): U+200E, U+200F, U+202A–U+202E, U+2066–U+2069. */
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** Text as an agent sees and matches it: without the invisible direction marks. */
export function displayText(raw: string): string {
  return raw.replace(DIRECTION_MARKS, '');
}

function normalizeText(raw: string, whole: boolean): string {
  const collapsed = displayText(raw).replace(/\s+/g, ' ').trim();
  return !whole && collapsed.length > MAX_KEPT_TEXT ? collapsed.slice(0, MAX_KEPT_TEXT) : collapsed;
}

/** React Native Screens' tab screens (native tabs: iOS, Android, and the older bottom-tabs name). */
const TAB_SCREEN = /^RNS(Tabs|BottomTabs)Screen/;

function displaysNone(style: unknown): boolean {
  try {
    const flat: unknown = StyleSheet.flatten(style as StyleProp<ViewStyle>);
    return isRecord(flat) && flat.display === 'none';
  } catch {
    return false;
  }
}

/**
 * Whether a host element and everything inside it is out of the user's reach, so Tapline leaves
 * it out: hidden from accessibility (React Native Screens marks a screen covered by another this
 * way, React Navigation its unfocused screens), not displayed, an inactive screen, or a tab that
 * isn't selected (native tabs keep every tab mounted and turn off touches on the hidden ones).
 */
export function hidesSubtree(hostType: string, props: Record<string, unknown>): boolean {
  if (props['aria-hidden'] === true) return true;
  if (props.accessibilityElementsHidden === true) return true;
  if (props.importantForAccessibility === 'no-hide-descendants') return true;
  if (props.style !== undefined && displaysNone(props.style)) return true;
  if (hostType === 'RNSScreen' && props.activityState === 0) return true;
  if (TAB_SCREEN.test(hostType) && (props.pointerEvents === 'none' || props.isFocused === false)) return true;
  return false;
}

/** React Native Screens' native tab containers. */
const TAB_HOST = /^RNS(Tabs|BottomTabs)Host/;

/** The navigation object React Navigation hands each screen (only what Tapline calls). */
export interface NavigationLike {
  isFocused?: () => boolean;
  canGoBack?: () => boolean;
  goBack?: () => void;
  navigate?: (name: string) => void;
  getState?: () => unknown;
}

/** A visible screen component that received React Navigation's `route` and `navigation` props. */
export interface RouteFound {
  key: string;
  name: string;
  params: unknown;
  navigation: NavigationLike;
  focused: boolean;
  /** Route names from the outermost navigator to this one. */
  chain: string[];
}

/** One tab of a native tab bar (drawn by the OS, so not in the host tree as a button). */
export interface TabFound {
  fiber: Fiber;
  title: string;
  screenKey: string | null;
  selected: boolean;
}

interface Collected {
  nodes: HostNode[];
  routes: RouteFound[];
  tabs: TabFound[];
  /** Open modals' host fibers (not inside a hidden subtree), in tree order. */
  modals: Fiber[];
  /** Set while a modal is open: the topmost modal's host, and the whole tree walked with it (the screen behind included). */
  behind?: { sheet: Fiber; nodes: HostNode[] };
}

function routeOf(fiber: Fiber, chain: RouteFound[]): RouteFound | null {
  const props = propsOf(fiber);
  const route = props.route;
  const nav = props.navigation;
  if (!isRecord(route) || !isRecord(nav)) return null;
  if (typeof route.key !== 'string' || typeof route.name !== 'string' || typeof nav.goBack !== 'function') return null;
  if (chain.length > 0 && chain[chain.length - 1]?.key === route.key) return null; // the same screen, passed on
  const navigation = nav as NavigationLike;
  let focused = true;
  try {
    // The navigator's state decides when it lists this route: the route is focused when it is the
    // current one. isFocused() alone isn't enough: a JavaScript tab bar passes every tab's route
    // to its buttons with the navigator's own navigation, which is focused for all of them.
    const state = typeof navigation.getState === 'function' ? navigation.getState() : undefined;
    const routes = isRecord(state) && Array.isArray(state.routes) ? state.routes : [];
    const at = routes.findIndex((r) => isRecord(r) && r.key === route.key);
    if (at >= 0 && isRecord(state) && typeof state.index === 'number') focused = at === state.index;
    else if (typeof navigation.isFocused === 'function') focused = navigation.isFocused() !== false;
  } catch {
    focused = true;
  }
  return {
    key: route.key,
    name: route.name,
    params: route.params,
    navigation,
    focused,
    chain: [...chain.map((r) => r.name), route.name],
  };
}

/** The tab screens under a native tab container, hidden ones included. */
function collectTabs(first: Fiber | null, tabs: TabFound[]): void {
  for (let fiber = first; fiber; fiber = fiber.sibling) {
    const hostType = fiber.tag === HostComponent && typeof fiber.type === 'string' ? fiber.type : '';
    if (TAB_SCREEN.test(hostType)) {
      const props = propsOf(fiber);
      const screenKey = typeof props.screenKey === 'string' ? props.screenKey : null;
      const fromKey = screenKey !== null && screenKey.includes('-') ? screenKey.slice(0, screenKey.lastIndexOf('-')) : screenKey;
      const title = typeof props.title === 'string' && props.title !== '' ? props.title : (fromKey ?? 'Tab');
      tabs.push({ fiber, title, screenKey, selected: !hidesSubtree(hostType, props) });
    } else {
      collectTabs(fiber.child, tabs);
    }
  }
}

function walk(
  first: Fiber | null,
  parent: number,
  owners: Fiber[],
  insideText: boolean,
  out: Collected,
  chain: RouteFound[],
): string[] {
  const segments: string[] = [];
  for (let fiber = first; fiber; fiber = fiber.sibling) {
    if (fiber.tag === HostText) {
      const value = fiber.memoizedProps;
      if (typeof value === 'string' && value !== '') segments.push(value);
    } else if (fiber.tag === HostComponent) {
      const hostType = typeof fiber.type === 'string' ? fiber.type : '';
      if (TAB_HOST.test(hostType)) collectTabs(fiber.child, out.tabs);
      if (hidesSubtree(hostType, propsOf(fiber))) continue;
      if (MODAL_HOSTS.has(hostType)) out.modals.push(fiber);
      const isText = TEXT_HOSTS.has(hostType);
      const node: HostNode = {
        index: out.nodes.length,
        parent,
        fiber,
        hostType,
        owners: owners.slice().reverse(),
        text: '',
        isText,
        insideText,
      };
      out.nodes.push(node);
      const inner = walk(fiber.child, node.index, [], insideText || isText, out, chain);
      node.text = normalizeText(isText ? inner.join('') : inner.join(' '), isText);
      if (isText) segments.push(inner.join(''));
      else for (const piece of inner) segments.push(piece);
    } else if (isCompositeTag(fiber.tag)) {
      const route = routeOf(fiber, chain);
      if (route) out.routes.push(route);
      const inner = walk(fiber.child, parent, [...owners, fiber], insideText, out, route ? [...chain, route] : chain);
      for (const piece of inner) segments.push(piece);
    } else {
      const inner = walk(fiber.child, parent, owners, insideText, out, chain);
      for (const piece of inner) segments.push(piece);
    }
  }
  return segments;
}

function collect(roots: FiberRootLike[]): Collected {
  const out: Collected = { nodes: [], routes: [], tabs: [], modals: [] };
  for (const root of roots) walk(root.current.child, -1, [], false, out, []);
  // iOS hides what is behind a modal from accessibility, so a person (and Tapwright, which reads
  // that tree) sees only the topmost modal: list only that, no screen behind it and no tab bar.
  const top = out.modals[out.modals.length - 1];
  if (!top) return out;
  const only: Collected = { nodes: [], routes: [], tabs: [], modals: [] };
  walk(top.child, -1, [], false, only, []);
  return { nodes: only.nodes, routes: out.routes, tabs: [], modals: out.modals, behind: { sheet: top, nodes: out.nodes } };
}

export function collectNodes(roots: FiberRootLike[] = getRoots()): HostNode[] {
  return collect(roots).nodes;
}

/** The focused screen: the deepest focused route, the last one on ties (drawn on top). */
export function currentRoute(routes: RouteFound[]): RouteFound | null {
  let best: RouteFound | null = null;
  for (const route of routes) {
    if (!route.focused) continue;
    if (best === null || route.chain.length >= best.chain.length) best = route;
  }
  return best;
}

/** Route params that read well in a line: top-level strings (cut to 80), numbers, booleans, null. */
function simpleParams(params: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(params)) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') out[key] = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* -------------------------------------------------------------------------- */
/* Props lookup and element description                                        */
/* -------------------------------------------------------------------------- */

/** First defined prop `key` on the host fiber, then on its owners (innermost first). */
export function findProp(node: HostNode, key: string): unknown {
  const own = propsOf(node.fiber)[key];
  if (own !== undefined) return own;
  for (const owner of node.owners) {
    const value = propsOf(owner)[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function findHandler(node: HostNode, key: string): ((...args: unknown[]) => unknown) | null {
  const value = findProp(node, key);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

function stateField(node: HostNode, field: string): unknown {
  const state = findProp(node, 'accessibilityState');
  return isRecord(state) ? state[field] : undefined;
}

const PRIMARY_TYPES = new Set([
  'Pressable',
  'Button',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'TouchableNativeFeedback',
  'Switch',
  'TextInput',
  'ScrollView',
  'FlatList',
  'SectionList',
  'VirtualizedList',
  'Text',
  'Image',
  'ImageBackground',
  'Modal',
  'ActivityIndicator',
  'SafeAreaView',
  'KeyboardAvoidingView',
  'RefreshControl',
]);

function isPlumbing(name: string): boolean {
  return (
    PRIMARY_TYPES.has(name) ||
    name === 'View' ||
    name.startsWith('Animated') ||
    name.startsWith('Virtualized') ||
    name.endsWith('CellRenderer') ||
    name.startsWith('ScrollView') ||
    name.startsWith('InternalTextInput') ||
    name.startsWith('RCT') ||
    name.startsWith('Android') ||
    name.startsWith('Context') ||
    name === 'TextAncestor'
  );
}

function ownerNames(node: HostNode): string[] {
  const names: string[] = [];
  for (const owner of node.owners) {
    const name = fiberName(owner);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Nearest named component that owns the element. React Native's own primitives
 * wrap each other (Pressable -> View), so within the leading run of RN
 * plumbing we report the outermost primary primitive (Pressable, Button, ...).
 */
function typeName(node: HostNode): string {
  let primary: string | null = null;
  let firstNamed: string | null = null;
  for (const owner of node.owners) {
    const name = fiberName(owner);
    if (!name) continue;
    if (firstNamed === null) firstNamed = name;
    if (!isPlumbing(name)) break;
    if (PRIMARY_TYPES.has(name)) primary = name;
  }
  return primary ?? firstNamed ?? (node.isText ? 'Text' : node.hostType || 'View');
}

const SCROLL_NAMES = new Set(['ScrollView', 'FlatList', 'SectionList', 'VirtualizedList']);

export function isScrollNode(node: HostNode): boolean {
  return /ScrollView/.test(node.hostType) || ownerNames(node).some((name) => SCROLL_NAMES.has(name));
}

export function isInputNode(node: HostNode): boolean {
  return /TextInput/.test(node.hostType) || ownerNames(node).includes('TextInput');
}

export function isSwitchNode(node: HostNode): boolean {
  return /Switch/.test(node.hostType) || ownerNames(node).includes('Switch');
}

/** Last text set through Tapline for uncontrolled inputs, keyed by the host stateNode. */
const typedValues = new WeakMap<object, string>();

export function rememberTyped(node: HostNode, text: string): void {
  const key = node.fiber.stateNode;
  if (typeof key === 'object' && key !== null) typedValues.set(key, text);
}

export function currentInputValue(node: HostNode): string {
  const controlled = findProp(node, 'value');
  if (typeof controlled === 'string') return controlled;
  const key = node.fiber.stateNode;
  if (typeof key === 'object' && key !== null) {
    const typed = typedValues.get(key);
    if (typed !== undefined) return typed;
  }
  const initial = findProp(node, 'defaultValue');
  return typeof initial === 'string' ? initial : '';
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
  ['Slider', 'slider'],
  ['RNCSlider', 'slider'],
  ['Text', 'text'],
  ['ScrollView', 'scroll'],
  ['FlatList', 'scroll'],
  ['SectionList', 'scroll'],
  ['VirtualizedList', 'scroll'],
]);

export function roleName(info: Pick<Entry['info'], 'role' | 'type' | 'actions'>): string {
  if (info.role !== null && info.role !== '') {
    const lower = info.role.toLowerCase();
    return ROLE_ALIASES.get(lower) ?? lower;
  }
  const byType = TYPE_ROLES.get(info.type);
  if (byType !== undefined) return byType;
  const pressable = info.type === 'Pressable' || info.type === 'Button' || info.type.startsWith('Touchable');
  return pressable && info.actions.includes('press') ? 'button' : 'other';
}

export interface NodeInfo {
  type: string;
  role: string | null;
  testID: string | null;
  label: string | null;
  text: string;
  value: string | null;
  /** An empty input's placeholder, else null. */
  placeholder: string | null;
  actions: Action[];
  disabled: boolean;
  selected: boolean;
  checked: boolean | 'mixed' | null;
  /** Shown in `tree` without `all`. */
  interesting: boolean;
}

function stringProp(node: HostNode, key: string): string | null {
  const value = findProp(node, key);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Handlers shared with a descendant host belong to the descendant, not to this wrapper. And a
 * testID a wrapper only inherits (from the component that rendered it, through `findProp`'s owners)
 * belongs to a descendant host that sets the same testID itself: a field component that passes its
 * testID on to its TextInput would otherwise name two elements. A host that sets its testID itself
 * (a button) keeps it.
 */
/** A host that takes a press, long press or toggle (its own or its component's handler), or is an input. */
function actsItself(node: HostNode): boolean {
  return (
    isInputNode(node) ||
    ['onPress', 'onLongPress', 'onValueChange'].some((key) => typeof findProp(node, key) === 'function')
  );
}

function suppressedHandlers(nodes: HostNode[]): Set<string> {
  const suppressed = new Set<string>();
  for (const node of nodes) {
    for (const key of ['onPress', 'onLongPress', 'onValueChange']) {
      const handler = findProp(node, key);
      if (typeof handler !== 'function') continue;
      for (let p = node.parent; p >= 0; ) {
        const ancestor = nodes[p];
        if (!ancestor) break;
        if (findProp(ancestor, key) === handler) suppressed.add(`${ancestor.index}:${key}`);
        p = ancestor.parent;
      }
    }
    const own = propsOf(node.fiber).testID;
    if (typeof own === 'string' && own !== '') {
      // a wrapper above that only inherits this host's testID and takes no action of its own (a
      // field's label-and-input box); a wrapper that acts (a tab item) keeps it, as it's what lists
      for (let p = node.parent; p >= 0; ) {
        const ancestor = nodes[p];
        if (!ancestor) break;
        if (propsOf(ancestor.fiber).testID === undefined && findProp(ancestor, 'testID') === own && !actsItself(ancestor)) {
          suppressed.add(`${ancestor.index}:testID`);
        }
        p = ancestor.parent;
      }
      continue;
    }
    // this host only inherits a testID that a host above sets itself (a button's label inside it)
    const inherited = findProp(node, 'testID');
    if (typeof inherited !== 'string' || inherited === '') continue;
    for (let p = node.parent; p >= 0; ) {
      const ancestor = nodes[p];
      if (!ancestor) break;
      if (propsOf(ancestor.fiber).testID === inherited) {
        suppressed.add(`${node.index}:testID`);
        break;
      }
      p = ancestor.parent;
    }
  }
  return suppressed;
}

export function describeNodes(nodes: HostNode[]): NodeInfo[] {
  const suppressed = suppressedHandlers(nodes);
  const infos: NodeInfo[] = [];
  for (const node of nodes) {
    const input = isInputNode(node);
    const toggleable = isSwitchNode(node);
    const actions: Action[] = [];
    const has = (key: string): boolean =>
      typeof findProp(node, key) === 'function' && !suppressed.has(`${node.index}:${key}`);
    // An input always takes a tap (focus) and then typing (AGENT-TOOLS v1.3): `tap, type`.
    if (has('onPress') || input) actions.push('press');
    if (has('onLongPress')) actions.push('longPress');
    if (input) actions.push('type', 'submit');
    if (toggleable && has('onValueChange')) actions.push('toggle');
    if (isScrollNode(node)) actions.push('scroll');

    const testID = suppressed.has(`${node.index}:testID`) ? null : stringProp(node, 'testID');
    const rawLabel = stringProp(node, 'accessibilityLabel') ?? stringProp(node, 'aria-label');
    const strippedLabel = rawLabel === null ? null : displayText(rawLabel);
    const label = strippedLabel === '' ? null : strippedLabel;

    const disabled =
      findProp(node, 'disabled') === true ||
      stateField(node, 'disabled') === true ||
      findProp(node, 'aria-disabled') === true ||
      (input && findProp(node, 'editable') === false);

    const selected =
      findProp(node, 'selected') === true ||
      stateField(node, 'selected') === true ||
      findProp(node, 'aria-selected') === true;

    let checked: boolean | 'mixed' | null = null;
    const stateChecked = stateField(node, 'checked');
    const ariaChecked = findProp(node, 'aria-checked');
    if (typeof stateChecked === 'boolean' || stateChecked === 'mixed') checked = stateChecked;
    else if (typeof ariaChecked === 'boolean' || ariaChecked === 'mixed') checked = ariaChecked;
    else if (toggleable && typeof findProp(node, 'value') === 'boolean') {
      checked = findProp(node, 'value') === true;
    }

    const explicitRole = stringProp(node, 'role') ?? stringProp(node, 'accessibilityRole');
    let role = explicitRole;
    if (role === null) {
      if (toggleable) role = 'switch';
      else if (input) role = 'textfield';
      else if (actions.includes('press')) role = 'button';
      else if (isScrollNode(node)) role = 'scrollview';
      else if (node.isText) role = 'text';
    }

    let redundantText = false;
    if (node.isText && actions.length === 0 && testID === null && label === null) {
      for (let p = node.parent; p >= 0; ) {
        const ancestor = nodes[p];
        const info = infos[p];
        if (!ancestor || !info) break;
        if (info.actions.length > 0 && info.text === node.text) {
          redundantText = true;
          break;
        }
        p = ancestor.parent;
      }
    }

    // Own text only (AGENT-TOOLS §3.3): an accessible element (what VoiceOver reads as one item)
    // carries the text inside it, the way iOS forms its label; a plain container quotes nothing,
    // so it never matches a text target through its children's text.
    const accessible =
      node.isText || input || toggleable || actions.includes('press') || actions.includes('longPress') || findProp(node, 'accessible') === true;

    const hasContent = node.isText && !node.insideText && node.text !== '';
    const inputValue = input ? currentInputValue(node) : null;
    infos.push({
      type: typeName(node),
      role,
      testID,
      label,
      text: input || !accessible ? '' : node.text,
      value: inputValue,
      placeholder: inputValue === '' ? stringProp(node, 'placeholder') : null,
      actions,
      disabled,
      selected,
      checked,
      interesting:
        !redundantText && (actions.length > 0 || testID !== null || label !== null || hasContent),
    });
  }
  return infos;
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

export type Measurer = (fiber: Fiber) => Promise<Frame | null>;

const MEASURE_TIMEOUT_MS = 500;

type MeasureCallback = (x: number, y: number, width: number, height: number) => void;

interface Measurable {
  measureInWindow: (callback: MeasureCallback) => void;
}

interface FabricUIManagerLike {
  measureInWindow: (node: unknown, callback: MeasureCallback) => void;
}

function isMeasurable(value: unknown): value is Measurable {
  return isRecord(value) && typeof value.measureInWindow === 'function';
}

/**
 * Public instances of a host fiber, in preference order:
 *  - old architecture: `stateNode` itself
 *  - Fabric: `stateNode.canonical.publicInstance` (null until a ref was requested)
 */
export function publicInstancesOf(fiber: Fiber): unknown[] {
  const found: unknown[] = [];
  const state = fiber.stateNode;
  if (!isRecord(state)) return found;
  found.push(state);
  const canonical = state.canonical;
  if (isRecord(canonical)) {
    found.push(canonical);
    if (canonical.publicInstance != null) found.push(canonical.publicInstance);
  }
  if (state.publicInstance != null) found.push(state.publicInstance);
  return found;
}

function fabricUIManager(): FabricUIManagerLike | null {
  const manager = (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
  return isRecord(manager) && typeof manager.measureInWindow === 'function'
    ? (manager as unknown as FabricUIManagerLike)
    : null;
}

export const defaultMeasurer: Measurer = (fiber) =>
  new Promise<Frame | null>((resolve) => {
    let settled = false;
    const finish = (frame: Frame | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(frame);
    };
    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);
    const callback: MeasureCallback = (x, y, width, height) => {
      if ([x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        finish({ x, y, width, height });
      } else finish(null);
    };
    try {
      const target = publicInstancesOf(fiber).find(isMeasurable);
      if (target) {
        target.measureInWindow(callback);
        return;
      }
      // Fabric host without a public instance: ask the UIManager about the shadow node.
      const state = fiber.stateNode;
      const manager = fabricUIManager();
      if (manager && isRecord(state) && state.node != null) {
        manager.measureInWindow(state.node, callback);
        return;
      }
      finish(null);
    } catch {
      finish(null);
    }
  });

let measurer: Measurer = defaultMeasurer;

/** Inject a measuring function (tests); pass null to restore the default. */
export function setMeasurer(next: Measurer | null): void {
  measurer = next ?? defaultMeasurer;
}

export function measureFiber(fiber: Fiber): Promise<Frame | null> {
  return measurer(fiber).catch(() => null);
}

/* -------------------------------------------------------------------------- */
/* Hit testing (what a real touch would land on)                               */
/* -------------------------------------------------------------------------- */

/**
 * The host fiber a real touch at window point (x, y) would land on: null when nothing there
 * takes touches, undefined when this can't be told (old architecture, tests, a timeout).
 */
export type HitTester = (x: number, y: number) => Promise<Fiber | null | undefined>;

const HIT_TIMEOUT_MS = 300;

interface FabricHitManager {
  findNodeAtPoint: (node: unknown, x: number, y: number, callback: (handle: unknown) => void) => void;
}

function fabricHitManager(): FabricHitManager | null {
  const manager = (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager;
  return isRecord(manager) && typeof manager.findNodeAtPoint === 'function'
    ? (manager as unknown as FabricHitManager)
    : null;
}

/** The shadow node of a root's outermost host component (Fabric). */
function rootShadowNode(root: FiberRootLike): unknown {
  for (let fiber: Fiber | null = root.current.child; fiber; fiber = fiber.child) {
    if (fiber.tag === HostComponent) {
      const state = fiber.stateNode;
      return isRecord(state) && state.node != null ? state.node : undefined;
    }
  }
  return undefined;
}

function isFiberLike(value: unknown): value is Fiber {
  return isRecord(value) && typeof value.tag === 'number' && 'return' in value;
}

/** React Native's `Modal` host (its Fabric name, and the name the JS side renders). */
const MODAL_HOSTS = new Set(['RCTModalHostView', 'ModalHostView']);

function shadowNodeOf(fiber: Fiber): unknown {
  const state = fiber.stateNode;
  return isRecord(state) && state.node != null ? state.node : undefined;
}

/** The first host fiber among `first`, its siblings and their descendants (pre-order). */
function firstHostFiber(first: Fiber | null): Fiber | null {
  const stack: Fiber[] = first ? [first] : [];
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next.tag === HostComponent) return next;
    if (next.sibling) stack.push(next.sibling);
    if (next.child) stack.push(next.child);
  }
  return null;
}

/**
 * The host fibers of mounted `Modal`s, in tree order. A closed `Modal` renders nothing, but one
 * that is being dismissed stays mounted (with `visible` false) until iOS ends the animation; it
 * still covers the screen, so it is listed here too (see `closingModalHosts`).
 */
export function openModalHosts(): Fiber[] {
  const hosts: Fiber[] = [];
  for (const root of getRoots()) {
    const stack: Fiber[] = root.current.child ? [root.current.child] : [];
    for (let fiber = stack.pop(); fiber; fiber = stack.pop()) {
      if (fiber.tag === HostComponent && typeof fiber.type === 'string' && MODAL_HOSTS.has(fiber.type)) hosts.push(fiber);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  }
  return hosts;
}

/** The mounted modal hosts that are on their way out: `visible` is false while the dismiss animation runs. */
export function closingModalHosts(): Fiber[] {
  return openModalHosts().filter((host) => isRecord(host.memoizedProps) && host.memoizedProps.visible === false);
}

/** Whether a `Modal` is open: its window covers the whole app, the native tab bar included. */
export function modalOpen(): boolean {
  return openModalHosts().length > 0;
}

/**
 * The shadow nodes of open modals' content, the last presented first. A `Modal` is its own native
 * window over the app, but its content sits in the same React tree, under a host whose layout
 * the root's hit test never reaches: hit-testing from the root finds the screen behind it.
 */
function openModalContentNodes(): unknown[] {
  const nodes: unknown[] = [];
  for (const host of openModalHosts()) {
    const content = firstHostFiber(host.child);
    const node = content ? shadowNodeOf(content) : undefined;
    if (node !== undefined) nodes.push(node);
  }
  return nodes.reverse();
}

/**
 * Fabric's own hit test (`findNodeAtPoint`, as React Native's element inspector uses): open modals
 * first (a modal's window covers the whole screen, so a touch never reaches what's behind it),
 * then the roots, topmost first.
 */
export const defaultHitTester: HitTester = async (x, y) => {
  const manager = fabricHitManager();
  if (!manager) return undefined;
  const roots = getRoots().map(rootShadowNode).filter((node) => node !== undefined).reverse();
  const nodes = [...openModalContentNodes(), ...roots];
  if (nodes.length === 0) return undefined;
  for (const node of nodes) {
    const hit = await new Promise<Fiber | null | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), HIT_TIMEOUT_MS);
      try {
        manager.findNodeAtPoint(node, x, y, (handle) => {
          clearTimeout(timer);
          resolve(isFiberLike(handle) ? handle : null);
        });
      } catch {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    if (hit !== null) return hit;
  }
  return null;
};

let hitTester: HitTester = defaultHitTester;

/** Inject a hit tester (tests); pass null to restore the default. */
export function setHitTester(next: HitTester | null): void {
  hitTester = next ?? defaultHitTester;
}

export function hitTest(x: number, y: number): Promise<Fiber | null | undefined> {
  return hitTester(x, y).catch(() => undefined);
}

/** Whether `inner` is `outer` or inside it (following `return` links). */
export function isWithin(inner: Fiber, outer: Fiber): boolean {
  for (let fiber: Fiber | null = inner; fiber; fiber = fiber.return) {
    if (sameFiber(fiber, outer)) return true;
  }
  return false;
}

export function getScreen(): ScreenInfo {
  const { width, height } = Dimensions.get('window');
  return { width, height, scale: PixelRatio.get() };
}

export function isOnScreen(frame: Frame, screen: ScreenInfo): boolean {
  return (
    frame.width > 0 &&
    frame.height > 0 &&
    frame.x < screen.width &&
    frame.y < screen.height &&
    frame.x + frame.width > 0 &&
    frame.y + frame.height > 0
  );
}

export function frameContains(frame: Frame, x: number, y: number): boolean {
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

/* -------------------------------------------------------------------------- */
/* Snapshots and refs                                                          */
/* -------------------------------------------------------------------------- */

export interface Entry {
  node: HostNode;
  info: NodeInfo;
  /** Set for a tab of a native tab bar: pressing it switches tabs through navigation. */
  tab?: TabFound;
  /** Set for the back button of the native navigation bar: pressing it goes back. */
  navBack?: true;
}

export interface Snapshot {
  nodes: HostNode[];
  entries: Entry[];
  screen: ScreenInfo;
  /** Visible screens that got React Navigation's props, in tree order. */
  routes: RouteFound[];
  /**
   * Set while a modal (a sheet) is open: what the open sheet hides, worked out on first call. The
   * look leaves the screen behind a sheet out, so `entries` don't hold it; this does, with the
   * `nodes` they index into (the sheet's own elements are among them, in tree order).
   */
  behind?: () => BehindSheet;
}

/** The screen behind the topmost open modal, which the element list leaves out. */
export interface BehindSheet {
  /** The topmost modal's host fiber. */
  sheet: Fiber;
  /** Everything walked (behind and inside the sheet); `entries[i]` describes `nodes[i]`. */
  nodes: HostNode[];
  entries: Entry[];
  /** Only the elements outside the sheet: what it covers. */
  hidden: Entry[];
}

/**
 * A stand-in fiber per native tab, stable across snapshots so its ref keeps working; the real
 * tab screen fiber is its `return`. (The selected tab's real fiber is also a regular node.)
 */
const tabFibers = new WeakMap<object, Fiber>();

/**
 * An object that stays the same for a host element across re-renders: Fabric clones `stateNode`
 * on every update but keeps its `canonical`; elsewhere the stateNode, else the fiber itself.
 */
export function stableObjectKey(fiber: Fiber): object {
  const state = fiber.stateNode;
  if (isRecord(state)) return isRecord(state.canonical) ? state.canonical : state;
  return fiber;
}

function tabFiberFor(real: Fiber): Fiber {
  const key = stableObjectKey(real);
  const fake: Fiber = tabFibers.get(key) ?? {
    tag: -1,
    type: 'Tab',
    elementType: 'Tab',
    memoizedProps: {},
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
  };
  tabFibers.set(key, fake);
  fake.return = real;
  return fake;
}

/** Take a fresh view of the current fiber tree (no measuring). */
export function takeSnapshot(): Snapshot {
  const roots = getRoots();
  if (roots.length === 0) {
    throw new TaplineError(
      'internal',
      "No React roots recorded. Import 'react-native-tapline/register' first in the app's entry file, before React.",
    );
  }
  const { nodes, routes, tabs, behind } = collect(roots);
  const infos = describeNodes(nodes);
  const entries: Entry[] = [];
  nodes.forEach((node, i) => {
    const info = infos[i];
    if (info) entries.push({ node, info });
  });
  for (const tab of tabs) {
    const node: HostNode = {
      index: nodes.length,
      parent: -1,
      fiber: tabFiberFor(tab.fiber),
      hostType: 'Tab',
      owners: [],
      text: tab.title,
      isText: false,
      insideText: false,
    };
    nodes.push(node);
    entries.push({
      node,
      tab,
      info: {
        type: 'Tab',
        role: 'tab',
        testID: null,
        label: null,
        text: tab.title,
        value: null,
        placeholder: null,
        actions: ['press'],
        disabled: false,
        selected: tab.selected,
        checked: null,
        interesting: true,
      },
    });
  }
  const snapshot: Snapshot = { nodes, entries, screen: getScreen(), routes };
  if (behind) {
    let worked: BehindSheet | undefined;
    snapshot.behind = () => {
      if (worked) return worked;
      const all = describeNodes(behind.nodes);
      const hidden: Entry[] = [];
      const everything: Entry[] = [];
      behind.nodes.forEach((node, i) => {
        const info = all[i];
        if (!info) return;
        const entry: Entry = { node, info };
        everything.push(entry);
        if (!isWithin(node.fiber, behind.sheet)) hidden.push(entry);
      });
      worked = { sheet: behind.sheet, nodes: behind.nodes, entries: everything, hidden };
      return worked;
    };
  }
  return snapshot;
}

/** The height of iOS's tab bar on an iPhone in portrait, in points (the classic and iOS 26 bars). */
const TAB_BAR_HEIGHT = 49;

/** The home-indicator inset, from the app's safe-area library when it has one. */
function bottomInset(screen: ScreenInfo): number {
  try {
    const safeArea: unknown = require('react-native-safe-area-context');
    const metrics = isRecord(safeArea) ? safeArea.initialWindowMetrics : undefined;
    const insets = isRecord(metrics) ? metrics.insets : undefined;
    if (isRecord(insets) && typeof insets.bottom === 'number' && insets.bottom >= 0) return insets.bottom;
  } catch {
    // not installed
  }
  return screen.height >= 812 ? 34 : 0; // iPhones with Face ID have a home indicator
}

/** Where iOS draws the native tab bar: from `top` to the bottom of the screen, `tabs` spread evenly. */
export interface NativeTabBar {
  top: number;
  tabs: Entry[];
}

/**
 * The native tab bar, which iOS draws outside React's tree: on an iPhone in portrait, 49 points
 * above the home-indicator inset, its items spread evenly across the width (the classic and the
 * iOS 26 bars alike). Null without native tabs, on other platforms, in landscape, and while a
 * modal's window covers it.
 */
export function nativeTabBar(snapshot: Snapshot): NativeTabBar | null {
  const tabs = snapshot.entries.filter((entry) => entry.tab !== undefined);
  if (tabs.length === 0) return null;
  if (Platform.OS !== 'ios' || Platform.isPad) return null;
  const { width, height } = snapshot.screen;
  if (height <= width || modalOpen()) return null;
  return { top: height - bottomInset(snapshot.screen) - TAB_BAR_HEIGHT, tabs };
}

/** The tab under x on the bar. */
export function tabAt(bar: NativeTabBar, x: number, width: number): Entry | undefined {
  const index = Math.floor(x / (width / bar.tabs.length));
  return bar.tabs[Math.min(bar.tabs.length - 1, Math.max(0, index))];
}

/** The height of the navigation bar iOS draws under the status bar, and what a large title adds. */
const NAV_BAR_HEIGHT = 44;
const NAV_BAR_LARGE_TITLE = 52;

/** The status-bar (top safe-area) inset, from the app's safe-area library when it has one. */
function topInset(screen: ScreenInfo): number {
  try {
    const safeArea: unknown = require('react-native-safe-area-context');
    const metrics = isRecord(safeArea) ? safeArea.initialWindowMetrics : undefined;
    const insets = isRecord(metrics) ? metrics.insets : undefined;
    if (isRecord(insets) && typeof insets.top === 'number' && insets.top >= 0) return insets.top;
  } catch {
    // not installed
  }
  if (screen.height >= 852) return 59;
  return screen.height >= 812 ? 47 : 20;
}

/** Where iOS draws the native navigation bar: from the top of the screen to `bottom`. */
export interface NativeNavBar {
  top: 0;
  bottom: number;
  title?: string;
  canGoBack: boolean;
  /** The header config fiber; what is inside it is drawn in the bar and stays reachable. */
  header: Fiber;
}

function isHostType(fiber: Fiber, type: string): boolean {
  return fiber.tag === HostComponent && fiber.type === type;
}

/** The screens of a stack (nearest `RNSScreen`s, in order), looking through wrappers. */
function stackScreens(stack: Fiber): Fiber[] {
  const screens: Fiber[] = [];
  const pending: Fiber[] = stack.child ? [stack.child] : [];
  for (let fiber = pending.pop(); fiber; fiber = pending.pop()) {
    if (fiber.sibling) pending.push(fiber.sibling);
    if (isHostType(fiber, 'RNSScreen')) screens.push(fiber);
    else if (!isHostType(fiber, 'RNSScreenStack') && fiber.child) pending.push(fiber.child);
  }
  return screens;
}

/**
 * The native navigation bar react-native-screens draws for the visible screen, outside React's
 * layout. The visible header is the deepest `RNSScreenStackHeaderConfig` reached by walking each
 * root and, at an `RNSScreenStack`, descending only into its last (top) `RNSScreen`. Null without
 * one, with `hidden` set, on other platforms, in landscape, and while a modal's window covers it.
 */
export function nativeNavBar(snapshot: Snapshot): NativeNavBar | null {
  if (Platform.OS !== 'ios' || Platform.isPad) return null;
  const { width, height } = snapshot.screen;
  if (height <= width || modalOpen()) return null;
  interface Context {
    firstScreen: boolean;
  }
  let found: { header: Fiber; context: Context } | null = null;
  for (const root of getRoots()) {
    const todo: Array<{ fiber: Fiber; context: Context }> = root.current.child
      ? [{ fiber: root.current.child, context: { firstScreen: true } }]
      : [];
    for (let item = todo.pop(); item; item = todo.pop()) {
      const { fiber, context } = item;
      if (fiber.sibling) todo.push({ fiber: fiber.sibling, context });
      // The same rule `look` uses: unselected native tabs, inactive screens and hidden subtrees don't count.
      if (fiber.tag === HostComponent && typeof fiber.type === 'string' && hidesSubtree(fiber.type, propsOf(fiber))) continue;
      if (isHostType(fiber, 'RNSScreenStackHeaderConfig')) {
        const props = propsOf(fiber);
        if (props.hidden !== true) found = { header: fiber, context };
      }
      if (isHostType(fiber, 'RNSScreenStack')) {
        const screens = stackScreens(fiber);
        const top = screens[screens.length - 1];
        if (top?.child) todo.push({ fiber: top.child, context: { firstScreen: screens.length === 1 } });
        continue;
      }
      if (fiber.child) {
        todo.push({ fiber: fiber.child, context: isHostType(fiber, 'RNSScreen') ? { firstScreen: true } : context });
      }
    }
  }
  if (!found) return null;
  const props = propsOf(found.header);
  const bottom = topInset(snapshot.screen) + NAV_BAR_HEIGHT + (props.largeTitle === true ? NAV_BAR_LARGE_TITLE : 0);
  const bar: NativeNavBar = {
    top: 0,
    bottom,
    canGoBack: !found.context.firstScreen && props.hideBackButton !== true,
    header: found.header,
  };
  if (typeof props.title === 'string') bar.title = props.title;
  return bar;
}

/** Whether a fiber is drawn inside the navigation bar (a custom header item): it stays reachable. */
export function inNavBarHeader(bar: NativeNavBar, fiber: Fiber): boolean {
  return isWithin(fiber, bar.header);
}

let refCounter = 0;
const refToFiber = new Map<string, Fiber>();
const fiberToRef = new Map<Fiber, string>();

function bindRef(ref: string, fiber: Fiber): void {
  refToFiber.set(ref, fiber);
  fiberToRef.set(fiber, ref);
  if (fiber.alternate) fiberToRef.set(fiber.alternate, ref);
}

export function resetRefs(): void {
  refCounter = 0;
  refToFiber.clear();
  fiberToRef.clear();
}

/** The ref for a fiber in the remembered snapshot, allocating a new one when unseen. */
export function refFor(fiber: Fiber): string {
  const direct = fiberToRef.get(fiber) ?? (fiber.alternate ? fiberToRef.get(fiber.alternate) : undefined);
  if (direct) return direct;
  for (const [ref, known] of refToFiber) {
    if (sameFiber(known, fiber)) {
      bindRef(ref, fiber);
      return ref;
    }
  }
  const ref = `e${++refCounter}`;
  bindRef(ref, fiber);
  return ref;
}

/** The ref a fiber already has, without handing out a new one. */
function peekRef(fiber: Fiber): string | null {
  const direct = fiberToRef.get(fiber) ?? (fiber.alternate ? fiberToRef.get(fiber.alternate) : undefined);
  if (direct) return direct;
  for (const [ref, known] of refToFiber) if (sameFiber(known, fiber)) return ref;
  return null;
}

export interface OverlayElement {
  ref: string | null;
  type: string;
  label: string | null;
  id: string | null;
  frame: Frame;
}

/**
 * `overlay`: the elements on screen with their frames and the UI revision, for the live
 * viewer's boxes. Unlike `tree` it leaves refs and the change baseline alone.
 */
export async function overlay(): Promise<{ rev: number; screen: ScreenInfo; elements: OverlayElement[] }> {
  const rev = commitRevision();
  const snapshot = takeSnapshot();
  const candidates = snapshot.entries.filter((entry) => entry.info.interesting && !entry.tab);
  const frames = await Promise.all(candidates.map((entry) => measureFiber(entry.node.fiber)));
  const elements: OverlayElement[] = [];
  candidates.forEach((entry, i) => {
    const frame = frames[i];
    if (!frame || !isOnScreen(frame, snapshot.screen)) return;
    const { info } = entry;
    elements.push({
      ref: peekRef(entry.node.fiber),
      type: roleName(info),
      label: info.label ?? (info.text !== '' ? info.text.slice(0, 80) : null),
      id: info.testID,
      frame,
    });
  });
  return { rev, screen: snapshot.screen, elements };
}

export function fiberForRef(ref: string): Fiber | null {
  return refToFiber.get(ref) ?? null;
}

/** An entry as an element. `ref` is the fiber's ref unless one is passed ('' for an element that isn't listed). */
export function toElement(entry: Entry, frame: Frame | null, ref: string = refFor(entry.node.fiber)): TaplineElement {
  const { info } = entry;
  const kept = info.text.length > MAX_KEPT_TEXT ? sliceWhole(info.text, MAX_KEPT_TEXT) : info.text;
  const more = info.text.length - kept.length;
  return {
    ref,
    type: info.type,
    role: info.role,
    testID: info.testID,
    label: info.label,
    text: kept,
    ...(more > 0 ? { textMore: more } : {}),
    value: info.value === null ? null : displayText(info.value),
    ...(info.placeholder !== null && displayText(info.placeholder) !== '' ? { placeholder: displayText(info.placeholder) } : {}),
    frame,
    actions: info.actions,
    disabled: info.disabled,
    selected: info.selected,
    checked: info.checked,
  };
}

/**
 * The previous `tree` result, keyed by host instance, for `changes`: what was listed, what lay
 * above or below the screen, and whether the keyboard was up (undefined: not known).
 */
let lastTree: {
  byKey: Map<object, TaplineElement>;
  offKey: Map<object, TaplineElement>;
  route: string;
  keyboard: boolean | undefined;
} | null = null;

/** How many changed off-screen elements a change block lists one by one (AGENT-TOOLS v1.6). */
const MAX_OFF_SCREEN_CHANGES = 5;

/** Forget the previous tree (tests; a new connection). */
export function forgetLastTree(): void {
  lastTree = null;
}

/** A key that survives re-renders: Fabric clones `stateNode` on updates but keeps `canonical`. */
function stableKey(entry: Entry): object {
  return stableObjectKey(entry.node.fiber);
}

function framesDiffer(a: Frame | null, b: Frame | null): boolean {
  if (a === null || b === null) return a !== b;
  return (
    Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.width - b.width) > 1 || Math.abs(a.height - b.height) > 1
  );
}

/**
 * Whether an element's line shows its label apart from its text (`label="…"`): only when both are
 * there and they differ (ignoring case). A label that just repeats the text is not a second value.
 * With no text, the label is what the line names the element by, so it is shown.
 */
function showsLabel(element: TaplineElement): boolean {
  const label = element.label ?? '';
  if (label === '') return false;
  const text = element.text;
  return text === '' || label.toLowerCase() !== text.toLowerCase();
}

function changedFields(old: TaplineElement, now: TaplineElement): ChangedFields {
  const was: ChangedFields = {};
  if (old.text !== now.text || old.textMore !== now.textMore) was.text = old.text;
  // A label counts as changed only when the line shows it, before or after.
  if (old.label !== now.label && (showsLabel(old) || showsLabel(now))) was.label = old.label;
  if (old.value !== now.value) was.value = old.value;
  if (old.placeholder !== now.placeholder && old.placeholder !== undefined) was.placeholder = old.placeholder;
  if (old.checked !== now.checked) was.checked = old.checked;
  if (old.selected !== now.selected) was.selected = old.selected;
  if (old.disabled !== now.disabled) was.disabled = old.disabled;
  if (old.actions.join(',') !== now.actions.join(',')) was.actions = old.actions;
  return was;
}

function diffTrees(
  previous: { byKey: Map<object, TaplineElement>; offKey: Map<object, TaplineElement>; route: string },
  byKey: Map<object, TaplineElement>,
  offKey: Map<object, TaplineElement>,
  route: string,
): TreeChanges {
  const changes: TreeChanges = { sameRoute: previous.route === route, added: [], removed: [], changed: [], moved: [] };
  // Off screen now: only what changed in it counts (a scroll moves all of them, and a lazy list
  // makes and drops rows out of view all the time). It may have been off screen before too, or on
  // the list and scrolled away since (an action answered without a list, then this one).
  let offScreenChanged = 0;
  for (const [key, now] of offKey) {
    const old = previous.offKey.get(key) ?? previous.byKey.get(key);
    if (!old) continue;
    // The same element: the same identifier, or the same role in the same place (Tapwright's rule
    // too). A recycling list hands an off-screen cell to another row; that is not a change.
    const sameId = now.testID !== null && now.testID === old.testID;
    const samePlace = now.role === old.role && now.type === old.type && !framesDiffer(old.frame, now.frame);
    if (!sameId && !samePlace) continue;
    const { actions: _actions, ...was } = changedFields(old, now);
    if (Object.keys(was).length === 0) continue;
    offScreenChanged++;
    if (offScreenChanged <= MAX_OFF_SCREEN_CHANGES) (changes.offScreen ??= []).push({ element: now, was });
  }
  if (offScreenChanged > MAX_OFF_SCREEN_CHANGES) changes.offScreenMore = offScreenChanged - MAX_OFF_SCREEN_CHANGES;
  for (const [key, now] of byKey) {
    const old = previous.byKey.get(key);
    if (!old) {
      changes.added.push(now.ref);
      continue;
    }
    const was = changedFields(old, now);
    if (Object.keys(was).length > 0) changes.changed.push({ ref: now.ref, was });
    else if (framesDiffer(old.frame, now.frame)) changes.moved.push(now.ref);
  }
  for (const [key, old] of previous.byKey) if (!byKey.has(key)) changes.removed.push(old);
  return changes;
}

/** An entry about to be listed, with its measured frame. */
export interface Listed {
  entry: Entry;
  frame: Frame | null;
}

/** What an element line quotes, for comparing two elements: the text, else the label, whitespace flattened, its first MAX_TEXT characters. */
function quotedText(entry: Entry): string {
  const { info } = entry;
  const flat = (info.text !== '' ? info.text : (info.label ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT) : flat;
}

function sameRect(a: Frame, b: Frame): boolean {
  return (
    Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1
  );
}

/**
 * AGENT-TOOLS v1.3 "Duplicates": when an element and its nearest listed ancestor have the same
 * quoted text and the same rect (within 1 pt), only one is listed: the one that takes an action,
 * else (both or neither do) the ancestor. Roles may differ: a labelled wrapper around an input
 * lists only the input. Elements are in tree order, so an ancestor comes before its descendants.
 */
export function foldDuplicates(snapshot: Snapshot, listed: Listed[]): Listed[] {
  const byNode = new Map<number, Listed>();
  for (const item of listed) byNode.set(item.entry.node.index, item);
  const dropped = new Set<Listed>();
  for (const item of listed) {
    if (item.frame === null) continue;
    const text = quotedText(item.entry);
    if (text === '') continue;
    let ancestor: Listed | undefined;
    for (let p = item.entry.node.parent; p >= 0; p = snapshot.nodes[p]?.parent ?? -1) {
      const candidate = byNode.get(p);
      if (candidate && !dropped.has(candidate)) {
        ancestor = candidate;
        break;
      }
    }
    if (!ancestor || ancestor.frame === null) continue;
    if (!sameRect(item.frame, ancestor.frame) || quotedText(ancestor.entry) !== text) continue;
    const itemActs = item.entry.info.actions.length > 0;
    const ancestorActs = ancestor.entry.info.actions.length > 0;
    dropped.add(itemActs && !ancestorActs ? ancestor : item);
  }
  return dropped.size === 0 ? listed : listed.filter((item) => !dropped.has(item));
}

/**
 * `tree`: the screen as elements. A look (no `changes`) starts the refs at e1 again. With
 * `changes: true`, which the host asks for in an action's answer, elements still on screen keep
 * their refs and new ones count on from the highest ref handed out since the last look, so an old
 * ref never lands on another element; it also reports what changed since the previous call. A new
 * host session has no previous call (`forgetLastTree`), so its first list starts over like a look.
 */
export async function tree(params: unknown = {}): Promise<TreeResult> {
  const all = isRecord(params) && params.all === true;
  // `peek`: a list for the host's own use (naming what a picture shows). The agent isn't given it,
  // so its refs keep their meaning and the baseline for changes stays where it is.
  const peek = isRecord(params) && params.peek === true;
  const wantChanges = !peek && isRecord(params) && params.changes === true && lastTree !== null;
  // An action may have opened (or closed) an alert or the share sheet UIKit draws: read it again.
  await refreshCover();
  const snapshot = takeSnapshot();
  const candidates = snapshot.entries.filter((entry) => all || entry.info.interesting);
  const frames = await Promise.all(candidates.map((entry) => measureFiber(entry.node.fiber)));

  if (!wantChanges && !peek) resetRefs();
  const elements: TaplineElement[] = [];
  const byKey = new Map<object, TaplineElement>();
  let listed: Listed[] = [];
  // Elements with a size that lie wholly above or below the screen: counted, not listed (v1.5).
  let above: Listed[] = [];
  let below: Listed[] = [];
  candidates.forEach((entry, i) => {
    const frame = entry.tab ? null : (frames[i] ?? null);
    if (!all && frame !== null && !isOnScreen(frame, snapshot.screen)) {
      if (frame.width > 0 && frame.height > 0) {
        if (frame.y + frame.height <= 0) above.push({ entry, frame });
        else if (frame.y >= snapshot.screen.height) below.push({ entry, frame });
      }
      return;
    }
    listed.push({ entry, frame });
  });
  if (!all) {
    listed = foldDuplicates(snapshot, listed);
    above = foldDuplicates(snapshot, above);
    below = foldDuplicates(snapshot, below);
  }
  for (const { entry, frame } of listed) {
    const element = peek ? toElement(entry, frame, peekRef(entry.node.fiber) ?? '') : toElement(entry, frame);
    elements.push(element);
    byKey.set(stableKey(entry), element);
  }
  const result: TreeResult = { screen: snapshot.screen, elements };
  if (above.length > 0 || below.length > 0) result.offScreen = { above: above.length, below: below.length };
  // What lies above and below, without refs (it isn't listed): the baseline for changes off screen.
  const offKey = new Map<object, TaplineElement>();
  for (const { entry, frame } of [...above, ...below]) offKey.set(stableKey(entry), toElement(entry, frame, ''));
  const current = currentRoute(snapshot.routes);
  if (current) {
    const params = simpleParams(current.params);
    result.route = params ? { names: current.chain, params } : { names: current.chain };
  }
  const alerts = openAlerts();
  if (alerts.length > 0) {
    result.alerts = alerts.map(({ kind, title, message, buttons, standIn }) => ({ kind, title, message, buttons, standIn }));
  }
  const busy = inFlight();
  if (busy > 0) result.network = { inFlight: busy };
  // `Keyboard: shown` in the header while it is up; in a change block only when it came or went.
  const keyboard = keyboardState()?.shown;
  if (keyboard === true) result.keyboard = true;
  const routeKey = current ? `${current.chain.join('/')}#${current.key}` : '';
  if (wantChanges && lastTree !== null) {
    result.changes = diffTrees(lastTree, byKey, offKey, routeKey);
    if (keyboard !== undefined && lastTree.keyboard !== undefined && keyboard !== lastTree.keyboard) {
      result.changes.keyboard = keyboard ? 'shown' : 'hidden';
    }
  }
  if (!peek) lastTree = { byKey, offKey, route: routeKey, keyboard };
  return result;
}
