import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runThinCall, type ThinCallIO } from "../src/thincall.js";

// AGENT-TOOLS 1.13 §18.10: tapline call <tool> '<json>'.

const FAKE_TOKEN = "fedcba9876543210fedcba9876543210";
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Stub {
  port: number;
  seen: Seen[];
}

async function stub(respond: (seen: Seen) => { status: number; body: string }): Promise<Stub> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      // The probe (a GET): a Tapline host says "POST only"; an MCP host and other answers pass through.
      if (req.method === "GET") {
        const asked = respond({ path: req.url ?? "", headers: req.headers, body });
        const status = asked.status === 404 && asked.body.includes("MCP server") ? 404 : 405;
        res.writeHead(status);
        res.end(status === 405 ? "POST only.\n" : asked.body);
        return;
      }
      const entry: Seen = { path: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      const answer = respond(entry);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, seen };
}

const answer = (text: string, isError = false, image?: { mimeType: string; dataBase64: string }) => ({
  status: 200,
  body: JSON.stringify({ text, isError, ...(image !== undefined ? { image } : {}) }),
});

function io(ports: number[], extra: Partial<ThinCallIO> = {}): { io: ThinCallIO; out: string[]; err: string[]; home: string } {
  const home = mkdtempSync(join(tmpdir(), "tapline-thin-"));
  dirs.push(home);
  writeFileSync(join(home, "token"), `${FAKE_TOKEN}\n`);
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t), env: { TAPLINE_HOME: home }, ppid: 4242, ports, address: "127.0.0.1", ...extra },
    out,
    err,
    home,
  };
}

describe("imports", () => {
  it("thincall.ts and bin.ts import only node: modules (bin.ts's lazy cli.js and thincall.js apart)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["thincall.ts", "bin.ts"]) {
      const source = readFileSync(join(here, "..", "src", file), "utf8");
      const specifiers: string[] = [];
      for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) specifiers.push(match[1] ?? "");
      for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(match[1] ?? "");
      for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(match[1] ?? "");
      for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specifiers.push(match[1] ?? "");
      const allowed = file === "bin.ts" ? new Set(["./cli.js", "./thincall.js"]) : new Set<string>();
      for (const specifier of specifiers) {
        expect(specifier.startsWith("node:") || allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
      }
      if (file === "thincall.ts") expect(specifiers.length).toBeGreaterThan(3);
    }
  });
});

describe("tapline call", () => {
  it("prints the answer's text and exits 0", async () => {
    const s = await stub(() => answer("Screen 402x874 pt"));
    const run = io([s.port]);
    expect(await runThinCall(["look", '{"screenshot":false}'], run.io)).toBe(0);
    expect(run.out.join("")).toBe("Screen 402x874 pt\n");
    expect(run.err).toEqual([]);
    expect(s.seen[0]?.path).toBe("/api/look");
    expect(s.seen[0]?.body).toBe('{"screenshot":false}');
    expect(s.seen[0]?.headers["authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("the JSON defaults to {}", async () => {
    const s = await stub(() => answer("ok"));
    const run = io([s.port]);
    expect(await runThinCall(["apps"], run.io)).toBe(0);
    expect(s.seen[0]?.body).toBe("{}");
  });

  it("an isError answer prints its first line on stderr and exits 2", async () => {
    const s = await stub(() => answer("Error not_found: nothing matches\nClosest: …", true));
    const run = io([s.port]);
    expect(await runThinCall(["tap", '{"target":{"id":"x"}}'], run.io)).toBe(2);
    expect(run.err.join("")).toBe("Error not_found: nothing matches\n");
    expect(run.out.join("")).toBe("");
  });

  it("no host: exit 3 and the message", async () => {
    const closed = await stub(() => answer("x"));
    const port = closed.port;
    await new Promise<void>((resolve) => { servers[0]?.close(() => resolve()); });
    servers.pop();
    const run = io([port]);
    expect(await runThinCall(["look"], run.io)).toBe(3);
    expect(run.err.join("")).toContain(`Can't reach a Tapline host on this computer: start one with "tapline host".`);
  });

  it("no token file: exit 3", async () => {
    const run = io([1]);
    rmSync(join(run.home, "token"));
    expect(await runThinCall(["look"], run.io)).toBe(3);
  });

  it("--json prints {text, image_path} and the file exists", async () => {
    const s = await stub(() => answer("a look", false, { mimeType: "image/jpeg", dataBase64: "QUJD" }));
    const run = io([s.port]);
    expect(await runThinCall(["look", "--json"], run.io)).toBe(0);
    const printed = JSON.parse(run.out.join("")) as { text: string; image_path: string | null };
    expect(printed.text).toBe("a look");
    expect(printed.image_path).toContain(join(run.home, "shots"));
    expect(existsSync(printed.image_path ?? "")).toBe(true);
    expect(readFileSync(printed.image_path ?? "", "utf8")).toBe("ABC");
  });

  it("without --json a picture's path is printed on the next line", async () => {
    const s = await stub(() => answer("a look", false, { mimeType: "image/png", dataBase64: "QUJD" }));
    const run = io([s.port]);
    expect(await runThinCall(["look"], run.io)).toBe(0);
    const lines = run.out.join("").trimEnd().split("\n");
    expect(lines[0]).toBe("a look");
    expect(lines[1]).toMatch(/shots[\\/]thin-\d+-[0-9a-f]{8}\.png$/);
    expect(existsSync(lines[1] ?? "")).toBe(true);
  });

  it("--client sets X-Agent-Client; the default is the parent process id", async () => {
    const s = await stub(() => answer("ok"));
    await runThinCall(["apps", "--client", "claude-a"], io([s.port]).io);
    await runThinCall(["apps"], io([s.port]).io);
    expect(s.seen[0]?.headers["x-agent-client"]).toBe("claude-a");
    expect(s.seen[1]?.headers["x-agent-client"]).toBe("4242");
  });

  it.each(["--policy", "--accounts", "--maps", "--ux-rules"])("refuses %s with the bad_params line, exit 2, and sends nothing", async (flag) => {
    const s = await stub(() => answer("ok"));
    const run = io([s.port]);
    expect(await runThinCall(["look", flag, "file.json"], run.io)).toBe(2);
    expect(run.err.join("")).toBe(`Error bad_params: ${flag} is set when tapline host starts, not per call.\n`);
    expect(s.seen).toEqual([]);
  });

  it.each(["--no-policy", "--no-dialog"])("refuses %s the same way", async (flag) => {
    const s = await stub(() => answer("ok"));
    const run = io([s.port]);
    expect(await runThinCall(["look", flag], run.io)).toBe(2);
    expect(run.err.join("")).toBe(`Error bad_params: ${flag} is set when tapline host starts, not per call.\n`);
    expect(s.seen).toEqual([]);
  });

  it("tries the ports in order and keeps the first that answers; --port skips the search", async () => {
    const dead = await stub(() => answer("x"));
    const deadPort = dead.port;
    await new Promise<void>((resolve) => { servers[0]?.close(() => resolve()); });
    servers.shift();
    const live = await stub(() => answer("from live"));
    const other = await stub(() => answer("from other"));
    const run = io([deadPort, live.port, other.port]);
    expect(await runThinCall(["apps"], run.io)).toBe(0);
    expect(run.out.join("")).toBe("from live\n");
    expect(other.seen).toEqual([]);
    const explicit = io([live.port]);
    expect(await runThinCall(["apps", "--port", String(other.port)], explicit.io)).toBe(0);
    expect(explicit.out.join("")).toBe("from other\n");
  });

  it("skips a host inside an agent's MCP server (404) and a wrong token (401), and says why when none is left", async () => {
    const mcp = await stub(() => ({ status: 404, body: 'The thin call is served by "tapline host" only, not by an agent\'s MCP server.\n' }));
    const run = io([mcp.port]);
    expect(await runThinCall(["apps"], run.io)).toBe(3);
    expect(run.err.join("")).toContain("doesn't take thin calls");
    const denied = await stub(() => ({ status: 401, body: "Bearer token required.\n" }));
    const second = io([denied.port]);
    expect(await runThinCall(["apps"], second.io)).toBe(3);
    expect(second.err.join("")).toContain("refused this computer's token");
  });

  it("an unknown tool from the host is a refusal, exit 2", async () => {
    const s = await stub(() => ({ status: 404, body: 'Unknown tool "nope".\n' }));
    const run = io([s.port]);
    expect(await runThinCall(["nope"], run.io)).toBe(2);
    expect(run.err.join("")).toBe('Error bad_params: Unknown tool "nope".\n');
  });

  it("a JSON argument that is not an object is refused before any request", async () => {
    const s = await stub(() => answer("ok"));
    const run = io([s.port]);
    expect(await runThinCall(["look", "[1]"], run.io)).toBe(2);
    expect(await runThinCall(["look", "{nope"], run.io)).toBe(2);
    expect(s.seen).toEqual([]);
  });

  it("neither stdout nor stderr ever holds the token", async () => {
    const live = await stub(() => answer("fine"));
    const refusing = await stub(() => answer("Error bad_params: nope", true));
    const denied = await stub(() => ({ status: 401, body: "Bearer token required.\n" }));
    const all: string[] = [];
    for (const [args, port] of [[["apps"], live.port], [["apps"], refusing.port], [["apps"], denied.port], [["apps", "--policy", "x"], live.port], [["apps", "--json"], live.port]] as const) {
      const run = io([port]);
      await runThinCall([...args], run.io);
      all.push(...run.out, ...run.err);
    }
    for (const text of all) expect(text).not.toContain(FAKE_TOKEN);
  });

  it("--host accepts only this computer; another name answers bad_params before the token is read", async () => {
    const s = await stub(() => answer("ok"));
    for (const name of ["192.168.1.20", "example.com", "0.0.0.0"]) {
      const run = io([s.port]);
      rmSync(join(run.home, "token")); // an unread token file would otherwise show up as exit 3
      expect(await runThinCall(["look", "--host", name], run.io)).toBe(2);
      expect(run.err.join("")).toMatch(/^Error bad_params: --host must be 127.0.0.1, localhost or ::1/);
      expect(run.err.join("")).not.toContain(FAKE_TOKEN);
    }
    const ok = io([s.port]);
    expect(await runThinCall(["look", "--host", "localhost"], ok.io)).toBe(0);
    expect(s.seen).toHaveLength(1);
  });

  it("a process that accepts and never answers doesn't hang the search", async () => {
    const mute = createNetServer(() => undefined); // accepts, says nothing
    await new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve));
    const address = mute.address();
    const mutePort = typeof address === "object" && address !== null ? address.port : 0;
    const live = await stub(() => answer("from live"));
    try {
      const started = Date.now();
      const run = io([mutePort, live.port]);
      expect(await runThinCall(["apps"], run.io)).toBe(0);
      expect(run.out.join("")).toBe("from live\n");
      expect(Date.now() - started).toBeLessThan(3000);
      const alone = io([mutePort]);
      expect(await runThinCall(["apps"], alone.io)).toBe(3);
    } finally {
      mute.close();
    }
  });

  it("a confirmed host's answer may take longer than the probe", async () => {
    const delayed = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(405);
        res.end("POST only.\n");
        return;
      }
      req.resume();
      req.on("end", () =>
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "held for a person", isError: false }));
        }, 700),
      );
    });
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", resolve));
    servers.push(delayed);
    const a = delayed.address();
    const run = io([typeof a === "object" && a !== null ? a.port : 0]);
    expect(await runThinCall(["tap", "{}"], run.io)).toBe(0);
    expect(run.out.join("")).toBe("held for a person\n");
  });

  it("picture file names differ even within one millisecond", async () => {
    const s = await stub(() => answer("a look", false, { mimeType: "image/png", dataBase64: "QUJD" }));
    const names = new Set<string>();
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      for (let i = 0; i < 3; i++) {
        const run = io([s.port]);
        await runThinCall(["look", "--json"], run.io);
        names.add((JSON.parse(run.out.join("")) as { image_path: string }).image_path);
      }
    } finally {
      Date.now = realNow;
    }
    expect(names.size).toBe(3);
  });
});
