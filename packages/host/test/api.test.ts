import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi, type ApiAnswer, type ApiHandler } from "../src/api.js";
import { callTool, isToolName } from "../src/dispatch.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, TOKEN, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.10: POST /api/<tool> on a standalone host.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const TREE = {
  screen: { width: 402, height: 874, scale: 3 },
  elements: [{ ref: "e3", type: "Pressable", role: "button", testID: "login-button", label: "Log in", text: "Log in", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] }],
};
const SHOT = { mime: "image/jpeg", data: "QUJD", width: 600, height: 1305 };

function handler(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: TREE };
  if (req.method === "screenshot") return { ok: true, result: SHOT };
  return { ok: true, result: {} };
}

/** A host that serves the thin call, one TaplineTools per client name, as the runtime does. */
async function serve(withApi = true) {
  const logDir = mkdtempSync(join(tmpdir(), "tapline-api-"));
  dirs.push(logDir);
  const perClient = new Map<string, TaplineTools>();
  let hostRef: TaplineHost | undefined;
  const toolsFor = (client: string | undefined): TaplineTools => {
    const key = client ?? "(connection)";
    let tools = perClient.get(key);
    if (tools === undefined) {
      if (hostRef === undefined) throw new Error("host not ready");
      tools = new TaplineTools(hostRef, { connect: { url: "", name: "Dev PC" }, logDir });
      perClient.set(key, tools);
    }
    return tools;
  };
  const api: ApiHandler = async (tool, args, client) => (isToolName(tool) ? callTool(toolsFor(client), tool, args) : undefined);
  const { host, port } = await startHost(withApi ? { api } : {});
  hostRef = host;
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { host, port };
}

function post(port: number, tool: string, body: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/<tool>", () => {
  it("answers look as {text, isError}", async () => {
    const { port } = await serve();
    const res = await post(port, "look", { screenshot: false });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as ApiAnswer;
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("login-button");
    expect(answer.image).toBeUndefined();
  });

  it("an empty body means no arguments", async () => {
    const { port } = await serve();
    const res = await post(port, "apps", "");
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiAnswer).text).toContain("Demo");
  });

  it("a refusal is a 200 with isError true", async () => {
    const { port } = await serve();
    const answer = (await (await post(port, "look", { bogus: 1 })).json()) as ApiAnswer;
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^Error bad_params: look doesn't take bogus/);
  });

  it("403 for a peer that is not this computer", () => {
    const written: { status?: number; body?: string } = {};
    const req = Object.assign(new EventEmitter(), { url: "/api/look", method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }) as unknown as IncomingMessage;
    const res = {
      writeHead: (status: number) => {
        written.status = status;
      },
      end: (body?: string) => {
        written.body = body;
      },
    } as unknown as ServerResponse;
    const handled = handleApi(req, res, { token: TOKEN, loopback: false, handler: async () => undefined });
    expect(handled).toBe(true);
    expect(written.status).toBe(403);
    expect(written.body).toBe("Only from this computer.\n");
  });

  it("401 without a bearer or with a wrong one", async () => {
    const { port } = await serve();
    expect((await post(port, "look", {}, {}, null)).status).toBe(401);
    expect((await post(port, "look", {}, {}, "wrong")).status).toBe(401);
  });

  it("405 for GET", async () => {
    const { port } = await serve();
    expect((await fetch(`http://127.0.0.1:${port}/api/look`)).status).toBe(405);
  });

  it("404 for an unknown tool", async () => {
    const { port } = await serve();
    const res = await post(port, "nope", {});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Unknown tool "nope".\n');
  });

  it("400 for a body that is not a JSON object", async () => {
    const { port } = await serve();
    expect((await post(port, "look", "[1]")).status).toBe(400);
    expect((await post(port, "look", "{nope")).status).toBe(400);
    expect((await post(port, "look", JSON.stringify("x"))).status).toBe(400);
  });

  it("400 for a body over 1 MB", async () => {
    const { port } = await serve();
    const big = JSON.stringify({ text: "x".repeat(1024 * 1024 + 10) });
    expect((await post(port, "type_text", big)).status).toBe(400);
  });

  it("404 with the standalone-only text when the host has no api", async () => {
    const { port } = await serve(false);
    const res = await post(port, "look", {});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('The thin call is served by "tapline host" only, not by an agent\'s MCP server.\n');
  });

  it("two X-Agent-Client names get two session reports", async () => {
    const { port } = await serve();
    await post(port, "look", { bogus: 1 }, { "x-agent-client": "agent-a" });
    await post(port, "look", { bogus: 1 }, { "x-agent-client": "agent-b" });
    const a = (await (await post(port, "session_report", {}, { "x-agent-client": "agent-a" })).json()) as ApiAnswer;
    const b = (await (await post(port, "session_report", {}, { "x-agent-client": "agent-b" })).json()) as ApiAnswer;
    for (const answer of [a, b]) {
      expect(answer.text).toMatch(/\b1 call\b/);
      expect(answer.text).not.toMatch(/\b2 calls\b/);
    }
  });

  it("an image answer comes back as base64 with its mime type", async () => {
    const { port } = await serve();
    const answer = (await (await post(port, "look", {})).json()) as ApiAnswer;
    expect(answer.image).toEqual({ mimeType: "image/jpeg", dataBase64: "QUJD" });
  });

  it("the token never appears in any response body", async () => {
    const { port } = await serve();
    const bodies: string[] = [];
    bodies.push(await (await post(port, "look", {})).text());
    bodies.push(await (await post(port, "pair", {})).text());
    bodies.push(await (await post(port, "session_report", {})).text());
    bodies.push(await (await post(port, "look", {}, {}, "wrong")).text());
    bodies.push(await (await post(port, "nope", {})).text());
    for (const body of bodies) expect(body).not.toContain(TOKEN);
  });
});
