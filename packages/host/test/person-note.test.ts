import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost } from "./helpers.js";

// The first answer of a session says what only a person can do (1.3.1), once, when something is pending.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const NOTE = /\nNote: needs a person: .*\.$/m;

async function toolsWith(pairedBefore: (() => boolean) | undefined): Promise<TaplineTools> {
  const { host, port } = await startHost();
  hosts.push(host);
  return new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, ...(pairedBefore !== undefined ? { pairedBefore } : {}) });
}

describe("Note: needs a person", () => {
  it("rides on the first answer with no app connected: pairing and opening the app, never the token", async () => {
    const tools = await toolsWith(() => false);
    const first = textOf(await tools.apps());
    expect(first).toMatch(NOTE);
    expect(first).toContain("the phone isn't paired yet");
    expect(first).toContain("the app isn't connected");
    expect(first.match(/Note: needs a person/g)).toHaveLength(1);
  });

  it("names only the app when the phone has paired before", async () => {
    const tools = await toolsWith(() => true);
    const first = textOf(await tools.look({}));
    expect(first).toMatch(NOTE);
    expect(first).not.toContain("isn't paired yet");
    expect(first).toContain("the app isn't connected");
  });

  it("comes once per session, not on the second answer", async () => {
    const tools = await toolsWith(() => false);
    await tools.apps();
    expect(textOf(await tools.apps())).not.toContain("needs a person");
    expect(textOf(await tools.look({}))).not.toContain("needs a person");
  });

  it("stays out when an app is connected on the first call", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: true, result: {} }));
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, pairedBefore: () => false });
    expect(textOf(await tools.apps())).not.toContain("needs a person");
  });

  it("is off when the host gives no pairing knowledge (tests, embedders)", async () => {
    const tools = await toolsWith(undefined);
    expect(textOf(await tools.apps())).not.toContain("needs a person");
  });
});
