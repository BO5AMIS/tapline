import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofFor } from "../src/otpclient.js";

/** A stand-in for Tapwright's daemon: a real HTTP server on loopback that proves itself (or doesn't) and hands a code over. All tokens here are made up. */

export const FAKE_TOKEN = "fake-tapwright-token-0123456789abcdef";
export const FAKE_CODE = "482913";

export interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
  /** Which connection it came in on, counted from 0 in the order connections opened. */
  socket: number;
  host: string | undefined;
}

export interface FakeBehavior {
  /** The token the daemon holds and proves with. */
  token: string;
  /** Overrides for what the proof is made for. */
  proofPort?: (port: number) => number;
  proofAddress?: string;
  /** Replaces the proof text altogether. */
  proofText?: string;
  /** After the proof: "close" ends the connection, "header" answers `Connection: close`, "silent" never answers /api/prove. */
  afterProof?: "close" | "header" | "silent";
  /** What /otp answers. */
  otp: { status: number; body?: Record<string, unknown>; chunked?: boolean };
}

export interface FakeDaemon {
  port: number;
  behavior: FakeBehavior;
  requests: SeenRequest[];
  connections: number;
  /** Everything every request carried, as text: to look for a token that must not be there. */
  everything(): string;
  close(): Promise<void>;
}

export async function startFakeTapwright(partial: Partial<FakeBehavior> = {}): Promise<FakeDaemon> {
  const behavior: FakeBehavior = { token: FAKE_TOKEN, otp: { status: 200, body: { code: FAKE_CODE, expires: Date.now() + 90_000, source: "com.apple.MobileSMS" } }, ...partial };
  const requests: SeenRequest[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
        socket: sockets.indexOf(req.socket),
        host: req.headers.host,
      });
      if (req.url === "/api/prove") {
        if (behavior.afterProof === "silent") return;
        const parsed = JSON.parse(body) as { challenge: string };
        const port = behavior.proofPort !== undefined ? behavior.proofPort(daemon.port) : daemon.port;
        const proof = behavior.proofText ?? proofFor(behavior.token, Buffer.from(parsed.challenge, "hex"), behavior.proofAddress ?? "127.0.0.1", port);
        const json = JSON.stringify({ proof });
        if (behavior.afterProof === "header") res.setHeader("Connection", "close");
        res.setHeader("Content-Type", "application/json");
        if (behavior.afterProof === "close") res.end(json, () => req.socket.destroy());
        else res.end(json);
        return;
      }
      if (req.url === "/otp") {
        // The daemon accepts only its own token.
        if (req.headers.authorization !== `Bearer ${behavior.token}`) {
          res.statusCode = 401;
          res.end("{}");
          return;
        }
        res.statusCode = behavior.otp.status;
        res.setHeader("Content-Type", "application/json");
        const json = JSON.stringify(behavior.otp.body ?? {});
        if (behavior.otp.chunked === true) {
          res.write(json.slice(0, 10));
          res.end(json.slice(10));
        } else res.end(json);
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const daemon: FakeDaemon = {
    port,
    behavior,
    requests,
    get connections() {
      return sockets.length;
    },
    everything: () => JSON.stringify(requests),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  return daemon;
}

/** A temporary `TAPWRIGHT_HOME` with a serve.json. */
export function tapwrightHome(serve: unknown): { dir: string; write(serve: unknown): void; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "tapline-fake-tapwright-"));
  const write = (value: unknown): void => writeFileSync(join(dir, "serve.json"), typeof value === "string" ? value : JSON.stringify(value));
  if (serve !== undefined) write(serve);
  return { dir, write, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
