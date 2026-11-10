/**
 * Incremental parser for the viewer's `multipart/x-mixed-replace` stream (VIEWER-PROTOCOL, GET /stream).
 *
 * Parts are cut by `Content-Length`, never by waiting for the next boundary, so a frame is
 * complete the moment its last byte arrives. Both layouts parse: a boundary before each part
 * (`--frame\r\n<headers>\r\n\r\n<jpeg>\r\n--frame\r\n...`) and a boundary sent right after each
 * part (`<headers>\r\n\r\n<jpeg>\r\n--frame\r\n`). A part without `Content-Length` falls back
 * to the next `\r\n--<boundary>` line (that one does wait for the boundary).
 */

export interface MjpegPart {
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: Buffer;
}

export class MjpegParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly boundary: string = "frame") {}

  /** Feeds a chunk (any size, split anywhere); returns the parts it completed, in order. */
  push(chunk: Uint8Array): MjpegPart[] {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const out: MjpegPart[] = [];
    for (;;) {
      const part = this.next();
      if (!part) return out;
      out.push(part);
    }
  }

  private next(): MjpegPart | null {
    const b = this.buf;
    let pos = 0;
    // Skip line breaks and boundary lines ("--frame", "--frame--") between parts.
    for (;;) {
      while (pos < b.length && (b[pos] === 13 || b[pos] === 10)) pos++;
      if (pos < b.length && b[pos] === 0x2d) {
        const eol = b.indexOf(10, pos);
        if (eol < 0) return this.wait(pos);
        pos = eol + 1;
        continue;
      }
      break;
    }
    if (pos >= b.length) return this.wait(pos);
    const headEnd = b.indexOf("\r\n\r\n", pos, "latin1");
    if (headEnd < 0) return this.wait(pos);
    const headers = parseHeaders(b.toString("latin1", pos, headEnd));
    const bodyStart = headEnd + 4;
    const lenText = headers["content-length"];
    const len = lenText === undefined ? Number.NaN : Number(lenText);
    if (Number.isInteger(len) && len >= 0) {
      if (bodyStart + len > b.length) return this.wait(pos);
      this.buf = b.subarray(bodyStart + len);
      return { headers, body: Buffer.from(b.subarray(bodyStart, bodyStart + len)) };
    }
    const marker = b.indexOf(`\r\n--${this.boundary}`, bodyStart, "latin1");
    if (marker < 0) return this.wait(pos);
    this.buf = b.subarray(marker);
    return { headers, body: Buffer.from(b.subarray(bodyStart, marker)) };
  }

  private wait(pos: number): null {
    this.buf = this.buf.subarray(pos);
    return null;
  }
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\r\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** One frame as the runner keeps it. */
export interface Frame extends FrameHeaders {
  /** performance.now() when the frame was complete. */
  arrivalPerf: number;
  /** Date.now() at the same moment (for the server's clock in X-Captured-At). */
  arrivalWall: number;
  /** The JPEG. Emptied for old frames (ViewerClient keeps only the newest ones' bytes). */
  bytes: Buffer;
  /** The JPEG's size in bytes, kept when `bytes` is emptied. */
  byteLength: number;
}

export interface FrameHeaders {
  seq?: number;
  /** Epoch ms on the server's clock. */
  capturedAt?: number;
  /** Frame size in points. */
  size?: { w: number; h: number };
  treeRev?: number;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Reads X-Seq, X-Captured-At, X-Size and X-Tree-Rev; anything missing or malformed is left out. */
export function parseFrameHeaders(headers: Record<string, string>): FrameHeaders {
  const out: FrameHeaders = {};
  const seq = num(headers["x-seq"]);
  if (seq !== undefined) out.seq = seq;
  const capturedAt = num(headers["x-captured-at"]);
  if (capturedAt !== undefined) out.capturedAt = capturedAt;
  const treeRev = num(headers["x-tree-rev"]);
  if (treeRev !== undefined) out.treeRev = treeRev;
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(headers["x-size"] ?? "");
  if (m?.[1] !== undefined && m[2] !== undefined) out.size = { w: Number(m[1]), h: Number(m[2]) };
  return out;
}

/** Width and height in pixels from a JPEG's start-of-frame marker, without decoding. Null if none is found. */
export function jpegSize(jpeg: Uint8Array): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    let m = jpeg[i + 1] ?? 0;
    while (m === 0xff && i + 2 < jpeg.length) {
      i++;
      m = jpeg[i + 1] ?? 0;
    }
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 8 >= jpeg.length) return null;
      const height = ((jpeg[i + 5] ?? 0) << 8) | (jpeg[i + 6] ?? 0);
      const width = ((jpeg[i + 7] ?? 0) << 8) | (jpeg[i + 8] ?? 0);
      return { width, height };
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2;
      continue;
    }
    const segLen = ((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0);
    i += 2 + segLen;
  }
  return null;
}
