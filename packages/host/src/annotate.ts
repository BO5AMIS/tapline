import jpeg from "jpeg-js";
import type { TreeElement } from "./protocol.js";

/**
 * Labeled screenshots: draws each actionable element's box and its ref (for example "e12")
 * onto a JPEG screenshot, so a vision model can name elements by ref.
 */

export interface ShotImage {
  mime: string;
  data: string;
  width?: number;
  height?: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

type Rgb = readonly [number, number, number];

/** Saturated, high-contrast colours (white text stays readable on all of them). */
export const ANNOTATION_PALETTE: readonly Rgb[] = [
  [220, 20, 60], // crimson
  [0, 90, 255], // blue
  [0, 140, 60], // green
  [150, 40, 200], // purple
  [230, 100, 0], // orange
  [0, 130, 140], // teal
];

const JPEG_QUALITY = 80;
const OUTLINE = 2;
const WIDE_IMAGE = 500;
const MID_IMAGE = 280;
const GLYPH_W = 5;
const GLYPH_H = 7;

// 5x7 glyphs, one string per row, '#' = ink.
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
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

interface Canvas {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

function setPixel(canvas: Canvas, x: number, y: number, colour: Rgb): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i] = colour[0];
  canvas.data[i + 1] = colour[1];
  canvas.data[i + 2] = colour[2];
  canvas.data[i + 3] = 255;
}

function fillRect(canvas: Canvas, x: number, y: number, w: number, h: number, colour: Rgb): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvas.width, x + w);
  const y1 = Math.min(canvas.height, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPixel(canvas, xx, yy, colour);
  }
}

/** Outline drawn inside the rectangle's edges. */
function strokeRect(canvas: Canvas, x: number, y: number, w: number, h: number, thickness: number, colour: Rgb): void {
  const t = Math.min(thickness, Math.floor(w / 2), Math.floor(h / 2));
  if (t <= 0) {
    fillRect(canvas, x, y, w, h, colour);
    return;
  }
  fillRect(canvas, x, y, w, t, colour); // top
  fillRect(canvas, x, y + h - t, w, t, colour); // bottom
  fillRect(canvas, x, y + t, t, h - 2 * t, colour); // left
  fillRect(canvas, x + w - t, y + t, t, h - 2 * t, colour); // right
}

const WHITE: Rgb = [255, 255, 255];

function drawLabel(canvas: Canvas, text: string, frameX: number, frameY: number, colour: Rgb): void {
  const glyphs = [...text].map((ch) => GLYPHS[ch]);
  if (glyphs.some((g) => g === undefined)) return;
  // Big enough to read on a phone screenshot (a vision model found 2x on 600 px too small).
  const scale = canvas.width >= WIDE_IMAGE ? 3 : canvas.width >= MID_IMAGE ? 2 : 1;
  const pad = scale;
  const spacing = scale; // 1 px of the 1x grid between glyphs
  const textW = glyphs.length * GLYPH_W * scale + Math.max(0, glyphs.length - 1) * spacing;
  const boxW = textW + 2 * pad;
  const boxH = GLYPH_H * scale + 2 * pad;
  // Keep the whole label inside the image: shift left/down when the frame touches an edge.
  const boxX = Math.max(0, Math.min(frameX, canvas.width - boxW));
  const boxY = Math.max(0, Math.min(frameY, canvas.height - boxH));
  fillRect(canvas, boxX, boxY, boxW, boxH, colour);
  let cursor = boxX + pad;
  for (const glyph of glyphs) {
    if (glyph === undefined) continue;
    for (let row = 0; row < GLYPH_H; row++) {
      const line = glyph[row] ?? "";
      for (let col = 0; col < GLYPH_W; col++) {
        if (line[col] === "#") fillRect(canvas, cursor + col * scale, boxY + pad + row * scale, scale, scale, WHITE);
      }
    }
    cursor += GLYPH_W * scale + spacing;
  }
}

function isLabelled(element: TreeElement): boolean {
  if (!element.frame) return false;
  return (element.actions ?? []).some((action) => action !== "scroll");
}

export function annotateScreenshot(shot: ShotImage, elements: TreeElement[], screen: ScreenSize): ShotImage {
  if (shot.mime !== "image/jpeg") return shot;
  if (!(screen.width > 0) || !(screen.height > 0)) return shot;

  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(Buffer.from(shot.data, "base64"), { useTArray: true });
  } catch {
    return shot;
  }
  if (decoded.width <= 0 || decoded.height <= 0) return shot;

  const canvas: Canvas = { width: decoded.width, height: decoded.height, data: decoded.data };
  const scale = canvas.width / screen.width;

  let index = 0;
  for (const element of elements) {
    const frame = element.frame;
    if (!frame || !isLabelled(element)) continue;
    const x = Math.round(frame.x * scale);
    const y = Math.round(frame.y * scale);
    const w = Math.max(1, Math.round(frame.width * scale));
    const h = Math.max(1, Math.round(frame.height * scale));
    if (x >= canvas.width || y >= canvas.height || x + w <= 0 || y + h <= 0) continue;
    const colour = ANNOTATION_PALETTE[index % ANNOTATION_PALETTE.length];
    index++;
    if (!colour) continue;
    strokeRect(canvas, x, y, w, h, OUTLINE, colour);
    drawLabel(canvas, element.ref, x, y, colour);
  }

  const encoded = jpeg.encode({ data: canvas.data, width: canvas.width, height: canvas.height }, JPEG_QUALITY);
  return {
    mime: "image/jpeg",
    data: encoded.data.toString("base64"),
    width: canvas.width,
    height: canvas.height,
  };
}
