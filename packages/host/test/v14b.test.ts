import { afterEach, describe, expect, it } from "vitest";
import { ControlQueue } from "../src/control.js";
import type { TaplineHost } from "../src/server.js";
import { KEEP_NUMBERING_PARAM, TaplineTools } from "../src/tools.js";
import { ViewerHub, viewerStatusForHost } from "../src/viewer.js";
import { FakeApp, startHost, until, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const hubs: ViewerHub[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

async function connected(handler: (req: IncomingRequest) => Reply, options: Parameters<typeof startHost>[0] = {}) {
  const { host, port } = await startHost(options);
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { host, app, port };
}

describe("viewer status from the host (v1.4)", () => {
  it("goes not-answering when a request ends with not_answering, and live again after any answer", async () => {
    let answer = false;
    const { host } = await connected((req) => (answer ? { ok: true, result: { method: req.method } } : "ignore"), { requestTimeoutMs: 60 });
    const seen: string[] = [];
    host.on("notAnswering", (s) => seen.push(`not-answering ${s.app.name}`));
    host.on("answering", (s) => seen.push(`answering ${s.app.name}`));
    expect(viewerStatusForHost(host)).toEqual({ state: "live", detail: undefined, via: "wifi" });
    await expect(host.request("tree")).rejects.toMatchObject({ code: "not_answering" });
    expect(viewerStatusForHost(host)).toEqual({ state: "not-answering", detail: "Demo" });
    // A second miss doesn't announce it twice.
    await expect(host.request("tree")).rejects.toMatchObject({ code: "not_answering" });
    answer = true;
    await expect(host.request("tree")).resolves.toEqual({ method: "tree" });
    expect(viewerStatusForHost(host)).toEqual({ state: "live", detail: undefined, via: "wifi" });
    expect(seen).toEqual(["not-answering Demo", "answering Demo"]);
  });

  it("a request that ended with the old timeout (app in the background) doesn't make it not-answering", async () => {
    const { host, app } = await connected(() => "ignore", { requestTimeoutMs: 150 });
    const pending = host.request("tree").catch((e: unknown) => e);
    await until(() => app.requests.length === 1);
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    expect(await pending).toMatchObject({ code: "timeout" });
    expect(viewerStatusForHost(host).state).toBe("locked");
    app.send({ type: "event", event: "appState", data: { state: "active" } });
    await until(() => host.sessions()[0]?.appState?.state === "active");
    expect(viewerStatusForHost(host).state).toBe("live");
  });

  it("goes not-answering when the host drops the app for silence, and live when one connects", async () => {
    const { host, port } = await connected(() => "ignore", { silenceTimeoutMs: 200, sweepIntervalMs: 30 });
    await until(() => host.sessions().length === 0);
    expect(viewerStatusForHost(host)).toEqual({ state: "not-answering", detail: "Demo" });
    const next = await FakeApp.connect(port);
    apps.push(next.app);
    expect(viewerStatusForHost(host)).toEqual({ state: "live", detail: undefined, via: "wifi" });
  });

  it("a plain disconnect is still no-device", async () => {
    const { host, app } = await connected(() => ({ ok: true, result: {} }));
    app.ws.close();
    await until(() => host.sessions().length === 0);
    expect(viewerStatusForHost(host).state).toBe("no-device");
  });

  it("a silent drop of an app in the background is still no-device", async () => {
    const { host, app } = await connected(() => "ignore", { silenceTimeoutMs: 250, sweepIntervalMs: 30 });
    app.send({ type: "event", event: "appState", data: { state: "background" } });
    await until(() => host.sessions().length === 0);
    expect(viewerStatusForHost(host).state).toBe("no-device");
  });
});

describe("the HTTP server at / (v1.4)", () => {
  it("has nothing else at /: without the viewer a plain GET gets 426, with it the page", async () => {
    const { host, port } = await connected(() => ({ ok: true, result: {} }));
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(426);
    const hub = new ViewerHub({
      token: "viewer-token-123",
      html: "<!doctype html><title>viewer</title>",
      allowedHosts: () => [`127.0.0.1:${port}`],
      allowRemote: false,
      accepts: ["tap"],
      control: new ControlQueue(),
      setFeed: () => undefined,
      readOverlay: async () => null,
      runInput: async () => ({ ok: true, action: { kind: "press" } }),
    });
    hubs.push(hub);
    host.setHttpExtension(hub);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401);
    const page = await fetch(`http://127.0.0.1:${port}/?token=viewer-token-123`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>viewer</title>");
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(426);
  });
});

describe("the tree request after an action versus a look (v1.4 numbering)", () => {
  const TREE = {
    screen: { width: 402, height: 874, scale: 3 },
    elements: [{ ref: "e3", type: "Pressable", role: "button", label: "Log in", text: "Log in", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] }],
  };

  it("look asks for a full list; an action's list asks for changes once a list was given; the numbering param is off until named", async () => {
    const { host, app, port } = await connected((req) =>
      req.method === "press" ? { ok: true, result: { settledMs: 100 } } : { ok: true, result: TREE },
    );
    const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
    await tools.tap({ target: { text: "Log in" } });
    await tools.look({ screenshot: false });
    await tools.tap({ target: { text: "Log in" } });
    const trees = app.requests.filter((r) => r.method === "tree").map((r) => r.params);
    expect(trees).toEqual([{}, {}, { changes: true }]);
    expect(KEEP_NUMBERING_PARAM).toBeUndefined();
  });
});
