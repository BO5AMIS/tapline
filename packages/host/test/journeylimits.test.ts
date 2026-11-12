import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIF_MAX_SOURCE_FRAMES, framesForGif, pruneJourneys, type FrameRecord } from "../src/journeyreport.js";

// 1.5 review, finding 6: a long journey decodes at most 150 pictures for its GIF, and old report folders go.

const frame = (n: number, screen: number, tap = false): FrameRecord => ({
  n,
  step: n,
  file: `frames/${String(n).padStart(3, "0")}.jpg`,
  at: n * 1000,
  screen,
  signature: `s${n}`,
  ...(tap ? { tap: { x: 0.5, y: 0.5 } } : {}),
});

describe("frames for the GIF", () => {
  it("keeps all when there are few", () => {
    const few = Array.from({ length: 10 }, (_, i) => frame(i + 1, 1));
    expect(framesForGif(few)).toHaveLength(10);
  });

  it("caps a long journey, keeping taps, screen changes, the first and the last", () => {
    // 500 frames on 25 screens of 20, with a tap every 10th frame
    const many = Array.from({ length: 500 }, (_, i) => frame(i + 1, Math.floor(i / 20) + 1, i % 10 === 5));
    const chosen = framesForGif(many);
    expect(chosen.length).toBeLessThanOrEqual(GIF_MAX_SOURCE_FRAMES);
    expect(chosen[0]?.n).toBe(1);
    expect(chosen.at(-1)?.n).toBe(500);
    const kept = new Set(chosen.map((f) => f.n));
    for (const f of many) if (f.tap !== undefined) expect(kept.has(f.n)).toBe(true);
    for (let s = 0; s < 25; s++) expect(kept.has(s * 20 + 1)).toBe(true);
    // in time order
    expect(chosen.map((f) => f.n)).toEqual([...chosen.map((f) => f.n)].sort((a, b) => a - b));
  });
});

describe("frames for the GIF when the mandatory ones are over the cap", () => {
  it("keeps the first and the final frame, within the limit", () => {
    // every one of 151 frames has a tap
    const all = Array.from({ length: 151 }, (_, i) => frame(i + 1, 1, true));
    const chosen = framesForGif(all);
    expect(chosen).toHaveLength(GIF_MAX_SOURCE_FRAMES);
    expect(chosen[0]?.n).toBe(1);
    expect(chosen.at(-1)?.n).toBe(151);
    expect(chosen.map((f) => f.n)).toEqual([...chosen.map((f) => f.n)].sort((a, b) => a - b));
    expect(new Set(chosen.map((f) => f.n)).size).toBe(chosen.length);
  });
});

describe("old reports", () => {
  it("keeps the newest, removes older report folders, and leaves anything else alone", () => {
    const root = mkdtempSync(join(tmpdir(), "tapline-journeys-"));
    for (let i = 0; i < 5; i++) {
      const dir = join(root, `report-${i}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "report.md"), "# r");
      const when = new Date(2026, 10, 12, 10, i);
      utimesSync(dir, when, when);
    }
    mkdirSync(join(root, "not-a-report"));
    writeFileSync(join(root, "notes.txt"), "keep me");
    expect(pruneJourneys(root, 2)).toBe(3);
    expect(readdirSync(root).sort()).toEqual(["not-a-report", "notes.txt", "report-3", "report-4"]);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
  });

  it("does nothing when the folder isn't there", () => {
    expect(pruneJourneys(join(tmpdir(), "tapline-no-such-folder-x"), 2)).toBe(0);
  });
});
