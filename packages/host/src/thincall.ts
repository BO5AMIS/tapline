// The thin call (AGENT-TOOLS 1.13 §18.10): `tapline call <tool> '<json>'`.
// It imports only node: modules, so it starts in a few milliseconds; a test checks that.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const FIRST_PORT = 7210;
const LAST_PORT = 7219;
/** How long a port gets to show it is a Tapline host before the search moves on. */
const PROBE_MS = 400;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Flags that fix what the host may do. A call can't widen them: they are set when the host starts. */
const FIXED_AT_START = ["policy", "no-policy", "no-dialog", "accounts", "maps", "ux-rules"] as const;

const USAGE = `Usage: tapline call <tool> ['<json>'] [--client NAME] [--json] [--port N] [--host H]

Sends one tool call to a running "tapline host" on this computer and prints the answer's text.
Exit 0: an answer. Exit 2: a refusal (its first line is on stderr). Exit 3: no host could be reached.
Exit 1: the call was sent and its outcome is unknown (no answer came back); it may have run, so look before you repeat it.
`;

export interface ThinCallIO {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** The parent process id, the default client name. */
  ppid: number;
  /** The ports to try, in order, when --port isn't given. */
  ports: number[];
  /** The address of the host. Default 127.0.0.1. */
  address: string;
}

function defaultIO(): ThinCallIO {
  const ports: number[] = [];
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) ports.push(port);
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    env: process.env,
    ppid: process.ppid,
    ports,
    address: "127.0.0.1",
  };
}

/** `~/.tapline`, or `$TAPLINE_HOME` when set (the same folder the host uses). */
function homeDir(env: NodeJS.ProcessEnv): string {
  const override = env["TAPLINE_HOME"];
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".tapline");
}

interface Reply {
  status: number;
  body: string;
}

/** A POST that failed: `sent` is false only when the connection was refused, so the call can't have run. */
class PostError extends Error {
  constructor(readonly sent: boolean) {
    super("the request failed");
  }
}

/** One POST; rejects with a PostError. The token goes in the header and nowhere else. */
function post(address: string, port: number, tool: string, body: string, token: string, client: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: address,
        port,
        path: `/api/${encodeURIComponent(tool)}`,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
          "x-agent-client": client,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => reject(new PostError(true)));
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => reject(new PostError(error.code !== "ECONNREFUSED")));
    req.end(body);
  });
}

type Probe = "host" | "mcp" | "none";

/** What a host must send back to prove it holds the token on this port (the same formula as hostProof in api.ts). */
function proofOf(token: string, challenge: string, port: number): string {
  return createHmac("sha256", token).update(`tapline-proof-v1\n${challenge}\n${port}\nloopback`).digest("hex");
}

/** The proof must be made for the port this client connected to: a proof relayed from another port fails here. */
function provesToken(header: string | string[] | undefined, token: string, challenge: string, port: number): boolean {
  if (typeof header !== "string") return false;
  const given = Buffer.from(header, "utf8");
  const wanted = Buffer.from(proofOf(token, challenge, port), "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * Asks a port who it is with a GET (no token, no side effect), bounded by PROBE_MS: a process that accepts and never
 * answers can't hang the search. The GET carries a fresh random challenge; a Tapline host answers 405 "POST only" with
 * an HMAC of it keyed by the token, which only a holder of the token can make. A port that doesn't prove it (another
 * program that borrowed the port) never sees the token. One inside an MCP server answers 404 with its own text. The
 * real call that follows waits without a limit, since it may be held for a person's OK.
 */
function probe(address: string, port: number, token: string): Promise<Probe> {
  const challenge = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Probe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    };
    const req = request({ host: address, port, path: "/api/", method: "GET", agent: false, headers: { "x-tapline-challenge": challenge } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 405 && text.startsWith("POST only") && provesToken(res.headers["x-tapline-proof"], token, challenge, port)) finish("host");
        else if (res.statusCode === 404 && text.includes("MCP server")) finish("mcp");
        else finish("none");
      });
      res.on("error", () => finish("none"));
    });
    const timer = setTimeout(() => finish("none"), PROBE_MS);
    req.on("error", () => finish("none"));
    req.end();
  });
}

interface Answer {
  text: string;
  isError: boolean;
  image?: { mimeType: string; dataBase64: string };
}

function asAnswer(value: unknown): Answer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record["text"] !== "string" || typeof record["isError"] !== "boolean") return null;
  const image = record["image"];
  if (typeof image === "object" && image !== null) {
    const { mimeType, dataBase64 } = image as Record<string, unknown>;
    if (typeof mimeType === "string" && typeof dataBase64 === "string") {
      return { text: record["text"], isError: record["isError"], image: { mimeType, dataBase64 } };
    }
  }
  return { text: record["text"], isError: record["isError"] };
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  return "bin";
}

/** Runs `tapline call`. `argv` is what follows the word `call`. Returns the exit code. */
export async function runThinCall(argv: string[], io: ThinCallIO = defaultIO()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        client: { type: "string" },
        json: { type: "boolean" },
        port: { type: "string" },
        host: { type: "string" },
        policy: { type: "string" },
        "no-policy": { type: "boolean" },
        "no-dialog": { type: "boolean" },
        accounts: { type: "string" },
        maps: { type: "string" },
        "ux-rules": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    io.err(`Error bad_params: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const { values, positionals } = parsed;

  // A call may narrow what its host was started with, never widen it: the model writes this command line.
  for (const flag of FIXED_AT_START) {
    if (values[flag] !== undefined) {
      io.err(`Error bad_params: --${flag} is set when tapline host starts, not per call.\n`);
      return 2;
    }
  }
  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }
  const tool = positionals[0];
  if (tool === undefined || positionals.length > 2) {
    io.err(USAGE);
    return 2;
  }
  const raw = positionals[1] ?? "{}";
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    io.err("Error bad_params: the arguments must be one JSON object, e.g. '{\"screenshot\":false}'.\n");
    return 2;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    io.err("Error bad_params: the arguments must be one JSON object, e.g. '{\"screenshot\":false}'.\n");
    return 2;
  }
  let ports = io.ports;
  const fromEnv = io.env["TAPLINE_PORT"];
  if (values.port === undefined && fromEnv !== undefined && fromEnv !== "") {
    // The host started with TAPLINE_PORT sits on that port and nowhere else: look there first.
    const port = Number(fromEnv);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      io.err(`Error bad_params: TAPLINE_PORT must be a port number, not "${fromEnv}".\n`);
      return 2;
    }
    ports = [port, ...io.ports.filter((other) => other !== port)];
  }
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      io.err(`Error bad_params: --port must be a port number, not "${values.port}".\n`);
      return 2;
    }
    ports = [port];
  }
  const address = values.host ?? io.address;
  // The token goes over plain http, so only this computer may be named.
  if (!LOOPBACK_NAMES.has(address.toLowerCase())) {
    io.err(`Error bad_params: --host must be 127.0.0.1, localhost or ::1; the token never leaves this computer.\n`);
    return 2;
  }
  const client = values.client ?? String(io.ppid);
  const body = JSON.stringify(args);

  const home = homeDir(io.env);
  let token: string;
  try {
    token = readFileSync(join(home, "token"), "utf8").trim();
  } catch {
    token = "";
  }
  const noHost = `Can't reach a Tapline host on this computer: start one with "tapline host".\n`;
  if (token === "") {
    io.err(noHost);
    return 3;
  }

  let mcpHostSeen = false;
  let tokenRefused = false;
  for (const port of ports) {
    const who = await probe(address, port, token);
    if (who === "mcp") {
      mcpHostSeen = true; // a host inside an agent's MCP server: it doesn't take thin calls
      continue;
    }
    if (who === "none") continue; // nothing here, or not a Tapline host
    let reply: Reply;
    try {
      reply = await post(address, port, tool, body, token, client);
    } catch (error) {
      if (error instanceof PostError && !error.sent) continue; // nothing listens there
      return unknownOutcome(io);
    }
    if (reply.status === 200) {
      let answer: Answer | null = null;
      try {
        answer = asAnswer(JSON.parse(reply.body));
      } catch {
        answer = null;
      }
      if (answer === null) return unknownOutcome(io); // the host ran it, and the answer can't be read
      return finish(answer, values.json === true, home, io);
    }
    if (reply.status === 401) {
      tokenRefused = true;
      continue;
    }
    if (reply.status === 404 && reply.body.startsWith("Unknown tool")) {
      io.err(`Error bad_params: ${reply.body.trim()}\n`);
      return 2;
    }
    if (reply.status === 404) {
      mcpHostSeen = true; // a host inside an agent's MCP server: it doesn't take thin calls
      continue;
    }
    if (reply.status === 400) {
      io.err(`Error bad_params: ${reply.body.trim()}\n`);
      return 2;
    }
    if (reply.status >= 500) return unknownOutcome(io);
  }
  io.err(noHost);
  if (tokenRefused) io.err("A host answered but refused this computer's token.\n");
  else if (mcpHostSeen) io.err("The host inside an agent's MCP server doesn't take thin calls.\n");
  return 3;
}

/** The call was sent and no usable answer came back: never sent again to another host. */
function unknownOutcome(io: ThinCallIO): number {
  io.err("Error unknown_outcome: the call was sent but no answer came back, so it may have run. Look at the app before you repeat it.\n");
  return 1;
}

function finish(answer: Answer, asJson: boolean, home: string, io: ThinCallIO): number {
  let imagePath: string | null = null;
  if (answer.image !== undefined) {
    const dir = join(home, "shots");
    // Pictures can show private screens and pairing codes: only this user may read them.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    imagePath = join(dir, `thin-${Date.now()}-${randomBytes(4).toString("hex")}.${extensionFor(answer.image.mimeType)}`);
    writeFileSync(imagePath, Buffer.from(answer.image.dataBase64, "base64"), { mode: 0o600 });
  }
  const firstLine = answer.text.split("\n")[0] ?? "";
  if (asJson) io.out(`${JSON.stringify({ text: answer.text, image_path: imagePath })}\n`);
  if (answer.isError) {
    io.err(`${firstLine}\n`);
    return 2;
  }
  if (!asJson) io.out(`${answer.text}\n${imagePath !== null ? `${imagePath}\n` : ""}`);
  return 0;
}
