import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handlePlaceRequest, type TaplineHost } from "../src/server.js";
import { placeAnswer } from "../src/places.js";
import { FakeApp, delay, startHost, TOKEN } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.11: GET /place?app=<bundle id>, answered from memory, for Tapwright.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const APP_ID = "com.example.wayfare";

async function setup(hello: Record<string, unknown> = {}): Promise<{ host: TaplineHost; port: number; app: FakeApp }> {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, { app: { name: "Wayfare", id: APP_ID, version: "1.4.0", build: "1.4.0 (212)" }, capabilities: ["tree", "press", "place"], ...hello });
  apps.push(app);
  return { host, port, app };
}

function get(port: number, query: string, token: string | null = TOKEN, method = "GET"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/place${query}`, { method, headers: token !== null ? { authorization: `Bearer ${token}` } : {} });
}

const place = (app: FakeApp, data: Record<string, unknown>): void => app.send({ type: "event", event: "place", data });

describe("GET /place", () => {
  it("200 with the exact fields, from memory, and no request sent to the phone", async () => {
    const { port, app } = await setup();
    const before = Date.now();
    place(app, { route: ["(tabs)", "settings", "language"], tab: "settings", layer: "sheet:Filters", seenAt: 1 });
    await delay(50);
    const response = await get(port, `?app=${APP_ID}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["app", "inFront", "layer", "route", "seenAt", "tab"]);
    expect(body).toMatchObject({ app: APP_ID, route: ["(tabs)", "settings", "language"], tab: "settings", layer: "sheet:Filters", inFront: true });
    // The host's own clock: the same computer as the tool that asks.
    expect(body["seenAt"]).toBeGreaterThanOrEqual(before);
    expect(body["seenAt"]).toBeLessThanOrEqual(Date.now());
    expect(app.requests).toEqual([]);
    expect(app.dryRuns).toEqual([]);
  });

  it("tab and layer are absent when the app sent none", async () => {
    const { port, app } = await setup();
    place(app, { route: ["index"] });
    await delay(50);
    const body = (await (await get(port, `?app=${APP_ID}`)).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tab");
    expect(body).not.toHaveProperty("layer");
  });

  it("always answers the latest place", async () => {
    const { port, app } = await setup();
    place(app, { route: ["a"] });
    place(app, { route: ["b", "c"] });
    await delay(50);
    const body = (await (await get(port, `?app=${APP_ID}`)).json()) as { route: string[] };
    expect(body.route).toEqual(["b", "c"]);
  });

  it("never contains params", async () => {
    const { port, app } = await setup();
    place(app, { route: ["trips", "[id]"], params: { id: "42", token: "secret-value" }, title: "Trip to Paris", extra: { id: "42" } });
    await delay(50);
    const text = await (await get(port, `?app=${APP_ID}`)).text();
    expect(text).not.toMatch(/42|secret-value|Paris|params|title|extra/);
  });

  it("inFront is false when the app is in the background", async () => {
    const { port, app } = await setup();
    place(app, { route: ["a"] });
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    await delay(50);
    expect(((await (await get(port, `?app=${APP_ID}`)).json()) as { inFront: boolean }).inFront).toBe(false);
    app.send({ type: "event", event: "appState", data: { state: "active" } });
    await delay(50);
    expect(((await (await get(port, `?app=${APP_ID}`)).json()) as { inFront: boolean }).inFront).toBe(true);
  });

  it("401 without the bearer token or with a wrong one", async () => {
    const { port, app } = await setup();
    place(app, { route: ["a"] });
    await delay(50);
    expect((await get(port, `?app=${APP_ID}`, null)).status).toBe(401);
    expect((await get(port, `?app=${APP_ID}`, "x".repeat(TOKEN.length))).status).toBe(401);
  });

  it("404 with {error: no app} for an app that isn't connected", async () => {
    const { port } = await setup();
    const response = await get(port, "?app=com.example.other");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no app" });
  });

  it("404 when the app has sent no place yet", async () => {
    const { port } = await setup();
    const response = await get(port, `?app=${APP_ID}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no place" });
  });

  it("400 without app", async () => {
    const { port } = await setup();
    expect((await get(port, "")).status).toBe(400);
    expect((await get(port, "?app=")).status).toBe(400);
  });

  it("405 for anything but GET", async () => {
    const { port } = await setup();
    expect((await get(port, `?app=${APP_ID}`, TOKEN, "POST")).status).toBe(405);
  });

  it("the same token as /agent-touch", async () => {
    const { port, app } = await setup();
    place(app, { route: ["a"] });
    await delay(50);
    const touch = await fetch(`http://127.0.0.1:${port}/agent-touch`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ms: 10 }),
    });
    expect(touch.status).toBe(204);
    expect((await get(port, `?app=${APP_ID}`)).status).toBe(200);
  });

  it("a place that isn't a route key is dropped", async () => {
    const { port, app } = await setup();
    place(app, { route: "settings" });
    place(app, { route: Array.from({ length: 40 }, () => "x") });
    await delay(50);
    expect((await get(port, `?app=${APP_ID}`)).status).toBe(404);
  });

  it("an event whose pieces look like values leaves the stored place unchanged", async () => {
    const { port, app } = await setup();
    place(app, { route: ["trips"], tab: "trips" });
    await delay(50);
    for (const bad of [
      { route: ["orders", "10432"] },
      { route: ["user", "123"] },
      { route: ["invite", "3fa9c1d2-7b0e-44a8-9c01-e7a5d2b84f36"] },
      { route: ["trips"], layer: "sheet:98765" },
      { route: ["trips"], tab: "3fa9c1d27b0e44a8c1" },
    ]) {
      place(app, bad);
    }
    await delay(50);
    const text = await (await get(port, `?app=${APP_ID}`)).text();
    const body = JSON.parse(text) as { route: string[]; tab?: string; layer?: string };
    expect(body).toMatchObject({ route: ["trips"], tab: "trips" });
    expect(body.layer).toBeUndefined();
  });

  it("the place event is not a log line", async () => {
    const { host, app } = await setup();
    place(app, { route: ["a"] });
    await delay(50);
    const session = host.current();
    expect(host.logs(session?.id ?? "")).toEqual([]);
  });
});

describe("placeAnswer", () => {
  const session = (over: Record<string, unknown> = {}) => ({
    app: { id: APP_ID },
    connectedAt: 1,
    place: { route: ["a"], seenAt: 10 },
    ...over,
  });

  it("403 for a peer that is not this computer", () => {
    const written: { status?: number; body?: string } = {};
    const req = Object.assign(new EventEmitter(), { url: `/place?app=${APP_ID}`, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }) as unknown as IncomingMessage;
    const res = {
      writeHead: (status: number) => {
        written.status = status;
      },
      end: (body?: string) => {
        written.body = body;
      },
    } as unknown as ServerResponse;
    expect(handlePlaceRequest(req, res, { token: TOKEN, loopback: false, sessions: () => [] })).toBe(true);
    expect(written.status).toBe(403);
    expect(written.body).toBe("Only from this computer.\n");
  });

  it("no session is a 404", () => {
    expect(placeAnswer([], APP_ID).status).toBe(404);
  });

  it("with two phones takes the one that spoke last", () => {
    const answer = placeAnswer([session({ place: { route: ["old"], seenAt: 5 } }), session({ place: { route: ["new"], seenAt: 9 } })], APP_ID);
    expect(answer.body["route"]).toEqual(["new"]);
  });
});
