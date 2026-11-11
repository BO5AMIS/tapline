import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { propsOf } from './fiber';
import {
  findProp,
  isOnScreen,
  measureFiber,
  refFor,
  takeSnapshot,
  type Entry,
  type HostNode,
} from './inspect';
import { isRecord, type Frame } from './types';

/**
 * Automatic visual and layout checks, computed from the fiber tree and the measured frames
 * (no pixels). Every finding names an element by the same ref `tree` uses.
 */

export type FindingKind =
  | 'small_target'
  | 'cut_off'
  | 'overlap'
  | 'low_contrast'
  | 'no_name'
  | 'maybe_truncated';

export interface Finding {
  kind: FindingKind;
  ref: string;
  /** The second element, for `overlap`. */
  other?: string;
  message: string;
}

/** Apple's and Google's minimum tap target, in points. */
const MIN_TARGET = 44;
/** How far past a screen edge an element may run before it counts as cut off, in points. */
const EDGE_SLACK = 1;
/** Fraction of the smaller frame that two elements may share before they count as overlapping. */
const OVERLAP_LIMIT = 0.25;
const NORMAL_CONTRAST = 4.5;
const LARGE_CONTRAST = 3;
const DEFAULT_FONT_SIZE = 14;
/** Average glyph width as a fraction of the font size; a rough estimate on purpose. */
const AVERAGE_GLYPH_WIDTH = 0.5;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function num(value: number): string {
  return String(Number(value.toFixed(1)));
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (style === undefined || style === null || typeof style === 'function') return {};
  try {
    const flat: unknown = StyleSheet.flatten(style as StyleProp<ViewStyle>);
    return isRecord(flat) ? flat : {};
  } catch {
    return {};
  }
}

function isTapTarget(entry: Entry): boolean {
  return entry.info.actions.some((action) => action === 'press' || action === 'longPress' || action === 'toggle');
}

interface Slop {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function hitSlopOf(node: HostNode): Slop {
  const raw = findProp(node, 'hitSlop');
  if (typeof raw === 'number' && Number.isFinite(raw)) return { top: raw, bottom: raw, left: raw, right: raw };
  const side = (key: string): number => {
    const value = isRecord(raw) ? raw[key] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return { top: side('top'), bottom: side('bottom'), left: side('left'), right: side('right') };
}

function isAncestor(nodes: HostNode[], ancestor: HostNode, node: HostNode): boolean {
  for (let p = node.parent; p >= 0; ) {
    if (p === ancestor.index) return true;
    const next = nodes[p];
    if (!next) return false;
    p = next.parent;
  }
  return false;
}

function intersectionArea(a: Frame, b: Frame): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/* -------------------------------------------------------------------------- */
/* Colours                                                                     */
/* -------------------------------------------------------------------------- */

interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0 to 1. */
  a: number;
}

const NAMED_COLORS: Record<string, Rgba> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

function parseHex(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const long = hex.length === 3 || hex.length === 4 ? hex.replace(/./g, (c) => c + c) : hex;
  if (long.length !== 6 && long.length !== 8) return null;
  const byte = (i: number): number => parseInt(long.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: long.length === 8 ? byte(6) / 255 : 1 };
}

function parseFunctional(body: string): Rgba | null {
  const parts = body.split(/[\s,/]+/).filter((part) => part !== '');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channels = parts.slice(0, 3).map((part) => Number(part));
  if (channels.some((value) => !Number.isFinite(value))) return null;
  let alpha = 1;
  const rawAlpha = parts[3];
  if (rawAlpha !== undefined) {
    alpha = rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha);
    if (!Number.isFinite(alpha)) return null;
  }
  const clamp = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
  return {
    r: clamp(channels[0] ?? 0),
    g: clamp(channels[1] ?? 0),
    b: clamp(channels[2] ?? 0),
    a: Math.min(1, Math.max(0, alpha)),
  };
}

/** A colour as RGBA, or null when it is not one this module understands (PlatformColor, hsl(), ...). */
function parseColor(value: unknown): Rgba | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) return null;
    const argb = value >>> 0;
    return { r: (argb >>> 16) & 0xff, g: (argb >>> 8) & 0xff, b: argb & 0xff, a: (argb >>> 24) / 255 };
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const named = NAMED_COLORS[text];
  if (named) return { ...named };
  if (text.startsWith('#')) return parseHex(text.slice(1));
  const match = /^rgba?\(([^)]*)\)$/.exec(text);
  return match && match[1] !== undefined ? parseFunctional(match[1]) : null;
}

function toHex(color: Rgba): string {
  const byte = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

function luminance(color: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG 2.1 contrast ratio, 1 to 21. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = luminance(a) >= luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (light + 0.05) / (dark + 0.05);
}

function over(foreground: Rgba, background: Rgba): Rgba {
  if (foreground.a >= 1) return foreground;
  const mix = (f: number, b: number): number => Math.round(foreground.a * f + (1 - foreground.a) * b);
  return { r: mix(foreground.r, background.r), g: mix(foreground.g, background.g), b: mix(foreground.b, background.b), a: 1 };
}

/** A text style value on the text node, else inherited from the nearest enclosing Text. */
function inheritedTextStyle(nodes: HostNode[], node: HostNode, key: string): unknown {
  for (let current: HostNode | undefined = node; current && current.isText; ) {
    const value = flatStyle(findProp(current, 'style'))[key];
    if (value !== undefined) return value;
    current = current.parent >= 0 ? nodes[current.parent] : undefined;
  }
  return undefined;
}

type Background = { found: true; color: Rgba } | { found: false };

/** The opaque background colour behind a node: nearest host (itself included) that sets one. */
function backgroundBehind(nodes: HostNode[], node: HostNode): Background {
  for (let current: HostNode | undefined = node; current; ) {
    const raw = flatStyle(propsOf(current.fiber).style).backgroundColor;
    if (raw !== undefined && raw !== null) {
      const color = parseColor(raw);
      if (color === null) return { found: false };
      if (color.a >= 1) return { found: true, color };
      // Fully transparent shows whatever is behind it; translucent mixes with something unknown.
      if (color.a > 0) return { found: false };
    }
    current = current.parent >= 0 ? nodes[current.parent] : undefined;
  }
  return { found: false };
}

function isLargeText(fontSize: number, fontWeight: unknown): boolean {
  if (fontSize >= 18) return true;
  if (fontSize < 14) return false;
  if (fontWeight === 'bold') return true;
  const weight = typeof fontWeight === 'number' ? fontWeight : typeof fontWeight === 'string' ? Number(fontWeight) : NaN;
  return weight >= 600 && weight <= 900;
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

interface Measured {
  entry: Entry;
  frame: Frame;
}

interface Tagged {
  position: number;
  finding: Finding;
}

function smallTarget(item: Measured): string | null {
  if (!isTapTarget(item.entry)) return null;
  const { frame } = item;
  const slop = hitSlopOf(item.entry.node);
  const width = frame.width + slop.left + slop.right;
  const height = frame.height + slop.top + slop.bottom;
  if (width >= MIN_TARGET && height >= MIN_TARGET) return null;
  return `tap area ${num(frame.width)}x${num(frame.height)} pt is smaller than ${MIN_TARGET}x${MIN_TARGET}`;
}

function cutOff(item: Measured, screenWidth: number): string | null {
  const { frame } = item;
  const parts: string[] = [];
  if (frame.x < -EDGE_SLACK) parts.push(`${num(-frame.x)} pt past the left edge`);
  const overRight = frame.x + frame.width - screenWidth;
  if (overRight > EDGE_SLACK) parts.push(`${num(overRight)} pt past the right edge`);
  return parts.length > 0 ? `runs ${parts.join(' and ')} of the screen` : null;
}

function noName(item: Measured): string | null {
  const { info } = item.entry;
  if (!info.actions.includes('press') || info.actions.includes('type') || info.text !== '' || info.label !== null) return null;
  return 'button has no text or accessibility label; VoiceOver would read nothing';
}

interface Contrast {
  /** Rounded down to one decimal. */
  ratio: number;
  required: number;
  foreground: string;
  background: string;
}

function contrastOf(item: Measured, nodes: HostNode[]): Contrast | null {
  const { node } = item.entry;
  if (!node.isText) return null;
  const foreground = parseColor(inheritedTextStyle(nodes, node, 'color'));
  if (foreground === null) return null;
  const behind = backgroundBehind(nodes, node);
  if (!behind.found) return null;

  const fontSizeRaw = inheritedTextStyle(nodes, node, 'fontSize');
  const fontSize = typeof fontSizeRaw === 'number' ? fontSizeRaw : DEFAULT_FONT_SIZE;
  const required = isLargeText(fontSize, inheritedTextStyle(nodes, node, 'fontWeight')) ? LARGE_CONTRAST : NORMAL_CONTRAST;

  const ratio = contrastRatio(over(foreground, behind.color), behind.color);
  if (ratio >= required) return null;
  return { ratio: Math.floor(ratio * 10) / 10, required, foreground: toHex(foreground), background: toHex(behind.color) };
}

function lowContrast(item: Measured, nodes: HostNode[]): string | null {
  const c = contrastOf(item, nodes);
  return c === null ? null : `contrast ${num(c.ratio)}:1 is below ${num(c.required)}:1 (${c.foreground} on ${c.background})`;
}

function maybeTruncated(item: Measured, nodes: HostNode[]): string | null {
  const { node, info } = item.entry;
  if (!node.isText || info.text === '') return null;
  const lines = findProp(node, 'numberOfLines');
  if (typeof lines !== 'number' || !(lines > 0)) return null;
  const sizeRaw = inheritedTextStyle(nodes, node, 'fontSize');
  const fontSize = typeof sizeRaw === 'number' && sizeRaw > 0 ? sizeRaw : DEFAULT_FONT_SIZE;
  const needed = info.text.length * fontSize * AVERAGE_GLYPH_WIDTH;
  const room = item.frame.width * lines;
  if (needed <= room) return null;
  return `text may be cut off: about ${num(needed)} pt of text, but numberOfLines=${lines} on ${num(item.frame.width)} pt fits about ${num(room)} pt`;
}

function overlapCandidate(entry: Entry): boolean {
  const { actions, text } = entry.info;
  if (text === '' && actions.length === 0) return false;
  if (actions.includes('type')) return false;
  const pressy = actions.some((action) => action === 'press' || action === 'longPress' || action === 'toggle');
  if (actions.includes('scroll') && !pressy) return false;
  return true;
}

/**
 * `check_layout`: problems a person would notice on screen, found from the tree and frames.
 * Refs are the ones from the latest `tree` call (they are not reset here).
 */
export async function checkLayout(_params?: unknown): Promise<{ findings: Finding[] }> {
  const snapshot = takeSnapshot();
  // Native tabs are drawn by the OS: no frame to check.
  const candidates = snapshot.entries.filter((entry) => entry.info.interesting && !entry.tab);
  const frames = await Promise.all(candidates.map((entry) => measureFiber(entry.node.fiber)));

  const measured: Measured[] = [];
  candidates.forEach((entry, i) => {
    const frame = frames[i] ?? null;
    if (frame !== null && isOnScreen(frame, snapshot.screen)) measured.push({ entry, frame });
  });

  const tagged: Tagged[] = [];
  const add = (position: number, kind: FindingKind, fiberOwner: Entry, message: string, other?: Entry): void => {
    const finding: Finding = { kind, ref: refFor(fiberOwner.node.fiber), message };
    if (other) finding.other = refFor(other.node.fiber);
    tagged.push({ position, finding });
  };

  for (const item of measured) {
    const position = item.entry.node.index;
    const checks: [FindingKind, string | null][] = [
      ['small_target', smallTarget(item)],
      ['cut_off', cutOff(item, snapshot.screen.width)],
      ['no_name', noName(item)],
      ['low_contrast', lowContrast(item, snapshot.nodes)],
      ['maybe_truncated', maybeTruncated(item, snapshot.nodes)],
    ];
    for (const [kind, message] of checks) if (message !== null) add(position, kind, item.entry, message);
  }

  const overlapping = measured.filter((item) => overlapCandidate(item.entry));
  for (let i = 0; i < overlapping.length; i++) {
    const first = overlapping[i];
    if (!first) continue;
    for (let j = i + 1; j < overlapping.length; j++) {
      const second = overlapping[j];
      if (!second) continue;
      const a = first.entry.node;
      const b = second.entry.node;
      if (isAncestor(snapshot.nodes, a, b) || isAncestor(snapshot.nodes, b, a)) continue;
      const smaller = Math.min(first.frame.width * first.frame.height, second.frame.width * second.frame.height);
      const shared = intersectionArea(first.frame, second.frame);
      if (smaller <= 0 || shared <= smaller * OVERLAP_LIMIT) continue;
      const percent = Math.round((shared / smaller) * 100);
      refFor(a.fiber); // name the first element first, so new refs follow tree order
      const otherRef = refFor(b.fiber);
      add(a.index, 'overlap', first.entry, `overlaps ${otherRef} by ${percent}% of the smaller element`, second.entry);
    }
  }

  tagged.sort((x, y) => x.position - y.position);
  return { findings: tagged.map((item) => item.finding) };
}

/* -------------------------------------------------------------------------- */
/* audit (AGENT-TOOLS 1.8 §10)                                                 */
/* -------------------------------------------------------------------------- */

/** The shared audit types Tapline checks; dynamic_type and element_detection are XCTest's own. */
export const AUDIT_TYPES = ['contrast', 'hit_region', 'description', 'clipped_text', 'trait', 'overlap', 'duplicate_id'] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

export interface AuditFinding {
  type: AuditType;
  /** The element, or null for the screen as a whole. */
  entry: Entry | null;
  frame: Frame | null;
  /** What is wrong, in plain words, without the element (the host puts the element line first). */
  problem: string;
  fix: string;
}

const STATEFUL_ROLES = new Set(['switch', 'checkbox', 'radio', 'togglebutton']);

function explicitRole(node: HostNode): string | null {
  for (const key of ['role', 'accessibilityRole']) {
    const value = findProp(node, key);
    if (typeof value === 'string' && value !== '' && value !== 'none') return value.toLowerCase();
  }
  return null;
}

/** A pressable without a role, or a switch-like element without a state: VoiceOver can't say what it is. */
function traitProblem(item: Measured): { problem: string; fix: string } | null {
  const { node, info } = item.entry;
  const role = explicitRole(node);
  if (role !== null && STATEFUL_ROLES.has(role) && info.checked === null) {
    return {
      problem: `it's a ${role} without a state, so VoiceOver can't say whether it's on`,
      fix: 'set accessibilityState={{ checked }}',
    };
  }
  if (role !== null) return null;
  const presses = info.actions.includes('press') || info.actions.includes('longPress');
  if (!presses || info.actions.includes('type') || info.actions.includes('toggle')) return null;
  // React Native's own Button and the text of a link set nothing either; a Text with onPress reads as text.
  if (node.isText) {
    return { problem: "it acts like a link but has no role, so VoiceOver reads it as plain text", fix: 'set accessibilityRole="link" (or "button")' };
  }
  return { problem: "it acts like a button but has no role, so VoiceOver doesn't say it's a button", fix: 'set accessibilityRole="button"' };
}

/** `audit`: the screen's accessibility problems, in the shared types (AGENT-TOOLS 1.8 §10). */
export async function auditScreen(types: ReadonlySet<AuditType>): Promise<AuditFinding[]> {
  const snapshot = takeSnapshot();
  const candidates = snapshot.entries.filter((entry) => entry.info.interesting && !entry.tab);
  const frames = await Promise.all(candidates.map((entry) => measureFiber(entry.node.fiber)));
  const measured: Measured[] = [];
  candidates.forEach((entry, i) => {
    const frame = frames[i] ?? null;
    if (frame !== null && isOnScreen(frame, snapshot.screen)) measured.push({ entry, frame });
  });
  const out: Array<AuditFinding & { position: number }> = [];
  const add = (item: Measured, type: AuditType, problem: string, fix: string): void => {
    if (types.has(type)) out.push({ type, entry: item.entry, frame: item.frame, problem, fix, position: item.entry.node.index });
  };

  for (const item of measured) {
    if (smallTarget(item) !== null) {
      add(item, 'hit_region', `too small to tap reliably (${num(item.frame.width)}x${num(item.frame.height)} pt)`, `make it at least ${MIN_TARGET}x${MIN_TARGET} pt`);
    }
    const contrast = contrastOf(item, snapshot.nodes);
    if (contrast !== null) {
      add(
        item,
        'contrast',
        `the text is hard to read against its background (${num(contrast.ratio)}:1, ${contrast.foreground} on ${contrast.background})`,
        `raise the contrast to at least ${num(contrast.required)}:1`,
      );
    }
    if (noName(item) !== null) {
      add(item, 'description', 'no label, so VoiceOver says only "button"', 'give it an accessibility label');
    }
    const truncated = maybeTruncated(item, snapshot.nodes);
    if (truncated !== null) add(item, 'clipped_text', truncated, 'let it wrap, or give it more room');
    const cut = cutOff(item, snapshot.screen.width);
    if (cut !== null) add(item, 'clipped_text', `it ${cut}`, 'keep it inside the screen');
    const trait = traitProblem(item);
    if (trait !== null) add(item, 'trait', trait.problem, trait.fix);
  }

  if (types.has('overlap')) {
    const overlapping = measured.filter((item) => overlapCandidate(item.entry));
    for (let i = 0; i < overlapping.length; i++) {
      const first = overlapping[i];
      if (!first) continue;
      for (let j = i + 1; j < overlapping.length; j++) {
        const second = overlapping[j];
        if (!second) continue;
        const a = first.entry.node;
        const b = second.entry.node;
        if (isAncestor(snapshot.nodes, a, b) || isAncestor(snapshot.nodes, b, a)) continue;
        const smaller = Math.min(first.frame.width * first.frame.height, second.frame.width * second.frame.height);
        const shared = intersectionArea(first.frame, second.frame);
        if (smaller <= 0 || shared <= smaller * OVERLAP_LIMIT) continue;
        refFor(a.fiber);
        const otherRef = refFor(b.fiber);
        add(first, 'overlap', `it covers ${Math.round((shared / smaller) * 100)}% of ${otherRef}`, 'move them apart, or make one of them not take touches');
      }
    }
  }

  if (types.has('duplicate_id')) {
    const byId = new Map<string, Measured[]>();
    for (const item of measured) {
      const id = item.entry.info.testID;
      if (id === null || id === '') continue;
      byId.set(id, [...(byId.get(id) ?? []), item]);
    }
    for (const [id, items] of byId) {
      const first = items[0];
      if (items.length < 2 || first === undefined) continue;
      const refs = items.map((item) => refFor(item.entry.node.fiber));
      add(first, 'duplicate_id', `the id "${id}" is on ${items.length} elements (${refs.join(', ')})`, 'give each its own testID');
    }
  }

  out.sort((x, y) => x.position - y.position);
  return out.map(({ position: _position, ...finding }) => finding);
}
