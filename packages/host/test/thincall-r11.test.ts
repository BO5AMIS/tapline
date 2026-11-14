import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import { runThinCall, type ThinCallIO } from "../src/thincall.js";

// PR 12 Codex cycle 4, finding 3 (AGENT-TOOLS 1.14 §18.10): the thin call proves the host and sends the token on ONE connection, and
// never reconnects. A listener that replaces the host between the probe and the POST never sees the token. Every value is made up.

const FAKE_TOKEN = "0123456789abcdef0123456789abcdef";
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const proofFor = (req: IncomingMessage, port: number = req.socket.localPort ?? 0): string =>
  createHmac("sha256", FAKE_TOKEN).update(`tapline-proof-v1\n${String(req.headers["x-tapline-challenge"])}\n${req.socket.localAddress}\n${port}`).digest("hex");

interface Seen {
  method: string;
  /** Which connection (by order of arrival) carried it. */
  connection: number;
  authorization: string | undefined;
}

interface Fake {
  port: number;
  seen: Seen[];
  connections: () => number;
}

type Mode = "keep" | "close-header" | "destroy" | "other-port-proof";

async function fakeHost(mode: Mode): Promise<Fake> {
  const seen: Seen[] = [];
  const ids = new WeakMap<Socket, number>();
  let count = 0;
  const server = createServer((req, res) => {
    const connection = ids.get(req.socket) ?? 0;
    seen.push({ method: req.method ?? "", connection, authorization: req.headers.authorization });
    req.resume();
    req.on("end", () => {
      if (req.method === "GET") {
        const proof = mode === "other-port-proof" ? proofFor(req, (req.socket.localPort ?? 0) + 1) : proofFor(req);
        res.writeHead(405, { "x-tapline-proof": proof, ...(mode === "close-header" ? { connection: "close" } : {}) });
        res.end("POST only.\n");
        if (mode === "destroy") req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "fine", isError: false }));
    });
  });
  server.on("connection", (socket) => {
    count += 1;
    ids.set(socket, count);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, seen, connections: () => count };
}

function io(ports: number[]): { io: ThinCallIO; out: string[]; err: string[] } {
  const home = mkdtempSync(join(tmpdir(), "tapline-thin-r11-"));
  dirs.push(home);
  writeFileSync(join(home, "token"), `${FAKE_TOKEN}\n`);
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t), env: { TAPLINE_HOME: home }, ppid: 1, ports, address: "127.0.0.1" }, out, err };
}

describe("the thin call proves and authenticates on one connection", () => {
  it("sends the probe and the POST on the same connection", async () => {
    const host = await fakeHost("keep");
    const run = io([host.port]);
    expect(await runThinCall(["look", "{}"], run.io)).toBe(0);
    expect(host.connections()).toBe(1);
    expect(host.seen.map((s) => `${s.method}@${s.connection}`)).toEqual(["GET@1", "POST@1"]);
    expect(host.seen[0]?.authorization).toBeUndefined();
    expect(host.seen[1]?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("sends no bearer when the host closes the connection after the proof (Connection: close)", async () => {
    const host = await fakeHost("close-header");
    const run = io([host.port]);
    expect(await runThinCall(["look", "{}"], run.io)).toBe(3);
    expect(host.seen.filter((s) => s.authorization !== undefined)).toEqual([]);
    expect(host.connections()).toBe(1);
    expect(run.err.join("")).toMatch(/closed the connection/);
    expect(run.err.join("")).not.toContain(FAKE_TOKEN);
  });

  it("never reconnects when the socket is gone after the proof", async () => {
    const host = await fakeHost("destroy");
    const run = io([host.port]);
    const code = await runThinCall(["look", "{}"], run.io);
    expect(code).toBe(3);
    expect(host.seen.filter((s) => s.authorization !== undefined)).toEqual([]);
    expect(host.connections()).toBe(1);
  });

  it("rejects a proof made for another port", async () => {
    const host = await fakeHost("other-port-proof");
    const run = io([host.port]);
    expect(await runThinCall(["look", "{}"], run.io)).toBe(3);
    expect(host.seen.filter((s) => s.authorization !== undefined)).toEqual([]);
  });

  it("a replacement listener on the second connection never sees the token", async () => {
    // The first connection is a real proof; the host then goes away. Whatever answers next must get nothing.
    const host = await fakeHost("close-header");
    const run = io([host.port]);
    await runThinCall(["look", "{}"], run.io);
    const second = host.seen.filter((s) => s.connection > 1);
    expect(second).toEqual([]);
  });
});

describe("the real host keeps the connection alive after it answers the probe", () => {
  it("answers the probe without Connection: close, and serves a second request on the same socket", async () => {
    const sockets: Array<number | undefined> = [];
    const server = createServer((req, res) => {
      sockets.push(req.socket.remotePort);
      handleApi(req, res, { token: FAKE_TOKEN, loopback: true, handler: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const run = io([port]);
    expect(await runThinCall(["look", "{}"], run.io)).toBe(0);
    expect(run.out.join("")).toBe("ok\n");
    expect(sockets).toHaveLength(2);
    expect(sockets[0]).toBe(sockets[1]);
  });
});
