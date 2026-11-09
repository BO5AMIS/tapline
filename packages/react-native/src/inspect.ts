import { Dimensions, PixelRatio, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
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
import { inFlight } from './network';
import { getRoots } from './register';
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

export const MAX_TEXT = 200;

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
  /** Descendant text, whitespace-collapsed, trimmed, at most MAX_TEXT chars. */
  text: string;
  isText: boolean;
  insideText: boolean;
}

function normalizeText(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_TEXT ? collapsed.slice(0, MAX_TEXT) : collapsed;
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
    if (typeof navigation.isFocused === 'function') focused = navigation.isFocused() !== false;
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
      node.text = normalizeText(isText ? inner.join('') : inner.join(' '));
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
  const out: Collected = { nodes: [], routes: [], tabs: [] };
  for (const root of roots) walk(root.current.child, -1, [], false, out, []);
  return out;
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

export interface NodeInfo {
  type: string;
  role: string | null;
  testID: string | null;
  label: string | null;
  text: string;
  value: string | null;
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

/** Handlers shared with a descendant host belong to the descendant, not to this wrapper. */
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
    if (has('onPress')) actions.push('press');
    if (has('onLongPress')) actions.push('longPress');
    if (input) actions.push('type', 'submit');
    if (toggleable && has('onValueChange')) actions.push('toggle');
    if (isScrollNode(node)) actions.push('scroll');

    const testID = stringProp(node, 'testID');
    const label = stringProp(node, 'accessibilityLabel') ?? stringProp(node, 'aria-label');

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

    const hasContent = node.isText && !node.insideText && node.text !== '';
    infos.push({
      type: typeName(node),
      role,
      testID,
      label,
      text: input ? '' : node.text,
      value: input ? currentInputValue(node) : null,
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

/** Fabric's own hit test (`findNodeAtPoint`, as React Native's element inspector uses), topmost root first. */
export const defaultHitTester: HitTester = async (x, y) => {
  const manager = fabricHitManager();
  if (!manager) return undefined;
  const nodes = getRoots().map(rootShadowNode).filter((node) => node !== undefined).reverse();
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
}

export interface Snapshot {
  nodes: HostNode[];
  entries: Entry[];
  screen: ScreenInfo;
  /** Visible screens that got React Navigation's props, in tree order. */
  routes: RouteFound[];
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
      "No React roots recorded. Import '@tapline/react-native/register' first in the app's entry file, before React.",
    );
  }
  const { nodes, routes, tabs } = collect(roots);
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
        actions: ['press'],
        disabled: false,
        selected: tab.selected,
        checked: null,
        interesting: true,
      },
    });
  }
  return { nodes, entries, screen: getScreen(), routes };
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

export function fiberForRef(ref: string): Fiber | null {
  return refToFiber.get(ref) ?? null;
}

export function toElement(entry: Entry, frame: Frame | null): TaplineElement {
  const { info } = entry;
  return {
    ref: refFor(entry.node.fiber),
    type: info.type,
    role: info.role,
    testID: info.testID,
    label: info.label,
    text: info.text,
    value: info.value,
    frame,
    actions: info.actions,
    disabled: info.disabled,
    selected: info.selected,
    checked: info.checked,
  };
}

/** The previous `tree` result, keyed by host instance, for `changes`. */
let lastTree: { byKey: Map<object, TaplineElement>; route: string } | null = null;

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

function changedFields(old: TaplineElement, now: TaplineElement): ChangedFields {
  const was: ChangedFields = {};
  if (old.text !== now.text) was.text = old.text;
  if (old.label !== now.label) was.label = old.label;
  if (old.value !== now.value) was.value = old.value;
  if (old.checked !== now.checked) was.checked = old.checked;
  if (old.selected !== now.selected) was.selected = old.selected;
  if (old.disabled !== now.disabled) was.disabled = old.disabled;
  if (old.actions.join(',') !== now.actions.join(',')) was.actions = old.actions;
  return was;
}

function diffTrees(
  previous: { byKey: Map<object, TaplineElement>; route: string },
  byKey: Map<object, TaplineElement>,
  route: string,
): TreeChanges {
  const changes: TreeChanges = { sameRoute: previous.route === route, added: [], removed: [], changed: [], moved: [] };
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

/**
 * `tree`: the screen as elements. Refs start at e1 again, except with `changes: true`, which
 * keeps the refs of elements still on screen and reports what changed since the previous call.
 */
export async function tree(params: unknown = {}): Promise<TreeResult> {
  const all = isRecord(params) && params.all === true;
  const wantChanges = isRecord(params) && params.changes === true && lastTree !== null;
  const snapshot = takeSnapshot();
  const candidates = snapshot.entries.filter((entry) => all || entry.info.interesting);
  const frames = await Promise.all(candidates.map((entry) => measureFiber(entry.node.fiber)));

  if (!wantChanges) resetRefs();
  const elements: TaplineElement[] = [];
  const byKey = new Map<object, TaplineElement>();
  candidates.forEach((entry, i) => {
    const frame = entry.tab ? null : (frames[i] ?? null);
    if (!all && frame !== null && !isOnScreen(frame, snapshot.screen)) return;
    const element = toElement(entry, frame);
    elements.push(element);
    byKey.set(stableKey(entry), element);
  });
  const result: TreeResult = { screen: snapshot.screen, elements };
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
  const routeKey = current ? `${current.chain.join('/')}#${current.key}` : '';
  if (wantChanges && lastTree !== null) result.changes = diffTrees(lastTree, byKey, routeKey);
  lastTree = { byKey, route: routeKey };
  return result;
}
