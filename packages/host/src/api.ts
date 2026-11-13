import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * `POST /api/<tool>` (AGENT-TOOLS 1.13 §18.10): the thin call's way in. Only a standalone `tapline host` sets an
 * `api` handler; a host inside an agent's MCP server has none and answers 404, so one agent's session can't be
 * driven by another's thin calls. The handler returns undefined for a tool that doesn't exist.
 */
export type ApiHandler = (tool: string, args: Record<string, unknown>, clientId: string | undefined) => Promise<CallToolResult | undefined>;

/** The most a call's JSON may be. */
export const MAX_API_BODY = 1024 * 1024;

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The host's proof that it holds the token: an HMAC of the caller's fresh challenge, keyed by the token. The token itself
 * never leaves; thincall.ts computes the same value and sends the token only to a host that proves it.
 */
export function hostProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(`tapline-thin-call-v1\n${challenge}`).digest("hex");
}

/** What goes back as JSON: the answer's text, whether it is a refusal, and the first picture when there is one. */
export interface ApiAnswer {
  text: string;
  isError: boolean;
  image?: { mimeType: string; dataBase64: string };
}

export function toApiAnswer(result: CallToolResult): ApiAnswer {
  const parts: string[] = [];
  let image: ApiAnswer["image"];
  for (const block of result.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image" && image === undefined) image = { mimeType: block.mimeType, dataBase64: block.data };
  }
  return { text: parts.join("\n"), isError: result.isError === true, ...(image !== undefined ? { image } : {}) };
}

export interface ApiRequestContext {
  /** The host's token; never written into an answer. */
  token: string;
  /** Whether the peer is this computer. */
  loopback: boolean;
  /** Undefined on a host that doesn't serve the thin call. */
  handler: ApiHandler | undefined;
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${text}\n`);
}

function clientOf(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-agent-client"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.replace(/[^\w .@/-]/g, "").slice(0, 60);
  return value !== undefined && value !== "" ? value : undefined;
}

/** Answers `/api/<tool>`; false for any other path. Checks run in the order this computer, method, token. */
export function handleApi(req: IncomingMessage, res: ServerResponse, context: ApiRequestContext): boolean {
  const path = new URL(req.url ?? "/", "http://host").pathname;
  if (!path.startsWith("/api/")) return false;
  if (!context.loopback) {
    plain(res, 403, "Only from this computer.");
    return true;
  }
  if (context.handler === undefined) {
    plain(res, 404, 'The thin call is served by "tapline host" only, not by an agent\'s MCP server.');
    return true;
  }
  if (req.method !== "POST") {
    // A thin call asks who it is talking to before it sends the token: only a host that holds the token can answer.
    const challenge = req.headers["x-tapline-challenge"];
    const proof = typeof challenge === "string" && /^[0-9a-f]{16,128}$/.test(challenge) ? hostProof(context.token, challenge) : undefined;
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8", ...(proof !== undefined ? { "x-tapline-proof": proof } : {}) });
    res.end("POST only.\n");
    return true;
  }
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7).trim(), context.token)) {
    plain(res, 401, "Bearer token required.");
    return true;
  }
  const handler = context.handler;
  let tool: string;
  try {
    tool = decodeURIComponent(path.slice("/api/".length));
  } catch {
    tool = "";
  }
  const client = clientOf(req);
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLong = false;
  let gone = false;
  // A peer that drops mid-body or resets: stop quietly, never throw an unhandled error event.
  req.on("error", () => {
    gone = true;
    if (!res.writableEnded) res.destroy();
  });
  req.on("aborted", () => {
    gone = true;
  });
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_API_BODY) tooLong = true;
    else chunks.push(chunk);
  });
  req.on("end", () => {
    if (gone || (req.destroyed && !req.complete)) return;
    let args: Record<string, unknown> | undefined;
    try {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const parsed: unknown = tooLong ? undefined : text === "" ? {} : JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      args = undefined;
    }
    if (args === undefined) {
      plain(res, 400, "Body: a JSON object of at most 1 MB.");
      return;
    }
    handler(tool, args, client).then(
      (result) => {
        if (result === undefined) {
          plain(res, 404, `Unknown tool "${tool}".`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(toApiAnswer(result)));
      },
      (error: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        // Same shape as a tool's own failure, so a caller reads one kind of answer.
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text: `Error internal: ${message}`, isError: true } satisfies ApiAnswer));
      },
    );
  });
  return true;
}
