import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { OK_ALLOW, OK_FIELD, OK_SCHEMA } from "../src/elicit.js";
import { elicitClientFor } from "../src/mcp.js";
import { runtimeOptionsOf, parseCli } from "../src/cli.js";

// AGENT-TOOLS 1.13 §11.3: the dialog over a real MCP connection (the SDK's in-memory pair).

async function connect(capabilities: { elicitation?: Record<string, unknown> }): Promise<{ server: McpServer; client: Client; seen: Array<Record<string, unknown>> }> {
  const server = new McpServer({ name: "tapline-test", version: "0" });
  const client = new Client({ name: "chat-app", version: "1" }, { capabilities });
  const seen: Array<Record<string, unknown>> = [];
  if (capabilities.elicitation !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      seen.push(request.params as Record<string, unknown>);
      return { action: "accept", content: { [OK_FIELD]: OK_ALLOW } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client, seen };
}

describe("the host's dialog over MCP", () => {
  it.each([
    ["no elicitation", undefined, false],
    ["an empty elicitation object (form mode, older clients)", {}, true],
    ["form", { form: {} }, true],
    ["form and url", { form: {}, url: {} }, true],
    ["url only", { url: {} }, false],
  ] as const)("canShowForm: %s", async (_name, elicitation, expected) => {
    const { server } = await connect(elicitation === undefined ? {} : { elicitation: { ...elicitation } });
    expect(elicitClientFor(server).canShowForm()).toBe(expected);
  });

  it("sends a form with the one required field and returns the person's answer", async () => {
    const { server, seen } = await connect({ elicitation: {} });
    const answer = await elicitClientFor(server).elicit('Allow: tap "Delete trip" in Wayfare? (policy word "Delete")', OK_SCHEMA, new AbortController().signal);
    expect(answer).toEqual({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      mode: "form",
      message: 'Allow: tap "Delete trip" in Wayfare? (policy word "Delete")',
      requestedSchema: { required: [OK_FIELD], properties: { [OK_FIELD]: { type: "string", enum: ["Allow once", "Don't allow"] } } },
    });
  });

  it("an abort ends the request", async () => {
    const server = new McpServer({ name: "tapline-test", version: "0" });
    const client = new Client({ name: "chat-app", version: "1" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, () => new Promise(() => undefined));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const stop = new AbortController();
    const asked = elicitClientFor(server).elicit("caption", OK_SCHEMA, stop.signal);
    setTimeout(() => stop.abort(), 10);
    await expect(asked).rejects.toBeDefined();
  });
});

describe("--no-dialog", () => {
  it("is read by the command line and reaches the runtime options", () => {
    expect(runtimeOptionsOf(parseCli(["mcp", "--no-dialog"]).values, {}).noDialog).toBe(true);
    expect(runtimeOptionsOf(parseCli(["mcp"]).values, {}).noDialog).toBeUndefined();
  });
});
