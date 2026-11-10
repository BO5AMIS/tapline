import { describe, expect, it } from "vitest";
import { feedParams } from "../src/tools.js";

describe("feedParams", () => {
  it("sends on and quality only by default", () => {
    expect(feedParams(true, "balanced", {})).toEqual({ on: true, quality: "balanced" });
  });

  it("adds gapMs from TAPLINE_FEED_GAP_MS within 30-2000 ms", () => {
    expect(feedParams(true, "sharp", { TAPLINE_FEED_GAP_MS: "150" })).toEqual({ on: true, quality: "sharp", gapMs: 150 });
    expect(feedParams(false, "light", { TAPLINE_FEED_GAP_MS: "30" })).toEqual({ on: false, quality: "light", gapMs: 30 });
  });

  it("ignores values out of range or not numbers", () => {
    for (const value of ["", " ", "10", "2001", "fast", "NaN"]) {
      expect(feedParams(true, "balanced", { TAPLINE_FEED_GAP_MS: value })).toEqual({ on: true, quality: "balanced" });
    }
  });
});
