import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ControlQueue } from "../src/control.js";
import {
  VIEWER_ACCEPTS,
  VIEWER_TOOL,
  ViewerHub,
  viewerStatusFor,
  type PersonInput,
  type ViewerHubOptions,
} from "../src/viewer.js";

const TOKEN = "viewer-token-123";
const servers: Server[] = [];
const hubs: ViewerHub[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

interface Harness {
  hub: ViewerHub;
  port: number;
  feed: Array<[boolean, string]>;
  inputs: PersonInput[];
  control: ControlQueue;
}

async function startHub(overrides: Partial<ViewerHubOptions> = {}): Promise<Harness> {
  const feed: Array<[boolean, string]> = [];
  const inputs: PersonInput[] = [];
  const control = new ControlQueue();
  let port = 0;
  const hub = new ViewerHub({
    token: TOKEN,
    html: "<!doctype html><title>viewer</title>",
    allowedHosts: () => [`127.0.0.1:${port}`, `localhost:${port}`],
    allowRemote: false,
    accepts: ["tap", "longPress", "scroll", "text", "enter", "backspace", "quality"],
    control,
    setFeed: (on, quality) => feed.push([on, quality]),
    readOverlay: async () => ({
      rev: 7,
      size: { w: 400, h: 800 },
      elements: [{ ref: "e3", type: "button", label: "Save", id: "save", rect: { x: 100, y: 200, w: 200, h: 40 } }],
    }),
    runInput: async (input) => {
      inputs.push(input);
      return input.type === "text" && input.text === "fail"
        ? { ok: false, code: "unsupported", message: "no input is focused" }
        : { ok: true, action: { kind: "press", label: "Save", rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.05 } } };
    },
    idleStopMs: 50,
    ...overrides,
  });
  const server = createServer((req, res) => {
    if (!hub.onRequest(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!hub.onUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  servers.push(server);
  hubs.push(hub);
  return { hub, port, feed, inputs, control };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function openWs(
  port: number,
  extra: { origin?: string; auth?: "bearer" | "cookie" | "query"; fetchSite?: string } = {},
): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const auth = extra.auth ?? "bearer";
    const headers: Record<string, string> = {
      ...(auth === "bearer" ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(auth === "cookie" ? { cookie: `tapline_viewer=${TOKEN}` } : {}),
      ...(extra.fetchSite ? { "sec-fetch-site": extra.fetchSite } : {}),
    };
    const path = auth === "query" ? `/ws?token=${TOKEN}` : "/ws";
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, ...(extra.origin ? { origin: extra.origin } : {}) });
    sockets.push(ws);
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
}

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const FRAME = { seq: 1, rev: 7, capturedAt: 1000, mime: "image/jpeg", data: Buffer.from("JPEGDATA").toString("base64"), width: 400, height: 800 };

describe("viewerStatusFor", () => {
  it("is live for a connected app, paused on the phone while it's in the background, no-device without one", () => {
    expect(viewerStatusFor(undefined)).toMatchObject({ state: "no-device", detail: expect.stringContaining("open it on the phone") });
    expect(viewerStatusFor({ app: { name: "Demo" } })).toEqual({ state: "live", detail: undefined });
    expect(viewerStatusFor({ app: { name: "Demo" }, appState: { state: "active", at: 1 } })).toEqual({ state: "live", detail: undefined });
    const away = viewerStatusFor({ app: { name: "Demo" }, appState: { state: "background", at: 1 } });
    expect(away.state).toBe("locked");
    // The page words the state "Phone locked" and appends this detail to it.
    expect(away.detail).toBe("the app is in the background");
    expect(away.detail).not.toMatch(/Error|in_background/);
  });
});

describe("what the host's status tells the page (protocol 1.3)", () => {
  it("names the tool and offers overlay in the accepts list it runs with", () => {
    expect(VIEWER_TOOL).toBe("Tapline");
    expect(VIEWER_ACCEPTS).toContain("overlay");
    expect([...VIEWER_ACCEPTS].sort()).toEqual(
      ["tap", "longPress", "scroll", "text", "enter", "backspace", "overlay", "quality"].sort(),
    );
  });

  it("sends tool: Tapline in every status, and the locked detail when the app is in the background", async () => {
    const { hub, port } = await startHub({ accepts: [...VIEWER_ACCEPTS] });
    const { messages } = await openWs(port);
    await until(() => messages.some((m) => m["type"] === "status"));
    expect(messages.find((m) => m["type"] === "status")).toMatchObject({ tool: "Tapline", accepts: [...VIEWER_ACCEPTS] });
    const away = viewerStatusFor({ app: { name: "Demo" }, appState: { state: "background", at: 1 } });
    hub.setStatus({ state: away.state, detail: away.detail });
    await until(() => messages.some((m) => m["type"] === "status" && m["state"] === "locked"));
    expect(messages.filter((m) => m["type"] === "status").at(-1)).toMatchObject({
      tool: "Tapline",
      state: "locked",
      detail: "the app is in the background",
    });
    for (const m of messages.filter((x) => x["type"] === "status")) expect(m["tool"]).toBe("Tapline");
  });
});

describe("viewerStatusFor: not-answering (v1.4)", () => {
  it("is not-answering, with the app's name, while a connected app doesn't answer", () => {
    expect(viewerStatusFor({ app: { name: "Demo" } }, { notAnswering: true })).toEqual({ state: "not-answering", detail: "Demo" });
    expect(viewerStatusFor({ app: { name: "Demo" } }, { notAnswering: false })).toEqual({ state: "live", detail: undefined });
  });

  it("is not-answering after the host dropped the app for silence, until one connects; other drops stay no-device", () => {
    const silent = { session: { app: { name: "Demo" } }, silentForMs: 46_000 };
    expect(viewerStatusFor(undefined, { lastDrop: silent })).toEqual({ state: "not-answering", detail: "Demo" });
    expect(viewerStatusFor(undefined, { lastDrop: { session: { app: { name: "Demo" } } } }).state).toBe("no-device");
    expect(viewerStatusFor({ app: { name: "Demo" } }, { lastDrop: silent })).toEqual({ state: "live", detail: undefined });
  });

  it("an app in the background is locked, not not-answering", () => {
    expect(viewerStatusFor({ app: { name: "Demo" }, appState: { state: "background", at: 1 } }, { notAnswering: true }).state).toBe("locked");
  });

  it("the hub passes the state and the app's name on to the viewers", async () => {
    const { hub, port } = await startHub();
    const { messages } = await openWs(port);
    await until(() => messages.some((m) => m["type"] === "status"));
    hub.setStatus({ state: "not-answering", detail: "Demo" });
    await until(() => messages.some((m) => m["type"] === "status" && m["state"] === "not-answering"));
    expect(messages.filter((m) => m["state"] === "not-answering").at(-1)).toMatchObject({ detail: "Demo" });
    hub.setStatus({ state: "live", detail: undefined });
    await until(() => messages.at(-1)?.["state"] === "live");
    expect(messages.at(-1)).not.toHaveProperty("detail");
  });
});

describe("the page at / (v1.4)", () => {
  it("answers at / exactly as at /viewer: token in the URL sets the cookie, the cookie works, no token is 401", async () => {
    const { port } = await startHub();
    expect((await get(port, "/")).status).toBe(401);
    const first = await get(port, `/?token=${TOKEN}`, { "sec-fetch-site": "cross-site" });
    expect(first.status).toBe(200);
    expect(first.body).toContain("<title>viewer</title>");
    expect(first.headers["location"]).toBeUndefined();
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.headers["cache-control"]).toBe("no-store");
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toContain(`tapline_viewer=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect((await get(port, "/", { cookie: `tapline_viewer=${TOKEN}`, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get(port, "/", { cookie: `tapline_viewer=${TOKEN}`, "sec-fetch-site": "none" })).status).toBe(200);
    expect((await get(port, "/", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await get(port, "/?token=wrong")).status).toBe(401);
    // Same refusals as /viewer: a cookie from another site, a foreign Host header.
    expect((await get(port, "/", { cookie: `tapline_viewer=${TOKEN}`, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await get(port, `/?token=${TOKEN}`, { host: "evil.example:80" })).status).toBe(403);
  });

  it("serves the same page as /viewer", async () => {
    const { port } = await startHub();
    const a = await get(port, `/viewer?token=${TOKEN}`);
    const b = await get(port, `/?token=${TOKEN}`);
    expect(b.body).toBe(a.body);
  });
});

describe("viewer access", () => {
  it("needs the token: the first load serves the page and sets a cookie (no redirect, which loses the cookie after a click on another site)", async () => {
    const { port } = await startHub();
    expect((await get(port, "/viewer")).status).toBe(401);
    const first = await get(port, `/viewer?token=${TOKEN}`, { "sec-fetch-site": "cross-site" });
    expect(first.status).toBe(200);
    expect(first.body).toContain("<title>viewer</title>");
    expect(first.headers["location"]).toBeUndefined();
    expect(first.headers["referrer-policy"]).toBe("no-referrer");
    expect(first.headers["cache-control"]).toBe("no-store");
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toContain(`tapline_viewer=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const page = await get(port, "/viewer", { cookie: `tapline_viewer=${TOKEN}`, "sec-fetch-site": "same-origin" });
    expect(page.status).toBe(200);
    expect((await get(port, "/viewer", { cookie: `tapline_viewer=${TOKEN}`, "sec-fetch-site": "none" })).status).toBe(200);
    expect((await get(port, "/viewer?token=wrong")).status).toBe(401);
  });

  it("takes the token in the URL only on that page load, not on the stream or the WebSocket", async () => {
    const { port } = await startHub();
    expect((await get(port, `/stream?token=${TOKEN}`)).status).toBe(401);
    await expect(openWs(port, { auth: "query" })).rejects.toThrow(/refused/);
  });

  it("refuses a cookie sent from another site, even on this computer (cookies ignore ports)", async () => {
    const { port } = await startHub();
    const fromOtherPort = { cookie: `tapline_viewer=${TOKEN}`, "sec-fetch-site": "same-site" };
    expect((await get(port, "/viewer", fromOtherPort)).status).toBe(403);
    expect((await get(port, "/stream", fromOtherPort)).status).toBe(403);
    await expect(openWs(port, { auth: "cookie", fetchSite: "cross-site" })).rejects.toThrow(/refused 403/);
    await expect(openWs(port, { auth: "cookie", origin: `http://127.0.0.1:${port}` })).resolves.toBeDefined();
    // A Bearer token is not a cookie: other sites can't send it, so the header doesn't matter.
    await expect(openWs(port, { fetchSite: "cross-site" })).resolves.toBeDefined();
  });

  it("checks the Host header and leaves other paths alone", async () => {
    const { port } = await startHub();
    expect((await get(port, `/viewer?token=${TOKEN}`, { host: "evil.example:80" })).status).toBe(403);
    expect((await get(port, "/something-else")).status).toBe(404);
  });

  it("refuses a WebSocket from another origin, accepts its own", async () => {
    const { port } = await startHub();
    await expect(openWs(port, { origin: "http://evil.example" })).rejects.toThrow(/refused 403/);
    await expect(openWs(port, { origin: `http://127.0.0.1:${port}` })).resolves.toBeDefined();
  });
});

describe("the stream", () => {
  it("sends frames as multipart JPEG with the shared headers, and runs the app's capture only while watched", async () => {
    const { hub, port, feed } = await startHub();
    const received: string[] = [];
    const req = request({ host: "127.0.0.1", port, path: "/stream", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      expect(res.headers["content-type"]).toBe("multipart/x-mixed-replace; boundary=frame");
      res.on("data", (chunk: Buffer) => received.push(chunk.toString("latin1")));
    });
    req.end();
    await until(() => feed.length > 0);
    expect(feed[0]).toEqual([true, "balanced"]);
    hub.pushFrame(FRAME);
    await until(() => received.join("").includes("JPEGDATA"));
    const text = received.join("");
    expect(text).toContain("--frame\r\n");
    expect(text).toContain("Content-Type: image/jpeg");
    expect(text).toMatch(/X-Seq: 1\r\n/);
    expect(text).toMatch(/X-Captured-At: \d+\r\n/);
    expect(text).toContain("X-Coverage: app-window");
    expect(text).toContain("X-Source: viewshot");
    expect(text).toContain("X-Tree-Rev: 7");
    req.destroy();
    await until(() => feed.some(([on]) => !on), 1000);
  });

  describe("part framing", () => {
    const CLOSE = "\r\n--frame\r\n";

    function openRaw(port: number): { chunks: Buffer[]; all: () => Buffer; close: () => void } {
      const chunks: Buffer[] = [];
      const req = request({ host: "127.0.0.1", port, path: "/stream", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
      });
      req.on("error", () => undefined);
      req.end();
      return { chunks, all: () => Buffer.concat(chunks), close: () => req.destroy() };
    }

    function bigFrame(seq: number, fill: number): typeof FRAME {
      return { ...FRAME, seq, data: Buffer.alloc(40_000, fill).toString("base64") };
    }

    // Parses by Content-Length, as a strict client would. Returns the complete parts and what is left.
    function parseByLength(buf: Buffer): { parts: Array<{ headers: string; body: Buffer }>; rest: Buffer } {
      const parts: Array<{ headers: string; body: Buffer }> = [];
      let rest = buf.toString("latin1").startsWith("--frame\r\n") ? buf.subarray("--frame\r\n".length) : buf;
      for (;;) {
        const end = rest.indexOf("\r\n\r\n");
        if (end < 0) break;
        const headers = rest.subarray(0, end).toString("latin1");
        const length = Number(/Content-Length: (\d+)/.exec(headers)?.[1]);
        const bodyStart = end + 4;
        const closeEnd = bodyStart + length + CLOSE.length;
        if (rest.length < closeEnd) break;
        expect(rest.subarray(bodyStart + length, closeEnd).toString("latin1")).toBe(CLOSE);
        parts.push({ headers, body: rest.subarray(bodyStart, bodyStart + length) });
        rest = rest.subarray(closeEnd);
      }
      return { parts, rest };
    }

    it("completes a frame larger than the write buffer at once, without a later frame", async () => {
      const { hub, port, feed } = await startHub();
      const raw = openRaw(port);
      await until(() => feed.length > 0);
      hub.pushFrame(bigFrame(1, 0x41));
      await until(() => raw.all().toString("latin1").endsWith(CLOSE));
      const parsed = parseByLength(raw.all());
      expect(parsed.parts).toHaveLength(1);
      expect(parsed.parts[0]?.body.length).toBe(40_000);
      expect(parsed.rest.length).toBe(0);
      raw.close();
    });

    it("opens the first part with --frame and does not repeat it; both parse by length and by boundary", async () => {
      const { hub, port, feed } = await startHub();
      const raw = openRaw(port);
      await until(() => feed.length > 0);
      hub.pushFrame(bigFrame(1, 0x41));
      await until(() => raw.all().toString("latin1").endsWith(CLOSE));
      hub.pushFrame(bigFrame(2, 0x42));
      await until(() => raw.all().toString("latin1").includes("X-Seq: 2") && raw.all().toString("latin1").endsWith(CLOSE));
      const all = raw.all();
      expect(all.toString("latin1").startsWith("--frame\r\nContent-Type: image/jpeg\r\n")).toBe(true);
      expect(all.toString("latin1").split("--frame\r\n").length - 1).toBe(3); // the opening one, then one closing each part
      // by length
      const parsed = parseByLength(all);
      expect(parsed.parts.map((p) => /X-Seq: (\d+)/.exec(p.headers)?.[1])).toEqual(["1", "2"]);
      expect(parsed.parts[0]?.body.every((b) => b === 0x41)).toBe(true);
      expect(parsed.parts[1]?.body.every((b) => b === 0x42)).toBe(true);
      expect(parsed.rest.length).toBe(0);
      // by boundary, as a browser splits: everything between boundaries is a part
      const pieces = all.toString("latin1").split(CLOSE);
      expect(pieces).toHaveLength(3);
      expect(pieces[2]).toBe("");
      const first = pieces[0]?.replace(/^--frame\r\n/, "") ?? "";
      const second = pieces[1] ?? "";
      for (const [piece, fill] of [[first, "A"], [second, "B"]] as const) {
        const split = piece.indexOf("\r\n\r\n");
        expect(piece.slice(0, split)).toContain("Content-Type: image/jpeg");
        expect(piece.slice(split + 4)).toBe(fill.repeat(40_000));
      }
      raw.close();
    });
  });

  it("answers at once, before the first frame, so a viewer knows it is waiting rather than stuck", async () => {
    const { port } = await startHub();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/stream", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});

describe("the WebSocket", () => {
  it("starts with a status, then sends overlays on request in 0..1", async () => {
    const { hub, port } = await startHub();
    const { ws, messages } = await openWs(port);
    await until(() => messages.some((m) => m["type"] === "status"));
    const status = messages.find((m) => m["type"] === "status");
    expect(status).toMatchObject({ protocol: 1, tool: "Tapline", accepts: ["tap", "longPress", "scroll", "text", "enter", "backspace", "quality"] });
    ws.send(JSON.stringify({ type: "overlay", on: true }));
    hub.pushFrame(FRAME);
    await until(() => messages.some((m) => m["type"] === "overlay"));
    const overlay = messages.find((m) => m["type"] === "overlay");
    expect(overlay).toMatchObject({ rev: 7, elements: [{ ref: "e3", label: "Save", id: "save", rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.05 } }] });
    expect(typeof overlay?.["at"]).toBe("number");
  });

  it("keeps the measured frame rate current in the status", async () => {
    const { hub, port } = await startHub({ statusEveryMs: 30 });
    const { messages } = await openWs(port);
    await until(() => messages.some((m) => m["type"] === "status"));
    expect(messages.find((m) => m["type"] === "status")?.["fps"]).toBe(0);
    hub.pushFrame(FRAME);
    hub.pushFrame({ ...FRAME, seq: 2 });
    await until(() => messages.some((m) => m["type"] === "status" && typeof m["fps"] === "number" && m["fps"] > 0));
  });

  it("passes a person's input on, shows the action to everyone, and reports a refusal to the sender", async () => {
    const { port, inputs } = await startHub();
    const a = await openWs(port);
    const b = await openWs(port);
    a.ws.send(JSON.stringify({ type: "gesture", points: [[0, 0.5, 0.25], [80, 0.5, 0.25]] }));
    await until(() => b.messages.some((m) => m["type"] === "action"));
    expect(inputs[0]).toEqual({ type: "gesture", points: [[0, 0.5, 0.25], [80, 0.5, 0.25]] });
    expect(b.messages.find((m) => m["type"] === "action")).toMatchObject({ by: "person", kind: "press", label: "Save", ok: true });
    a.ws.send(JSON.stringify({ type: "text", text: "fail" }));
    await until(() => a.messages.some((m) => m["type"] === "error"));
    expect(a.messages.find((m) => m["type"] === "error")).toMatchObject({ code: "unsupported", message: "no input is focused" });
    a.ws.send(JSON.stringify({ type: "nonsense" })); // ignored
    a.ws.send("not json"); // ignored
  });

  it("pauses the agent and tells everyone; quality changes the capture", async () => {
    const { port, control, feed } = await startHub();
    const { ws, messages } = await openWs(port);
    ws.send(JSON.stringify({ type: "pause", on: true }));
    await until(() => control.paused());
    await until(() => messages.some((m) => m["type"] === "status" && m["paused"] === true));
    ws.send(JSON.stringify({ type: "quality", preset: "light" }));
    await until(() => feed.some(([on, q]) => on && q === "light"));
  });

  it("shows an agent's actions too", async () => {
    const { hub, port } = await startHub();
    const { messages } = await openWs(port);
    hub.pushAction({ by: "agent", kind: "press", label: "Pay", ok: false, code: "busy" });
    await until(() => messages.some((m) => m["type"] === "action"));
    expect(messages.find((m) => m["type"] === "action")).toMatchObject({ by: "agent", kind: "press", ok: false, code: "busy" });
  });
});

describe("a person's OK in the live view (VIEWER-PROTOCOL 1.5)", () => {
  it("shows a request to every viewer, to one that joins later too, and takes the first answer", async () => {
    const { Confirmations } = await import("../src/confirm.js");
    const confirmations = new Confirmations();
    const { port } = await startHub({ confirmations });
    const first = await openWs(port);
    const check = confirmations.check("tap|id:d", { kind: "tap", caption: 'Tap "Delete trip"', word: "Delete" });
    if (check.granted) throw new Error("granted without asking");
    await until(() => first.messages.some((m) => m["type"] === "confirm"));
    expect(first.messages.find((m) => m["type"] === "confirm")).toMatchObject({ id: check.request.id, by: "agent", kind: "tap", caption: 'Tap "Delete trip"', word: "Delete" });
    const late = await openWs(port);
    await until(() => late.messages.some((m) => m["type"] === "confirm"));
    late.ws.send(JSON.stringify({ type: "confirm_answer", id: check.request.id, allow: true }));
    await until(() => first.messages.some((m) => m["type"] === "confirm_closed"));
    expect(first.messages.find((m) => m["type"] === "confirm_closed")).toEqual({ type: "confirm_closed", id: check.request.id, allow: true });
    first.ws.send(JSON.stringify({ type: "confirm_answer", id: check.request.id, allow: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(confirmations.check("tap|id:d", { kind: "tap", caption: "", word: "Delete" }).granted).toBe(true);
    confirmations.close();
  });
});
