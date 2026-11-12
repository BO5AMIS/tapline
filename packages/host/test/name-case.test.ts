import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { caseTwin } from "../src/script.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13.1 item 5: a script or reference name that differs from an existing one only in case is refused
// before anything is written (`home` and `HOME` are one file on Windows and macOS). Names are checked, not the file
// system, so these tests mean the same on every OS.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const WIDTH = 60;
const HEIGHT = 120;
const PICTURE = jpeg.encode({ data: Buffer.alloc(WIDTH * HEIGHT * 4, 200), width: WIDTH, height: HEIGHT }, 100).data.toString("base64");
const TREE = { screen: { width: 30, height: 60, scale: 2 }, elements: [{ ref: "e1", type: "Text", role: "text", text: "Home", frame: { x: 0, y: 0, width: 30, height: 10 }, actions: [] }] };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "tapline-name-case-"));
  dirs.push(root);
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply =>
    req.method === "screenshot"
      ? { ok: true, result: { mime: "image/jpeg", data: PICTURE, width: WIDTH, height: HEIGHT } }
      : { ok: true, result: req.method === "tree" ? TREE : { element: TREE.elements[0], settledMs: 10 } };
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const store = join(root, "baselines", "com.example.demo");
  const scripts = join(root, "scripts");
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, baselinesDir: join(root, "baselines"), scriptsDir: scripts, stillGapMs: 1, stillCapMs: 50 });
  return { tools, store, scripts, root };
}

/** The file names in a folder as they are: no case folding, on any OS. */
const names = (dir: string): string[] => readdirSync(dir).sort();

describe("caseTwin", () => {
  it("names the existing name that differs only in case", () => {
    expect(caseTwin("HOME", ["home", "other"])).toBe("home");
    expect(caseTwin("Home", ["home"])).toBe("home");
  });

  it("the same name, or a different one, is no twin", () => {
    expect(caseTwin("home", ["home"])).toBeNull();
    expect(caseTwin("home", ["homes", "hom"])).toBeNull();
    expect(caseTwin("home", [])).toBeNull();
  });

  it("the exact name wins when a twin from another OS sits next to it", () => {
    expect(caseTwin("home", ["HOME", "home"])).toBeNull();
  });

  it("names are ASCII: a letter outside A to Z is never folded onto one", () => {
    expect(caseTwin("kelvin", ["Kelvin"])).toBeNull();
    expect(caseTwin("istanbul", ["İstanbul"])).toBeNull();
  });
});

describe("a reference name", () => {
  it("that differs only in case from a saved one is refused, naming the saved one, and nothing is written", async () => {
    const { tools, store } = await setup();
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "home.jpg"), Buffer.from(PICTURE, "base64"));
    const answer = await tools.compareScreen({ name: "HOME" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe('Error bad_params: the reference "HOME" differs only in case from the existing "home"; use that name.');
    const saved = await tools.compareScreen({ name: "HOME", update: true });
    expect(textOf(saved)).toBe('Error bad_params: the reference "HOME" differs only in case from the existing "home"; use that name.');
    expect(names(store)).toEqual(["home.jpg"]);
  });

  it("the exact name still works, to compare and to update", async () => {
    const { tools, store } = await setup();
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "home.jpg"), Buffer.from(PICTURE, "base64"));
    expect(textOf(await tools.compareScreen({ name: "home" }))).toMatch(/^Matches/);
    expect((await tools.compareScreen({ name: "home", update: true })).isError).not.toBe(true);
  });

  it("a run step's compare_screen and expect.matches are refused the same way", async () => {
    const { tools, store } = await setup();
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "home.jpg"), Buffer.from(PICTURE, "base64"));
    const compare = await tools.run({ steps: [{ tool: "compare_screen", name: "Home" }] });
    expect(textOf(compare)).toContain('the reference "Home" differs only in case from the existing "home"; use that name.');
    const matches = await tools.run({ steps: [{ tool: "wait", seconds: 0.1, expect: { matches: "HOME" } }] });
    expect(textOf(matches)).toContain('the reference "HOME" differs only in case from the existing "home"; use that name.');
    expect(names(store)).toEqual(["home.jpg"]);
  });

  it("a name that differs only in case from one earlier in the same recording is refused", async () => {
    const { tools, store, scripts } = await setup();
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "home.jpg"), Buffer.from(PICTURE, "base64"));
    await tools.record({ start: true, name: "flow" });
    expect(textOf(await tools.compareScreen({ name: "home" }))).toMatch(/^Matches/);
    // the picture is gone, so only the recording remembers the name
    rmSync(join(store, "home.jpg"));
    const again = await tools.compareScreen({ name: "Home" });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe('Error bad_params: the reference "Home" differs only in case from "home", used earlier in this recording; use that name.');
    expect(names(store)).toEqual([]);
    await tools.record({ action: "discard" });
    expect(() => readdirSync(scripts)).toThrow();
  });
});

describe("a script name", () => {
  it("record start refuses a name that differs only in case from a saved script", async () => {
    const { tools, scripts } = await setup();
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "checkout.json"), "{}");
    const answer = await tools.record({ start: true, name: "Checkout" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe('Error bad_params: the script "Checkout" differs only in case from the existing "checkout"; use that name.');
    expect(names(scripts)).toEqual(["checkout.json"]);
    // not recording: the exact name starts
    expect(textOf(await tools.record({ start: true, name: "checkout" }))).toContain('Recording "checkout"');
  });

  it("replay refuses it too, by name only", async () => {
    const { tools, scripts } = await setup();
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "checkout.json"), "{}");
    const answer = await tools.replay({ name: "CHECKOUT" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe('Error bad_params: the script "CHECKOUT" differs only in case from the existing "checkout"; use that name.');
  });

  it("stop refuses to save when a twin appeared while recording", async () => {
    const { tools, scripts } = await setup();
    await tools.record({ start: true, name: "Flow" });
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "flow.json"), "{}");
    const stopped = await tools.record({ stop: true });
    expect(stopped.isError).toBe(true);
    expect(textOf(stopped)).toBe('Error bad_params: the script "Flow" differs only in case from the existing "flow"; use that name.');
    expect(names(scripts)).toEqual(["flow.json"]);
  });
});
