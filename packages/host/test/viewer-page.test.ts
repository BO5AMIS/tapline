import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEWER_HTML } from "../src/viewer-page.js";

interface Part {
  headers: Record<string, string>;
  body: Uint8Array;
}

interface ParserState {
  readonly __brand?: never;
}

interface ParserApi {
  boundaryFromContentType(contentType: string): string;
  createParserState(boundary: string): ParserState;
  parseMultipartChunk(state: ParserState, chunk: Uint8Array): Part[];
}

function scriptBody(): string {
  const matches = [...VIEWER_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(matches).toHaveLength(1);
  return matches[0]![1]!;
}

function loadParser(): ParserApi {
  const script = scriptBody();
  const start = script.indexOf("/* parser:start */");
  const end = script.indexOf("/* parser:end */");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(script.indexOf("/* parser:start */", start + 1)).toBe(-1);
  const code = script.slice(start, end);
  const factory = new Function(
    `${code}\nreturn { boundaryFromContentType, createParserState, parseMultipartChunk };`,
  ) as () => ParserApi;
  return factory();
}

const enc = new TextEncoder();

function jpegLike(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  for (let i = 2; i < size - 2; i++) out[i] = (i * 31 + seed * 17) % 256;
  // Awkward content: CRLF and a partial boundary inside the image bytes.
  out.set(enc.encode("\r\n--fram"), 10);
  out.set(enc.encode("\r\n\r\n"), 40);
  out[size - 2] = 0xff;
  out[size - 1] = 0xd9;
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function partBytes(boundary: string, headers: Record<string, string>, body: Uint8Array): Uint8Array {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`);
  const head = `--${boundary}\r\n${lines.join("")}\r\n`;
  return concat([enc.encode(head), body, enc.encode("\r\n")]);
}

const bodyA = jpegLike(1, 150);
const bodyB = jpegLike(2, 220);

function headersFor(body: Uint8Array, seq: number, withLength: boolean): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "image/jpeg" };
  if (withLength) h["Content-Length"] = String(body.length);
  h["X-Seq"] = String(seq);
  h["X-Captured-At"] = String(1760000000000 + seq);
  h["X-Tree-Rev"] = String(40 + seq);
  h["X-Size"] = "402x874";
  h["X-Source"] = "viewshot";
  h["X-Coverage"] = "app-window";
  return h;
}

function buildStream(withLength: boolean): Uint8Array {
  return concat([
    partBytes("frame", headersFor(bodyA, 1, withLength), bodyA),
    partBytes("frame", headersFor(bodyB, 2, withLength), bodyB),
    enc.encode("--frame--\r\n"),
  ]);
}

function run(api: ParserApi, contentType: string, chunks: Uint8Array[]): Part[] {
  const state = api.createParserState(api.boundaryFromContentType(contentType));
  const parts: Part[] = [];
  for (const chunk of chunks) parts.push(...api.parseMultipartChunk(state, chunk));
  return parts;
}

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

function expectBothParts(parts: Part[]): void {
  expect(parts).toHaveLength(2);
  const [a, b] = parts as [Part, Part];
  expect(a.headers["x-seq"]).toBe("1");
  expect(a.headers["x-captured-at"]).toBe("1760000000001");
  expect(a.headers["x-tree-rev"]).toBe("41");
  expect(a.headers["x-size"]).toBe("402x874");
  expect(a.headers["x-source"]).toBe("viewshot");
  expect(a.headers["x-coverage"]).toBe("app-window");
  expect(a.headers["content-type"]).toBe("image/jpeg");
  expect(Array.from(a.body)).toEqual(Array.from(bodyA));
  expect(b.headers["x-seq"]).toBe("2");
  expect(b.headers["x-tree-rev"]).toBe("42");
  expect(Array.from(b.body)).toEqual(Array.from(bodyB));
}

const ICON = '<link rel="icon" href="data:,">';

describe("viewer page document", () => {
  it("is one self-contained HTML document with no external references", () => {
    expect(VIEWER_HTML.toLowerCase()).toContain("<!doctype html>");
    expect(VIEWER_HTML).not.toContain("http://");
    expect(VIEWER_HTML).not.toContain("https://");
    expect(VIEWER_HTML).not.toContain("//");
    expect(VIEWER_HTML.replace(ICON, "")).not.toMatch(/<link\b/i);
    expect(VIEWER_HTML).not.toMatch(/@import/i);
    expect(VIEWER_HTML).not.toMatch(/(^|[\s:,])url\(/);
    expect(VIEWER_HTML).not.toMatch(/<script[^>]*\ssrc=/i);
  });

  it("has an inline script that is valid JavaScript", () => {
    expect(() => new Function(scriptBody())).not.toThrow();
  });

  it("has an empty inline icon, so the browser doesn't ask the host for /favicon.ico", () => {
    expect(VIEWER_HTML).toContain(ICON);
  });

  it("says the app is paused on the phone when it can't be reached from here", () => {
    expect(scriptBody()).toContain('locked: "Paused on the phone"');
  });

  it("tags a box with the element's ref only when it has one (never \"null\")", () => {
    expect(scriptBody()).toContain('if (typeof e.ref === "string" && e.ref !== "")');
  });

  it("takes the token out of the address bar and history on load", () => {
    expect(scriptBody()).toContain('history.replaceState(null, "", location.pathname)');
  });

  it("talks to /stream, /ws and /video and sets a viewport for phones", () => {
    const script = scriptBody();
    expect(script).toContain("/stream");
    expect(script).toContain("/ws");
    expect(script).toContain("/video");
    expect(VIEWER_HTML).toContain("viewport");
  });

  it("words the not-answering state as App not answering", () => {
    const script = scriptBody();
    expect(script).toContain("not-answering");
    expect(script).toContain("App not answering");
  });
});

const START = "/* video-block:start */";
const END = "/* video-block:end */";

function videoBlock(): string {
  const script = scriptBody();
  const start = script.indexOf(START);
  const end = script.indexOf(END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end + END.length);
}

describe("viewer page video block", () => {
  it("has each marker exactly once, in order", () => {
    const script = scriptBody();
    expect(script.split(START)).toHaveLength(2);
    expect(script.split(END)).toHaveLength(2);
    expect(script.indexOf(START)).toBeLessThan(script.indexOf(END));
  });

  it("holds no backtick, no dollar-brace and no double slash", () => {
    const block = videoBlock();
    expect(block).not.toContain("`");
    expect(block).not.toContain("${");
    expect(block).not.toContain("//");
  });

  it("is valid JavaScript on its own and defines only createVideoBlock", () => {
    const factory = new Function(`${videoBlock()}\nreturn typeof createVideoBlock;`) as () => string;
    expect(factory()).toBe("function");
  });
});

interface VideoIo {
  socketUrl(): string;
  accepts(): boolean;
  picture(): FakeElement;
  onVideoConfig?(c: { width: number; height: number; coverage: string; source: string }): void;
  onVideoStarted(): void;
  onVideoStopped(why: string): void;
}

interface VideoApi {
  update(): void;
  stop(): void;
  stats(): {
    configs: number;
    pictures: number;
    frames: number;
    ignored: number;
    skipped: number;
    errors: number;
    keyRequests: number;
    fallbacks: number;
    hardware: string;
    lastReason: string;
    active: boolean;
  };
}

interface FakeElement {
  className: string;
  style: { display: string };
  parentNode: { insertBefore(el: FakeElement, ref: FakeElement | null): void } | null;
  nextSibling: FakeElement | null;
  width: number;
  height: number;
  setAttribute(name: string, value: string): void;
  getContext(kind: string, opts: object): { drawImage(frame: object, x: number, y: number): void };
}

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    this.readyState = 1;
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  message(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

interface FakeChunk {
  type: string;
  timestamp: number;
  data: Uint8Array;
}

class FakeDecoder {
  static all: FakeDecoder[] = [];
  static supportedHardware = true;
  static supportedAny = true;
  static asked: string[] = [];
  state = "unconfigured";
  decodeQueueSize = 0;
  chunks: FakeChunk[] = [];
  configured: Record<string, unknown>[] = [];
  closedCount = 0;
  constructor(readonly init: { output(frame: object): void; error(err: Error): void }) {
    FakeDecoder.all.push(this);
  }
  static isConfigSupported(c: { hardwareAcceleration: string }): Promise<{ supported: boolean }> {
    FakeDecoder.asked.push(c.hardwareAcceleration);
    const ok = c.hardwareAcceleration === "prefer-hardware" ? FakeDecoder.supportedHardware : FakeDecoder.supportedAny;
    return Promise.resolve({ supported: ok });
  }
  configure(c: Record<string, unknown>): void {
    this.configured.push(c);
    this.state = "configured";
  }
  decode(chunk: FakeChunk): void {
    this.chunks.push(chunk);
  }
  reset(): void {
    this.state = "unconfigured";
  }
  close(): void {
    this.state = "closed";
    this.closedCount++;
  }
}

class FakeChunkClass {
  type: string;
  timestamp: number;
  data: Uint8Array;
  constructor(init: FakeChunk) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

interface Rig {
  api: VideoApi;
  state: { accepts: boolean };
  events: string[];
  pic: FakeElement;
  canvases: FakeElement[];
  drawn: object[];
  configs: { width: number; height: number; coverage: string; source: string }[];
}

function makeRig(): Rig {
  FakeSocket.all = [];
  FakeDecoder.all = [];
  FakeDecoder.asked = [];
  FakeDecoder.supportedHardware = true;
  FakeDecoder.supportedAny = true;
  const canvases: FakeElement[] = [];
  const drawn: object[] = [];
  const children: FakeElement[] = [];
  const parent = {
    insertBefore(el: FakeElement): void {
      children.push(el);
    },
  };
  const makeEl = (): FakeElement => ({
    className: "",
    style: { display: "" },
    parentNode: null,
    nextSibling: null,
    width: 300,
    height: 150,
    setAttribute(): void {},
    getContext() {
      return { drawImage: (frame: object): void => void drawn.push(frame) };
    },
  });
  const pic = makeEl();
  pic.className = "pic";
  pic.parentNode = parent;
  const doc = {
    createElement(): FakeElement {
      const el = makeEl();
      canvases.push(el);
      return el;
    },
  };
  const win = { VideoDecoder: FakeDecoder, EncodedVideoChunk: FakeChunkClass };
  const factory = new Function(
    "window",
    "document",
    "WebSocket",
    "atob",
    `${videoBlock()}\nreturn createVideoBlock;`,
  ) as (w: object, d: object, s: object, a: (s: string) => string) => (io: VideoIo) => VideoApi;
  const state = { accepts: true };
  const events: string[] = [];
  const configs: Rig["configs"] = [];
  const api = factory(win, doc, FakeSocket, (s) => Buffer.from(s, "base64").toString("binary"))({
    socketUrl: () => "ws://host/video",
    accepts: () => state.accepts,
    picture: () => pic,
    onVideoConfig: (c) => void configs.push(c),
    onVideoStarted: () => void events.push("started"),
    onVideoStopped: (why) => void events.push(`stopped:${why}`),
  });
  return { api, state, events, pic, canvases, drawn, configs };
}

const CONFIG = JSON.stringify({
  type: "config",
  codec: "avc1.64001f",
  width: 660,
  height: 1434,
  description: Buffer.from([1, 100, 0, 31, 255]).toString("base64"),
  at: 1731222000000,
  coverage: "screen",
  source: "airplay",
});

function picture(key: boolean, ms: number): ArrayBuffer {
  const bytes = new Uint8Array(12);
  bytes[0] = key ? 1 : 0;
  new DataView(bytes.buffer).setUint32(4, ms, false);
  bytes.set([0, 0, 0, 4], 8);
  return bytes.buffer;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function openWithConfig(rig: Rig): Promise<FakeSocket> {
  rig.api.update();
  const s = FakeSocket.all[0]!;
  s.message(CONFIG);
  await settle();
  return s;
}

describe("viewer page video block behaviour", () => {
  it("opens /video only while accepts has video and VideoDecoder exists", () => {
    const rig = makeRig();
    rig.state.accepts = false;
    rig.api.update();
    expect(FakeSocket.all).toHaveLength(0);
    rig.state.accepts = true;
    rig.api.update();
    rig.api.update();
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.url).toBe("ws://host/video");
    expect(FakeSocket.all[0]!.binaryType).toBe("arraybuffer");
  });

  it("does nothing when the browser has no VideoDecoder", () => {
    const rig = makeRig();
    const factory = new Function(
      "window",
      "document",
      "WebSocket",
      `${videoBlock()}\nreturn createVideoBlock;`,
    ) as (w: object, d: object, s: object) => (io: VideoIo) => VideoApi;
    const api = factory({}, {}, FakeSocket)({
      socketUrl: () => "ws://host/video",
      accepts: () => true,
      picture: () => rig.pic,
      onVideoStarted: () => undefined,
      onVideoStopped: () => undefined,
    });
    FakeSocket.all = [];
    api.update();
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("configures the decoder, ignores deltas until a key frame, then shows the canvas", async () => {
    const rig = makeRig();
    const s = await openWithConfig(rig);
    const d = FakeDecoder.all[0]!;
    expect(d.configured[0]).toMatchObject({
      codec: "avc1.64001f",
      codedWidth: 660,
      codedHeight: 1434,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
    expect(Array.from(d.configured[0]!["description"] as Uint8Array)).toEqual([1, 100, 0, 31, 255]);
    expect(rig.canvases).toHaveLength(1);
    expect(rig.canvases[0]!.className).toBe("pic");
    expect(rig.canvases[0]!.width).toBe(660);
    expect(rig.canvases[0]!.height).toBe(1434);
    expect(rig.configs).toEqual([{ width: 660, height: 1434, coverage: "screen", source: "airplay" }]);
    s.message(picture(false, 5));
    expect(d.chunks).toHaveLength(0);
    s.message(picture(true, 40));
    s.message(picture(false, 73));
    expect(d.chunks.map((c) => [c.type, c.timestamp])).toEqual([
      ["key", 40000],
      ["delta", 73000],
    ]);
    expect(rig.events).toEqual([]);
    d.init.output({ close: (): void => void rig.events.push("closed") });
    expect(rig.events).toEqual(["started", "closed"]);
    expect(rig.drawn).toHaveLength(1);
    expect(rig.pic.style.display).toBe("none");
    expect(rig.canvases[0]!.style.display).toBe("");
    expect(rig.api.stats()).toMatchObject({ frames: 1, pictures: 2, ignored: 1, active: true });
  });

  it("buffers pictures that arrive while the config is being checked", async () => {
    const rig = makeRig();
    rig.api.update();
    const s = FakeSocket.all[0]!;
    s.message(CONFIG);
    s.message(picture(true, 0));
    s.message(picture(false, 33));
    await settle();
    expect(FakeDecoder.all[0]!.chunks).toHaveLength(2);
  });

  it("retries without hardware preference when prefer-hardware is not supported", async () => {
    const rig = makeRig();
    FakeDecoder.supportedHardware = false;
    await openWithConfig(rig);
    expect(FakeDecoder.asked).toEqual(["prefer-hardware", "no-preference"]);
    expect(FakeDecoder.all[0]!.configured[0]).toMatchObject({ hardwareAcceleration: "no-preference" });
    expect(rig.api.stats().hardware).toBe("no-preference");
  });

  it("falls back to JPEG, and never retries, when the config is unsupported", async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      FakeDecoder.supportedHardware = false;
      FakeDecoder.supportedAny = false;
      const s = await openWithConfig(rig);
      expect(s.closed).toBe(true);
      expect(rig.api.stats().lastReason).toBe("unsupported");
      vi.advanceTimersByTime(20000);
      rig.api.update();
      expect(FakeSocket.all).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips deltas when the decode queue grows, asks for a key frame once, and resumes at a key frame", async () => {
    const rig = makeRig();
    const s = await openWithConfig(rig);
    const d = FakeDecoder.all[0]!;
    s.message(picture(true, 0));
    d.decodeQueueSize = 4;
    s.message(picture(false, 33));
    s.message(picture(false, 66));
    expect(d.chunks).toHaveLength(1);
    expect(s.sent).toEqual(['{"type":"key"}']);
    d.decodeQueueSize = 0;
    s.message(picture(false, 99));
    expect(d.chunks).toHaveLength(1);
    s.message(picture(true, 120));
    s.message(picture(false, 150));
    expect(d.chunks.map((c) => c.type)).toEqual(["key", "key", "delta"]);
    expect(rig.api.stats().skipped).toBe(1);
  });

  it("after one decoder error asks for a key frame and waits for it", async () => {
    const rig = makeRig();
    const s = await openWithConfig(rig);
    const d = FakeDecoder.all[0]!;
    s.message(picture(true, 0));
    d.init.error(new Error("bad data"));
    expect(d.state).toBe("configured");
    expect(s.sent).toEqual(['{"type":"key"}']);
    s.message(picture(false, 33));
    expect(d.chunks).toHaveLength(1);
    s.message(picture(true, 66));
    expect(d.chunks).toHaveLength(2);
    expect(rig.api.stats().errors).toBe(1);
  });

  it("stops after 3 decoder errors within 10 s, restores the picture and retries after 5 s", async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      const s = await openWithConfig(rig);
      const d = FakeDecoder.all[0]!;
      d.init.output({ close(): void {} });
      expect(rig.events).toEqual(["started"]);
      d.init.error(new Error("1"));
      d.init.error(new Error("2"));
      expect(rig.events).toEqual(["started"]);
      d.init.error(new Error("3"));
      expect(rig.events).toEqual(["started", "stopped:decoder errors"]);
      expect(s.closed).toBe(true);
      expect(rig.pic.style.display).toBe("");
      expect(rig.canvases[0]!.style.display).toBe("none");
      vi.advanceTimersByTime(4999);
      expect(FakeSocket.all).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(FakeSocket.all).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("errors spread over more than 10 s do not stop the video", async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      await openWithConfig(rig);
      const d = FakeDecoder.all[0]!;
      d.init.error(new Error("1"));
      vi.advanceTimersByTime(6000);
      d.init.error(new Error("2"));
      vi.advanceTimersByTime(6000);
      d.init.error(new Error("3"));
      expect(rig.api.stats().fallbacks).toBe(0);
      expect(FakeDecoder.all[0]!.state).toBe("configured");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to JPEG when the socket closes and retries only while accepts has video", async () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      const s = await openWithConfig(rig);
      FakeDecoder.all[0]!.init.output({ close(): void {} });
      s.drop();
      expect(rig.events).toEqual(["started", "stopped:closed"]);
      rig.state.accepts = false;
      vi.advanceTimersByTime(6000);
      expect(FakeSocket.all).toHaveLength(1);

      const rig2 = makeRig();
      const s2 = await openWithConfig(rig2);
      s2.drop();
      vi.advanceTimersByTime(5001);
      expect(FakeSocket.all).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when accepts loses video", async () => {
    const rig = makeRig();
    const s = await openWithConfig(rig);
    FakeDecoder.all[0]!.init.output({ close(): void {} });
    rig.state.accepts = false;
    rig.api.update();
    expect(s.closed).toBe(true);
    expect(rig.events).toEqual(["started", "stopped:not offered"]);
    expect(rig.pic.style.display).toBe("");
  });

  it("reconfigures on a new config and drops frames from the old decoder", async () => {
    const rig = makeRig();
    const s = await openWithConfig(rig);
    const first = FakeDecoder.all[0]!;
    s.message(picture(true, 0));
    s.message(CONFIG.replace("660", "720"));
    await settle();
    expect(first.state).toBe("closed");
    expect(FakeDecoder.all).toHaveLength(2);
    expect(rig.canvases).toHaveLength(1);
    expect(rig.canvases[0]!.width).toBe(720);
    let closed = 0;
    first.init.output({ close: (): void => void closed++ });
    expect(closed).toBe(1);
    expect(rig.drawn).toHaveLength(0);
    s.message(picture(false, 33));
    expect(FakeDecoder.all[1]!.chunks).toHaveLength(0);
  });
});

describe("viewer page multipart parser", () => {
  const contentType = "multipart/x-mixed-replace; boundary=frame";

  it("reads the boundary from a Content-Type", () => {
    const api = loadParser();
    expect(api.boundaryFromContentType(contentType)).toBe("frame");
    expect(api.boundaryFromContentType('multipart/x-mixed-replace;boundary="abc-1"; charset=x')).toBe("abc-1");
    expect(api.boundaryFromContentType("multipart/x-mixed-replace")).toBe("frame");
  });

  it("parses a stream delivered in one chunk", () => {
    const api = loadParser();
    expectBothParts(run(api, contentType, [buildStream(true)]));
  });

  it("parses a stream delivered one byte at a time", () => {
    const api = loadParser();
    expectBothParts(run(api, contentType, split(buildStream(true), 1)));
  });

  it("parses awkward chunk sizes", () => {
    const api = loadParser();
    for (const size of [2, 3, 5, 7, 13, 64, 100]) {
      expectBothParts(run(api, contentType, split(buildStream(true), size)));
    }
  });

  it("parses when the stream is cut at every possible position", () => {
    const api = loadParser();
    const bytes = buildStream(true);
    for (let k = 1; k < bytes.length; k++) {
      expectBothParts(run(api, contentType, [bytes.slice(0, k), bytes.slice(k)]));
    }
  });

  it("parses parts without Content-Length by searching for the boundary", () => {
    const api = loadParser();
    const bytes = buildStream(false);
    expectBothParts(run(api, contentType, [bytes]));
    expectBothParts(run(api, contentType, split(bytes, 1)));
    expectBothParts(run(api, contentType, split(bytes, 9)));
  });

  it("skips a preamble before the first boundary", () => {
    const api = loadParser();
    const bytes = concat([enc.encode("ignored preamble\r\n"), buildStream(true)]);
    expectBothParts(run(api, contentType, split(bytes, 11)));
  });

  it("lowercases header names and ignores lines without a colon", () => {
    const api = loadParser();
    const body = jpegLike(3, 60);
    const bytes = concat([
      enc.encode("--frame\r\nCONTENT-LENGTH: 60\r\nnot a header\r\nX-SEQ:  7 \r\n\r\n"),
      body,
      enc.encode("\r\n"),
    ]);
    const parts = run(api, contentType, split(bytes, 4));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.headers["x-seq"]).toBe("7");
    expect(Array.from(parts[0]!.body)).toEqual(Array.from(body));
  });
});

/* The page's own script against a small fake DOM: what a person's click draws, and when. */

type DomListener = (ev: Record<string, unknown>) => void;

class DomEl {
  children: DomEl[] = [];
  parentNode: DomEl | null = null;
  style: Record<string, string> = {};
  className = "";
  hidden = false;
  value = "";
  title = "";
  src = "";
  clientWidth = 800;
  clientHeight = 800;
  naturalWidth = 0;
  naturalHeight = 0;
  private text = "";
  private listeners = new Map<string, DomListener[]>();
  readonly classList = {
    add: (c: string): void => {
      if (!this.has(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string): void => {
      this.className = this.className
        .split(" ")
        .filter((x) => x !== c && x !== "")
        .join(" ");
    },
    contains: (c: string): boolean => this.has(c),
    toggle: (c: string, on?: boolean): void => {
      const want = on ?? !this.has(c);
      if (want) this.classList.add(c);
      else this.classList.remove(c);
    },
  };
  has(c: string): boolean {
    return this.className.split(" ").includes(c);
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
  get firstChild(): DomEl | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): DomEl | null {
    return null;
  }
  appendChild(el: DomEl): DomEl {
    el.parentNode = this;
    this.children.push(el);
    return el;
  }
  removeChild(el: DomEl): DomEl {
    const i = this.children.indexOf(el);
    if (i >= 0) this.children.splice(i, 1);
    el.parentNode = null;
    return el;
  }
  insertBefore(el: DomEl): DomEl {
    return this.appendChild(el);
  }
  setAttribute(): void {}
  setPointerCapture(): void {}
  blur(): void {}
  closest(): null {
    return null;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 200, height: 400 };
  }
  addEventListener(type: string, fn: DomListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => undefined, ...ev });
  }
}

interface PageRig {
  frame: DomEl;
  marks: DomEl;
  notice: DomEl;
  sock: FakeSocket;
  gestures(): number;
}

const PAGE_ACCEPTS = ["tap", "longPress", "drag", "scroll"];

function pageRig(accepts: string[] = PAGE_ACCEPTS): PageRig {
  FakeSocket.all = [];
  const els = new Map<string, DomEl>();
  const get = (id: string): DomEl => {
    let el = els.get(id);
    if (!el) {
      el = new DomEl();
      els.set(id, el);
    }
    return el;
  };
  const doc = {
    getElementById: get,
    createElement: (): DomEl => new DomEl(),
    addEventListener: (): void => undefined,
    activeElement: null,
  };
  const win = { addEventListener: (): void => undefined };
  const loc = { search: "", pathname: "/viewer", protocol: "http:", href: "http://host/viewer" };
  const hist = { replaceState: (): void => undefined };
  const factory = new Function(
    "window",
    "document",
    "location",
    "history",
    "WebSocket",
    "fetch",
    scriptBody(),
  ) as (w: object, d: object, l: object, h: object, s: object, f: () => Promise<never>) => void;
  factory(win, doc, loc, hist, FakeSocket, () => new Promise<never>(() => undefined));
  const sock = FakeSocket.all[0]!;
  sock.message(
    JSON.stringify({
      type: "status",
      protocol: 1,
      state: "live",
      driver: null,
      paused: false,
      size: { w: 400, h: 800 },
      accepts,
    }),
  );
  return {
    frame: get("frame"),
    marks: get("marks"),
    notice: get("notice"),
    sock,
    gestures: () => sock.sent.filter((s) => (JSON.parse(s) as { type: string }).type === "gesture").length,
  };
}

function pointer(rig: PageRig, type: string, x: number, y: number, t: number): void {
  rig.frame.dispatch(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
    button: 0,
    clientX: x,
    clientY: y,
    timeStamp: t,
  });
}

/* A finger down and up at (x, y) of the 200 x 400 frame, held for ms. */
function tapAt(rig: PageRig, x: number, y: number, ms = 80): void {
  pointer(rig, "pointerdown", x, y, 1000);
  pointer(rig, "pointerup", x, y, 1000 + ms);
}

function action(rig: PageRig, m: Record<string, unknown>): void {
  rig.sock.message(JSON.stringify({ type: "action", at: 1731222000000, ...m }));
}

describe("viewer page: a person's click shows a mark at once", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws a pending mark synchronously when a tap is released, before any server message", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    expect(rig.gestures()).toBe(1);
    expect(rig.marks.children).toHaveLength(1);
    const el = rig.marks.children[0]!;
    for (const c of ["mark", "person", "ring", "pending"]) expect(el.has(c)).toBe(true);
    expect(el.style.left).toBe("50.000%");
    expect(el.style.top).toBe("50.000%");
  });

  it("draws a pending mark at the release point of a long press", () => {
    const rig = pageRig();
    tapAt(rig, 50, 100, 700);
    expect(rig.marks.children).toHaveLength(1);
    expect(rig.marks.children[0]!.has("pending")).toBe(true);
    expect(rig.marks.children[0]!.style.left).toBe("25.000%");
  });

  it("keeps exactly one mark, no longer pending, when the person's action arrives near the point", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    const pending = rig.marks.children[0]!;
    action(rig, { by: "person", kind: "press", label: "Log in", point: { x: 0.5, y: 0.51 } });
    expect(rig.marks.children).toHaveLength(1);
    const el = rig.marks.children[0]!;
    expect(el).toBe(pending);
    expect(el.has("pending")).toBe(false);
    expect(el.has("ring")).toBe(true);
    expect(el.has("fail")).toBe(false);
    expect(el.style.top).toBe("51.000%");
    expect(el.children[0]!.textContent).toBe("Log in");
  });

  it("turns the pending mark into the element's rect when the action carries one around the point", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    const pending = rig.marks.children[0]!;
    action(rig, {
      by: "person",
      kind: "press",
      label: "Log in",
      rect: { x: 0.4, y: 0.45, w: 0.2, h: 0.1 },
      point: { x: 0.5, y: 0.5 },
    });
    expect(rig.marks.children).toHaveLength(1);
    const el = rig.marks.children[0]!;
    expect(el).toBe(pending);
    expect(el.has("rect")).toBe(true);
    expect(el.has("ring")).toBe(false);
    expect(el.has("pending")).toBe(false);
    expect(el.style.width).toBe("20.000%");
  });

  it("shows the failure mark and no pending one when the person's action failed", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    action(rig, { by: "person", kind: "press", point: { x: 0.5, y: 0.5 }, ok: false, code: "not_actionable" });
    expect(rig.marks.children).toHaveLength(1);
    const el = rig.marks.children[0]!;
    expect(el.has("fail")).toBe(true);
    expect(el.has("pending")).toBe(false);
    expect(el.children[0]!.textContent).toBe("press (not_actionable)");
  });

  it("takes the pending mark for a failed action that has no position", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    action(rig, { by: "person", kind: "press", ok: false, code: "busy" });
    expect(rig.marks.children).toHaveLength(1);
    expect(rig.marks.children[0]!.has("pill")).toBe(true);
    expect(rig.marks.children[0]!.has("pending")).toBe(false);
  });

  it("removes the pending mark at once on an error message", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    expect(rig.marks.children).toHaveLength(1);
    rig.sock.message(JSON.stringify({ type: "error", message: "A person is driving", code: "busy" }));
    expect(rig.marks.children).toHaveLength(0);
    expect(rig.notice.textContent).toBe("A person is driving (busy)");
  });

  it("fades the pending mark out and removes it by 2 s when no answer comes", () => {
    vi.useFakeTimers();
    const rig = pageRig();
    tapAt(rig, 100, 200);
    const el = rig.marks.children[0]!;
    vi.advanceTimersByTime(1600);
    expect(el.has("gone")).toBe(false);
    vi.advanceTimersByTime(150);
    expect(el.has("gone")).toBe(true);
    expect(rig.marks.children).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(rig.marks.children).toHaveLength(0);
    action(rig, { by: "person", kind: "press", point: { x: 0.5, y: 0.5 } });
    expect(rig.marks.children).toHaveLength(1);
    expect(rig.marks.children[0]).not.toBe(el);
  });

  it("lets an answered mark run its own life, not the pending timers", () => {
    vi.useFakeTimers();
    const rig = pageRig();
    tapAt(rig, 100, 200);
    action(rig, { by: "person", kind: "press", point: { x: 0.5, y: 0.5 } });
    vi.advanceTimersByTime(1650);
    expect(rig.marks.children).toHaveLength(1);
    expect(rig.marks.children[0]!.has("gone")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(rig.marks.children).toHaveLength(0);
  });

  it("draws nothing new for a drag", () => {
    const rig = pageRig();
    pointer(rig, "pointerdown", 100, 100, 1000);
    pointer(rig, "pointermove", 100, 200, 1050);
    pointer(rig, "pointerup", 100, 300, 1100);
    expect(rig.gestures()).toBe(1);
    expect(rig.marks.children).toHaveLength(0);
  });

  it("draws nothing when the gesture could not be sent", () => {
    const rig = pageRig();
    rig.sock.readyState = 3;
    tapAt(rig, 100, 200);
    expect(rig.marks.children).toHaveLength(0);
  });

  it("leaves the pending mark alone for a person's action far from it", () => {
    const rig = pageRig();
    tapAt(rig, 100, 200);
    action(rig, { by: "person", kind: "press", point: { x: 0.9, y: 0.9 } });
    expect(rig.marks.children).toHaveLength(2);
    expect(rig.marks.children[0]!.has("pending")).toBe(true);
    expect(rig.marks.children[1]!.has("pending")).toBe(false);
  });

  it("draws agent actions as before and never takes a pending mark", () => {
    const rig = pageRig();
    action(rig, { by: "agent", kind: "press", label: "Save", rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } });
    expect(rig.marks.children).toHaveLength(1);
    const agent = rig.marks.children[0]!;
    expect(agent.className).toBe("mark agent rect");
    expect(agent.style.left).toBe("10.000%");
    expect(agent.children[0]!.textContent).toBe("Save");
    tapAt(rig, 100, 200);
    action(rig, { by: "agent", kind: "press", point: { x: 0.5, y: 0.5 } });
    expect(rig.marks.children).toHaveLength(3);
    expect(rig.marks.children[1]!.has("pending")).toBe(true);
    expect(rig.marks.children[2]!.className).toBe("mark agent ring");
  });

  it("draws a failed agent action with the failure mark", () => {
    const rig = pageRig();
    action(rig, { by: "agent", kind: "press", point: { x: 0.2, y: 0.2 }, ok: false, code: "covered" });
    expect(rig.marks.children[0]!.className).toBe("mark agent fail ring");
  });
});
