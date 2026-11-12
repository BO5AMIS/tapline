import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { fromAWebPage, isLocalNetwork, type TaplineHost } from "../src/server.js";
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
      // used once: Metro stops handing it out
      const { existsSync } = await import("node:fs");
      expect((await offer(port)).status).toBe(200); // this device fetches it, so it may pair with it
      const { app } = await FakeApp.connect(port, { token: undefined, pairCode: String(written["code"]) });
      apps.push(app);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(join(dir, `${port}.json`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("open_url of the app's own forget link", () => {
  it("answers that the app unpaired, not an error, when the app drops the connection as it should", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, (req) => {
      if (req.method === "openURL") {
        setTimeout(() => app.ws.close(), 5);
        return "ignore";
      }
      return { ok: true, result: {} };
    });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const answer = await tools.openUrl({ url: "demo://tapline/forget", look: false });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toBe("Unpaired: the app forgot this computer and disconnected. To connect it again, call `pair`.");
  });
});

describe("an offer is the fetching device's alone", () => {
  it("a code another device claimed doesn't pair this one, and that device's later fetch finds nothing", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const opened = host.openDevOffer("Dev PC");
    opened.claimedBy = "192.168.1.99";
    expect((await offer(port)).status).toBe(404);
    const app = await FakeApp.open(port);
    apps.push(app);
    app.send(FakeApp.hello({ token: undefined, pairCode: opened.code }));
    const closed = await app.closed;
    expect(closed.reason).toMatch(/pairing code invalid/);
  });

  it("a forwarded request (Tailscale Serve, a tunnel) gets no offer", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    host.openDevOffer("Dev PC");
    const res = await fetch(`http://127.0.0.1:${port}/tapline/offer`, { headers: { "x-forwarded-for": "100.101.102.103" } });
    expect(res.status).toBe(403);
    expect(isLocalNetwork("fd7a:115c:a1e0::1")).toBe(false);
    // a web page in the user's browser: it sends an Origin, or reaches us under its own name (DNS rebinding)
    expect(fromAWebPage({ host: "127.0.0.1:7210", origin: "http://evil.example" })).toBe(true);
    expect(fromAWebPage({ host: "evil.example:7210" })).toBe(true);
    expect(fromAWebPage({ host: "192.168.1.20:7210" })).toBe(false);
    const page = await fetch(`http://127.0.0.1:${port}/tapline/offer`, { headers: { origin: "http://evil.example" } });
    expect(page.status).toBe(403);
  });
});
