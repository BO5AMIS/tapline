import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { looseScrubber } from "./accounts.js";

/**
 * AGENT-TOOLS 1.14 §18.11 and §20.4: the one-time code client. A sign-in code arrives where only Tapwright can read it, so
 * Tapline's host asks Tapwright's daemon for it on loopback:
 *
 * 1. read `serve.json` (`port`, `token`) afresh, and keep the token only for this request;
 * 2. open ONE connection to the literal `127.0.0.1:<port>` and have the daemon prove it holds the token (`POST /api/prove`,
 *    no token sent), checking the proof for the address and port actually dialled, in constant time;
 * 3. only then, on that same connection, `POST /otp` with the token. A connection the daemon closed gets nothing, and the
 *    token never goes to a second connection.
 *
 * This is a raw `net.Socket` with a small HTTP/1.1 reader, so that "one socket" is a fact of the code and not a setting of an
 * agent pool. Nothing here prints a token or a code; a failure says why in words.
 */

/** The address that is dialled, always as this literal (no name, no fallback). */
export const LOOPBACK = "127.0.0.1";
const PROOF_LABEL = "tapwright-proof-v2";
/** How a code is shown wherever it could be seen (§20.3). */
export const OTP_PLACEHOLDER = "<one-time code>";
const MAX_RESPONSE = 64 * 1024;
/** How many codes the redaction keeps for the session. */
/** A session never forgets a code; past this many distinct codes a new one is refused rather than an old one dropped. */
const MAX_CODES = 1000;

/** `${otp.<app>}` as the whole text of a step: the app's id (reverse-domain names, so letters, digits, '.', '_' and '-'). */
const OTP_WHOLE = /^\$\{otp\.([A-Za-z0-9._-]+)\}$/;

/** The app id a text names when it is exactly `${otp.<app>}`; null for any other text. */
export function otpReference(text: string): string | null {
  return OTP_WHOLE.exec(text)?.[1] ?? null;
}

export interface OtpDeps {
  /** Tapwright's folder. Default: `TAPWRIGHT_HOME` of `env`, else `~/.tapwright`. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: () => string;
  /** Epoch ms. */
  now?: () => number;
  /** The challenge's random bytes. */
  random?: (size: number) => Buffer;
  /** Gives the whole exchange this long (ms). Default 5000. */
  timeoutMs?: number;
  /** How long to wait after the proof for a daemon that closes the connection at once (ms). Default 15. */
  settleMs?: number;
}

export type OtpFailure = "no_file" | "bad_file" | "unreachable" | "no_proof" | "closed" | "none" | "refused" | "bad_reply" | "expired" | "timeout";

export type OtpFetch =
  | { ok: true; code: string; expires: number; source: string | undefined }
  | { ok: false; reason: OtpFailure; message: string };

const fail = (reason: OtpFailure, message: string): OtpFetch => ({ ok: false, reason, message });

/** The words for a step that has no code. They name no token and no code. */
export function noCodeMessage(app: string): string {
  return `no one-time code for ${app}: Tapwright has none waiting. It needs Tapwright 1.7's daemon running, with this app's code setting turned on, and the code must come within 2 minutes after the app showed a code field.`;
}

function tapwrightHome(deps: OtpDeps): string {
  if (deps.home !== undefined) return deps.home;
  const override = (deps.env ?? process.env)["TAPWRIGHT_HOME"];
  return override !== undefined && override.length > 0 ? override : join((deps.homeDir ?? homedir)(), ".tapwright");
}

/** `serve.json`, read now. The token is returned to the one request that asked and kept nowhere else. */
function readServe(deps: OtpDeps): { port: number; token: string } | OtpFetch {
  let text: string;
  try {
    text = readFileSync(join(tapwrightHome(deps), "serve.json"), "utf8");
  } catch {
    return fail("no_file", "Tapwright's daemon file (serve.json) isn't there; start Tapwright's daemon (Tapwright 1.7) and try again.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Node's own message would quote part of the text, which holds a token.
    return fail("bad_file", "Tapwright's daemon file (serve.json) isn't valid JSON.");
  }
  const top = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { port?: unknown; token?: unknown }) : null;
  const port = top?.port;
  const token = top?.token;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string" || token === "") {
    return fail("bad_file", "Tapwright's daemon file (serve.json) has no usable port and token.");
  }
  return { port, token };
}

/** HMAC-SHA256(token, "tapwright-proof-v2" NUL challenge-bytes NUL "127.0.0.1" NUL port), as hex. */
export function proofFor(token: string, challenge: Buffer, address: string, port: number): string {
  const nul = Buffer.from([0]);
  const message = Buffer.concat([Buffer.from(PROOF_LABEL, "utf8"), nul, challenge, nul, Buffer.from(address, "utf8"), nul, Buffer.from(String(port), "ascii")]);
  return createHmac("sha256", token).update(message).digest("hex");
}

function sameProof(given: unknown, wanted: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given.toLowerCase(), "utf8");
  const b = Buffer.from(wanted, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// -- one connection, spoken to by hand

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

class Closed extends Error {}

/** A parsed response, or null while more bytes are needed. Throws on anything that isn't a plain HTTP/1.1 answer. */
function parseReply(buffer: Buffer): Reply | null {
  const end = buffer.indexOf("\r\n\r\n");
  if (end < 0) {
    if (buffer.length > MAX_RESPONSE) throw new Error("too long");
    return null;
  }
  const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
  const match = /^HTTP\/1\.1 (\d{3})(?: |$)/.exec(lines[0] ?? "");
  if (match === null) throw new Error("not HTTP/1.1");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const status = Number(match[1]);
  const rest = buffer.subarray(end + 4);
  if ((headers["transfer-encoding"] ?? "").toLowerCase() === "chunked") {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const lineEnd = rest.indexOf("\r\n", at);
      if (lineEnd < 0) return null;
      const size = Number.parseInt(rest.subarray(at, lineEnd).toString("latin1").split(";")[0] ?? "", 16);
      if (!Number.isInteger(size) || size < 0) throw new Error("bad chunk");
      if (size === 0) {
        // The trailer's end: an empty line.
        return rest.length >= lineEnd + 4 ? { status, headers, body: Buffer.concat(parts).toString("utf8") } : null;
      }
      if (rest.length < lineEnd + 2 + size + 2) return null;
      parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      at = lineEnd + 2 + size + 2;
    }
  }
  const lengthText = headers["content-length"];
  if (lengthText === undefined) {
    if (status === 204 || status === 304) return { status, headers, body: "" };
    throw new Error("no length");
  }
  const length = Number(lengthText);
  if (!Number.isInteger(length) || length < 0 || length > MAX_RESPONSE) throw new Error("bad length");
  return rest.length >= length ? { status, headers, body: rest.subarray(0, length).toString("utf8") } : null;
}

class Wire {
  private buffer: Buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  /** The peer ended the connection, or it failed. */
  gone = false;

  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake?.();
    });
    const end = (): void => {
      this.gone = true;
      this.wake?.();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  /** Whether another request may still go on this connection. */
  usable(): boolean {
    return !this.gone && !this.socket.destroyed && this.socket.writable;
  }

  async request(path: string, port: number, body: string, authorization: string | undefined): Promise<Reply> {
    const head = [
      `POST ${path} HTTP/1.1`,
      `Host: ${LOOPBACK}:${port}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: keep-alive",
      ...(authorization !== undefined ? [`Authorization: ${authorization}`] : []),
      "",
      "",
    ].join("\r\n");
    this.buffer = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(head + body, (error) => (error ? reject(new Closed("write failed")) : resolve()));
    });
    for (;;) {
      let reply: Reply | null;
      try {
        reply = parseReply(this.buffer);
      } catch {
        throw new Error("bad reply");
      }
      if (reply !== null) return reply;
      if (this.gone) throw new Closed("closed before an answer");
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = undefined;
          resolve();
        };
      });
    }
  }
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // The literal address, IPv4 only: no name lookup, no fallback to localhost.
    const socket = connect({ host: LOOPBACK, port, family: 4 });
    socket.setNoDelay(true);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Asks Tapwright's daemon for the code of an app (§18.11). The caller has already checked that a step is typing
 * `${otp.<that app>}` for the connected app; this is the only way a code comes in.
 */
export async function fetchOtp(app: string, deps: OtpDeps = {}): Promise<OtpFetch> {
  const serve = readServe(deps);
  if ("ok" in serve) return serve;
  const { port, token } = serve;
  const random = deps.random ?? randomBytes;
  const now = deps.now ?? Date.now;
  const challenge = random(32);
  let wire: Wire | undefined;
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<OtpFetch> => {
    let socket: Socket;
    try {
      socket = await dial(port);
    } catch {
      return fail("unreachable", "Tapwright's daemon didn't answer on this computer; start it (Tapwright 1.7) and try again.");
    }
    const opened = new Wire(socket);
    wire = opened;
    // Only the socket's own answer about where it is connected counts: the address and port the proof is made for.
    if (socket.remoteAddress !== LOOPBACK || socket.remotePort !== port) return fail("unreachable", "Tapwright's daemon didn't answer on this computer.");
    let proved: Reply;
    try {
      proved = await opened.request("/api/prove", port, JSON.stringify({ challenge: challenge.toString("hex") }), undefined);
    } catch (error) {
      return error instanceof Closed ? fail("no_proof", "Tapwright's daemon closed the connection before it proved itself; nothing was sent to it.") : fail("bad_reply", "Tapwright's daemon answered in a form this Tapline doesn't know.");
    }
    const proof = proved.status === 200 ? parseJson(proved.body)?.["proof"] : undefined;
    if (!sameProof(proof, proofFor(token, challenge, LOOPBACK, port))) {
      return fail("no_proof", "Whatever answers on Tapwright's daemon port didn't prove it holds Tapwright's token, so nothing was sent to it.");
    }
    // A daemon that closes its connection after the proof gets nothing: the token never goes to a second connection.
    const settle = deps.settleMs ?? 15;
    if (settle > 0) await new Promise<void>((done) => setTimeout(done, settle));
    if (!opened.usable() || (proved.headers["connection"] ?? "").toLowerCase().includes("close")) {
      return fail("closed", "Tapwright's daemon closed the connection after it proved itself; nothing was sent, and the token is never sent on a new connection.");
    }
    let answer: Reply;
    try {
      answer = await opened.request("/otp", port, JSON.stringify({ app }), `Bearer ${token}`);
    } catch (error) {
      return error instanceof Closed ? fail("closed", "Tapwright's daemon closed the connection before it answered.") : fail("bad_reply", "Tapwright's daemon answered in a form this Tapline doesn't know.");
    }
    if (answer.status === 404) return fail("none", noCodeMessage(app));
    if (answer.status !== 200) return fail("refused", `Tapwright's daemon refused the request for a one-time code for ${app} (status ${answer.status}).`);
    const body = parseJson(answer.body);
    const code = body?.["code"];
    const expires = body?.["expires"];
    const from = body?.["source"];
    if (typeof code !== "string" || !/^[0-9]{4,12}$/.test(code) || typeof expires !== "number" || !Number.isFinite(expires)) {
      return fail("bad_reply", "Tapwright's daemon sent a one-time code in a form this Tapline doesn't know.");
    }
    if (expires <= now()) return fail("expired", `the one-time code for ${app} had already expired when it arrived; ask the app for a new one.`);
    // The source is Tapwright's own word for where the code came from; it is a name, never the code.
    const source = typeof from === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(from) && from !== code ? from : undefined;
    return { ok: true, code, expires, source };
  };
  try {
    const limit = new Promise<OtpFetch>((resolve) => {
      timer = setTimeout(() => resolve(fail("timeout", "Tapwright's daemon didn't answer in time.")), deps.timeoutMs ?? 5000);
    });
    return await Promise.race([run(), limit]);
  } catch {
    return fail("unreachable", "Tapwright's daemon couldn't be asked.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    wire?.socket.destroy();
  }
}

// -- what the codes of a session are scrubbed from

/** The codes this session typed. Each one is scrubbed from everything shown or kept, for the rest of the session (§20.3). */
export class OtpCodes {
  private codes: string[] = [];
  /** Built on first use after a code is added, so a burst of codes compiles once. */
  private scrub: ((text: string) => string) | null = null;

  /**
   * Keeps scrubbing a code for the rest of the session: none is ever dropped (§20.3). Codes are short-lived and few; past a
   * large cap a new code is refused (false) instead of an old one being forgotten.
   */
  register(code: string): boolean {
    if (this.codes.includes(code)) return true;
    if (this.codes.length >= MAX_CODES) return false;
    this.codes = [...this.codes, code];
    this.scrub = null;
    return true;
  }

  /** Arrow, so it can be handed on as a plain function. */
  readonly redact = (text: string): string => {
    if (this.codes.length === 0) return text;
    this.scrub ??= looseScrubber(this.codes, OTP_PLACEHOLDER);
    return this.scrub(text);
  };
}

/** What the tools use: the redaction shared with the host's sinks, and the way a code comes in. */
export interface OtpService {
  readonly codes: OtpCodes;
  /** Asks for a code. A code is registered for scrubbing before it is returned. */
  fetch(app: string): Promise<OtpFetch>;
}

export function createOtpService(deps: OtpDeps = {}, codes: OtpCodes = new OtpCodes()): OtpService {
  return {
    codes,
    async fetch(app) {
      const result = await fetchOtp(app, deps);
      if (result.ok && !codes.register(result.code)) {
        // Never hand on a code that couldn't be registered for scrubbing.
        return { ok: false, reason: "refused", message: "this session has used too many one-time codes to scrub them all; restart Tapline to type another." };
      }
      return result;
    },
  };
}
