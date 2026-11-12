import { describe, expect, it } from "vitest";
import { markRing, readPixels } from "../src/images.js";
import { GIF_MAX_BYTES, GIF_WIDTH, encodeJourneyGif, gifInfo, slidePlan, type GifFrame } from "../src/journeygif.js";
import { shot } from "./journeyhelpers.js";

// AGENT-TOOLS 1.12 §17.5: the journey's GIF.

const pixels = (colour: [number, number, number], width = 360, height = 780, noisy = false) =>
  readPixels({ mime: "image/jpeg", data: shot(colour, width, height, noisy) });

describe("the journey GIF", () => {
  it("is a GIF 360 px wide that loops, one picture per frame", () => {
    const frames: GifFrame[] = [
      { pixels: pixels([40, 90, 200]), at: 0 },
      { pixels: pixels([30, 160, 90]), at: 400 },
      { pixels: pixels([200, 60, 60]), at: 900 },
    ];
    const gif = encodeJourneyGif(frames);
    const info = gifInfo(gif.bytes);
    expect(info.version).toBe("GIF89a");
    expect(info.width).toBe(GIF_WIDTH);
    expect(info.height).toBe(780);
    expect(info.frames).toBe(3);
    expect(info.loops).toBe(0);
    expect(gif.frames).toBe(3);
    expect(gif.dropped).toBe(0);
    expect(gif.bytes.length).toBeLessThan(GIF_MAX_BYTES);
  });

  it("scales frames of another size to 360 px wide", () => {
    const gif = encodeJourneyGif([{ pixels: pixels([40, 90, 200], 720, 1560), at: 0 }]);
    const info = gifInfo(gif.bytes);
    expect([info.width, info.height]).toEqual([360, 780]);
  });

  it("draws a tap as a ring on the screen before it, shown just before the result", () => {
    const before = pixels([40, 90, 200]);
    const frames: GifFrame[] = [
      { pixels: before, at: 0 },
      { pixels: pixels([30, 160, 90]), at: 500, tap: { x: 0.5, y: 0.5 } },
    ];
    expect(gifInfo(encodeJourneyGif(frames).bytes).frames).toBe(3); // the first screen, the ring on it, the result
    expect(slidePlan(frames).map((s) => s.ring)).toEqual([false, true, false]);
    // the ring itself: red on a white edge, at the radius, and the rest of the screen untouched
    const ringed = markRing(before, { x: 0.5, y: 0.5 });
    const at = (x: number, y: number): number[] => Array.from(ringed.data.subarray((y * ringed.width + x) * 4, (y * ringed.width + x) * 4 + 3));
    expect(at(180 + 16, 390)).toEqual([255, 0, 0]);
    expect(at(180, 390)).toEqual(Array.from(before.data.subarray((390 * 360 + 180) * 4, (390 * 360 + 180) * 4 + 3)));
    expect(at(5, 5)).toEqual(Array.from(before.data.subarray((5 * 360 + 5) * 4, (5 * 360 + 5) * 4 + 3)));
  });

  it("puts the ring on the first screen when the first step is a tap", () => {
    const frames: GifFrame[] = [{ pixels: pixels([40, 90, 200]), at: 0, tap: { x: 0.2, y: 0.2 } }];
    expect(gifInfo(encodeJourneyGif(frames).bytes).frames).toBe(2);
  });

  it("keeps real time across close frames and about two frames a second in still stretches", () => {
    const frames: GifFrame[] = [
      { pixels: pixels([1, 1, 1], 8, 8), at: 0 },
      { pixels: pixels([9, 9, 9], 8, 8), at: 120 }, // a transition: 120 ms between frames
      { pixels: pixels([60, 60, 60], 8, 8), at: 5120 }, // five seconds of nothing
      { pixels: pixels([90, 90, 90], 8, 8), at: 5200 },
    ];
    expect(slidePlan(frames)).toEqual([
      { delay: 120, still: false, ring: false },
      { delay: 500, still: true, ring: false },
      { delay: 80, still: false, ring: false },
      { delay: 1500, still: false, ring: false },
    ]);
  });

  describe("the 3 MB cap", () => {
    const noisy = (n: number): GifFrame[] =>
      Array.from({ length: n }, (_, i) => ({ pixels: pixels([i * 20, 255 - i * 20, 90], 120, 260, true), at: [0, 100, 200, 300, 400, 3400, 6400, 9400, 12400, 15400][i] ?? i * 3000 }));

    it("drops still frames first", () => {
      const frames = noisy(10);
      const full = encodeJourneyGif(frames, { width: 120 });
      expect(full.frames).toBe(10);
      const capped = encodeJourneyGif(frames, { width: 120, maxBytes: Math.floor(full.bytes.length * 0.9) });
      expect(capped.bytes.length).toBeLessThanOrEqual(Math.floor(full.bytes.length * 0.9));
      expect(capped.dropped).toBe(2);
      expect(gifInfo(capped.bytes).frames).toBe(8);
      // the transition (the first five frames) is intact: 8 left = 5 transition + 3 of the 5 still ones
      expect(slidePlan(frames).filter((s) => !s.still).length).toBe(5);
    });

    it("then lowers the frame count further, down to what fits", () => {
      const frames = noisy(10);
      const full = encodeJourneyGif(frames, { width: 120 });
      const capped = encodeJourneyGif(frames, { width: 120, maxBytes: Math.floor(full.bytes.length / 4) });
      expect(capped.bytes.length).toBeLessThanOrEqual(Math.floor(full.bytes.length / 4));
      expect(capped.frames).toBeLessThan(6);
      expect(gifInfo(capped.bytes).frames).toBe(capped.frames);
    });

    it("shrinks the pictures when even two do not fit", () => {
      const frames = noisy(3).slice(0, 2);
      const two = encodeJourneyGif(frames, { width: 120 });
      const capped = encodeJourneyGif(frames, { width: 120, maxBytes: Math.floor(two.bytes.length / 2) });
      expect(capped.shrunk).toBe(true);
      expect(capped.width).toBeLessThan(120);
    });

    it("the default cap is 3 MB", () => {
      expect(GIF_MAX_BYTES).toBe(3 * 1024 * 1024);
    });
  });

  it("refuses a GIF with no frames, and gifInfo refuses what is not a GIF", () => {
    expect(() => encodeJourneyGif([])).toThrow(/no frames/);
    expect(() => gifInfo(new TextEncoder().encode("not a gif at all"))).toThrow(/not a GIF/);
  });
});
