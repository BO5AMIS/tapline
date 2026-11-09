import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ControlQueue } from "../src/control.js";
import { ViewerHub, viewerStatusFor, type PersonInput, type ViewerHubOptions } from "../src/viewer.js";

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
    expect(away.detail).toContain("Demo is in the background");
    expect(away.detail).not.toMatch(/Error|in_background/);
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
    expect(status).toMatchObject({ protocol: 1, accepts: ["tap", "longPress", "scroll", "text", "enter", "backspace", "quality"] });
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
