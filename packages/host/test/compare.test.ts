import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { expectSchema } from "../src/run.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Square {
  x: number;
  y: number;
  size: number;
}

/** A grey JPEG with dark squares (pixels). */
function picture(squares: Square[] = [], width = 300, height = 600): string {
  const data = Buffer.alloc(width * height * 4, 200);
  for (const sq of squares) {
    for (let y = sq.y; y < sq.y + sq.size; y++) {
      for (let x = sq.x; x < sq.x + sq.size; x++) {
        const i = (y * width + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return jpeg.encode({ data, width, height }, 90).data.toString("base64");
}

const BIG: Square[] = [{ x: 40, y: 40, size: 60 }]; // 2% of 300x600
/** Ten small squares far enough apart to be ten regions. */
const TEN: Square[] = Array.from({ length: 10 }, (_, i) => ({ x: 10 + 50 * (i % 5), y: 10 + 60 * Math.floor(i / 5), size: 20 }));

const TREE = {
  screen: { width: 150, height: 300, scale: 3 },
  elements: [
    { ref: "e1", type: "ScrollView", role: "scrollview", text: "Everything on the page", frame: { x: 0, y: 0, width: 150, height: 300 }, actions: ["scroll"] },
    { ref: "e2", type: "Text", role: "text", testID: "clock", text: "12:00", frame: { x: 20, y: 20, width: 40, height: 40 }, actions: [] },
    { ref: "e3", type: "Pressable", role: "button", testID: "save", label: "Save", text: "Save", frame: { x: 10, y: 250, width: 100, height: 30 }, actions: ["press"] },
  ],
};

async function setup(initial: string, width = 300, height = 600) {
  const dir = mkdtempSync(join(tmpdir(), "tapline-compare-"));
  dirs.push(dir);
  const state = { shot: initial, width, height };
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "screenshot":
        return { ok: true, result: { mime: "image/jpeg", data: state.shot, width: state.width, height: state.height } };
      case "tree":
        return { ok: true, result: TREE };
      case "press":
        return { ok: true, result: { element: TREE.elements[2] } };
      default:
        return { ok: true, result: {} };
    }
  };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, baselinesDir: dir });
  return { app, tools, dir, state };
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const hasImage = (result: CallToolResult): boolean => result.content.some((block) => block.type === "image");

describe("compare_screen", () => {
  it("saves the reference the first time", async () => {
    const { tools, dir } = await setup(picture());
    const result = await tools.compareScreen({ name: "home" });
    expect(textOf(result)).toBe('Saved the reference "home" (300x600 px).');
    expect(existsSync(join(dir, "com.example.demo", "home.jpg"))).toBe(true);
  });

  it("update saves again", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    expect(textOf(await tools.compareScreen({ name: "home", update: true }))).toBe('Saved the reference "home" (300x600 px).');
    expect(textOf(await tools.compareScreen({ name: "home" }))).toBe('Matches the reference "home": 0% changed.');
  });

  it("matches when the change is within the threshold, with no picture", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG); // 2% changed
    const result = await tools.compareScreen({ name: "home", threshold: 2.5 });
    expect(textOf(result)).toBe('Matches the reference "home" (2% changed, under the 2.5% threshold): changed at e2 text "12:00"');
    expect(hasImage(result)).toBe(false);
    expect(result.isError).not.toBe(true);
  });

  it("differs above the threshold, with regions and the red picture", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const result = await tools.compareScreen({ name: "home" });
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text.split("\n")[0]).toBe('Differs from the reference "home": 2% changed, in 1 region (points):');
    expect(text).toMatch(/^- @\d+,\d+ \d+x\d+: .*e2 text "12:00"/m);
    expect(text).not.toContain("Everything on the page");
    expect(text).toContain("The image shows the screen now, faded, with the changed pixels in red.");
    expect(hasImage(result)).toBe(true);
  });

  it("lists at most 8 regions, then counts the rest", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(TEN);
    const text = textOf(await tools.compareScreen({ name: "home", threshold: 0 }));
    expect(text.split("\n")[0]).toMatch(/^Differs from the reference "home": [\d.]+% changed, in 10 regions \(points\):$/);
    expect(text.split("\n").filter((line) => line.startsWith("- @"))).toHaveLength(8);
    expect(text).toContain("(+2 more regions)");
  });

  it("ignore by id paints out the element on both pictures", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG); // the square sits inside the clock (points 20..60 = pixels 40..120)
    const result = await tools.compareScreen({ name: "home", ignore: [{ id: "clock" }] });
    expect(textOf(result)).toBe('Matches the reference "home": 0% changed.');
  });

  it("ignore by text and by rect", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    expect(textOf(await tools.compareScreen({ name: "home", ignore: [{ text: "12:00" }] }))).toContain("Matches");
    expect(textOf(await tools.compareScreen({ name: "home", ignore: [{ x: 15, y: 15, width: 60, height: 60 }] }))).toContain("Matches");
    expect(textOf(await tools.compareScreen({ name: "home", ignore: [{ x: 100, y: 100, width: 10, height: 10 }] }))).toContain("Differs");
  });

  it("skips an ignore target that is not on the screen, with a note", async () => {
    const { tools } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    const text = textOf(await tools.compareScreen({ name: "home", ignore: [{ id: "nope" }] }));
    expect(text).toContain('Matches the reference "home": 0% changed.');
    expect(text).toContain("Note: ignore id=nope isn't on the screen; skipped.");
  });

  it("refuses a reference of another size", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture([], 300, 400);
    state.height = 400;
    const result = await tools.compareScreen({ name: "home" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Error bad_params: the reference "home" is 300x600 px and this screen is 300x400; take it at the same width, or update: true.',
    );
  });

  it("keeps the name rule", async () => {
    const { tools } = await setup(picture());
    expect(textOf(await tools.compareScreen({ name: "../x" }))).toContain("Error bad_params");
  });
});

describe("run with visual checks", () => {
  const tap = { tool: "tap", target: { id: "save" } };

  it("expect.matches holds on a match", async () => {
    const { tools } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    const result = await tools.run({ steps: [{ ...tap, expect: { matches: "home" } }], look: false });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("Ran 1 of 1 steps");
  });

  it("expect.matches stops when the screen differs", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const result = await tools.run({ steps: [{ ...tap, expect: { matches: "home" } }, { tool: "wait", seconds: 0.1 }], look: false });
    expect(result.isError).toBe(true);
    const first = textOf(result).split("\n")[0];
    expect(first).toMatch(
      /^Error expect_failed: Ran 0 of 2 steps; stopped at step 1 \(tap id=save\): its action ran, but 2% changed from the reference "home" \(threshold 0\.5%\), in 1 region \(points\): @\d+,\d+ \d+x\d+\.$/,
    );
  });

  it("expect.matches takes its own threshold", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const result = await tools.run({ steps: [{ ...tap, expect: { matches: "home", threshold: 3 } }], look: false });
    expect(result.isError).not.toBe(true);
  });

  it("expect.matches stops when there is no reference", async () => {
    const { tools } = await setup(picture());
    const result = await tools.run({ steps: [{ ...tap, expect: { matches: "home" } }], look: false });
    expect(result.isError).toBe(true);
    expect(textOf(result).split("\n")[0]).toBe(
      'Error expect_failed: Ran 0 of 1 steps; stopped at step 1 (tap id=save): its action ran, but no reference "home" yet; save one with compare_screen { name: "home" }.',
    );
    expect(existsSync(join(dirs[0] ?? "", "com.example.demo", "home.jpg"))).toBe(false);
  });

  it("matches can stand alone or with text, and only one of text, id, label", () => {
    expect(expectSchema.safeParse({ matches: "home" }).success).toBe(true);
    expect(expectSchema.safeParse({ matches: "home", text: "Saved" }).success).toBe(true);
    expect(expectSchema.safeParse({ text: "a", id: "b", matches: "home" }).success).toBe(false);
    expect(expectSchema.safeParse({ threshold: 1, text: "a" }).success).toBe(false);
    expect(expectSchema.safeParse({}).success).toBe(false);
  });

  it("a compare_screen step passes on a match", async () => {
    const { tools } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    const result = await tools.run({ steps: [tap, { tool: "compare_screen", name: "home" }], look: false, trace: true });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('2. Matches the reference "home": 0% changed.');
  });

  it("a compare_screen step stops the batch when the screen differs", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const result = await tools.run({ steps: [tap, { tool: "compare_screen", name: "home" }], look: false });
    expect(result.isError).toBe(true);
    expect(textOf(result).split("\n")[0]).toMatch(
      /^Error expect_failed: Ran 1 of 2 steps; stopped at step 2 \(compare_screen "home"\): 2% changed from the reference "home" \(threshold 0\.5%\), in 1 region \(points\): @\d+,\d+ \d+x\d+\.$/,
    );
  });

  it("a compare_screen step stops when there is no reference, and never saves", async () => {
    const { tools, dir } = await setup(picture());
    const result = await tools.run({ steps: [{ tool: "compare_screen", name: "home" }], look: false });
    expect(textOf(result).split("\n")[0]).toBe(
      'Error expect_failed: Ran 0 of 1 steps; stopped at step 1 (compare_screen "home"): no reference "home" yet; save one with compare_screen { name: "home" }.',
    );
    expect(existsSync(join(dir, "com.example.demo", "home.jpg"))).toBe(false);
  });

  it("a compare_screen step honours threshold and ignore", async () => {
    const { tools, state } = await setup(picture());
    await tools.compareScreen({ name: "home" });
    state.shot = picture(BIG);
    const ok = await tools.run({ steps: [{ tool: "compare_screen", name: "home", ignore: [{ id: "clock" }] }], look: false });
    expect(ok.isError).not.toBe(true);
    const loose = await tools.run({ steps: [{ tool: "compare_screen", name: "home", threshold: 5 }], look: false });
    expect(loose.isError).not.toBe(true);
  });

  it("update is rejected in a step", async () => {
    const { tools } = await setup(picture());
    const result = await tools.run({ steps: [tap, { tool: "compare_screen", name: "home", update: true }], look: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error bad_params: step 2: update can't be used in run (a step never saves a reference)");
  });
});
