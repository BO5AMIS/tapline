import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { ANNOTATION_PALETTE, annotateScreenshot } from "../src/annotate.js";
import type { TreeElement } from "../src/protocol.js";

const WIDTH = 300;
const HEIGHT = 600;
const SCREEN = { width: 150, height: 300 };
const GREY = 128;

function greyShot(width = WIDTH, height = HEIGHT) {
  const data = Buffer.alloc(width * height * 4, GREY);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const encoded = jpeg.encode({ data, width, height }, 90);
  return { mime: "image/jpeg", data: encoded.data.toString("base64"), width, height };
}

function decode(shot: { data: string }) {
  return jpeg.decode(Buffer.from(shot.data, "base64"), { useTArray: true });
}

type Rgb = [number, number, number];

function pixel(img: { width: number; data: Uint8Array }, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

function near(actual: Rgb, expected: Rgb, tolerance = 40): boolean {
  return actual.every((channel, i) => Math.abs(channel - (expected[i] ?? 0)) <= tolerance);
}

function whitePixels(
  img: { width: number; data: Uint8Array },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pixel(img, x, y).every((c) => c > 180)) count++;
    }
  }
  return count;
}

function element(ref: string, frame: TreeElement["frame"], actions: string[] | null): TreeElement {
  return { ref, type: "Pressable", role: null, text: null, frame, actions };
}

describe("annotateScreenshot", () => {
  it("draws the box outline and a white ref label, leaving the inside untouched", () => {
    const shot = greyShot();
    const out = annotateScreenshot(shot, [element("e3", { x: 20, y: 40, width: 60, height: 30 }, ["press"])], SCREEN);
    expect(out.mime).toBe("image/jpeg");
    expect(out.width).toBe(WIDTH);
    expect(out.height).toBe(HEIGHT);
    const img = decode(out);
    expect(img.width).toBe(WIDTH);
    expect(img.height).toBe(HEIGHT);
    const colour = ANNOTATION_PALETTE[0];
    expect(colour).toBeDefined();
    // Frame in pixels: x 40..160, y 80..140. Outline is 2px, inside the frame.
    expect(near(pixel(img, 100, 139), colour as Rgb)).toBe(true); // bottom edge
    expect(near(pixel(img, 159, 110), colour as Rgb)).toBe(true); // right edge
    expect(near(pixel(img, 100, 110), [GREY, GREY, GREY], 20)).toBe(true); // centre
    expect(near(pixel(img, 100, 142), [GREY, GREY, GREY], 20)).toBe(true); // just outside
    // Label at the top-left corner (1x glyphs on a 300px image).
    expect(whitePixels(img, 40, 80, 56, 92)).toBeGreaterThan(4);
  });

  it("does not draw scroll-only, action-less or frameless elements", () => {
    const shot = greyShot();
    const out = annotateScreenshot(
      shot,
      [
        element("e1", { x: 10, y: 200, width: 40, height: 40 }, ["scroll"]),
        element("e2", { x: 60, y: 200, width: 40, height: 40 }, []),
        element("e4", { x: 100, y: 200, width: 40, height: 40 }, null),
        element("e5", null, ["press"]),
      ],
      SCREEN,
    );
    const img = decode(out);
    const grey: Rgb = [GREY, GREY, GREY];
    for (const fx of [10, 60, 100]) {
      const px = fx * 2;
      for (const [dx, dy] of [
        [0, 0],
        [1, 1],
        [40, 0],
        [40, 79],
        [79, 40],
        [5, 5],
      ] as const) {
        expect(near(pixel(img, px + dx, 400 + dy), grey, 15)).toBe(true);
      }
    }
  });

  it("keeps the label inside the image when the element touches the right edge", () => {
    const shot = greyShot();
    // Frame starts at pixel 296 and runs past the right edge (300).
    const out = annotateScreenshot(shot, [element("e12", { x: 148, y: 100, width: 20, height: 30 }, ["press"])], SCREEN);
    const img = decode(out);
    expect(img.width).toBe(WIDTH);
    // The label shifts left; its white glyph pixels must be inside the image, left of x=296.
    expect(whitePixels(img, 270, 200, 299, 216)).toBeGreaterThan(4);
  });

  it("keeps the label inside the image when the element touches the top edge", () => {
    const shot = greyShot();
    const out = annotateScreenshot(shot, [element("e7", { x: 20, y: -4, width: 40, height: 30 }, ["press"])], SCREEN);
    const img = decode(out);
    expect(whitePixels(img, 40, 0, 60, 14)).toBeGreaterThan(4);
  });

  it("skips elements completely outside the image", () => {
    const shot = greyShot();
    const out = annotateScreenshot(shot, [element("e9", { x: 500, y: 500, width: 40, height: 30 }, ["press"])], SCREEN);
    const img = decode(out);
    expect(near(pixel(img, 150, 300), [GREY, GREY, GREY], 15)).toBe(true);
  });

  it("returns non-JPEG input unchanged", () => {
    const shot = { mime: "image/png", data: "AAAA", width: 10, height: 10 };
    const out = annotateScreenshot(shot, [element("e1", { x: 0, y: 0, width: 5, height: 5 }, ["press"])], SCREEN);
    expect(out).toBe(shot);
  });

  it("returns the input unchanged when the data is not a decodable JPEG", () => {
    const shot = { mime: "image/jpeg", data: Buffer.from("not a jpeg").toString("base64") };
    const out = annotateScreenshot(shot, [element("e1", { x: 0, y: 0, width: 5, height: 5 }, ["press"])], SCREEN);
    expect(out).toBe(shot);
  });
});
