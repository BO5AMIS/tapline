import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// The Codex review of release 1.2.0 (PR #3): reference names can't leave their folder, an ignore ref keeps which
// of several same-named elements it was, visual checks inside `run` are recorded, the pass bar uses the exact share,
// and an unreadable reference is a failed check, never a crash.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const textOf = (r: CallToolResult): string => r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");

/** A grey picture, with optional dark squares [x, y, size]. */
function picture(width: number, height: number, squares: Array<[number, number, number]> = []): string {
  const data = Buffer.alloc(width * height * 4, 200);
  for (const [sx, sy, size] of squares) {
    for (let y = sy; y < sy + size; y++) {
      for (let x = sx; x < sx + size; x++) {
        const i = (y * width + x) * 4;
        data[i] = 10;
        data[i + 1] = 10;
        data[i + 2] = 10;
      }
    }
  }
  return jpeg.encode({ data, width, height }, 100).data.toString("base64");
}

const TWO_PRICES = [
  { ref: "e1", role: "text", label: "Price", text: "$10", frame: { x: 10, y: 10, width: 50, height: 20 } },
  { ref: "e2", role: "text", label: "Price", text: "$20", frame: { x: 10, y: 100, width: 50, height: 20 } },
];

async function rig(shots: () => string, size = { width: 300, height: 600 }) {
  const root = mkdtempSync(join(tmpdir(), "tapline-compare-review-"));
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "screenshot") return { ok: true, result: { mime: "image/jpeg", data: shots(), ...size } };
    if (req.method === "tree") return { ok: true, result: { screen: { width: size.width / 2, height: size.height / 2, scale: 2 }, elements: TWO_PRICES } };
    if (req.method === "press") return { ok: true, result: { element: TWO_PRICES[0] } };
    return { ok: true, result: {} };
  };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, {
    connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
    baselinesDir: join(root, "baselines"),
    scriptsDir: join(root, "scripts"),
  });
  return { tools, root, app };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String);
}

describe("reference names can't leave their folder (finding 1)", () => {
  it("refuses expect.matches with a path before anything runs, and writes nothing outside", async () => {
    const { tools, root, app } = await rig(() => picture(300, 600));
    for (const name of ["../../outside/victim", "..\\..\\outside\\victim", "/abs/victim"]) {
      const out = await tools.run({ steps: [{ tool: "tap", target: { text: "$10" }, expect: { matches: name } }] });
      expect(out.isError).toBe(true);
      expect(textOf(out)).toMatch(/bad_params/);
    }
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    expect(existsSync(join(root, "outside"))).toBe(false);
    expect(filesUnder(root).some((f) => f.includes("victim"))).toBe(false);
  });

  it("refuses a compare_screen step whose name is a path", async () => {
    const { tools } = await rig(() => picture(300, 600));
    const out = await tools.run({ steps: [{ tool: "compare_screen", name: "../x" }] });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/name the reference with letters, digits/);
  });
});

describe("an ignore ref keeps which of several same-named elements it was (finding 2)", () => {
  it("saves the label with its index", async () => {
    const { tools, root } = await rig(() => picture(300, 600));
    await tools.compareScreen({ name: "prices" }); // the reference
    await tools.record({ action: "start", name: "prices-flow" });
    expect(textOf(await tools.compareScreen({ name: "prices", ignore: [{ ref: "e2" }] }))).toMatch(/Matches/);
    await tools.record({ action: "stop" });
    const script = JSON.parse(readFileSync(join(root, "scripts", "prices-flow.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
    const step = script.steps.find((s) => s["tool"] === "compare_screen");
    expect(step?.["ignore"]).toEqual([{ label: "Price", index: 1 }]);
  });
});

describe("visual checks inside run are recorded (finding 3)", () => {
  it("keeps a compare_screen step of a batch in the recording", async () => {
    const { tools, root } = await rig(() => picture(300, 600));
    await tools.compareScreen({ name: "home" }); // the reference
    await tools.record({ action: "start", name: "batch-check" });
    const out = await tools.run({ steps: [{ tool: "compare_screen", name: "home", threshold: 1 }] });
    expect(out.isError).not.toBe(true);
    await tools.record({ action: "stop" });
    const script = JSON.parse(readFileSync(join(root, "scripts", "batch-check.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
    expect(script.steps).toEqual([expect.objectContaining({ tool: "compare_screen", name: "home", threshold: 1 })]);
  });

  it("keeps an expect.matches that held, as the step's matches", async () => {
    const { tools, root } = await rig(() => picture(300, 600));
    await tools.compareScreen({ name: "home" });
    await tools.record({ action: "start", name: "expect-check" });
    const out = await tools.run({ steps: [{ tool: "tap", target: { text: "$10" }, expect: { matches: "home" } }] });
    expect(out.isError).not.toBe(true);
    await tools.record({ action: "stop" });
    const script = JSON.parse(readFileSync(join(root, "scripts", "expect-check.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
    expect(script.steps).toEqual([expect.objectContaining({ tool: "tap", expect: expect.objectContaining({ matches: "home" }) })]);
  });
});

describe("the pass bar uses the exact share (finding 4)", () => {
  it("a few changed pixels fail threshold 0 even when the shown percent rounds to 0", async () => {
    let n = 0;
    const shots = [picture(600, 1200), picture(600, 1200, [[300, 600, 3]])];
    const { tools } = await rig(() => shots[Math.min(n++, 1)] ?? "", { width: 600, height: 1200 });
    await tools.compareScreen({ name: "tiny", width: 600 });
    const out = textOf(await tools.compareScreen({ name: "tiny", width: 600, threshold: 0 }));
    expect(out).toMatch(/^Differs from the reference "tiny"/);
  });
});

describe("an unreadable reference is a failed check (finding 5)", () => {
  it("answers an error instead of throwing when a folder sits where the picture should be", async () => {
    const { tools, root } = await rig(() => picture(300, 600));
    mkdirSync(join(root, "baselines", "com.example.demo", "home.jpg"), { recursive: true });
    const out = await tools.compareScreen({ name: "home" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/the reference "home" can't be read/);
    writeFileSync(join(root, "ok.txt"), "still running");
  });
});
