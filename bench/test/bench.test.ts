import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { guardApp } from "../src/guard.js";
import { FakeLab, LAB_APP } from "./fakeLab.js";
import { closeKeyboard, expectState, openLab, RESET_STATE, resetLab } from "../src/lab.js";
import { parseToolResult, type CallResult, type ToolSession } from "../src/mcp.js";
import {
  allPass,
  buildScorecard,
  formatTable,
  scorecardFileName,
  speedRow,
  writeScorecard,
} from "../src/scorecard.js";
import { measureStartToReady, parseSettled, runSpeed } from "../src/speed.js";
import { summarize } from "../src/stats.js";
import { selectSuites } from "../src/suites.js";
import { targetFor } from "../src/targets.js";

interface Call {
  name: string;
  args: Record<string, unknown>;
}

type Handler = (call: Call, index: number) => Partial<CallResult>;

function fakeTool(handler: Handler): ToolSession & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async call(name, args) {
      const c = { name, args };
      calls.push(c);
      return { text: "", images: 0, isError: false, ms: 100, ...handler(c, calls.length - 1) };
    },
  };
}

describe("stats", () => {
  it("uses nearest-rank", () => {
    const s = summarize(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(s).toEqual({ n: 20, median: 10, p95: 19, min: 1, max: 20 });
  });
  it("handles one sample, unsorted input and ties", () => {
    expect(summarize([5])).toEqual({ n: 1, median: 5, p95: 5, min: 5, max: 5 });
    expect(summarize([3, 1, 2]).median).toBe(2);
    expect(summarize([1, 1, 1, 9]).p95).toBe(9);
  });
  it("drops non-finite samples", () => {
    const s = summarize([1, Number.NaN, Infinity, 3, -Infinity]);
    expect(s.n).toBe(2);
    expect(s.max).toBe(3);
  });
  it("gives NaN for no samples", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(Number.isNaN(s.median)).toBe(true);
  });
});

describe("targets", () => {
  it("looks up by id and link", () => {
    expect(targetFor("S1", "good")).toEqual({ median: 0.7, p95: 1.2 });
    expect(targetFor("S2", "3g")).toEqual({ median: 1.5, p95: 3.0 });
    expect(targetFor("S3", "good")).toEqual({ median: 0.8, p95: 1.5 });
    expect(targetFor("S5", "good")).toEqual({ max: 5 });
    expect(targetFor("S5", "3g")).toEqual({ max: 8 });
  });
  it("gives sub-rows the parent target", () => {
    expect(targetFor("S1.type", "3g")).toEqual({ median: 1.5, p95: 2.5 });
  });
  it("throws for an unknown id", () => {
    expect(() => targetFor("X9", "good")).toThrow();
  });
});

describe("scorecard", () => {
  const meta = { tool: "tapline", version: "0.1.0", phone: "iPhone 15", ios: "26.5", link: "good" as const };

  it("passes and fails against the target", () => {
    expect(speedRow("S1", [0.5, 0.6, 0.65], "good").pass).toBe(true);
    expect(speedRow("S1", [0.5, 0.6, 1.5], "good").pass).toBe(false); // p95 too high
    expect(speedRow("S1", [0.8, 0.9, 0.9], "good").pass).toBe(false); // median too high
    expect(speedRow("S5", [4.2], "good").pass).toBe(true);
    expect(speedRow("S5", [6], "good").pass).toBe(false);
    expect(speedRow("S1", [], "good").pass).toBe(false);
  });
  it("fails a row with errors and says so", () => {
    const r = speedRow("S1", [0.1, 0.2], "good", { errors: 1 });
    expect(r.pass).toBe(false);
    expect(r.notes).toContain("1 failed");
  });
  it("rounds to 3 decimals and has the QUALITY-BAR shape", () => {
    const r = speedRow("S1", [0.123456], "good");
    expect(r).toEqual({
      id: "S1",
      samples: 1,
      median: 0.123,
      p95: 0.123,
      target: { median: 0.7, p95: 1.2 },
      pass: true,
    });
    const card = buildScorecard(meta, [r], new Date("2026-11-10T08:09:10.123Z"));
    expect(Object.keys(card)).toEqual(["tool", "version", "phone", "ios", "link", "date", "results"]);
    expect(card.date).toBe("2026-11-10T08:09:10.123Z");
    expect(allPass(card)).toBe(true);
  });
  it("names the file without colons and writes it", () => {
    const card = buildScorecard(meta, [speedRow("S5", [1], "good")], new Date("2026-11-10T08:09:10.123Z"));
    expect(scorecardFileName(card)).toBe("tapline-good-2026-11-10T080910.123Z.json");
    const dir = join(mkdtempSync(join(tmpdir(), "bench-")), "nested");
    const path = writeScorecard(dir, card);
    expect(basename(path)).toBe("tapline-good-2026-11-10T080910.123Z.json");
    const back: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(back).toEqual(card);
  });
  it("prints a table with PASS and FAIL", () => {
    const card = buildScorecard(meta, [speedRow("S1", [0.5], "good"), speedRow("S2", [2], "good")]);
    const t = formatTable(card);
    expect(t).toMatch(/S1\s+1\s+0\.500\s+0\.500\s+0\.7 \/ 1\.2\s+PASS/);
    expect(t).toMatch(/S2\s+1\s+2\.000\s+2\.000\s+0\.5 \/ 1\s+FAIL/);
    expect(allPass(card)).toBe(false);
  });
});

describe("config", () => {
  const ok = {
    tool: "tapline",
    version: "0.1.0",
    command: "tapline",
    args: ["mcp"],
    phone: "iPhone 15",
    ios: "26.5",
    link: "good",
  };
  it("accepts a valid config with optional fields", () => {
    expect(parseConfig(ok).labUrl).toBeUndefined();
    expect(parseConfig({ ...ok, env: { A: "b" }, labUrl: "x://lab", link: "3g" }).link).toBe("3g");
  });
  it("rejects bad configs", () => {
    expect(() => parseConfig({ ...ok, link: "wifi" })).toThrow(/link/);
    expect(() => parseConfig({ ...ok, args: "mcp" })).toThrow(/args/);
    expect(() => parseConfig({ ...ok, command: undefined })).toThrow(/command/);
    expect(() => parseConfig(null)).toThrow(/Invalid config/);
  });
});

describe("mcp result parsing", () => {
  it("joins text and counts images", () => {
    const r = parseToolResult({
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "xx", mimeType: "image/jpeg" },
        { type: "text", text: "b" },
      ],
    });
    expect(r).toEqual({ text: "a\nb", images: 1, isError: false });
  });
  it("flags isError and unparseable results", () => {
    expect(parseToolResult({ content: [], isError: true }).isError).toBe(true);
    expect(parseToolResult("nope").isError).toBe(true);
  });
});

describe("suite registry", () => {
  it("selects by name and rejects unknown names", () => {
    expect(selectSuites(undefined).map((s) => s.name)).toContain("speed");
    expect(selectSuites("speed")).toHaveLength(1);
    expect(() => selectSuites("nope")).toThrow(/Unknown suite/);
  });
});

describe("lab helpers", () => {
  it("opens the lab and waits for lab-state", async () => {
    const t = fakeTool(() => ({ text: "Done." }));
    await openLab(t, "x://lab");
    expect(t.calls[0]).toEqual({ name: "open_url", args: { url: "x://lab", look: false } });
    expect(t.calls[1]?.args).toMatchObject({ id: "lab-state", timeout: 15 });
  });
  it("throws when the lab does not appear", async () => {
    const t = fakeTool((c) => (c.name === "wait_for" ? { text: "Error timeout: no" } : { text: "ok" }));
    await expect(openLab(t)).rejects.toThrow(/lab did not appear/);
  });
  it("resets: a look for a leftover alert, top, a tap outside any field, scroll, reset, top, then checks lab-state", async () => {
    const t = fakeTool(() => ({ text: "ok" }));
    await resetLab(t);
    expect(t.calls.map((c) => c.name)).toEqual(["look", "scroll", "tap", "scroll", "tap", "scroll", "wait_for"]);
    expect(t.calls[2]?.args).toMatchObject({ target: { id: "lab-state" } });
    expect(t.calls[3]?.args).toMatchObject({ direction: "down", amount: 0.4 });
    expect(t.calls[4]?.args).toMatchObject({ target: { id: "lab-reset" } });
    expect(t.calls[6]?.args).toMatchObject({ text: RESET_STATE });
  });
  it("a refused tap outside the field is fine; a failed reset tap throws", async () => {
    const t = fakeTool((c) =>
      c.name === "tap" ? { text: "Error not_actionable: no_action: has no tap action" } : { text: "ok" },
    );
    await expect(resetLab(t)).rejects.toThrow(/resetLab: tap failed: Error not_actionable/);
    expect(t.calls.map((c) => c.name)).toEqual(["look", "scroll", "tap", "scroll", "tap"]);
  });
  it("closes a lab alert left open before the reset, and names the step before it", async () => {
    const lab = new FakeLab({ alertTool: true });
    const g = guardApp(lab.tool(), LAB_APP);
    await g.call("tap", { target: { id: "lab-alert" } });
    expect(lab.standIn).toBe(true);
    g.setStep('run 1 R1 "Alert OK"');
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    try {
      await resetLab(g);
    } finally {
      spy.mockRestore();
    }
    expect(lab.standIn).toBe(false);
    expect(lab.state()).toContain(RESET_STATE);
    expect(logged).toEqual(['resetLab (after run 1 R1 "Alert OK"): closed a lab alert left open over the lab']);
  });
  it("closes the keyboard with a scroll to the top and a tap on lab-state", async () => {
    const t = fakeTool(() => ({ text: "ok" }));
    await closeKeyboard(t);
    expect(t.calls).toEqual([
      { name: "scroll", args: { target: { id: "lab-scroll" }, to: "start", look: false } },
      { name: "tap", args: { target: { id: "lab-state" }, look: false } },
    ]);
  });
  it("a reset that leaves state behind throws", async () => {
    const t = fakeTool((c) => (c.name === "wait_for" ? { text: "Error timeout: no" } : { text: "ok" }));
    await expect(resetLab(t)).rejects.toThrow(/did not read/);
  });
  it("expectState is true unless the answer starts with Error", async () => {
    expect(await expectState(fakeTool(() => ({ text: "Done after 0.1 s." })), "taps=1")).toBe(true);
    expect(await expectState(fakeTool(() => ({ text: "Error timeout: x" })), "taps=1")).toBe(false);
  });
});

describe("speed suite against a fake tool", () => {
  const noSleep = (): Promise<void> => Promise.resolve();
  const answer: Handler = (c) => {
    if (c.name === "look") return { text: "Screen 440x956", images: c.args["screenshot"] === false ? 0 : 1 };
    if (c.name === "tap") return { text: "Tapped e3.\nNo visible change.\nSettled in 0.13 s.", ms: 300 };
    return { text: "Done.", ms: 200 };
  };

  it("parses Settled in", () => {
    expect(parseSettled("Tapped.\nSettled in 0.13 s.")).toBe(0.13);
    expect(parseSettled("Tapped.")).toBeUndefined();
  });

  it("produces all rows with the right call counts and passes", async () => {
    const t = fakeTool(answer);
    const rows = await runSpeed(t, { samples: 20, link: "good", pauseMs: 200, sleep: noSleep });
    expect(rows.map((r) => r.id)).toEqual([
      "S2", "S3", "S1", "S1.settle", "S1.type", "S1.scroll", "S1.toggle",
    ]);
    expect(rows.every((r) => r.samples === 20)).toBe(true);
    expect(rows.every((r) => r.pass)).toBe(true);
    expect(rows.find((r) => r.id === "S1")?.median).toBe(0.3);
    expect(rows.find((r) => r.id === "S1.settle")?.median).toBe(0.13);
    const looks = t.calls.filter((c) => c.name === "look");
    // 20 S2 samples, plus each of the two resets' look for a leftover alert.
    expect(looks.filter((c) => c.args["screenshot"] === false)).toHaveLength(22);
    expect(looks.filter((c) => !("screenshot" in c.args))).toHaveLength(20);
    const scrolls = t.calls.filter((c) => c.name === "scroll" && c.args["amount"] === 0.5);
    expect(scrolls.map((c) => c.args["direction"]).slice(0, 4)).toEqual([undefined, "up", undefined, "up"]);
    expect(t.calls.filter((c) => c.name === "type_text").map((c) => c.args["text"]).slice(0, 2)).toEqual(["w0", "w1"]);
  });

  it("fails rows that are too slow", async () => {
    const t = fakeTool((c, i) => ({ ...answer(c, i), ms: c.name === "tap" ? 900 : 100 }));
    const rows = await runSpeed(t, { samples: 5, link: "good", pauseMs: 0, sleep: noSleep });
    expect(rows.find((r) => r.id === "S1")?.pass).toBe(false);
    expect(rows.find((r) => r.id === "S2")?.pass).toBe(true);
  });

  it("counts error answers as failed attempts, not samples", async () => {
    const t = fakeTool((c, i) =>
      c.name === "toggle" && i % 2 === 0 ? { text: "Error not_found: no such element" } : answer(c, i),
    );
    const rows = await runSpeed(t, { samples: 4, link: "good", pauseMs: 0, sleep: noSleep });
    const toggle = rows.find((r) => r.id === "S1.toggle");
    expect(toggle?.pass).toBe(false);
    expect(toggle?.notes).toContain("first error: Error not_found");
    expect(toggle && toggle.samples < 4).toBe(true);
  });

  it("fails S3 when the default look carries no image", async () => {
    const t = fakeTool((c, i) => (c.name === "look" ? { text: "Screen", images: 0 } : answer(c, i)));
    const rows = await runSpeed(t, { samples: 3, link: "good", pauseMs: 0, sleep: noSleep });
    expect(rows.find((r) => r.id === "S3")?.pass).toBe(false);
  });

  it("flags tap answers without a Settled line", async () => {
    const t = fakeTool((c, i) => (c.name === "tap" ? { text: "Tapped.", ms: 100 } : answer(c, i)));
    const rows = await runSpeed(t, { samples: 3, link: "good", pauseMs: 0, sleep: noSleep });
    expect(rows.find((r) => r.id === "S1.settle")?.pass).toBe(false);
  });
});

describe("S5 start to ready", () => {
  it("retries until a look succeeds and reports seconds since spawn", async () => {
    let clock = 1000;
    const t = fakeTool((_c, i) => (i < 3 ? { text: "Error not_connected: no app" } : { text: "Screen" }));
    const row = await measureStartToReady(t, 1000, "good", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(t.calls).toHaveLength(4);
    expect(row.samples).toBe(1);
    expect(row.median).toBe(0.75);
    expect(row.pass).toBe(true);
    expect(row.target).toEqual({ max: 5 });
  });
  it("gives up after the limit and fails", async () => {
    let clock = 0;
    const t = fakeTool(() => ({ text: "Error not_connected: no app" }));
    const row = await measureStartToReady(t, 0, "good", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(row.samples).toBe(0);
    expect(row.pass).toBe(false);
    expect(row.notes).toContain("not ready within 30 s");
  });
});
