import { decode } from "jpeg-js";

/**
 * The "picture changed" rule, agreed with the other tool (do not change it alone):
 *
 *  1. Decode both JPEGs to RGBA.
 *  2. Different width or height: they differ.
 *  3. Otherwise look at every 16th byte of the RGBA data, that is the first byte (R) of every
 *     4th pixel, and the byte after it (G). Count the samples with |dR| + |dG| > 40.
 *  4. They differ when that count is more than 20.
 */
export const SAMPLE_STRIDE = 16;
export const CHANNEL_DELTA = 40;
export const MIN_CHANGED_SAMPLES = 20;

export interface DecodedFrame {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export function decodeFrame(jpeg: Uint8Array): DecodedFrame {
  const img = decode(jpeg, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
}

export function decodedDiffer(a: DecodedFrame, b: DecodedFrame): boolean {
  if (a.width !== b.width || a.height !== b.height) return true;
  const n = Math.min(a.data.length, b.data.length);
  let changed = 0;
  for (let i = 0; i + 1 < n; i += SAMPLE_STRIDE) {
    const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    if (dr + dg > CHANNEL_DELTA) {
      changed++;
      if (changed > MIN_CHANGED_SAMPLES) return true;
    }
  }
  return false;
}

/** A rectangle in fractions (0..1) of the frame. */
export interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * V1's rule (QUALITY-BAR V1: a fixed crop around the lab's tap counter, changed above a pixel
 * threshold). A one-digit change moves a whole frame very little, so only the crop is compared:
 * every pixel in it, changed when |dR| + |dG| > 40, and the crop changed when more than
 * max(20, 0.1% of its pixels) did. Different frame sizes count as changed.
 */
export function cropDiffer(a: DecodedFrame, b: DecodedFrame, crop: Crop): boolean {
  if (a.width !== b.width || a.height !== b.height) return true;
  const x0 = Math.max(0, Math.floor(crop.x0 * a.width));
  const x1 = Math.min(a.width, Math.ceil(crop.x1 * a.width));
  const y0 = Math.max(0, Math.floor(crop.y0 * a.height));
  const y1 = Math.min(a.height, Math.ceil(crop.y1 * a.height));
  const pixels = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const need = Math.max(MIN_CHANGED_SAMPLES, Math.floor(pixels / 1000));
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
      const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
      if (dr + dg > CHANNEL_DELTA && ++changed > need) return true;
    }
  }
  return false;
}

/** True when two JPEGs show different pictures by the rule above. */
export function framesDiffer(a: Uint8Array, b: Uint8Array): boolean {
  return decodedDiffer(decodeFrame(a), decodeFrame(b));
}
