import type { Frame, TreeElement } from "./protocol.js";

// The action signature (AGENT-TOOLS 1.15 §25.3): the name of an action on a place, without a ref. `record` and the
// explorer both name an element through this module, so they name the same thing.
//
// The first three tiers are exactly the targets `record` saves (§9.4): id, else label, else text.
// The fourth is the role and a position bucket. A signature never uses a point.

/** Text in a signature is cut here, after redaction (§25.3). */
export const SIGNATURE_TEXT_MAX = 80;
/** The grid the position bucket is taken on: 4 columns, 8 rows. */
export const BUCKET_COLUMNS = 4;
export const BUCKET_ROWS = 8;

export type SignatureTier = "id" | "label" | "text" | "role";

/** The pieces of an element that name it. A subset of `TreeElement`, so a test can pass a small object. */
export type NamedElement = Pick<TreeElement, "testID" | "label" | "text" | "role" | "frame" | "row">;

export interface Screen {
  width: number;
  height: number;
}

/** What `record` saves for an element: a target by `testID`, else `label`, else `text` (§9.4). Never a ref. */
export type NamedTarget = { testID: string } | { label: string } | { text: string };

const filled = (value: string | null | undefined): value is string => typeof value === "string" && value !== "";

/**
 * The first of an element's own names that it has (id, else label, else text), exactly as a script step saves it;
 * null when it has none of the three. This is the choice of the first three tiers of the signature.
 */
export function namedTarget(element: Pick<TreeElement, "testID" | "label" | "text">): NamedTarget | null {
  if (filled(element.testID)) return { testID: element.testID };
  if (filled(element.label)) return { label: element.label };
  if (filled(element.text)) return { text: element.text };
  return null;
}

/** `c<col>r<row>`: the centre of the frame on a 4 by 8 grid over the screen, from 0 at the top left. Null without a screen. */
export function positionBucket(frame: Frame, screen: Screen | null | undefined): string | null {
  if (screen === null || screen === undefined || !(screen.width > 0) || !(screen.height > 0)) return null;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const cell = (value: number, size: number, count: number): number => Math.min(count - 1, Math.max(0, Math.floor((value / size) * count)));
  return `c${cell(cx, screen.width, BUCKET_COLUMNS)}r${cell(cy, screen.height, BUCKET_ROWS)}`;
}

/** Cut at 80 characters (whole characters, never half of one). */
function cut(text: string): string {
  if (text.length <= SIGNATURE_TEXT_MAX) return text;
  const chars = Array.from(text);
  return chars.length <= SIGNATURE_TEXT_MAX ? text : chars.slice(0, SIGNATURE_TEXT_MAX).join("");
}

export interface SignatureOptions {
  screen?: Screen | null | undefined;
  /** Scrubs a value from text before it is kept (§20.3). Default: none. */
  redact?: ((text: string) => string) | undefined;
  /**
   * The frame for the role tier. For an element inside a scroll view it is the frame taken when the place was first read
   * after arriving, at the start of the list (§25.3). Default: the element's own frame.
   */
  frame?: Frame | null | undefined;
  /** 0-based index among the elements the signature also fits (see `sharedIndex`); the signature ends `#<index>`. */
  index?: number | undefined;
  /** A list row: the signature of its list and its number from 1. A row is never named by its text. */
  row?: { list: string; n: number } | undefined;
}

/**
 * The signature of an element, or null when it has no name and no place on the screen. The tiers: `id:`, `label:`,
 * `text:`, `role:<role>@<bucket>`. A row is `row:<signature of its list>#<n>` and needs `options.row`.
 */
export function signatureOf(element: NamedElement, options: SignatureOptions = {}): string | null {
  if (element.row === true) {
    // A row's text is content (§18.1): it is named by its list and number, or not at all.
    if (options.row === undefined || !Number.isInteger(options.row.n) || options.row.n < 1) return null;
    return `row:${options.row.list}#${options.row.n}`;
  }
  const redact = options.redact ?? ((text: string) => text);
  const own = (kind: "label" | "text", value: string): string => `${kind}:${cut(redact(value))}`;
  let base: string | null = null;
  if (filled(element.testID)) base = `id:${element.testID}`;
  else if (filled(element.label)) base = own("label", element.label);
  else if (filled(element.text)) base = own("text", element.text);
  else if (filled(element.role)) {
    const frame = options.frame ?? element.frame;
    const bucket = frame === null || frame === undefined ? null : positionBucket(frame, options.screen);
    if (bucket !== null) base = `role:${element.role}@${bucket}`;
  }
  if (base === null) return null;
  return options.index !== undefined ? `${base}#${options.index}` : base;
}

/** The tier an element is named by, or null when it has none. */
export function tierOf(element: NamedElement, options: Pick<SignatureOptions, "screen" | "frame"> = {}): SignatureTier | null {
  if (element.row === true) return null;
  if (filled(element.testID)) return "id";
  if (filled(element.label)) return "label";
  if (filled(element.text)) return "text";
  const frame = options.frame ?? element.frame;
  if (filled(element.role) && frame !== null && frame !== undefined && positionBucket(frame, options.screen) !== null) return "role";
  return null;
}

/** An element as a `{label}` target matches it: its accessibility label, else its text (the SDK's rule). */
const labelOf = (e: Pick<TreeElement, "label" | "text">): string => e.label ?? e.text ?? "";

/**
 * Whether two elements are named the same way at the tier the first one uses: the same testID, the same label (case
 * ignored, as a label target matches), the same text, or the same role in the same bucket.
 */
function sharesName(a: NamedElement, b: NamedElement, screen: Screen | null | undefined): boolean {
  if (filled(a.testID)) return b.testID === a.testID;
  if (filled(a.label)) return labelOf(b).toLowerCase() === a.label.toLowerCase();
  if (filled(a.text)) return b.text === a.text;
  const frameA = a.frame;
  const frameB = b.frame;
  if (!filled(a.role) || frameA === null || frameA === undefined || frameB === null || frameB === undefined) return false;
  return b.role === a.role && positionBucket(frameA, screen) === positionBucket(frameB, screen);
}

/**
 * The 0-based index of `element` among the elements (in list order) that share its name at its tier, as `record` saves
 * `index`. Undefined when it is the only one, or has no name. `elements` should hold the element itself, as the same object.
 */
export function sharedIndex(element: NamedElement, elements: readonly NamedElement[], screen?: Screen | null): number | undefined {
  if (element.row === true) return undefined;
  const same = elements.filter((other) => other.row !== true && sharesName(element, other, screen));
  if (same.length < 2) return undefined;
  const at = same.indexOf(element);
  return at < 0 ? undefined : at;
}

/**
 * Signatures for a whole list, each with its `#index` where several elements share a name. A row takes its name from
 * `rowOf` (its list's signature and its number); with none given a row has no signature. Null for an unnamed element.
 */
export function signaturesOf(
  elements: readonly NamedElement[],
  options: Omit<SignatureOptions, "index" | "row" | "frame"> & {
    rowOf?: (element: NamedElement) => { list: string; n: number } | undefined;
    frameOf?: (element: NamedElement) => Frame | null | undefined;
  } = {},
): Array<string | null> {
  const { rowOf, frameOf, ...rest } = options;
  return elements.map((element) => {
    const frame = frameOf?.(element);
    const index = sharedIndex(element, elements, rest.screen);
    return signatureOf(element, { ...rest, frame, index, row: rowOf?.(element) });
  });
}
