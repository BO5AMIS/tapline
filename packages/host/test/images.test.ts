import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { composeFilmstrip, diffImages } from "../src/images.js";

type Rgb = [number, number, number];
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  colour: Rgb;
}

const GREY = 128;

function makeShot(width: number, height: number, rects: Rect[] = [], base: Rgb = [GREY, GREY, GREY]) {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = base[0];
    data[i * 4 + 1] = base[1];
    data[i * 4 + 2] = base[2];
  }
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * width + x) * 4;
        data[i] = r.colour[0];
        data[i + 1] = r.colour[1];
        data[i + 2] = r.colour[2];
      }
    }
  }
  const encoded = jpeg.encode({ data, width, height }, 95);
  return { mime: "image/jpeg", data: encoded.data.toString("base64") };
}

function decode(shot: { data: string }) {
  return jpeg.decode(Buffer.from(shot.data, "base64"), { useTArray: true });
}

function pixel(img: { width: number; data: Uint8Array }, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

const BLACK: Rgb = [0, 0, 0];

describe("diffImages", () => {
  it("reports nothing for identical images", () => {
    const a = makeShot(200, 300);
    const result = diffImages(a, a);
    expect(result.changedPixels).toBe(0);
    expect(result.changedPercent).toBe(0);
    expect(result.boxes).toEqual([]);
    expect(result.width).toBe(200);
    expect(result.height).toBe(300);
    expect(result.image.mime).toBe("image/jpeg");
    expect(result.image.width).toBe(200);
    expect(result.image.height).toBe(300);
  });

  it("finds one 40x40 square changed in a corner", () => {
    const before = makeShot(200, 300);
    const after = makeShot(200, 300, [{ x: 16, y: 16, w: 40, h: 40, colour: BLACK }]);
    const result = diffImages(before, after);
    const expected = (40 * 40 * 100) / (200 * 300); // 2.67 %
    expect(result.changedPercent).toBeGreaterThan(expected - 0.5);
    expect(result.changedPercent).toBeLessThan(expected + 0.5);
    expect(Math.round(result.changedPercent * 100)).toBeCloseTo(result.changedPercent * 100, 6);
    expect(result.boxes).toHaveLength(1);
    const box = result.boxes[0];
    expect(box).toBeDefined();
    if (!box) return;
    expect(Math.abs(box.x - 16)).toBeLessThanOrEqual(16);
    expect(Math.abs(box.y - 16)).toBeLessThanOrEqual(16);
    expect(box.x + box.width).toBeGreaterThanOrEqual(56);
    expect(box.y + box.height).toBeGreaterThanOrEqual(56);
    expect(box.width).toBeLessThanOrEqual(40 + 32);
    expect(box.height).toBeLessThanOrEqual(40 + 32);

    const out = decode(result.image);
    const inside = pixel(out, 36, 36);
    expect(inside[0]).toBeGreaterThan(inside[1] + 80);
    expect(inside[0]).toBeGreaterThan(inside[2] + 80);
    const outside = pixel(out, 150, 250);
    // 128 blended 60 % towards white is about 204.
    for (const c of outside) expect(c).toBeGreaterThan(185);
  });

  it("tints changes red but keeps the new content readable", () => {
    const before = makeShot(200, 300);
    const after = makeShot(200, 300, [
      { x: 20, y: 20, w: 30, h: 60, colour: BLACK },
      { x: 50, y: 20, w: 30, h: 60, colour: [255, 255, 255] },
    ]);
    const out = decode(diffImages(before, after).image);
    const dark = pixel(out, 35, 50);
    const light = pixel(out, 65, 50);
    for (const p of [dark, light]) expect(p[0]).toBeGreaterThan(p[2] + 60); // red-tinted
    expect(light[1]).toBeGreaterThan(dark[1] + 60); // dark text stays darker than its background
  });

  it("returns two boxes, largest first", () => {
    const before = makeShot(200, 300);
    const after = makeShot(200, 300, [
      { x: 8, y: 8, w: 24, h: 24, colour: BLACK },
      { x: 96, y: 160, w: 64, h: 64, colour: BLACK },
    ]);
    const result = diffImages(before, after);
    expect(result.boxes).toHaveLength(2);
    const [first, second] = result.boxes;
    if (!first || !second) throw new Error("expected two boxes");
    expect(first.width * first.height).toBeGreaterThan(second.width * second.height);
    expect(first.x).toBeGreaterThanOrEqual(80);
    expect(second.x).toBeLessThan(48);
  });

  it("throws a plain message when the sizes differ", () => {
    const a = makeShot(200, 300);
    const b = makeShot(100, 150);
    expect(() => diffImages(a, b)).toThrow(
      "The screenshots differ in size (200x300 vs 100x150); take both at the same width.",
    );
  });

  it("throws when an image is not a JPEG", () => {
    const a = makeShot(40, 40);
    expect(() => diffImages(a, { mime: "image/jpeg", data: Buffer.from("nope").toString("base64") })).toThrow(Error);
  });

  it("ignores a slight colour change below the threshold", () => {
    const before = makeShot(200, 300);
    const after = makeShot(200, 300, [], [GREY + 6, GREY + 6, GREY + 6]);
    const result = diffImages(before, after);
    expect(result.changedPixels).toBe(0);
    expect(result.boxes).toEqual([]);
  });

  it("honours a custom threshold", () => {
    const before = makeShot(200, 300);
    const after = makeShot(200, 300, [], [GREY + 6, GREY + 6, GREY + 6]);
    const result = diffImages(before, after, { threshold: 0.01 });
    expect(result.changedPixels).toBeGreaterThan(0);
  });
});

describe("composeFilmstrip", () => {
  const FRAME_W = 50;
  const GAP = 8;

  it("lays 4 frames out in 2 rows of 3 columns", () => {
    const frames = [1, 2, 3, 4].map(() => makeShot(100, 200));
    const strip = composeFilmstrip(frames, { columns: 3, frameWidth: FRAME_W, gap: GAP });
    expect(strip.mime).toBe("image/jpeg");
    expect(strip.width).toBe(3 * FRAME_W + 4 * GAP);
    expect(strip.height).toBe(2 * 100 + 3 * GAP);
    const out = decode(strip);
    expect(out.width).toBe(strip.width);
    expect(out.height).toBe(strip.height);
    // Centre of frame 1 is grey, the gap is white.
    const centre = pixel(out, GAP + 25, GAP + 50);
    for (const c of centre) expect(Math.abs(c - GREY)).toBeLessThan(25);
    const gap = pixel(out, GAP + FRAME_W + 4, GAP + 50);
    for (const c of gap) expect(c).toBeGreaterThan(230);
  });

  it("draws a dark label box at the top-left of frame 1", () => {
    const frames = [makeShot(100, 200), makeShot(100, 200)];
    const labelled = decode(composeFilmstrip(frames, { frameWidth: FRAME_W, gap: GAP }));
    const plain = decode(composeFilmstrip(frames, { frameWidth: FRAME_W, gap: GAP, labels: false }));
    const withLabel = pixel(labelled, GAP + 1, GAP + 1);
    const without = pixel(plain, GAP + 1, GAP + 1);
    for (const c of withLabel) expect(c).toBeLessThan(90);
    for (const c of without) expect(Math.abs(c - GREY)).toBeLessThan(25);
  });

  it("uses the defaults (200 px frames, 3 columns, 8 px gap)", () => {
    const frames = [1, 2, 3].map(() => makeShot(100, 200));
    const strip = composeFilmstrip(frames);
    expect(strip.width).toBe(3 * 200 + 4 * 8);
    expect(strip.height).toBe(400 + 2 * 8);
  });

  it("throws for zero frames", () => {
    expect(() => composeFilmstrip([])).toThrow(Error);
  });

  it("throws for a frame that does not decode", () => {
    expect(() => composeFilmstrip([{ mime: "image/jpeg", data: Buffer.from("nope").toString("base64") }])).toThrow(Error);
  });
});
