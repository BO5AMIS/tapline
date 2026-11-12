// The thin call (AGENT-TOOLS 1.13 §18.10): `tapline call <tool> '<json>'`.
// It imports only node: modules, so it starts in a few milliseconds; a test checks that.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const FIRST_PORT = 7210;
const LAST_PORT = 7219;

/** Flags that fix what the host may do. A call can't widen them: they are set when the host starts. */
const FIXED_AT_START = ["policy", "no-policy", "no-dialog", "accounts", "maps", "ux-rules"] as const;

const USAGE = `Usage: tapline call <tool> ['<json>'] [--client NAME] [--json] [--port N] [--host H]

Sends one tool call to a running "tapline host" on this computer and prints the answer's text.
Exit 0: an answer. Exit 2: a refusal (its first line is on stderr). Exit 3: no host could be reached.
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

/** One POST; rejects when nothing listens. The token goes in the header and nowhere else. */
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
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
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
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      io.err(`Error bad_params: --port must be a port number, not "${values.port}".\n`);
      return 2;
    }
    ports = [port];
  }
  const address = values.host ?? io.address;
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
    let reply: Reply;
    try {
      reply = await post(address, port, tool, body, token, client);
    } catch {
      continue; // nothing listens there
    }
    if (reply.status === 200) {
      let answer: Answer | null = null;
      try {
        answer = asAnswer(JSON.parse(reply.body));
      } catch {
        answer = null;
      }
      if (answer === null) continue; // not a Tapline host
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
  }
  io.err(noHost);
  if (tokenRefused) io.err("A host answered but refused this computer's token.\n");
  else if (mcpHostSeen) io.err("The host inside an agent's MCP server doesn't take thin calls.\n");
  return 3;
}

function finish(answer: Answer, asJson: boolean, home: string, io: ThinCallIO): number {
  let imagePath: string | null = null;
  if (answer.image !== undefined) {
    const dir = join(home, "shots");
    mkdirSync(dir, { recursive: true });
    imagePath = join(dir, `thin-${Date.now()}.${extensionFor(answer.image.mimeType)}`);
    writeFileSync(imagePath, Buffer.from(answer.image.dataBase64, "base64"));
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
