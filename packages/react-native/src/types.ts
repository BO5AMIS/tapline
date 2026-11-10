/** Wire-protocol and shared types (see docs/PROTOCOL.md, version 1). */

export const PROTOCOL_VERSION = 1;

export type ErrorCode =
  | 'not_found'
  | 'ambiguous'
  | 'not_actionable'
  | 'unsupported'
  | 'bad_params'
  | 'timeout'
  | 'internal';

export interface WireError {
  code: ErrorCode;
  message: string;
  /** Candidate refs, only for `ambiguous`. */
  refs?: string[];
  /** The candidates as elements (role, id, actions, frame), only for `ambiguous`. */
  candidates?: TaplineElement[];
}

/** An error that maps 1:1 onto a protocol error response. */
export class TaplineError extends Error {
  readonly code: ErrorCode;
  readonly refs: string[] | undefined;
  readonly candidates: TaplineElement[] | undefined;

  constructor(code: ErrorCode, message: string, refs?: string[], candidates?: TaplineElement[]) {
    super(message);
    this.name = 'TaplineError';
    this.code = code;
    this.refs = refs;
    this.candidates = candidates;
  }

  toWire(): WireError {
    const wire: WireError = { code: this.code, message: this.message };
    if (this.refs) wire.refs = this.refs;
    if (this.candidates) wire.candidates = this.candidates;
    return wire;
  }
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Action = 'press' | 'longPress' | 'type' | 'submit' | 'toggle' | 'scroll';

export interface TaplineElement {
  ref: string;
  type: string;
  role: string | null;
  testID: string | null;
  label: string | null;
  /** The element's text, whitespace-collapsed; at most 2000 characters of it. */
  text: string;
  /** How many characters of the text were left out; absent when it is whole. */
  textMore?: number;
  /** TextInput content; null for everything else. */
  value: string | null;
  /** Null only when the element could not be measured. */
  frame: Frame | null;
  actions: Action[];
  disabled: boolean;
  selected: boolean;
  /** true / false / 'mixed' for checkable controls (Switch, checkbox role), else null. */
  checked: boolean | 'mixed' | null;
}

export interface ScreenInfo {
  width: number;
  height: number;
  scale: number;
}

export interface RouteInfo {
  /** Route names from the outermost navigator to the focused screen, e.g. ["(tabs)", "nutrition"]. */
  names: string[];
  /** The focused screen's simple params (strings, numbers, booleans, null). */
  params?: Record<string, string | number | boolean | null>;
}

/** What an element was before, for the fields that changed. */
export type ChangedFields = Partial<
  Pick<TaplineElement, 'text' | 'label' | 'value' | 'checked' | 'selected' | 'disabled' | 'actions'>
>;

/** The difference from the previous `tree` call (only with `changes: true`). Refs of unchanged elements are kept. */
export interface TreeChanges {
  /** Whether the focused route is the same as before. */
  sameRoute: boolean;
  /** Refs of elements that are new. */
  added: string[];
  /** Elements that are gone, as they were (their refs no longer work). */
  removed: TaplineElement[];
  /** Elements whose text, value, state or actions changed, with the old values. */
  changed: Array<{ ref: string; was: ChangedFields }>;
  /** Refs of elements that only moved. */
  moved: string[];
  /**
   * Elements off screen (above or below it, before and now) whose text, label, value or state
   * changed, as they are now and without a ref, with the old values. At most 5; absent when none.
   */
  offScreen?: Array<{ element: TaplineElement; was: ChangedFields }>;
  /** How many more changed off screen than `offScreen` holds; absent when none. */
  offScreenMore?: number;
}

/** An alert the app showed and nobody has answered yet. */
export interface TreeAlert {
  kind: 'alert' | 'prompt';
  title: string;
  message: string | null;
  buttons: Array<{ text: string; style: 'default' | 'cancel' | 'destructive' }>;
  /** Tapline's in-app stand-in (its buttons are elements to press) rather than the OS alert. */
  standIn: boolean;
}

export interface TreeResult {
  screen: ScreenInfo;
  elements: TaplineElement[];
  /** How many elements lie wholly above and below the screen (scroll to reach them); absent when none. */
  offScreen?: { above: number; below: number };
  /** Open alerts (Alert.alert / Alert.prompt) the app showed, oldest first. */
  alerts?: TreeAlert[];
  /** Network requests still running (fetch / XMLHttpRequest); absent when none. */
  network?: { inFlight: number };
  /** The focused screen, when the app uses React Navigation (Expo Router included). */
  route?: RouteInfo;
  /** With `changes: true` and a previous tree: what changed since then. */
  changes?: TreeChanges;
}

export type Target =
  | { ref: string; index?: number }
  | { testID: string; index?: number }
  | { label: string; index?: number }
  | { text: string; index?: number }
  | { x: number; y: number; index?: number };

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  ts: number;
}

export interface ErrorEventData {
  message: string;
  stack: string;
  fatal: boolean;
  ts: number;
}

export interface AppInfo {
  name?: string;
  id?: string;
  version?: string;
  build?: string;
}

export interface DeviceInfo {
  platform: string;
  osVersion: string;
  model?: string;
  name?: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
