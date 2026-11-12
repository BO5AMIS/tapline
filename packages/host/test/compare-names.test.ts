import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { diffImages } from "../src/images.js";
import { analyze, buildCalls } from "../src/report.js";
import type { ActionLogEntry } from "../src/actionlog.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13.1 item 2: under the threshold, `compare_screen` still names each changed cluster that is at
// least 0.1% of the screen, and every changed cluster that overlaps a text element, whatever its size.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Square {
  x: number;
  y: number;
  size: number;
}

const WIDTH = 300;
const HEIGHT = 600;

/** A grey picture with dark squares, as a JPEG at quality 100 so a small square stays about its size. */
function picture(squares: Square[] = []): string {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4, 200);
  for (const sq of squares) {
    for (let y = sq.y; y < sq.y + sq.size; y++) {
      for (let x = sq.x; x < sq.x + sq.size; x++) {
        const i = (y * WIDTH + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return jpeg.encode({ data, width: WIDTH, height: HEIGHT }, 100).data.toString("base64");
}

// Points are half the pixels here (the tree says the screen is 150 pt wide).
const TREE = {
  screen: { width: 150, height: 300, scale: 3 },
  elements: [
    { ref: "e1", type: "ScrollView", role: "scrollview", text: "Everything on the page", frame: { x: 0, y: 0, width: 150, height: 300 }, actions: ["scroll"] },
    { ref: "e9", type: "Text", role: "text", text: "from €1,362", frame: { x: 20, y: 20, width: 60, height: 20 }, actions: [] },
  ],
};

async function setup(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), "tapline-compare-names-"));
  dirs.push(dir);
  const state = { shot: initial };
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "screenshot":
        return { ok: true, result: { mime: "image/jpeg", data: state.shot, width: WIDTH, height: HEIGHT } };
      case "tree":
        return { ok: true, result: TREE };
      default:
        return { ok: true, result: {} };
    }
  };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, baselinesDir: dir, stillGapMs: 1, stillCapMs: 50 });
  return { tools, state };
}

const textOf = (result: CallToolResult): string => result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");

/** What the diff says of a changed square, so the tests state their numbers. */
function percentOf(squares: Square[]): number {
  return diffImages({ mime: "image/jpeg", data: picture() }, { mime: "image/jpeg", data: picture(squares) }).changedPercent;
}

// pixels 40..80 x 40..80 are points 20..40 x 20..40: inside the text element e9.
const OVER_TEXT: Square[] = [{ x: 44, y: 44, size: 24 }];
// pixels 200.. are points 100.., where no element is.
const BARE_SMALL: Square[] = [{ x: 200, y: 300, size: 15 }];
const BARE_TINY: Square[] = [{ x: 200, y: 300, size: 9 }];

describe("compare_screen under the threshold", () => {
  it("a change over a text element is named, with the percent and the threshold", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(OVER_TEXT);
    const percent = percentOf(OVER_TEXT);
    expect(percent).toBeGreaterThan(0.1);
    expect(percent).toBeLessThan(0.5);
    expect(textOf(await tools.compareScreen({ name: "home" }))).toBe(
      `Matches the reference "home" (${percent}% changed, under the 0.5% threshold): changed at e9 text "from €1,362"`,
    );
  });

  it("a text change far below 0.1% is still named", async () => {
    const dot: Square[] = [{ x: 44, y: 44, size: 5 }];
    const percent = percentOf(dot);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(0.1);
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(dot);
    expect(textOf(await tools.compareScreen({ name: "home" }))).toContain('changed at e9 text "from €1,362"');
  });

  it("a cluster of at least 0.1% with no text is named by its place; a smaller one is not", async () => {
    expect(percentOf(BARE_SMALL)).toBeGreaterThanOrEqual(0.1);
    expect(percentOf(BARE_TINY)).toBeLessThan(0.1);
    const small = await setup(picture());
    await small.tools.compareScreen({ name: "home" });
    small.state.shot = picture(BARE_SMALL);
    expect(textOf(await small.tools.compareScreen({ name: "home" }))).toMatch(/^Matches the reference "home" \([\d.]+% changed, under the 0\.5% threshold\): changed at @\d+,\d+ \d+x\d+$/);
    const tiny = await setup(picture());
    await tiny.tools.compareScreen({ name: "home" });
    tiny.state.shot = picture(BARE_TINY);
    expect(textOf(await tiny.tools.compareScreen({ name: "home" }))).toMatch(/^Matches the reference "home": [\d.]+% changed\.$/);
  });

  it("with no qualifying cluster the line is today's", async () => {
    const { tools } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    expect(textOf(await tools.compareScreen({ name: "home" }))).toBe('Matches the reference "home": 0% changed.');
  });

  it("a threshold at 0 has no under-the-threshold case (a change differs)", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(OVER_TEXT);
    expect(textOf(await tools.compareScreen({ name: "home", threshold: 0 }))).toMatch(/^Differs from the reference/);
  });

  it("replay stays a match, and the trace carries the names", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(OVER_TEXT);
    const answer = textOf(await tools.run({ steps: [{ tool: "compare_screen", name: "home" }], trace: true }));
    expect(answer).toMatch(/^Ran 1 of 1 steps/);
    expect(answer).toContain('changed at e9 text "from €1,362"');
    expect(answer).toContain("1. Matches the reference");
  });

  it("an expect.matches check on a step holds and says the names in a note", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(OVER_TEXT);
    const answer = textOf(await tools.run({ steps: [{ tool: "wait", seconds: 0.1, expect: { matches: "home" } }] }));
    expect(answer).toMatch(/^Ran 1 of 1 steps/);
    expect(answer).toContain('Note (step 1): the screen matches "home" with changes: changed at e9 text "from €1,362"');
  });
});

describe("session_report counts matches with text changes", () => {
  const entry = (call: number, over: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
    t: new Date(1_000_000 + call * 1000).toISOString(),
    source: "tapline",
    by: "agent",
    tool: "compare_screen",
    kind: "read",
    ok: true,
    session: "s1",
    call,
    ...over,
  });

  it("lists the calls, with the advice", () => {
    const report = analyze(buildCalls([entry(1, { matched_with_changes: true }), entry(2), entry(3, { matched_with_changes: true })]));
    expect(report.flags.map((f) => f.text)).toContain("2 compare_screen matches with text changes (calls 1, 3): look at them");
  });

  it("says nothing when none matched with changes", () => {
    expect(analyze(buildCalls([entry(1)])).flags).toEqual([]);
  });

  it("the tool logs it when the answer names changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-compare-names-log-"));
    dirs.push(dir);
    const { host, port } = await startHost();
    hosts.push(host);
    const state = { shot: picture() };
    const { app } = await FakeApp.connect(port, {}, (req) =>
      req.method === "screenshot"
        ? { ok: true, result: { mime: "image/jpeg", data: state.shot, width: WIDTH, height: HEIGHT } }
        : { ok: true, result: req.method === "tree" ? TREE : {} },
    );
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, baselinesDir: dir, logDir: join(dir, "log"), stillGapMs: 1, stillCapMs: 50 });
    await tools.compareScreen({ name: "home" });
    state.shot = picture(OVER_TEXT);
    await tools.compareScreen({ name: "home" });
    const { reportFor } = await import("../src/report.js");
    expect(reportFor(join(dir, "log"), 0)).toContain("1 compare_screen match with text changes (calls 2): look at them");
  });
});
