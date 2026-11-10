import WebSocket from "ws";
import { z } from "zod";
import { MjpegParser, parseFrameHeaders, type Frame } from "./mjpeg.js";
import type { ViewerLink } from "./link.js";

const messageSchema = z.looseObject({ type: z.string() });

/** How many of the newest frames keep their JPEG bytes (about 15 s at 26 fps). */
export const KEEP_FRAME_BYTES = 400;
const EMPTY = Buffer.alloc(0);

export interface ServerMessage {
  type: string;
  /** performance.now() when it arrived. */
  at: number;
  body: Record<string, unknown>;
}

/** The viewer as a person's browser uses it: /stream frames in, /ws gestures out. */
export class ViewerClient {
  readonly frames: Frame[] = [];
  readonly messages: ServerMessage[] = [];
  /** Bumped on every frame and message, so waiters never miss one. */
  private version = 0;
  private wakers = new Set<() => void>();
  private readonly abort = new AbortController();
  private ws: WebSocket | null = null;
  private streamDone: Promise<void> = Promise.resolve();
  streamError: string | null = null;

  private constructor() {}

  /** Opens /stream and /ws; resolves when both are open. Closes what it opened if one fails. */
  static async connect(link: ViewerLink): Promise<ViewerClient> {
    const client = new ViewerClient();
    try {
      await client.openStream(link);
      await client.openSocket(link);
    } catch (e) {
      await client.close();
      throw e;
    }
    return client;
  }

  private async openStream(link: ViewerLink): Promise<void> {
    const res = await fetch(`${link.origin}/stream`, {
      headers: { Authorization: `Bearer ${link.token}` },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`/stream answered HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    const boundary = /boundary="?([^";\s]+)"?/i.exec(type)?.[1]?.replace(/^--/, "") ?? "frame";
    const parser = new MjpegParser(boundary);
    const reader = res.body.getReader();
    this.streamDone = (async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          const perf = performance.now();
          const wall = Date.now();
          for (const part of parser.push(value)) {
            this.frames.push({
              arrivalPerf: perf,
              arrivalWall: wall,
              bytes: part.body,
              byteLength: part.body.length,
              ...parseFrameHeaders(part.headers),
            });
            // A full-size stream at 25+ fps would hold gigabytes over a run: keep only recent JPEGs.
            const old = this.frames[this.frames.length - 1 - KEEP_FRAME_BYTES];
            if (old && old.bytes.length > 0) old.bytes = EMPTY;
            this.wake();
          }
        }
      } catch (e) {
        if (!this.abort.signal.aborted) {
          this.streamError = e instanceof Error ? e.message : String(e);
        }
      } finally {
        this.wake();
      }
    })();
  }

  private openSocket(link: ViewerLink): Promise<void> {
    const url = `${link.origin.replace(/^http/, "ws")}/ws`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${link.token}` } });
    this.ws = ws;
    ws.on("message", (data) => {
      const at = performance.now();
      try {
        const parsed = messageSchema.safeParse(JSON.parse(data.toString()));
        if (parsed.success) this.messages.push({ type: parsed.data.type, at, body: parsed.data });
      } catch {
        // not JSON: ignore, as the protocol says for unknown input
      }
      this.wake();
    });
    return new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(new Error(`/ws failed: ${e.message}`)));
    });
  }

  private wake(): void {
    this.version++;
    for (const w of [...this.wakers]) w();
  }

  /** Sends one JSON message on /ws. */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("/ws is not open");
    this.ws.send(JSON.stringify(message));
  }

  /** A person's tap at fractions (0..1) of the frame. */
  tap(x: number, y: number): void {
    this.send({
      type: "gesture",
      points: [
        [0, x, y],
        [60, x, y],
      ],
    });
  }

  /**
   * Calls `check` now and after every new frame or message until it gives a value or `timeoutMs`
   * passes (then undefined).
   */
  async waitFor<T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const v = this.version;
      const r = check();
      if (r !== undefined) return r;
      const left = deadline - performance.now();
      if (left <= 0) return undefined;
      if (this.version !== v) continue;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.wakers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.wakers.add(done);
      });
    }
  }

  /** Closes the stream and the socket. Safe to call twice, and after a failed connect. */
  async close(): Promise<void> {
    this.abort.abort();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners("message");
      ws.on("error", () => undefined);
      ws.terminate();
    }
    await this.streamDone.catch(() => undefined);
  }
}
