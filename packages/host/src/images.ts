import jpeg from "jpeg-js";
import type { ShotImage } from "./annotate.js";

/**
 * Visual QA helpers for phone screenshots (JPEG, base64 in and out):
 * `diffImages` marks what changed between two screenshots, `composeFilmstrip` lays several
 * screenshots side by side so a model can read a sequence from a single image.
 */

export type { ShotImage };

export interface DiffBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OutputImage {
  mime: "image/jpeg";
  data: string;
  width: number;
  height: number;
}

export interface DiffResult {
  width: number;
  height: number;
  changedPixels: number;
  changedPercent: number;
  boxes: DiffBox[];
  image: OutputImage;
}

export interface DiffOptions {
  /** Colour distance (0..1) a pixel must exceed to count as changed. Default 0.1. */
  threshold?: number;
  /** Pixel rectangles painted out (one flat colour) on both pictures before they are compared. */
  mask?: DiffBox[];
}

export interface FilmstripOptions {
  columns?: number;
  frameWidth?: number;
  gap?: number;
  labels?: boolean;
}

type Rgb = readonly [number, number, number];

interface Decoded {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

const JPEG_QUALITY = 80;
const CELL = 16;
const MAX_BOXES = 10;
const DEFAULT_THRESHOLD = 0.1;
const DIM_TOWARDS_WHITE = 0.6;
const OUTLINE = 2;
const RED: Rgb = [255, 0, 0];
/** How much red covers a changed pixel (0..1); the rest is the new content. */
const RED_TINT = 0.55;
const WHITE: Rgb = [255, 255, 255];
const MASK_COLOUR: Rgb = [128, 128, 128];
const LABEL_BOX: Rgb = [30, 30, 30];
const GLYPH_W = 5;
const GLYPH_H = 7;
const LARGE_FRAME = 150;

// 5x7 digit glyphs, one string per row, '#' = ink.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
};

function decodeJpeg(shot: ShotImage, what: string): Decoded {
  if (shot.mime !== "image/jpeg") {
    throw new Error(`${what} is not a JPEG (it is ${shot.mime || "of unknown type"}).`);
  }
  let decoded: Decoded;
  try {
    decoded = jpeg.decode(Buffer.from(shot.data, "base64"), { useTArray: true });
  } catch {
    throw new Error(`${what} could not be read as a JPEG.`);
  }
  if (!(decoded.width > 0) || !(decoded.height > 0)) {
    throw new Error(`${what} could not be read as a JPEG.`);
  }
  return decoded;
}

/** The size in pixels of a JPEG; throws when it can't be read. */
export function imageSize(shot: ShotImage): { width: number; height: number } {
  const { width, height } = decodeJpeg(shot, "The picture");
  return { width, height };
}

function encodeJpeg(canvas: Decoded): OutputImage {
  const encoded = jpeg.encode({ data: canvas.data, width: canvas.width, height: canvas.height }, JPEG_QUALITY);
  return {
    mime: "image/jpeg",
    data: encoded.data.toString("base64"),
    width: canvas.width,
    height: canvas.height,
  };
}

function setPixel(canvas: Decoded, x: number, y: number, colour: Rgb): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i] = colour[0];
  canvas.data[i + 1] = colour[1];
  canvas.data[i + 2] = colour[2];
  canvas.data[i + 3] = 255;
}

function fillRect(canvas: Decoded, x: number, y: number, w: number, h: number, colour: Rgb): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvas.width, x + w);
  const y1 = Math.min(canvas.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPixel(canvas, xx, yy, colour);
  }
}

/** Outline drawn inside the rectangle's edges. */
function strokeRect(canvas: Decoded, x: number, y: number, w: number, h: number, thickness: number, colour: Rgb): void {
  const t = Math.min(thickness, Math.floor(w / 2), Math.floor(h / 2));
  if (t <= 0) {
    fillRect(canvas, x, y, w, h, colour);
    return;
  }
  fillRect(canvas, x, y, w, t, colour);
  fillRect(canvas, x, y + h - t, w, t, colour);
  fillRect(canvas, x, y + t, t, h - 2 * t, colour);
  fillRect(canvas, x + w - t, y + t, t, h - 2 * t, colour);
}

// ---------------------------------------------------------------------------------------------
// diffImages
// ---------------------------------------------------------------------------------------------

function regionsFromMask(mask: Uint8Array, width: number, height: number): DiffBox[] {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const marked = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cellRow = Math.floor(y / CELL) * cols;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) marked[cellRow + Math.floor(x / CELL)] = 1;
    }
  }

  const seen = new Uint8Array(cols * rows);
  const boxes: DiffBox[] = [];
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    let minC = cols;
    let maxC = -1;
    let minR = rows;
    let maxR = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop();
      if (cell === undefined) break;
      const cx = cell % cols;
      const cy = Math.floor(cell / cols);
      minC = Math.min(minC, cx);
      maxC = Math.max(maxC, cx);
      minR = Math.min(minR, cy);
      maxR = Math.max(maxR, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const next = ny * cols + nx;
          if (marked[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    const x = minC * CELL;
    const y = minR * CELL;
    boxes.push({
      x,
      y,
      width: Math.min(width, (maxC + 1) * CELL) - x,
      height: Math.min(height, (maxR + 1) * CELL) - y,
    });
  }
  boxes.sort((a, b) => b.width * b.height - a.width * a.height);
  return boxes.slice(0, MAX_BOXES);
}

export function diffImages(before: ShotImage, after: ShotImage, options: DiffOptions = {}): DiffResult {
  const a = decodeJpeg(before, "The first screenshot");
  const b = decodeJpeg(after, "The second screenshot");
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `The screenshots differ in size (${a.width}x${a.height} vs ${b.width}x${b.height}); take both at the same width.`,
    );
  }

  for (const m of options.mask ?? []) {
    fillRect(a, m.x, m.y, m.width, m.height, MASK_COLOUR);
    fillRect(b, m.x, m.y, m.width, m.height, MASK_COLOUR);
  }

  const { width, height } = b;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const total = width * height;
  const mask = new Uint8Array(total);
  let changedPixels = 0;
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    const db = Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (Math.max(dr, dg, db) / 255 > threshold) {
      mask[p] = 1;
      changedPixels++;
    }
  }
  const changedPercent = Math.round((changedPixels / total) * 100 * 100) / 100;
  const boxes = regionsFromMask(mask, width, height);

  // The "after" picture, dimmed, with changes tinted red: the new content stays readable under it.
  const out: Decoded = { width, height, data: new Uint8Array(total * 4) };
  for (let p = 0; p < total; p++) {
    const i = p * 4;
    if (mask[p]) {
      for (let c = 0; c < 3; c++) {
        const v = b.data[i + c] ?? 0;
        out.data[i + c] = Math.round(v * (1 - RED_TINT) + (RED[c] ?? 0) * RED_TINT);
      }
    } else {
      for (let c = 0; c < 3; c++) {
        const v = b.data[i + c] ?? 0;
        out.data[i + c] = Math.round(v + (255 - v) * DIM_TOWARDS_WHITE);
      }
    }
    out.data[i + 3] = 255;
  }
  for (const box of boxes) strokeRect(out, box.x, box.y, box.width, box.height, OUTLINE, RED);

  return { width, height, changedPixels, changedPercent, boxes, image: encodeJpeg(out) };
}

// ---------------------------------------------------------------------------------------------
// composeFilmstrip
// ---------------------------------------------------------------------------------------------

/** Box-average downscale (or nearest-neighbour upscale) of `src` into a w x h block at (ox, oy). */
function drawScaled(canvas: Decoded, src: Decoded, ox: number, oy: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const sy0 = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    const sy1 = Math.max(sy0 + 1, Math.min(src.height, Math.floor(((y + 1) * src.height) / h)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const sx1 = Math.max(sx0 + 1, Math.min(src.width, Math.floor(((x + 1) * src.width) / w)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i] ?? 0;
          g += src.data[i + 1] ?? 0;
          b += src.data[i + 2] ?? 0;
          n++;
        }
      }
      setPixel(canvas, ox + x, oy + y, [Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    }
  }
}

function drawNumberLabel(canvas: Decoded, text: string, x: number, y: number, scale: number): void {
  const glyphs = [...text].map((ch) => GLYPHS[ch]);
  const pad = scale;
  const spacing = scale;
  const textW = glyphs.length * GLYPH_W * scale + Math.max(0, glyphs.length - 1) * spacing;
  fillRect(canvas, x, y, textW + 2 * pad, GLYPH_H * scale + 2 * pad, LABEL_BOX);
  let cursor = x + pad;
  for (const glyph of glyphs) {
    if (glyph) {
      for (let row = 0; row < GLYPH_H; row++) {
        const line = glyph[row] ?? "";
        for (let col = 0; col < GLYPH_W; col++) {
          if (line[col] === "#") fillRect(canvas, cursor + col * scale, y + pad + row * scale, scale, scale, WHITE);
        }
      }
    }
    cursor += GLYPH_W * scale + spacing;
  }
}

function positiveInt(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

export function composeFilmstrip(frames: ShotImage[], options: FilmstripOptions = {}): OutputImage {
  if (frames.length === 0) throw new Error("There are no screenshots to put in a filmstrip.");

  const frameWidth = positiveInt(options.frameWidth, 200, 1);
  const gap = positiveInt(options.gap, 8, 0);
  const columns = Math.min(positiveInt(options.columns, 3, 1), frames.length);
  const labels = options.labels ?? true;

  const decoded = frames.map((frame, index) => decodeJpeg(frame, `Screenshot ${index + 1}`));
  const heights = decoded.map((d) => Math.max(1, Math.round((frameWidth * d.height) / d.width)));
  const rows = Math.ceil(decoded.length / columns);

  const rowHeights: number[] = [];
  for (let r = 0; r < rows; r++) {
    rowHeights.push(Math.max(...heights.slice(r * columns, (r + 1) * columns)));
  }

  const width = columns * frameWidth + (columns + 1) * gap;
  const height = rowHeights.reduce((sum, h) => sum + h, 0) + (rows + 1) * gap;
  const canvas: Decoded = { width, height, data: new Uint8Array(width * height * 4).fill(255) };

  const labelScale = frameWidth >= LARGE_FRAME ? 2 : 1;
  let top = gap;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const index = r * columns + c;
      const frame = decoded[index];
      const frameHeight = heights[index];
      if (!frame || frameHeight === undefined) continue;
      const left = gap + c * (frameWidth + gap);
      drawScaled(canvas, frame, left, top, frameWidth, frameHeight);
      if (labels) drawNumberLabel(canvas, String(index + 1), left, top, labelScale);
    }
    top += (rowHeights[r] ?? 0) + gap;
  }

  return encodeJpeg(canvas);
}
