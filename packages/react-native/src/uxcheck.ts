import {
  MIN_TARGET,
  backgroundBehind,
  contrastOf,
  contrastRatio,
  cutOff,
  flatStyle,
  isAncestor,
  isTapTarget,
  maybeTruncated,
  noName,
  num,
  parseColor,
  smallTarget,
  type Measured,
} from './checks';
import { propsOf } from './fiber';
import { isOnScreen, measureFiber, takeSnapshot, type Entry, type HostNode } from './inspect';
import type { Frame } from './types';

/**
 * `ux_check` (AGENT-TOOLS 1.12 §17.3): one screen against the basics, as facts. Each finding names the
 * element it concerns and the basis it rests on: `measured`, `best practice: <rule>` or `house rule: <rule>`.
 */

export type UxKind =
  | 'choices'
  | 'main_action'
  | 'thumb_reach'
  | 'icon_only'
  | 'cut_off_text'
  | 'contrast'
  | 'target_size'
  | 'naming'
  | 'dead_end'
  | 'way_back';

export type UxCheckName = UxKind;

/** More competing choices than this on one screen is flagged (Hick's law). */
export const MAX_CHOICES = 7;
/** A phone at least this tall (points) has a top third out of the thumb's reach. */
export const TALL_SCREEN = 700;
/** The top-ranked action must be this many times as prominent as the next to count as clear. */
export const CLEAR_MARGIN = 1.5;
/** A filled button counts this many times its area. */
const FILL_WEIGHT = 2;
/** A fill needs this contrast against what is behind it to count as filled. */
const FILL_CONTRAST = 1.5;
/** An action this far (points) from a message counts as near it. */
export const NEAR = 160;
/** A primary-looking button is a filled one at least this share of the screen width wide. */
const PRIMARY_WIDTH = 0.4;

export const BASIS_CHOICES = `best practice: Hick's law, more than ${MAX_CHOICES} choices`;
export const BASIS_MAIN = 'best practice: one clear main action per screen';
export const BASIS_THUMB = 'best practice: thumb zone, main actions belong in the lower part of a tall screen';
export const BASIS_ICON = 'best practice: an icon-only button needs an accessibility label';
export const BASIS_NAMING = 'best practice: name the same action the same way on every screen';
export const BASIS_DEAD_END = 'best practice: an error or empty state says what to do next';
export const BASIS_WAY_BACK = 'house rule: every screen has a way back';

/** An action seen on an earlier screen of the journey (the journey keeps these and hands them back). */
export interface UxAction {
  label: string;
  id?: string;
}

export interface UxFinding {
  kind: UxKind;
  /** The element, or null for the screen as a whole. */
  entry: Entry | null;
  frame: Frame | null;
  problem: string;
  basis: string;
}

export interface UxOptions {
  /** `way_back` is a house rule: check that the screen has a visible way back. */
  wayBack?: boolean;
  /** Actions on earlier screens of the running journey; undefined when there is no journey. */
  earlier?: readonly UxAction[];
}

export interface UxResult {
  findings: UxFinding[];
  checked: UxCheckName[];
  /** Number of competing choices on the screen. */
  choices: number;
  /** The named actions on this screen, for the journey to keep as "earlier" for later screens. */
  actions: UxAction[];
}

/* -------------------------------------------------------------------------- */
/* Pure measurements                                                           */
/* -------------------------------------------------------------------------- */

const SYNONYMS: readonly (readonly string[])[] = [
  ['save', 'done', 'submit', 'confirm', 'apply', 'ok'],
  ['cancel', 'dismiss', 'close', 'back'],
  ['delete', 'remove', 'trash', 'discard'],
  ['add', 'new', 'create'],
  ['edit', 'change', 'modify', 'update'],
  ['log in', 'login', 'sign in'],
  ['sign up', 'register', 'create account', 'join'],
  ['next', 'continue'],
  ['search', 'find'],
];

function normalise(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function groupOf(label: string): number {
  return SYNONYMS.findIndex((group) => group.includes(label));
}

/** Names that are two names for one action: the same group of synonyms, but not the same words. */
export function sameActionDifferentName(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (x === y || x === '' || y === '') return false;
  const group = groupOf(x);
  return group >= 0 && group === groupOf(y);
}

const MESSAGE = /\b(error|errors|failed|failure|couldn['’]t|could not|can['’]t|cannot|something went wrong|nothing|empty)\b|^\s*no\s+\S/i;

/** Text that reads like an error or an empty-state message. */
export function looksLikeMessage(text: string): boolean {
  return MESSAGE.test(text);
}

const BACK_NAME = /^(go back|back|close|cancel|dismiss|×|✕|✖|‹|<|x)$|^(back|close)\b/i;
const BACK_ID = /(^|[-_.])(back|close|dismiss)([-_.]|$)/i;

function nameOf(entry: Entry): string {
  const { label, text } = entry.info;
  return (label !== null && label !== '' ? label : text).trim();
}

function isBackControl(entry: Entry): boolean {
  if (entry.navBack === true || entry.tab !== undefined) return true;
  if (!isTapTarget(entry)) return false;
  const id = entry.info.testID;
  return BACK_NAME.test(nameOf(entry)) || (id !== null && BACK_ID.test(id));
}

/** The opaque fill of a button: its own background, else its parent's, if it stands out from what is behind. */
function fillOf(nodes: HostNode[], node: HostNode): boolean {
  let current: HostNode | undefined = node;
  for (let level = 0; current && level < 2; level++) {
    const raw = flatStyle(propsOf(current.fiber).style).backgroundColor;
    const color = raw !== undefined && raw !== null ? parseColor(raw) : null;
    if (color !== null && color.a >= 1) {
      const above = current.parent >= 0 ? nodes[current.parent] : undefined;
      const behind = above !== undefined ? backgroundBehind(nodes, above) : ({ found: false } as const);
      const reference = behind.found ? behind.color : { r: 255, g: 255, b: 255, a: 1 };
      return contrastRatio(color, reference) >= FILL_CONTRAST;
    }
    current = current.parent >= 0 ? nodes[current.parent] : undefined;
  }
  return false;
}

interface Candidate {
  item: Measured;
  filled: boolean;
  score: number;
}

/* -------------------------------------------------------------------------- */
/* The check                                                                   */
/* -------------------------------------------------------------------------- */

export async function uxScreen(options: UxOptions = {}): Promise<UxResult> {
  const snapshot = takeSnapshot();
  const { screen, nodes } = snapshot;
  const candidates = snapshot.entries.filter((entry) => entry.info.interesting && !entry.tab);
  const frames = await Promise.all(candidates.map((entry) => measureFiber(entry.node.fiber)));
  const measured: Measured[] = [];
  candidates.forEach((entry, i) => {
    const frame = frames[i] ?? null;
    if (frame !== null && isOnScreen(frame, screen)) measured.push({ entry, frame });
  });

  const findings: UxFinding[] = [];
  const add = (kind: UxKind, item: Measured | null, problem: string, basis: string): void => {
    findings.push({ kind, entry: item?.entry ?? null, frame: item?.frame ?? null, problem, basis });
  };
  const checked: UxCheckName[] = ['choices', 'main_action', 'thumb_reach', 'icon_only', 'cut_off_text', 'contrast', 'target_size', 'dead_end'];

  // 1. Competing choices.
  const taps = measured.filter((item) => isTapTarget(item.entry));
  if (taps.length > MAX_CHOICES) {
    add('choices', null, `${taps.length} choices compete for attention on this screen (more than ${MAX_CHOICES})`, BASIS_CHOICES);
  }

  // 2. One clear main action.
  const buttons: Candidate[] = taps
    .filter((item) => item.entry.info.actions.includes('press') && !item.entry.info.actions.includes('toggle') && nameOf(item.entry) !== '')
    .map((item) => {
      const filled = fillOf(nodes, item.entry.node);
      return { item, filled, score: item.frame.width * item.frame.height * (filled ? FILL_WEIGHT : 1) };
    })
    .sort((a, b) => b.score - a.score);
  const [first, second] = buttons;
  if (first !== undefined && second !== undefined && first.score < second.score * CLEAR_MARGIN) {
    const a = nameOf(first.item.entry);
    const b = nameOf(second.item.entry);
    if (first.filled && second.filled) {
      add('main_action', first.item, `two actions look equally important: ${JSON.stringify(a)} and ${JSON.stringify(b)}`, BASIS_MAIN);
    } else {
      add('main_action', null, `no action stands out as the main one (largest: ${JSON.stringify(a)} and ${JSON.stringify(b)} are alike in size and look)`, BASIS_MAIN);
    }
  }

  // 3. Primary-looking buttons in the top third of a tall screen.
  if (screen.height >= TALL_SCREEN) {
    for (const candidate of buttons) {
      const { frame } = candidate.item;
      if (!candidate.filled || frame.width < screen.width * PRIMARY_WIDTH) continue;
      if (frame.y + frame.height / 2 < screen.height / 3) {
        add('thumb_reach', candidate.item, `a main-looking button sits in the top third of a ${num(screen.height)} pt tall screen, out of easy thumb reach`, BASIS_THUMB);
      }
    }
  }

  // 4. Icon-only buttons with no label; then cut-off text, contrast and target size (as audit).
  for (const item of measured) if (noName(item) !== null) add('icon_only', item, 'icon-only button with no accessibility label', BASIS_ICON);
  for (const item of measured) {
    const truncated = maybeTruncated(item, nodes);
    if (truncated !== null) add('cut_off_text', item, truncated, 'measured');
    const cut = cutOff(item, screen.width);
    if (cut !== null) add('cut_off_text', item, `it ${cut}`, 'measured');
    const contrast = contrastOf(item, nodes);
    if (contrast !== null) {
      add('contrast', item, `contrast ${num(contrast.ratio)}:1 is below ${num(contrast.required)}:1 (${contrast.foreground} on ${contrast.background})`, 'measured');
    }
    const systemSwitch = item.entry.info.type === 'Switch' && item.frame.width >= MIN_TARGET && item.frame.height >= 24;
    if (smallTarget(item) !== null && !systemSwitch) {
      add('target_size', item, `tap area ${num(item.frame.width)}x${num(item.frame.height)} pt is smaller than ${MIN_TARGET}x${MIN_TARGET}`, 'measured');
    }
  }

  // 5. The same action named differently on screens seen in this journey.
  const actions: UxAction[] = taps.flatMap((item) => {
    const label = nameOf(item.entry);
    const id = item.entry.info.testID;
    return label === '' ? [] : [{ label, ...(id !== null && id !== '' ? { id } : {}) }];
  });
  if (options.earlier !== undefined) {
    checked.push('naming');
    const told = new Set<string>();
    for (const item of taps) {
      const label = nameOf(item.entry);
      if (label === '') continue;
      const id = item.entry.info.testID;
      const before = options.earlier.find(
        (e) => normalise(e.label) !== normalise(label) && ((id !== null && id !== '' && e.id === id) || sameActionDifferentName(e.label, label)),
      );
      if (before === undefined) continue;
      const key = `${normalise(before.label)}|${normalise(label)}`;
      if (told.has(key)) continue;
      told.add(key);
      add('naming', item, `the same action is ${JSON.stringify(label)} here and ${JSON.stringify(before.label)} on an earlier screen`, BASIS_NAMING);
    }
  }

  // 6. An error or empty state that doesn't say what to do next.
  for (const item of measured) {
    const { node, info } = item.entry;
    if (!node.isText || info.text === '' || !looksLikeMessage(info.text)) continue;
    if (taps.some((tap) => tap === item || isAncestor(nodes, tap.entry.node, node))) continue;
    const near = taps.some((tap) => {
      const gap = Math.max(tap.frame.y - (item.frame.y + item.frame.height), item.frame.y - (tap.frame.y + tap.frame.height), 0);
      return gap <= NEAR;
    });
    if (!near) add('dead_end', item, 'it reports a problem or an empty state, and nothing near it says what to do next', BASIS_DEAD_END);
  }

  // 7. House rule: a way back.
  if (options.wayBack === true) {
    checked.push('way_back');
    const reachable = snapshot.entries.some((entry) => isBackControl(entry) && (entry.tab !== undefined || entry.navBack === true || measured.some((m) => m.entry === entry)));
    if (!reachable) add('way_back', null, 'no back button, close control or tab bar is visible', BASIS_WAY_BACK);
  }

  return { findings, checked, choices: taps.length, actions };
}
