import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIRM_ERROR, MEDIA_MAX_BYTES, pictureSize, readPictures } from "../src/media.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { NOT_IN_RUN } from "../src/run.js";
import { FakeApp, startHost } from "./helpers.js";

// AGENT-TOOLS 1.12 §17.6: media, the host side.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-media-"));
  dirs.push(dir);
  return dir;
}

function png(width: number, height: number, extra = 0): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(extra)]);
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function pictures(): { dir: string; a: string; b: string } {
  const dir = tempDir();
  const a = join(dir, "breakfast.jpg");
  const b = join(dir, "label.png");
  writeFileSync(a, jpeg(640, 480));
  writeFileSync(b, png(300, 200));
  return { dir, a, b };
}

type Handler = (params: Record<string, unknown>) => { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } };

async function connect(handler: Handler, capabilities = ["tree", "media"]): Promise<{ app: FakeApp; tools: TaplineTools }> {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, { capabilities }, (req) => {
    if (req.method === "tree") return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [] } };
    return handler(req.params as Record<string, unknown>);
  });
  apps.push(app);
  return { app, tools: new TaplineTools(host, { connect: { url: "", name: "Dev PC" } }) };
}

const mediaRequests = (app: FakeApp): Array<Record<string, unknown>> =>
  app.requests.filter((r) => r.method === "media").map((r) => r.params as Record<string, unknown>);

describe("media file checks", () => {
  it("reads JPEG and PNG by content, with their sizes", () => {
    const { a, b } = pictures();
    const read = readPictures([a, b]);
    expect("files" in read && read.files.map((f) => [f.name, f.mime, f.width, f.height])).toEqual([
      ["breakfast.jpg", "image/jpeg", 640, 480],
      ["label.png", "image/png", 300, 200],
    ]);
  });

  it("reads sizes from the headers", () => {
    expect(pictureSize(png(10, 20), "image/png")).toEqual({ width: 10, height: 20 });
    expect(pictureSize(jpeg(7, 9), "image/jpeg")).toEqual({ width: 7, height: 9 });
  });

  it("refuses a file that is not a JPEG or PNG, whatever its name says", () => {
    const dir = tempDir();
    const fake = join(dir, "cat.png");
    writeFileSync(fake, "GIF89a not a png");
    expect(readPictures([fake])).toEqual({ error: `Error bad_params: ${fake} is not a JPEG or PNG picture; media takes only those.` });
  });

  it("refuses a missing file and a directory", () => {
    const dir = tempDir();
    expect(readPictures([join(dir, "nope.jpg")])).toMatchObject({ error: expect.stringContaining("was not found on this computer") });
    expect(readPictures([dir])).toMatchObject({ error: expect.stringContaining("is not a file") });
  });

  it("refuses a file over 10 MB and accepts one at the limit", () => {
    const dir = tempDir();
    const big = join(dir, "big.png");
    writeFileSync(big, png(1, 1, MEDIA_MAX_BYTES - 33 + 1));
    expect(readPictures([big])).toMatchObject({ error: expect.stringContaining("at most 10 MB") });
    const edge = join(dir, "edge.png");
    writeFileSync(edge, png(1, 1, MEDIA_MAX_BYTES - 33));
    expect(readPictures([edge])).toHaveProperty("files");
  });

  it("refuses more than 10 pictures", () => {
    const { a } = pictures();
    expect(readPictures(Array.from({ length: 11 }, () => a))).toEqual({ error: "Error bad_params: add takes at most 10 pictures per call (got 11)." });
  });
});

describe("the media tool", () => {
  it("is not a step of run, and the tool is not read-only (it has no readOnlyHint)", () => {
    expect(NOT_IN_RUN).toContain("media");
  });

  it("needs confirm: true to add to the photo library, and touches nothing without it", async () => {
    const { a } = pictures();
    const { app, tools } = await connect(() => ({ ok: true, result: { id: "x" } }));
    const out = await tools.media({ add: [a] });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(CONFIRM_ERROR);
    expect(mediaRequests(app)).toEqual([]);
  });

  it("checks the pictures before it sends any", async () => {
    const dir = tempDir();
    const text = join(dir, "a.txt");
    writeFileSync(text, "hello");
    const { app, tools } = await connect(() => ({ ok: true, result: { id: "x" } }));
    const out = await tools.media({ add: [text], confirm: true });
    expect(textOf(out)).toContain("Error bad_params:");
    expect(mediaRequests(app)).toEqual([]);
  });

  it("needs add or remove", async () => {
    const { tools } = await connect(() => ({ ok: true, result: {} }));
    expect(textOf(await tools.media({}))).toContain("needs add");
    expect(textOf(await tools.media({ remove: true, add: ["x"] }))).toContain("takes nothing else");
    expect(textOf(await tools.media({ picker: true }))).toContain("needs add");
  });

  it("sends each picture alone, remembers the ids per app, and says what it did", async () => {
    const { a, b } = pictures();
    let n = 0;
    const { app, tools } = await connect(() => ({ ok: true, result: { id: `asset-${++n}` } }));
    const out = await tools.media({ add: [a, b], confirm: true });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toBe(
      "Added 2 pictures to the phone's photo library (breakfast.jpg, label.png); they show in the picker as Recently Added. Call media with remove: true to delete them afterwards.",
    );
    const sent = mediaRequests(app);
    expect(sent.map((p) => [p.op, p.name, p.mime])).toEqual([
      ["add", "breakfast.jpg", "image/jpeg"],
      ["add", "label.png", "image/png"],
    ]);
    expect(typeof sent[0]?.data).toBe("string");
    expect(tools.mediaState.addedIds("com.example.demo")).toEqual(["asset-1", "asset-2"]);
  });

  it("tells that a person must allow photo access, and keeps what was added", async () => {
    const { a, b } = pictures();
    let n = 0;
    const { tools } = await connect(() => (++n === 1 ? { ok: true, result: { id: "asset-1" } } : { ok: true, result: { needsPerson: true } }));
    const out = textOf(await tools.media({ add: [a, b], confirm: true }));
    expect(out).toContain("Added 1 of 2 pictures. A person must allow photo access on the phone first");
    expect(out).toContain("call media again with the 1 picture left (label.png)");
    expect(out.split("\n").at(-1)).toBe("Note: needs a person: allow photo access on the phone (an OS alert Tapline can't tap).");
    expect(tools.mediaState.addedIds("com.example.demo")).toEqual(["asset-1"]);
  });

  it("passes the app's unsupported answer on as it is", async () => {
    const { a } = pictures();
    const message =
      "this app has no photo-library module (expo-media-library or @react-native-camera-roll/camera-roll); Tapwright's media adds pictures for any app.";
    const { tools } = await connect(() => ({ ok: false, error: { code: "unsupported", message } }));
    const out = await tools.media({ add: [a], confirm: true });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toBe(`Error unsupported: ${message}`);
  });

  it("refuses kindly on an older app", async () => {
    const { a } = pictures();
    const { tools } = await connect(() => ({ ok: true, result: {} }), ["tree"]);
    expect(textOf(await tools.media({ add: [a], confirm: true }))).toContain("too old for media");
  });

  it("answers not_connected without an app", async () => {
    const { a } = pictures();
    const { host } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    expect(textOf(await tools.media({ add: [a], confirm: true }))).toContain("Error not_connected");
  });

  it("removes only the ids it added, says iOS asks the person, then forgets them", async () => {
    const { a } = pictures();
    const { app, tools } = await connect((p) => (p.op === "add" ? { ok: true, result: { id: "asset-9" } } : { ok: true, result: { removed: 1 } }));
    await tools.media({ add: [a], confirm: true });
    const out = textOf(await tools.media({ remove: true }));
    expect(mediaRequests(app).at(-1)).toEqual({ op: "remove", ids: ["asset-9"] });
    expect(out).toBe("Removed 1 picture this session added. iOS asks the person to confirm the delete on the phone: ask your user to tap Delete.");
    expect(tools.mediaState.addedIds("com.example.demo")).toEqual([]);
  });

  it("keeps the ids when the person declines the delete", async () => {
    const { a } = pictures();
    const { tools } = await connect((p) => (p.op === "add" ? { ok: true, result: { id: "asset-9" } } : { ok: true, result: { removed: 0, declined: true } }));
    await tools.media({ add: [a], confirm: true });
    expect(textOf(await tools.media({ remove: true }))).toContain("The person declined the delete");
    expect(tools.mediaState.addedIds("com.example.demo")).toEqual(["asset-9"]);
  });

  it("says there is nothing to remove when nothing was added", async () => {
    const { tools } = await connect(() => ({ ok: true, result: { removed: 0 } }));
    expect(textOf(await tools.media({ remove: true }))).toBe("Nothing to remove: this session added no pictures.");
  });

  it("arms the picker without confirm, answers in the shared words, and records picker skipped for the app", async () => {
    const { a, b } = pictures();
    const { app, tools } = await connect((p) => ({ ok: true, result: { pictures: p.index } }));
    const seen: Array<[string, number]> = [];
    tools.mediaState.onPickerSkipped((appId, count) => seen.push([appId, count]));
    const out = await tools.media({ add: [a, b], picker: true });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toBe('The next photo pick returns 2 pictures without the OS picker (marked "picker skipped" in a journey report).');
    expect(mediaRequests(app).map((p) => [p.op, p.index, p.total])).toEqual([
      ["picker", 1, 2],
      ["picker", 2, 2],
    ]);
    expect(seen).toEqual([["com.example.demo", 2]]);
    expect(tools.mediaState.pickerSkips("com.example.demo")).toBe(1);
    expect(tools.mediaState.takePickerSkips("com.example.demo")).toBe(1);
    expect(tools.mediaState.pickerSkips("com.example.demo")).toBe(0);
    // Nothing was added to the library, so nothing is remembered for remove.
    expect(tools.mediaState.addedIds("com.example.demo")).toEqual([]);
  });

  it("says 1 picture in the singular and records nothing when the app can't arm the picker", async () => {
    const { a } = pictures();
    const { tools } = await connect(() => ({ ok: false, error: { code: "unsupported", message: "this app has no expo-image-picker" } }));
    const out = await tools.media({ add: [a], picker: true });
    expect(textOf(out)).toBe("Error unsupported: this app has no expo-image-picker");
    expect(tools.mediaState.pickerSkips("com.example.demo")).toBe(0);
  });
});
