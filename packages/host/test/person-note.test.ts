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

describe("needs a person: review fixes (1.3.1)", () => {
  it("a pair call spends the note without telling the agent to call pair", async () => {
    const tools = await toolsWith(() => false);
    const paired = textOf(await tools.pair({}));
    expect(paired).not.toContain("needs a person");
    expect(textOf(await tools.apps())).not.toContain("needs a person");
  });

  it("counts the marker, or what only a connected app leaves in ~/.tapline, as paired", async () => {
    const { pairedBefore } = await import("../src/config.js");
    const env = { TAPLINE_HOME: "/fake/tapline" };
    const only = (name: string) => (path: string) => path.split("\\").join("/").endsWith(`/fake/tapline/${name}`);
    const files = (n: number) => () => Array.from({ length: n }, (_, i) => `f${i}`);
    expect(pairedBefore(env, () => false)).toBe(false);
    expect(pairedBefore(env, only("paired"))).toBe(true);
    expect(pairedBefore(env, only("shots"), files(2))).toBe(true);
    expect(pairedBefore(env, only("scripts"), files(1))).toBe(true);
    // an empty folder is no sign of a phone
    expect(pairedBefore(env, only("shots"), files(0))).toBe(false);
    // the action log's folder is made at startup, and an offer may never have been taken (Codex review of 1.3.1)
    expect(pairedBefore(env, only("log"), files(3))).toBe(false);
    expect(pairedBefore(env, only("offers"), files(1))).toBe(false);
    expect(pairedBefore(env, only("token"))).toBe(false);
    expect(pairedBefore(env, () => { throw new Error("EACCES"); })).toBe(false);
  });

  it("a fresh home is still unpaired after the host starts with its action log", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pairedBefore } = await import("../src/config.js");
    const { TaplineTools } = await import("../src/tools.js");
    const { startHost } = await import("./helpers.js");
    const home = mkdtempSync(join(tmpdir(), "tapline-fresh-home-"));
    const env = { TAPLINE_HOME: home };
    const { host } = await startHost();
    try {
      new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir: join(home, "log") });
      expect(pairedBefore(env)).toBe(false);
    } finally {
      await host.close();
    }
  });
});
