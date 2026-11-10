import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encode } from "jpeg-js";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { CallResult, ToolSession } from "../src/mcp.js";
import { allPass, formatTable, buildScorecard, valueRow, type ValueRow } from "../src/scorecard.js";
import { valueTargetFor } from "../src/targets.js";
import { cropDiffer, framesDiffer, type Crop, type DecodedFrame } from "../src/viewer/diff.js";
import { parseViewerLink, redactToken } from "../src/viewer/link.js";
import { jpegSize, MjpegParser, parseFrameHeaders } from "../src/viewer/mjpeg.js";
import {
  frameAgesSeconds,
  framesPerSecond,
  kbPerSecond,
  maxGapSeconds,
  firstChanged,
  normalize,
  parseLook,
  pxPerPt,
  runViewer,
} from "../src/viewer/suite.js";
import { selectSuites } from "../src/suites.js";

function solid(w: number, h: number, r: number, g: number, b: number): Buffer {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return encode({ width: w, height: h, data }, 90).data;
}

function part(body: Buffer, extra: Record<string, string> = {}, boundaryBefore = true): Buffer {
  const head = [
    ...(boundaryBefore ? ["--frame"] : []),
    "Content-Type: image/jpeg",
    `Content-Length: ${body.length}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(head, "latin1"), body, Buffer.from("\r\n", "latin1")]);
}

describe("MjpegParser", () => {
  const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const b = Buffer.from("\r\n--frame\r\nlooks like a boundary", "latin1");

  it("parses a boundary before each part", () => {
    const stream = Buffer.concat([
      part(a, { "X-Seq": "1" }),
      part(b, { "X-Seq": "2" }),
    ]);
    const parts = new MjpegParser().push(stream);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.body.equals(a)).toBe(true);
    expect(parts[1]?.body.equals(b)).toBe(true);
    expect(parts[0]?.headers["x-seq"]).toBe("1");
  });

  it("parses a boundary sent right after each part, and returns the part before the next boundary", () => {
    const one = Buffer.concat([part(a, {}, false), Buffer.from("--frame\r\n", "latin1")]);
    const parser = new MjpegParser();
    const first = parser.push(one);
    expect(first).toHaveLength(1);
    const second = parser.push(part(b, {}, false));
    expect(second).toHaveLength(1);
    expect(second[0]?.body.equals(b)).toBe(true);
  });

  it("completes a part without waiting for the next boundary", () => {
    const all = part(a);
    const without = all.subarray(0, all.length - 2); // no trailing CRLF yet
    expect(new MjpegParser().push(without)).toHaveLength(1);
  });

  it("gives the same parts when fed byte by byte", () => {
    const stream = Buffer.concat([part(a, { "X-Seq": "1" }), part(b), part(a, { "X-Seq": "3" }, false), Buffer.from("--frame\r\n")]);
    const parser = new MjpegParser();
    const parts = [];
    for (const byte of stream) parts.push(...parser.push(Uint8Array.of(byte)));
    expect(parts.map((p) => p.body.length)).toEqual([a.length, b.length, a.length]);
    expect(parts[2]?.headers["x-seq"]).toBe("3");
  });

  it("handles several parts in one chunk and splits at every offset", () => {
    const stream = Buffer.concat([part(a), part(a), part(b)]);
    for (let cut = 1; cut < stream.length; cut += 7) {
      const parser = new MjpegParser();
      const parts = [...parser.push(stream.subarray(0, cut)), ...parser.push(stream.subarray(cut))];
      expect(parts).toHaveLength(3);
    }
  });

  it("copes with missing optional headers", () => {
    const parts = new MjpegParser().push(part(a));
    expect(parts).toHaveLength(1);
    expect(parseFrameHeaders(parts[0]?.headers ?? {})).toEqual({});
  });

  it("falls back to the boundary when there is no Content-Length", () => {
    const raw = Buffer.concat([
      Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n", "latin1"),
      a,
      Buffer.from("\r\n--frame\r\n", "latin1"),
    ]);
    const parts = new MjpegParser().push(raw);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.body.equals(a)).toBe(true);
  });

  it("reads the frame headers", () => {
    expect(
      parseFrameHeaders({ "x-seq": "7", "x-captured-at": "1700000000123", "x-size": "440x956", "x-tree-rev": "12" }),
    ).toEqual({ seq: 7, capturedAt: 1700000000123, size: { w: 440, h: 956 }, treeRev: 12 });
    expect(parseFrameHeaders({ "x-size": "bad", "x-seq": "nope" })).toEqual({});
  });

  it("reads a JPEG's size from its header", () => {
    expect(jpegSize(solid(40, 24, 1, 2, 3))).toEqual({ width: 40, height: 24 });
    expect(jpegSize(Buffer.from("not a jpeg"))).toBeNull();
  });
});

describe("viewer link", () => {
  it("takes the first URL with a token, whatever its path", () => {
    const text = "Docs at http://127.0.0.1:7211/docs and the viewer: http://127.0.0.1:7211/viewer?token=ABC123. Open it.";
    expect(parseViewerLink(text)).toEqual({ origin: "http://127.0.0.1:7211", token: "ABC123" });
    // Tapwright serves its page at /
    expect(parseViewerLink("Live view: http://127.0.0.1:8417/?token=XYZ")).toEqual({ origin: "http://127.0.0.1:8417", token: "XYZ" });
  });

  it("accepts https and skips a /viewer URL without a token", () => {
    const text = "https://x.ts.net:7211/viewer then https://x.ts.net:7211/viewer?token=T0K";
    expect(parseViewerLink(text)).toEqual({ origin: "https://x.ts.net:7211", token: "T0K" });
  });

  it("returns null when there is none", () => {
    expect(parseViewerLink("no link here")).toBeNull();
    expect(parseViewerLink("http://127.0.0.1:1/viewer")).toBeNull();
  });

  it("redacts the token", () => {
    const t = "open http://h:1/viewer?token=SECRET&x=1 or send SECRET";
    const out = redactToken(t, "SECRET");
    expect(out).not.toContain("SECRET");
    expect(out).toContain("token=<hidden>");
    expect(redactToken("token=abc")).toBe("token=<hidden>");
  });
});

describe("framesDiffer", () => {
  it("treats identical pictures as the same", () => {
    expect(framesDiffer(solid(64, 64, 10, 10, 10), solid(64, 64, 10, 10, 10))).toBe(false);
  });
  it("sees a large colour change", () => {
    expect(framesDiffer(solid(64, 64, 10, 10, 10), solid(64, 64, 200, 90, 10))).toBe(true);
  });
  it("ignores a small colour change", () => {
    expect(framesDiffer(solid(64, 64, 100, 100, 100), solid(64, 64, 110, 110, 100))).toBe(false);
  });
  it("calls different sizes different", () => {
    expect(framesDiffer(solid(64, 64, 1, 1, 1), solid(32, 64, 1, 1, 1))).toBe(true);
  });
  it("needs more than 20 changed samples", () => {
    // 64x64 has 4096 samples at stride 16; paint a patch of 5 samples' worth of pixels (20 pixels = 5 samples).
    const w = 64;
    const base = Buffer.alloc(w * w * 4, 0);
    const patched = Buffer.from(base);
    for (let i = 0; i < w * w; i++) {
      base[i * 4 + 3] = 255;
      patched[i * 4 + 3] = 255;
    }
    for (let i = 0; i < 20 * 4; i++) patched[i * 4] = 255; // 80 pixels = 20 samples
    const a = encode({ width: w, height: w, data: base }, 100).data;
    const b = encode({ width: w, height: w, data: patched }, 100).data;
    expect(framesDiffer(a, b)).toBe(false);
    for (let i = 0; i < 40 * 4; i++) patched[i * 4] = 255; // 160 pixels = 40 samples
    expect(framesDiffer(a, encode({ width: w, height: w, data: patched }, 100).data)).toBe(true);
  });
});

describe("V1 crop rule and first changed frame", () => {
  const W = 100;
  const H = 200;
  /** A grey frame with an optional dark block (a "digit") at x 40-60, y 40-80. */
  function frame(digit: boolean, blockAt = 40): DecodedFrame {
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = 200;
      data[i * 4 + 1] = 200;
      data[i * 4 + 2] = 200;
      data[i * 4 + 3] = 255;
    }
    if (digit) {
      for (let y = blockAt; y < blockAt + 40; y++) {
        for (let x = 40; x < 60; x++) {
          data[(y * W + x) * 4] = 20;
          data[(y * W + x) * 4 + 1] = 20;
        }
      }
    }
    return { width: W, height: H, data };
  }
  const counter: Crop = { x0: 0.3, y0: 0.15, x1: 0.7, y1: 0.45 };

  it("sees a digit change inside the crop, ignores one outside it", () => {
    expect(cropDiffer(frame(false), frame(true), counter)).toBe(true);
    expect(cropDiffer(frame(false), frame(false), counter)).toBe(false);
    expect(cropDiffer(frame(false), frame(true, 150), counter)).toBe(false);
  });

  it("ignores a few noisy pixels", () => {
    const a = frame(false);
    const b = frame(false);
    for (let i = 0; i < 15; i++) b.data[((60 + i) * W + 50) * 4] = 0;
    expect(cropDiffer(a, b, counter)).toBe(false);
  });

  it("finds the first changed frame by binary search", () => {
    const jpeg = (digit: boolean): Buffer => Buffer.from(encode({ ...frame(digit), data: Buffer.from(frame(digit).data) }, 90).data);
    const before = { arrivalPerf: 0, arrivalWall: 0, bytes: jpeg(false), byteLength: 1 };
    const after = [false, false, false, true, true, true, true].map((d, i) => ({
      arrivalPerf: 100 * (i + 1),
      arrivalWall: 0,
      bytes: jpeg(d),
      byteLength: 1,
    }));
    expect(firstChanged(before, after, counter)?.arrivalPerf).toBe(400);
    expect(firstChanged(before, after.slice(0, 3), counter)).toBeUndefined();
    expect(firstChanged(before, [], counter)).toBeUndefined();
  });
});

describe("V metric computations", () => {
  it("frames per second", () => {
    expect(framesPerSecond(150, 10)).toBe(15);
    expect(framesPerSecond(0, 10)).toBe(0);
  });
  it("longest gap includes the window edges", () => {
    expect(maxGapSeconds([1100, 1200, 1700, 1800], 1000, 2000)).toBeCloseTo(0.5, 6);
    expect(maxGapSeconds([], 1000, 11000)).toBe(10);
    expect(maxGapSeconds([500, 12000, 1500], 1000, 2000)).toBeCloseTo(0.5, 6);
  });
  it("frame age uses the arrival time minus the capture time and skips frames without one", () => {
    expect(
      frameAgesSeconds([
        { arrivalWall: 10_200, capturedAt: 10_000 },
        { arrivalWall: 10_300 },
        { arrivalWall: 10_050, capturedAt: 10_000 },
      ]),
    ).toEqual([0.2, 0.05]);
  });
  it("pixels per point and KB/s", () => {
    expect(pxPerPt(880, 440)).toBe(2);
    expect(Number.isNaN(pxPerPt(100, 0))).toBe(true);
    expect(kbPerSecond(330_000, 10)).toBe(33);
  });
  it("reads the look header and the element centre", () => {
    const text = [
      "Screen 440x956 pt @3x · 3 elements",
      "e1 text \"x\" @10,10 100x20",
      "e2 button \"Tap\" id=lab-taps @20,600 400x100 [tap]",
      "e3 button \"Other\" id=lab-taps-extra @0,0 10x10 [tap]",
    ].join("\n");
    const g = parseLook(text, "lab-taps");
    expect(g?.screen).toEqual({ w: 440, h: 956 });
    expect(g?.center).toEqual({ x: 220, y: 650 });
    expect(normalize({ x: 220, y: 650 }, { w: 440, h: 956 })).toEqual({ x: 0.5, y: 650 / 956 });
    expect(parseLook("nothing", "lab-taps")).toBeNull();
  });
});

describe("scorecard value rows", () => {
  it("passes, fails and reports", () => {
    expect(valueRow("V2", 20, "fps", "good").pass).toBe(true);
    expect(valueRow("V2", 3, "fps", "good").pass).toBe(false);
    expect(valueRow("V2", 3, "fps", "3g").pass).toBe(true);
    expect(valueRow("V3.look", 0.4, "s", "good").pass).toBe(false);
    expect(valueRow("V7.kbps", 500, "KB/s", "good").pass).toBeNull();
    expect(valueRow("V7.kbps", 40, "KB/s", "3g").pass).toBe(false);
    expect(valueRow("V5.light", Number.NaN, "px/pt", "good").pass).toBe(false);
    expect(valueTargetFor("V5.sharp", "good")).toEqual({ min: 2 });
  });
  it("a null row does not fail the card, and the table prints it", () => {
    const row: ValueRow = valueRow("V7.kbps", 12.5, "KB/s", "good");
    const card = buildScorecard({ tool: "t", version: "1", phone: "p", ios: "26", link: "good" }, [row]);
    expect(allPass(card)).toBe(true);
    expect(formatTable(card)).toContain("n/a");
    expect(formatTable(card)).toContain("12.5 KB/s");
  });
  it("the viewer suite is registered", () => {
    expect(selectSuites("viewer").map((s) => s.name)).toEqual(["viewer"]);
  });
});

/* ---------- end to end against a local fake server ---------- */

const TOKEN = "FAKE-TOKEN-123";

interface Fake {
  server: Server;
  wss: WebSocketServer;
  timer: NodeJS.Timeout;
  origin: string;
}

async function startFake(): Promise<Fake> {
  let widthPx = 150;
  let color = 0;
  let seq = 0;
  const colors: [number, number, number][] = [
    [20, 20, 20],
    [220, 40, 40],
    [40, 220, 40],
    [40, 40, 220],
  ];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.url !== "/stream" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
    const send = (): void => {
      const c = colors[color % colors.length] ?? [0, 0, 0];
      const body = solid(widthPx, widthPx * 2, c[0], c[1], c[2]);
      seq++;
      res.write(
        part(body, { "X-Seq": String(seq), "X-Captured-At": String(Date.now() - 20), "X-Size": "100x200" }),
      );
    };
    const timer = setInterval(send, 40);
    send();
    res.on("close", () => clearInterval(timer));
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const msg: unknown = JSON.parse(raw.toString());
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as { type?: string; preset?: string };
        if (m.type === "gesture") {
          color++;
          ws.send(JSON.stringify({ type: "action", by: "person", kind: "tap", ok: true }));
        } else if (m.type === "quality") {
          widthPx = m.preset === "sharp" ? 200 : m.preset === "balanced" ? 150 : 75;
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { server, wss, timer: setTimeout(() => undefined, 0), origin: `http://127.0.0.1:${port}` };
}

function fakeTool(origin: string): ToolSession & { calls: string[] } {
  const calls: string[] = [];
  const ok = (text: string): CallResult => ({ text, images: 0, isError: false, ms: 5 });
  return {
    calls,
    async call(name, args) {
      calls.push(`${name}${typeof args.value === "boolean" ? `:${args.value}` : ""}`);
      switch (name) {
        case "viewer":
          return ok(`Viewer: ${origin}/viewer?token=${TOKEN}`);
        case "look":
          return ok(
            'Screen 100x200 pt @3x · 2 elements\ne1 button "Tap" id=lab-taps @10,100 80x40 [tap]\ne2 switch id=lab-anim-toggle @10,150 40x20 [toggle]',
          );
        default:
          return ok("Done. Settled in 0.10 s.");
      }
    },
  };
}

describe("viewer suite against a fake server", () => {
  let fake: Fake | undefined;
  afterEach(async () => {
    if (!fake) return;
    clearTimeout(fake.timer);
    for (const c of fake.wss.clients) c.terminate();
    fake.server.closeAllConnections();
    await new Promise<void>((r) => fake?.server.close(() => r()));
    fake = undefined;
  });

  it("measures every row and closes up", async () => {
    fake = await startFake();
    const tool = fakeTool(fake.origin);
    const rows = await runViewer(tool, {
      samples: 3,
      link: "good",
      tapGapMs: 100,
      giveUpMs: 2000,
      windowMs: 600,
      warmupMs: 50,
      presetWaitMs: 2000,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()]).toEqual([
      "V1", "V2", "V3", "V3.look", "V4", "V7.kbps", "V5.sharp", "V5.balanced", "V5.light", "V7.s1", "V6", "V8",
    ]);
    const v1 = byId.get("V1");
    expect(v1 && "samples" in v1 ? v1.samples : 0).toBe(3);
    expect(v1 && "median" in v1 ? v1.median : 0).toBeGreaterThan(0);
    expect(v1 && "median" in v1 ? v1.median : 9).toBeLessThan(0.5);
    const v2 = byId.get("V2");
    expect(v2 && "value" in v2 ? v2.value : 0).toBeGreaterThan(5);
    const v4 = byId.get("V4");
    expect(v4 && "pass" in v4 ? v4.pass : false).toBe(true);
    const sharp = byId.get("V5.sharp");
    const light = byId.get("V5.light");
    expect(sharp && "value" in sharp ? sharp.value : 0).toBe(2);
    expect(light && "value" in light ? light.value : 0).toBe(0.75);
    const v6 = byId.get("V6");
    expect(v6 && "pass" in v6 ? v6.pass : false).toBeNull();
    expect(tool.calls.filter((c) => c === "toggle:true")).toHaveLength(1);
    expect(tool.calls.at(-1)).not.toBe("toggle:true");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  }, 20_000);
});
