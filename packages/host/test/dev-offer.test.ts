import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { isLocalNetwork, type TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, TOKEN, startHost } from "./helpers.js";

// Zero-QR pairing (Tapline 1.1): after `pair`, a development build on the local network may fetch a one-use code.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function offer(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/tapline/offer`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the development offer", () => {
  it("is closed until pair, then gives one code once; the code pairs an app and the offer closes", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    expect((await offer(port)).status).toBe(404);
    const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
    const answer = textOf(await tools.pair({}));
    expect(answer).toContain("Pairing is open for development builds for 10 minutes (Dev PC).");
    expect(answer).toContain("the user only taps Connect, no QR code");
    const open = await offer(port);
    expect(open.status).toBe(200);
    expect(open.body["name"]).toBe("Dev PC");
    const code = String(open.body["code"]);
    const { app, welcome } = await FakeApp.connect(port, { token: undefined, pairCode: code });
    apps.push(app);
    expect(welcome["token"]).toBe(TOKEN);
    expect((await offer(port)).status).toBe(404);
  });

  it("lapses after its time", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    host.openDevOffer("Dev PC", 30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await offer(port)).status).toBe(404);
  });

  it("goes to the local network only", () => {
    expect(isLocalNetwork("192.168.1.40")).toBe(true);
    expect(isLocalNetwork("::ffff:10.0.0.7")).toBe(true);
    expect(isLocalNetwork("127.0.0.1")).toBe(true);
    expect(isLocalNetwork("100.101.102.103")).toBe(false);
    expect(isLocalNetwork("203.0.113.5")).toBe(false);
    expect(isLocalNetwork(undefined)).toBe(false);
  });

  it("with a scheme, pair gives the QR code and also opens the offer", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
    const answer = await tools.pair({ scheme: "demo" });
    expect(answer.content.some((c) => c.type === "image")).toBe(true);
    expect(textOf(answer)).toContain("asks by itself");
    expect((await offer(port)).status).toBe(200);
  });
});

describe("the offer file for the Metro helper", () => {
  it("pair writes <port>.json (code, name, port, until) where Metro reads it", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "tapline-offerdir-"));
    try {
      const { host, port } = await startHost();
      hosts.push(host);
      const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, offerDir: dir });
      await tools.pair({});
      const written = JSON.parse(readFileSync(join(dir, `${port}.json`), "utf8")) as Record<string, unknown>;
      expect(written).toMatchObject({ name: "Dev PC", port, code: host.currentDevOffer()?.code });
      expect(Number(written["until"])).toBeGreaterThan(Date.now());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
