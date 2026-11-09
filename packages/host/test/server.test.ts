import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { PAIR_CODE_TTL_MS, createPairCode } from "../src/pairing.js";
import { TaplineError, TaplineHost } from "../src/server.js";
import { FakeApp, TOKEN, delay, startHost, until } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

async function start(options: Parameters<typeof startHost>[0] = {}): ReturnType<typeof startHost> {
  const started = await startHost(options);
  hosts.push(started.host);
  return started;
}

async function connect(
  port: number,
  hello?: Record<string, unknown>,
  handler?: Parameters<typeof FakeApp.connect>[2],
): Promise<{ app: FakeApp; session: string; welcome: Record<string, unknown> }> {
  const result = await FakeApp.connect(port, hello, handler);
  apps.push(result.app);
  return result;
}

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

describe("handshake", () => {
  it("welcomes a good token and registers the session", async () => {
    const { host, port } = await start();
    const { session } = await connect(port);
    expect(session).toMatch(/^s-[0-9a-f]{4}$/);
    const sessions = host.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: session,
      app: { name: "Demo", id: "com.example.demo", version: "1.0.0" },
      device: { platform: "ios", name: "Test iPhone" },
    });
    expect(sessions[0]?.connectedAt).toBeGreaterThan(0);
    expect(host.current()?.id).toBe(session);
  });

  it("closes 4001 on a bad token", async () => {
    const { host, port } = await start();
    const app = await FakeApp.open(port);
    apps.push(app);
    app.send(FakeApp.hello({ token: "nope" }));
    expect((await app.closed).code).toBe(4001);
    expect(host.sessions()).toHaveLength(0);
  });

  it("closes 4001 when the token is missing", async () => {
    const { port } = await start();
    const app = await FakeApp.open(port);
    apps.push(app);
    const { token: _token, ...noToken } = FakeApp.hello();
    app.send(noToken);
    expect((await app.closed).code).toBe(4001);
  });

  it("closes 4002 when a message arrives before hello", async () => {
    const { port } = await start();
    const app = await FakeApp.open(port);
    apps.push(app);
    app.send({ type: "response", id: 1, ok: true, result: {} });
    expect((await app.closed).code).toBe(4002);
  });

  it("closes 4002 when hello never arrives", async () => {
    const { port } = await start({ helloTimeoutMs: 100 });
    const app = await FakeApp.open(port);
    apps.push(app);
    expect((await app.closed).code).toBe(4002);
  });

  it("closes 4003 on a protocol mismatch", async () => {
    const { host, port } = await start();
    const app = await FakeApp.open(port);
    apps.push(app);
    app.send(FakeApp.hello({ protocol: 2 }));
    expect((await app.closed).code).toBe(4003);
    expect(host.sessions()).toHaveLength(0);
  });

  it("survives a connect listener that throws", async () => {
    const { host, port } = await start();
    host.on("connect", () => {
      throw new Error("listener bug");
    });
    const { app } = await connect(port, {}, () => ({ ok: true, result: { fine: true } }));
    expect(await host.request("tree")).toEqual({ fine: true });
    void app;
  });

  it("does not repeat the token in the welcome of a token hello", async () => {
    const { port } = await start();
    const { welcome } = await connect(port);
    expect(welcome["token"]).toBeUndefined();
  });
});

describe("pairing", () => {
  it("accepts a pairing code once and hands the app the token", async () => {
    const { host, port } = await start();
    const code = host.createPairCode();
    const { welcome } = await connect(port, { token: undefined, pairCode: code });
    expect(welcome["token"]).toBe(TOKEN);
    expect(host.sessions()).toHaveLength(1);

    const again = await FakeApp.open(port);
    apps.push(again);
    again.send(FakeApp.hello({ token: undefined, pairCode: code, device: { platform: "ios", id: "other" } }));
    expect((await again.closed).code).toBe(4004);
  });

  it("closes 4004 on an expired or made-up code", async () => {
    const { port } = await start();
    for (const code of [createPairCode(TOKEN, Date.now() - PAIR_CODE_TTL_MS - 1000), "zz-0123456789abcdef0123", 42]) {
      const app = await FakeApp.open(port);
      apps.push(app);
      app.send(FakeApp.hello({ token: undefined, pairCode: code }));
      expect((await app.closed).code).toBe(4004);
    }
  });

  it("accepts a code made by another process with the same token", async () => {
    const { port } = await start();
    const { welcome } = await connect(port, { token: undefined, pairCode: createPairCode(TOKEN) });
    expect(welcome["token"]).toBe(TOKEN);
  });
});

describe("ports", () => {
  it("moves on to a following port when the port is taken and fallback is allowed", async () => {
    const { port: taken } = await start();
    const next = new TaplineHost({ token: TOKEN, port: taken, hosts: ["127.0.0.1"], portFallback: 5 });
    hosts.push(next);
    const result = await next.listen();
    const bound = next.boundPort() ?? 0;
    expect(bound).toBeGreaterThan(taken);
    expect(bound).toBeLessThanOrEqual(taken + 5);
    expect(result.listening).toEqual([{ host: "127.0.0.1", port: bound }]);
  });

  it("refuses a second listen", async () => {
    const { host } = await start();
    await expect(host.listen()).rejects.toThrow(/already/);
  });

  it("fails on a taken port without fallback", async () => {
    const { port: taken } = await start();
    const next = new TaplineHost({ token: TOKEN, port: taken, hosts: ["127.0.0.1"] });
    hosts.push(next);
    await expect(next.listen()).rejects.toThrow(/Could not listen/);
  });
});

describe("requests", () => {
  it("round-trips a request and its response", async () => {
    const { host, port } = await start();
    const { app } = await connect(port, {}, (req) => ({ ok: true, result: { echoed: req.params, method: req.method } }));
    const result = await host.request("press", { target: { testID: "go" } });
    expect(result).toEqual({ method: "press", echoed: { target: { testID: "go" } } });
    expect(app.requests).toHaveLength(1);
  });

  it("rejects with the app's error code and message", async () => {
    const { host, port } = await start();
    await connect(port, {}, () => ({ ok: false, error: { code: "not_found", message: "No element matches testID \"x\"" } }));
    const error = await host.request("press", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaplineError);
    expect(error).toMatchObject({ code: "not_found", message: 'No element matches testID "x"' });
  });

  it("times out with a clear error", async () => {
    const { host, port } = await start();
    await connect(port, {}, () => "ignore");
    const error = await host.request("tree", {}, { timeoutMs: 80 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "timeout" });
    expect((error as Error).message).toContain('"tree"');
  });

  it("uses the default request timeout from options", async () => {
    const { host, port } = await start({ requestTimeoutMs: 60 });
    await connect(port, {}, () => "ignore");
    await expect(host.request("tree")).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects pending requests when the app disconnects", async () => {
    const { host, port } = await start();
    const { app } = await connect(port, {}, () => "ignore");
    const pending = host.request("tree", {}, { timeoutMs: 5000 });
    await until(() => app.requests.length === 1);
    app.ws.terminate();
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await until(() => host.sessions().length === 0);
  });

  it("fails clearly with no app connected or an unknown session", async () => {
    const { host, port } = await start();
    await expect(host.request("tree")).rejects.toMatchObject({ code: "no_app" });
    await connect(port);
    await expect(host.request("tree", {}, { sessionId: "s-ffff" })).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("targets a specific session and supports select()/current()", async () => {
    const { host, port } = await start();
    const a = await connect(port, { app: { name: "A", id: "a" } }, () => ({ ok: true, result: { from: "A" } }));
    await delay(5);
    const b = await connect(port, { app: { name: "B", id: "b" } }, () => ({ ok: true, result: { from: "B" } }));
    expect(host.current()?.id).toBe(b.session);
    expect(await host.request("tree")).toEqual({ from: "B" });
    host.select(a.session);
    expect(host.current()?.id).toBe(a.session);
    expect(await host.request("tree")).toEqual({ from: "A" });
    expect(await host.request("tree", {}, { sessionId: b.session })).toEqual({ from: "B" });
    expect(() => host.select("s-0000")).toThrow(/No connected session/);
    a.app.ws.terminate();
    await until(() => host.sessions().length === 1);
    expect(host.current()?.id).toBe(b.session);
  });
});

describe("sessions", () => {
  it("replaces the old session when the same app and device reconnect", async () => {
    const { host, port } = await start();
    const first = await connect(port, {}, () => "ignore");
    host.select(first.session);
    const outcome = host.request("tree", {}, { timeoutMs: 5000 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await until(() => first.app.requests.length === 1);
    const second = await connect(port);
    expect((await first.app.closed).code).toBe(4010);
    expect(await outcome).toMatchObject({ code: "disconnected" });
    expect(host.sessions().map((s) => s.id)).toEqual([second.session]);
    expect(second.session).not.toBe(first.session);
    // selection follows the app to its new session
    expect(host.selectedSessionId()).toBe(second.session);
  });

  it("keeps different devices running the same app side by side", async () => {
    const { host, port } = await start();
    await connect(port, { device: { platform: "ios", name: "Phone A" } });
    await connect(port, { device: { platform: "ios", name: "Phone B" } });
    expect(host.sessions()).toHaveLength(2);
  });

  it("tells two iPhones apart by install id when they send no name or model", async () => {
    const { host, port } = await start();
    const bare = { platform: "ios", osVersion: "26.1" };
    const a = await connect(port, { device: { ...bare, id: "install-a" } });
    await connect(port, { device: { ...bare, id: "install-b" } });
    expect(host.sessions()).toHaveLength(2);
    expect(host.sessions().map((s) => s.device.id).sort()).toEqual(["install-a", "install-b"]);

    // The same install reconnecting still replaces its old session.
    await connect(port, { device: { ...bare, id: "install-a" } });
    expect((await a.app.closed).code).toBe(4010);
    expect(host.sessions()).toHaveLength(2);
  });

  it("answers ping with pong", async () => {
    const { port } = await start();
    const { app } = await connect(port);
    app.send({ type: "ping" });
    expect(await app.next()).toEqual({ type: "pong" });
  });

  it("drops an app that stays silent, but not one that keeps pinging", async () => {
    const { host, port } = await start({ silenceTimeoutMs: 250, sweepIntervalMs: 40 });
    const quiet = await connect(port, { device: { platform: "ios", name: "quiet" } });
    const chatty = await connect(port, { device: { platform: "ios", name: "chatty" } });
    const timer = setInterval(() => chatty.app.send({ type: "ping" }), 60);
    try {
      expect((await quiet.app.closed).code).toBe(4011);
      await until(() => host.sessions().length === 1);
      expect(host.sessions()[0]?.id).toBe(chatty.session);
    } finally {
      clearInterval(timer);
    }
  });

  it("emits connect and disconnect events", async () => {
    const { host, port } = await start();
    const seen: string[] = [];
    host.on("connect", (s) => seen.push(`connect ${s.id}`));
    host.on("disconnect", (s) => seen.push(`disconnect ${s.id}`));
    const { app, session } = await connect(port);
    app.ws.close();
    await until(() => seen.length === 2);
    expect(seen).toEqual([`connect ${session}`, `disconnect ${session}`]);
  });
});

describe("http extension and frames", () => {
  it("lets an extension answer HTTP requests and WebSocket upgrades first; apps still connect", async () => {
    const { host, port } = await start();
    const viewerWss = new WebSocketServer({ noServer: true });
    host.setHttpExtension({
      onRequest: (req, res) => {
        if (req.url !== "/hello") return false;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hi");
        return true;
      },
      onUpgrade: (req, socket, head) => {
        if (req.url !== "/ws") return false;
        viewerWss.handleUpgrade(req, socket, head, (ws) => ws.send("viewer"));
        return true;
      },
    });
    const hello = await fetch(`http://127.0.0.1:${port}/hello`);
    expect(await hello.text()).toBe("hi");
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(426);
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const first = await new Promise<string>((resolve) => viewer.once("message", (data) => resolve(String(data))));
    expect(first).toBe("viewer");
    viewer.close();
    const { session } = await connect(port);
    expect(host.sessions().map((s) => s.id)).toEqual([session]);
    viewerWss.close();
  });

  it("emits frames the app sends, without putting them in the logs", async () => {
    const { host, port } = await start();
    const frames: unknown[] = [];
    host.on("frame", (_s, frame) => frames.push(frame));
    const { app, session } = await connect(port);
    app.send({ type: "event", event: "frame", data: { seq: 1, rev: 4, capturedAt: 10, captureMs: 120, mime: "image/jpeg", data: "QUJD", width: 400, height: 870 } });
    app.send({ type: "event", event: "frame", data: { nope: true } });
    await until(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ seq: 1, rev: 4, mime: "image/jpeg", data: "QUJD", width: 400 });
    expect(host.logs(session)).toEqual([]);
  });
});

describe("app state", () => {
  it("keeps the app's last state, logs it, and remembers it after the app drops", async () => {
    const { host, port } = await start();
    const { app, session } = await connect(port);
    expect(host.lastDisconnect()).toBeUndefined();
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    await until(() => host.sessions()[0]?.appState?.state === "background");
    expect(host.logs(session).at(-1)).toMatchObject({ level: "info", message: "[tapline] the app went to the background" });
    app.close();
    await until(() => host.lastDisconnect() !== undefined);
    const last = host.lastDisconnect();
    expect(last?.session.id).toBe(session);
    expect(last?.session.appState?.state).toBe("background");
    expect(typeof last?.at).toBe("number");
  });

  it("answers requests at once while the app is in the background, and normally once it's back", async () => {
    const { host, port } = await start({ requestTimeoutMs: 5000 });
    const { app, session } = await connect(port, {}, (req) => ({ ok: true, result: { method: req.method } }));
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    await until(() => host.sessions()[0]?.appState?.state === "background");
    const started = Date.now();
    await expect(host.request("tree", {}, { sessionId: session })).rejects.toMatchObject({
      code: "in_background",
      message: expect.stringContaining("open the app"),
    });
    expect(Date.now() - started).toBeLessThan(500);
    app.send({ type: "event", event: "appState", data: { state: "active" } });
    await until(() => host.sessions()[0]?.appState?.state === "active");
    await expect(host.request("tree", {}, { sessionId: session })).resolves.toEqual({ method: "tree" });
  });

  it("emits the app's state changes", async () => {
    const { host, port } = await start();
    const seen: string[] = [];
    host.on("appState", (s, state) => seen.push(`${s.app.name}:${state}`));
    const { app } = await connect(port);
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    app.send({ type: "event", event: "appState", data: { state: "active" } });
    await until(() => seen.length === 2);
    expect(seen[0]).toMatch(/:background$/);
    expect(seen[1]).toMatch(/:active$/);
  });

  it("ignores app state events without a state", async () => {
    const { host, port } = await start();
    const { app } = await connect(port);
    app.send({ type: "event", event: "appState", data: { nope: 1 } });
    app.send({ type: "event", event: "log", data: { message: "after", ts: 1 } });
    await until(() => host.logs(host.sessions()[0]?.id ?? "").length === 1);
    expect(host.sessions()[0]?.appState).toBeUndefined();
  });
});

describe("log events", () => {
  it("buffers log and error events and returns them from logs()", async () => {
    const { host, port } = await start();
    const { app, session } = await connect(port);
    app.send({ type: "event", event: "log", data: { level: "warn", message: "careful", ts: 1000 } });
    app.send({ type: "event", event: "log", data: { level: "info", message: "later", ts: 2000 } });
    app.send({ type: "event", event: "error", data: { message: "boom", stack: "at x", fatal: true, ts: 3000 } });
    app.send({ type: "event", event: "something-else", data: { message: "ignored" } });
    await until(() => host.logs(session).length === 3);
    expect(host.logs(session).map((e) => [e.level, e.message])).toEqual([
      ["warn", "careful"],
      ["info", "later"],
      ["error", "boom"],
    ]);
    expect(host.logs(session)[2]).toMatchObject({ fatal: true, stack: "at x" });
    expect(host.logs(session, 1000).map((e) => e.message)).toEqual(["later", "boom"]);
    expect(() => host.logs("s-ffff")).toThrow(/No connected session/);
  });

  it("keeps only the last N events", async () => {
    const { host, port } = await start({ logBufferSize: 5 });
    const { app, session } = await connect(port);
    for (let i = 0; i < 12; i++) {
      app.send({ type: "event", event: "log", data: { level: "log", message: `m${i}`, ts: i + 1 } });
    }
    await until(() => host.logs(session).at(-1)?.message === "m11");
    expect(host.logs(session).map((e) => e.message)).toEqual(["m7", "m8", "m9", "m10", "m11"]);
  });

  it("emits a log event for the CLI", async () => {
    const { host, port } = await start();
    const seen: string[] = [];
    host.on("log", (_s, entry) => seen.push(entry.message));
    const { app } = await connect(port);
    app.send({ type: "event", event: "log", data: { level: "log", message: "hi", ts: 1 } });
    await until(() => seen.length === 1);
    expect(seen).toEqual(["hi"]);
  });
});
