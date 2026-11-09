import { describe, expect, it } from "vitest";
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

  it("talks to /stream and /ws and sets a viewport for phones", () => {
    const script = scriptBody();
    expect(script).toContain("/stream");
    expect(script).toContain("/ws");
    expect(VIEWER_HTML).toContain("viewport");
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
