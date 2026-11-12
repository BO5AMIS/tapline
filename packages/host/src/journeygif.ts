import gifencDefault, * as gifencNamespace from "gifenc";
import { markRing, scaleToWidth, type Pixels } from "./images.js";

/**
 * The journey's GIF (AGENT-TOOLS 1.12 §17.5): 360 px wide, about two frames a second across still stretches and
 * real time across transitions, each tap drawn as a ring on the screen it was made on, at most 3 MB.
 */

type Gifenc = typeof gifencDefault;

function isGifenc(value: unknown): value is Gifenc {
  return typeof value === "object" && value !== null && "GIFEncoder" in value && typeof value.GIFEncoder === "function" && "quantize" in value && "applyPalette" in value;
}

/** gifenc is CommonJS with a `default` of its own: Node hands over its exports as the default, bundlers and test runners as the module. */
function loadGifenc(): Gifenc {
  const inner: unknown = typeof gifencDefault === "object" && gifencDefault !== null && "default" in gifencDefault ? gifencDefault.default : undefined;
  for (const candidate of [gifencDefault, inner, gifencNamespace] as unknown[]) if (isGifenc(candidate)) return candidate;
  throw new Error("The GIF encoder (gifenc) could not be loaded.");
}

const gifenc = loadGifenc();

export const GIF_WIDTH = 360;
export const GIF_MAX_BYTES = 3 * 1024 * 1024;
/** A still stretch shows its frame this long at most (two frames a second); closer frames keep their real gap. */
const STILL_MS = 500;
const MIN_DELAY_MS = 40;
const RING_MS = 350;
const LAST_MS = 1500;
/** Time handed to the frame before when a frame is dropped, at most. */
const MERGED_MS = 1200;
const COLOURS = 128;

/** One kept frame: the screen after a step, when it was taken, and where the step touched (shares of the screen). */
export interface GifFrame {
  pixels: Pixels;
  at: number;
  tap?: { x: number; y: number };
}

export interface GifResult {
  bytes: Uint8Array;
  /** Pictures in the file (frames and tap rings). */
  frames: number;
  width: number;
  height: number;
  /** Pictures dropped to stay under the cap. */
  dropped: number;
  /** The cap needed the pictures at half the size. */
  shrunk: boolean;
}

interface Slide {
  pixels: Pixels;
  delay: number;
  /** A frame of a still stretch: the first to go when the file is too big. */
  still: boolean;
  /** The screen before a tap, with the ring drawn on it. */
  ring: boolean;
}

interface Coded {
  palette: number[][];
  index: Uint8Array;
}

/** The frames made the same size as the first one. */
export function fitted(frames: GifFrame[], width: number): GifFrame[] {
  const first = frames[0];
  if (first === undefined) return [];
  const scaledFirst = scaleToWidth(first.pixels, width);
  const height = scaledFirst.height;
  return frames.map((frame, i) => {
    const scaled = i === 0 ? scaledFirst : scaleToWidth(frame.pixels, width);
    if (scaled.height === height) return { ...frame, pixels: scaled };
    // Another shape (the phone turned): the whole picture is fitted inside the canvas, centred, never cropped.
    const k = Math.min(width / frame.pixels.width, height / frame.pixels.height);
    const inner = scaleToWidth(frame.pixels, Math.max(1, Math.round(frame.pixels.width * k)));
    const data = new Uint8Array(width * height * 4).fill(255);
    const left = Math.max(0, Math.floor((width - inner.width) / 2));
    const top = Math.max(0, Math.floor((height - inner.height) / 2));
    const rows = Math.min(inner.height, height - top);
    const columns = Math.min(inner.width, width - left);
    for (let y = 0; y < rows; y++) {
      data.set(inner.data.subarray(y * inner.width * 4, (y * inner.width + columns) * 4), ((top + y) * width + left) * 4);
    }
    return { ...frame, pixels: { width, height, data } };
  });
}

function slidesOf(frames: GifFrame[]): Slide[] {
  const slides: Slide[] = [];
  frames.forEach((frame, i) => {
    const previous = frames[i - 1];
    if (frame.tap !== undefined) {
      // The tap was made on the screen before it: the ring goes there, a moment before the result.
      slides.push({ pixels: markRing(previous?.pixels ?? frame.pixels, frame.tap), delay: RING_MS, still: false, ring: true });
    }
    const next = frames[i + 1];
    const gap = next === undefined ? LAST_MS : Math.max(0, next.at - frame.at);
    slides.push({
      pixels: frame.pixels,
      delay: next === undefined ? LAST_MS : Math.min(STILL_MS, Math.max(MIN_DELAY_MS, gap)),
      still: next !== undefined && gap > STILL_MS,
      ring: false,
    });
  });
  return slides;
}

/** Every second one of `indexes` (or the only one), dropped; the time goes to the picture before. */
function dropHalf(slides: Slide[], indexes: number[]): Slide[] | null {
  if (indexes.length === 0) return null;
  const gone = new Set(indexes.length === 1 ? indexes : indexes.filter((_, n) => n % 2 === 1));
  const kept: Slide[] = [];
  slides.forEach((slide, i) => {
    if (!gone.has(i)) {
      kept.push(slide);
      return;
    }
    const before = kept[kept.length - 1];
    if (before !== undefined) kept[kept.length - 1] = { ...before, delay: Math.min(MERGED_MS, before.delay + slide.delay) };
  });
  return kept;
}

/** Fewer pictures: the still ones first, then every second one but the first and the last; null when there is nothing left to drop. */
function shrink(slides: Slide[]): Slide[] | null {
  const inner = slides.map((_, i) => i).filter((i) => i > 0 && i < slides.length - 1);
  const still = inner.filter((i) => slides[i]?.still === true);
  return dropHalf(slides, still) ?? dropHalf(slides, inner);
}

/** How the frames are laid out in time (for tests): each picture's delay in ms, whether it is a still stretch, whether it is a tap ring. */
export function slidePlan(frames: GifFrame[]): Array<{ delay: number; still: boolean; ring: boolean }> {
  return slidesOf([...frames].sort((a, b) => a.at - b.at)).map(({ delay, still, ring }) => ({ delay, still, ring }));
}

function encode(slides: Slide[], coded: Map<Pixels, Coded>): Uint8Array {
  const first = slides[0];
  if (first === undefined) throw new Error("There are no frames for a GIF.");
  const encoder = gifenc.GIFEncoder();
  const { width, height } = first.pixels;
  for (const slide of slides) {
    let entry = coded.get(slide.pixels);
    if (entry === undefined) {
      const palette = gifenc.quantize(slide.pixels.data, COLOURS, { format: "rgb444" });
      entry = { palette, index: gifenc.applyPalette(slide.pixels.data, palette, "rgb444") };
      coded.set(slide.pixels, entry);
    }
    encoder.writeFrame(entry.index, width, height, { palette: entry.palette, delay: slide.delay, repeat: 0 });
  }
  encoder.finish();
  return encoder.bytes();
}

/** The GIF of a journey. `maxBytes` and `width` are for tests; the defaults are the spec's (3 MB, 360 px). */
export function encodeJourneyGif(frames: GifFrame[], options: { maxBytes?: number; width?: number } = {}): GifResult {
  if (frames.length === 0) throw new Error("There are no frames for a GIF.");
  const maxBytes = options.maxBytes ?? GIF_MAX_BYTES;
  let width = options.width ?? GIF_WIDTH;
  let shrunk = false;
  let ordered = [...frames].sort((a, b) => a.at - b.at);
  for (;;) {
    let slides = slidesOf(fitted(ordered, width));
    const total = slides.length;
    const coded = new Map<Pixels, Coded>();
    let bytes = encode(slides, coded);
    while (bytes.length > maxBytes) {
      const fewer = shrink(slides);
      if (fewer === null) break;
      slides = fewer;
      bytes = encode(slides, coded);
    }
    const first = slides[0];
    if (bytes.length <= maxBytes || width <= 90 || first === undefined) {
      return { bytes, frames: slides.length, width: first?.pixels.width ?? width, height: first?.pixels.height ?? 0, dropped: total - slides.length, shrunk };
    }
    // Even two pictures are over the cap: the same pictures at half the size.
    width = Math.max(90, Math.round(width / 2));
    shrunk = true;
    ordered = ordered.map((frame) => ({ ...frame, pixels: scaleToWidth(frame.pixels, width) }));
  }
}

export interface GifInfo {
  version: string;
  width: number;
  height: number;
  frames: number;
  /** 0 = forever; undefined when the file says nothing. */
  loops: number | undefined;
}

/** Reads a GIF's header and counts its pictures by walking its blocks; throws when it isn't one. */
export function gifInfo(bytes: Uint8Array): GifInfo {
  const text = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  const head = text(0, 6);
  if (!/^GIF8[79]a$/.test(head)) throw new Error("not a GIF");
  const u16 = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const width = u16(6);
  const height = u16(8);
  const packed = bytes[10] ?? 0;
  let at = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let frames = 0;
  let loops: number | undefined;
  const skipBlocks = (): void => {
    while (at < bytes.length && (bytes[at] ?? 0) !== 0) at += (bytes[at] ?? 0) + 1;
    at += 1;
  };
  while (at < bytes.length) {
    const marker = bytes[at];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[at + 1];
      if (label === 0xff && text(at + 3, at + 14) === "NETSCAPE2.0") loops = u16(at + 16);
      at += 2;
      skipBlocks();
    } else if (marker === 0x2c) {
      const flags = bytes[at + 9] ?? 0;
      at += 10 + ((flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      at += 1; // the LZW minimum code size
      skipBlocks();
      frames++;
    } else throw new Error("not a GIF");
  }
  return { version: head, width, height, frames, loops };
}
