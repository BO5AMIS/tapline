import { z } from "zod";
import type { Frame, TreeElement } from "./protocol.js";

// A step's `seen` (AGENT-TOOLS 1.16 §9.4, §26.3, §26.6): the element's facts when `record` saved the step, so that a repair can
// compare them with each candidate's. It holds four facts and never text: no label, no text, no value.

/** The 3 by 3 grid of `seen.bucket`: `c1` to `c3` by `r1` to `r3`, from 1 at the top left. It is not the 4 by 8 grid of §25.3. */
export const SEEN_GRID = 3;

/** The trailing words of an id that name what an element is, not what it is for (§9.4). */
export const ID_STEM_WORDS = ["btn", "button", "link", "tab", "row", "item", "cell", "switch", "toggle", "field", "input"] as const;

export const seenSchema = z
  .object({
    role: z.string().min(1).optional(),
    bucket: z.string().regex(/^c[1-3]r[1-3]$/).optional(),
    component: z.string().min(1).optional(),
    id_stem: z.string().min(1).optional(),
  })
  .strict();
export type Seen = z.infer<typeof seenSchema>;

const SEPARATOR = "[-_.\\s]";
const WORDS = ID_STEM_WORDS.join("|");
/** A trailing word after a separator (`save-button`), any case. */
const SEPARATED_WORD = new RegExp(`${SEPARATOR}+(?:${WORDS})$`, "i");
/** A trailing word that starts a camel-case word (`saveButton`): the capital is the separator. */
const CAMEL_WORD = new RegExp(`(?<=[a-z0-9])(?:${WORDS.replace(/\b[a-z]/g, (c) => c.toUpperCase())})$`);
const TRAILING_DIGITS = new RegExp(`${SEPARATOR}*\\d+$`);

/**
 * The stem of an id (§9.4): lower-cased, with trailing digits and trailing words from the list removed again and again, with
 * their separators (`save-button` gives `save`, `trip-row-1` gives `trip`). The whole id when nothing would be left; null for no id.
 */
export function idStemOf(id: string | null | undefined): string | null {
  if (typeof id !== "string" || id.trim() === "") return null;
  let rest = id.trim();
  for (;;) {
    const next = rest.replace(TRAILING_DIGITS, "").replace(SEPARATED_WORD, "").replace(CAMEL_WORD, "");
    if (next === rest) break;
    rest = next;
  }
  rest = rest.replace(new RegExp(`${SEPARATOR}+$`), "").toLowerCase();
  return rest === "" ? id.trim().toLowerCase() : rest;
}

interface Screen {
  width: number;
  height: number;
}

/** `c<col>r<row>`: the centre of the frame on a 3 by 3 grid over the screen, from 1 at the top left. Null without a usable screen. */
export function seenBucket(frame: Frame, screen: Screen | null | undefined): string | null {
  if (screen === null || screen === undefined || !(screen.width > 0) || !(screen.height > 0)) return null;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const cell = (value: number, size: number): number => Math.min(SEEN_GRID, Math.max(1, Math.floor((value / size) * SEEN_GRID) + 1));
  return `c${cell(cx, screen.width)}r${cell(cy, screen.height)}`;
}

/** Whether the centre of the element's frame lies inside another element that scrolls (a scroll view holds it). */
export function insideScroll(element: TreeElement, all: readonly TreeElement[]): boolean {
  const frame = element.frame;
  if (frame === null || frame === undefined) return false;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  return all.some((other) => {
    if (other.ref === element.ref || other.role !== "scroll" || other.frame === null || other.frame === undefined) return false;
    const f = other.frame;
    return cx >= f.x && cx <= f.x + f.width && cy >= f.y && cy <= f.y + f.height;
  });
}

const filled = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";

/**
 * The facts of an element for a step's `seen`; null when it has none of them. `all` is the screen's elements (for the scroll
 * views) and `screen` its size: without both, no bucket is written (the part is then absent, as for an element in a scroll view).
 */
export function seenOf(element: TreeElement, all: readonly TreeElement[] | null, screen: Screen | null | undefined): Seen | null {
  const seen: Seen = {};
  if (filled(element.role)) seen.role = element.role;
  if (all !== null && element.frame !== null && element.frame !== undefined && !insideScroll(element, all)) {
    const bucket = seenBucket(element.frame, screen);
    if (bucket !== null) seen.bucket = bucket;
  }
  if (filled(element.type)) seen.component = element.type;
  const stem = idStemOf(element.testID);
  if (stem !== null) seen.id_stem = stem;
  return Object.keys(seen).length === 0 ? null : seen;
}

/** A step's `seen` as saved, or undefined when it has none or isn't in the shape (an unknown or broken one is ignored, never trusted). */
export function readSeen(step: unknown): Seen | undefined {
  if (typeof step !== "object" || step === null || !("seen" in step)) return undefined;
  const parsed = seenSchema.safeParse((step as { seen: unknown }).seen);
  return parsed.success ? parsed.data : undefined;
}
