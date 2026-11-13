import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_META, TOOL_NAMES, callTool } from "../src/dispatch.js";
import { createMcpServer } from "../src/mcp.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, toolShapes } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.10: one table from a tool's name to its handler, used by the MCP server and by /api/<tool>.

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

function handler(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: TREE };
  return { ok: true, result: {} };
}

async function setup() {
  const logDir = mkdtempSync(join(tmpdir(), "tapline-dispatch-"));
  dirs.push(logDir);
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { logDir, tools: new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir }) };
}

const textOf = (result: CallToolResult): string => result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

describe("the tool table", () => {
  it("covers every tool shape", () => {
    expect([...TOOL_NAMES]).toEqual(Object.keys(toolShapes));
    for (const name of TOOL_NAMES) expect(TOOL_META[name]).toMatchObject({ title: expect.any(String), readOnly: expect.any(Boolean) });
    expect(Object.keys(TOOL_META).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("refuses an unknown argument like MCP, and logs it as a call", async () => {
    const { tools, logDir } = await setup();
    const answer = await callTool(tools, "look", { bogus: 1 });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: look doesn't take bogus; it takes screenshot, width/);
    expect(textOf(tools.sessionReport({}))).toContain("1 call");
    expect(logDir).toBeTruthy();
  });

  it("refuses an unknown tool", async () => {
    const { tools } = await setup();
    const answer = await callTool(tools, "nope", {});
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain('Error bad_params: unknown tool "nope"');
  });

  it("refuses an argument of the wrong kind", async () => {
    const { tools } = await setup();
    const answer = await callTool(tools, "look", { screenshot: "yes" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: look: screenshot/);
  });

  it("runs a tool and answers what the method answers", async () => {
    const { tools } = await setup();
    const viaTable = await callTool(tools, "look", { screenshot: false });
    expect(viaTable.isError).not.toBe(true);
    expect(textOf(viaTable)).toContain("login-button");
  });

  it("the MCP server registers exactly TOOL_NAMES", async () => {
    const { tools } = await setup();
    const server = createMcpServer(tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      for (const tool of listed.tools) {
        expect(tool.title ?? tool.annotations?.title ?? TOOL_META[tool.name as keyof typeof TOOL_META].title).toBeTruthy();
        expect(tool.annotations?.readOnlyHint === true).toBe(TOOL_META[tool.name as keyof typeof TOOL_META].readOnly);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
