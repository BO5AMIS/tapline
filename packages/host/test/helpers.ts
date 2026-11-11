import { WebSocket } from "ws";
import { TaplineHost, type TaplineHostOptions } from "../src/server.js";

export const TOKEN = "0123456789abcdef0123456789abcdef";

export async function startHost(options: Partial<TaplineHostOptions> = {}): Promise<{ host: TaplineHost; port: number }> {
  const host = new TaplineHost({ token: TOKEN, port: 0, hosts: ["127.0.0.1"], ...options });
  await host.listen();
  const port = host.boundPort();
  if (port === undefined) throw new Error("host did not bind a port");
  return { host, port };
}

export interface Closed {
  code: number;
  reason: string;
}

export type Reply =
  | { ok: true; result?: unknown }
  | { ok: false; error: { code: string; message: string; [key: string]: unknown } }
  | "ignore";

export interface IncomingRequest {
  id: number;
  method: string;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stand-in for the in-app agent: a plain `ws` client speaking the Tapline protocol. */
export class FakeApp {
  readonly ws: WebSocket;
  readonly received: unknown[] = [];
  readonly requests: IncomingRequest[] = [];
  /** Dry runs (AGENT-TOOLS 1.8 §11.4) the host sent before a touch; kept apart so request lists stay as they were. */
  readonly dryRuns: IncomingRequest[] = [];
  readonly closed: Promise<Closed>;
  handler: (request: IncomingRequest) => Reply = () => ({ ok: true, result: {} });
  private waiters: Array<(message: unknown) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
    ws.on("message", (data) => {
      const parsed: unknown = JSON.parse(data.toString("utf8"));
      if (isRecord(parsed) && parsed["type"] === "request") {
        const request: IncomingRequest = {
          id: Number(parsed["id"]),
          method: String(parsed["method"]),
          params: parsed["params"],
        };
        // A dry run: the handler's answer for the same call, marked dry (nothing is "touched" in a fake).
        if (isRecord(request.params) && request.params["dryRun"] === true) {
          this.dryRuns.push(request);
          const reply = this.handler(request);
          if (reply === "ignore") return;
          const result = reply.ok && isRecord(reply.result) ? { ...reply.result, dryRun: true } : undefined;
          this.send({ type: "response", id: request.id, ...(reply.ok ? { ok: true, result } : reply) });
          return;
        }
        this.requests.push(request);
        const reply = this.handler(request);
        if (reply !== "ignore") this.send({ type: "response", id: request.id, ...reply });
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(parsed);
      else this.received.push(parsed);
    });
  }

  static async open(port: number): Promise<FakeApp> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const app = new FakeApp(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return app;
  }

  /** Opens a socket, sends hello and waits for welcome. */
  static async connect(
    port: number,
    hello: Record<string, unknown> = {},
    handler?: (request: IncomingRequest) => Reply,
  ): Promise<{ app: FakeApp; session: string; welcome: Record<string, unknown> }> {
    const app = await FakeApp.open(port);
    if (handler !== undefined) app.handler = handler;
    app.send(FakeApp.hello(hello));
    const welcome = await app.next();
    if (!isRecord(welcome) || welcome["type"] !== "welcome" || typeof welcome["session"] !== "string") {
      throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
    }
    return { app, session: welcome["session"], welcome };
  }

  static hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "hello",
      protocol: 1,
      token: TOKEN,
      app: { name: "Demo", id: "com.example.demo", version: "1.0.0", build: "1" },
      device: { platform: "ios", osVersion: "26.1", model: "iPhone18,2", name: "Test iPhone" },
      capabilities: ["tree", "press", "screenshot", "logs", "dryRun"],
      ...overrides,
    };
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Next non-request message from the host. */
  next(timeoutMs = 2000): Promise<unknown> {
    const queued = this.received.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves when `check` returns true (polling), or rejects after a timeout. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(10);
  }
}
