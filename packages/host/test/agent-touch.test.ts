import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { FakeApp, startHost, TOKEN } from "./helpers.js";

// When Tapwright drives the same app with real touches, the SDK reports each of them like a
// person's finger. Tapwright tells the host first (POST /agent-touch), and touches that arrive in
// that window are the agent's: no "a person used the app" note, refs don't go stale.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

async function setup(slackMs = 300): Promise<{ host: TaplineHost; port: number; app: FakeApp; touches: number[] }> {
  const { host, port } = await startHost({ agentTouchSlackMs: slackMs });
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {});
  apps.push(app);
  const touches: number[] = [];
  host.on("touch", () => touches.push(Date.now()));
  return { host, port, app, touches };
}

function announce(port: number, body: unknown, token: string | null = TOKEN, method = "POST"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/agent-touch`, {
    method,
    headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

const touch = (app: FakeApp): void => app.send({ type: "event", event: "touch", data: { at: Date.now() } });
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("POST /agent-touch", () => {
  it("a touch inside the announced window is the agent's; one after it is a person's again", async () => {
    const { port, app, touches } = await setup(200);
    expect((await announce(port, { ms: 100, by: "tapwright" })).status).toBe(204);
    touch(app);
    await wait(50);
    expect(touches).toHaveLength(0);
    await wait(400); // 100 ms + 200 ms slack are over
    touch(app);
    await wait(50);
    expect(touches).toHaveLength(1);
  });

  it("without an announcement every touch is a person's", async () => {
    const { app, touches } = await setup();
    touch(app);
    await wait(50);
    expect(touches).toHaveLength(1);
  });

  it("refuses a wrong or missing token, and changes nothing", async () => {
    const { port, app, touches } = await setup();
    expect((await announce(port, { ms: 1000 }, "x".repeat(TOKEN.length))).status).toBe(401);
    expect((await announce(port, { ms: 1000 }, null)).status).toBe(401);
    touch(app);
    await wait(50);
    expect(touches).toHaveLength(1);
  });

  it("refuses a bad body or method", async () => {
    const { port } = await setup();
    expect((await announce(port, { ms: -1 })).status).toBe(400);
    expect((await announce(port, { ms: 60_000 })).status).toBe(400);
    expect((await announce(port, { nope: 1 })).status).toBe(400);
    expect((await announce(port, null, TOKEN, "GET")).status).toBe(405);
  });
});
