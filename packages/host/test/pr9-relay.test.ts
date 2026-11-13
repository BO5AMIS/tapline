import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import { hostProof } from "../src/api.js";
import { reflexSchema, runMap, type ReflexInput } from "../src/mapcmd.js";
import { linkReadable, linkWords, matchWord } from "../src/policy.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { runThinCall, type ThinCallIO } from "../src/thincall.js";
import { baseMap, place, setupDrive, textOf, flushDriveMaps } from "./drive-helpers.js";
import type { TaplineHost } from "../src/server.js";
import { FakeApp, until, type IncomingRequest, type Reply } from "./helpers.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { AppMap } from "../src/places.js";
import type { MapContext } from "../src/mapcmd.js";
import type { MapFile } from "../src/mapfile.js";

// PR 9 review (Codex): the relay attack on the host's proof, abandoned queued calls, and links that can't be decoded.

const runtimes: Runtime[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function realHost(): Promise<{ runtime: Runtime; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "tapline-relay-"));
  dirs.push(home);
  const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: home }, log: () => undefined, api: true });
  runtimes.push(runtime);
  return { runtime, home };
}

function ioFor(home: string, ports: number[], address = "127.0.0.1"): { io: ThinCallIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t), env: { TAPLINE_HOME: home }, ppid: 1, ports, address }, out, err };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("the host's proof is bound to the port it was asked on", () => {
  it("a proof made for one port never verifies for another", () => {
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).toMatch(/^[0-9a-f]{64}$/);
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).not.toBe(hostProof("t", "aa", "127.0.0.1", 7211));
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).not.toBe(hostProof("u", "aa", "127.0.0.1", 7210));
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).not.toBe(hostProof("t", "aa", "::1", 7210));
    expect(hostProof("t", "aa", "127.0.0.1", 7210)).toBe(hostProof("t", "aa", "::ffff:127.0.0.1", 7210));
  });

  it("an impostor that relays the probe to the real host on another port never gets the token", async () => {
    const { runtime, home } = await realHost();
    const token = runtime.config.token;
    const stolen: string[] = [];
    // The impostor sits on an earlier port, forwards the probe to the real host and gives its proof back.
    const impostor = createServer((req, res) => {
      if (req.method === "POST") {
        stolen.push(String(req.headers.authorization));
        req.resume();
        res.writeHead(401);
        res.end();
        return;
      }
      const forward = request({ host: "127.0.0.1", port: runtime.port, path: req.url, method: "GET", headers: req.headers, agent: false }, (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (c: Buffer) => chunks.push(c));
        answer.on("end", () => {
          res.writeHead(answer.statusCode ?? 502, { ...(answer.headers as Record<string, string>) });
          res.end(Buffer.concat(chunks));
        });
      });
      forward.end();
    });
    const impostorPort = await listen(impostor);
    expect(impostorPort).not.toBe(runtime.port);
    const run = ioFor(home, [impostorPort, runtime.port]);
    // The real host is second in the search: the call still reaches it, and only it sees the token.
    expect(await runThinCall(["apps"], run.io)).toBe(0);
    expect(stolen).toEqual([]);
    expect(JSON.stringify(stolen)).not.toContain(token);
    const alone = ioFor(home, [impostorPort]);
    expect(await runThinCall(["apps"], alone.io)).toBe(3);
    expect(stolen).toEqual([]);
  });
});

// Abandoned calls -------------------------------------------------------------------------------

const hasIpv6 = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

/** A relay on ::1 at the given port that forwards every request to 127.0.0.1 at the real host port, and records the credentials it saw. */
async function relayOnIpv6(port: number, target: number): Promise<{ stolen: string[] }> {
  const stolen: string[] = [];
  const relay = createServer((req, res) => {
    if (req.method === "POST") stolen.push(String(req.headers.authorization));
    const forward = request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers, agent: false }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    req.pipe(forward);
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(port, "::1", resolve);
  });
  servers.push(relay);
  return { stolen };
}

describe.skipIf(!hasIpv6)("a relay on ::1 with the real host port never gets the credential", () => {
  it("refuses it for ::1, localhost and TAPLINE_PORT", async () => {
    const { runtime, home } = await realHost();
    const { stolen } = await relayOnIpv6(runtime.port, runtime.port);
    const aimed = ioFor(home, [runtime.port], "::1");
    expect(await runThinCall(["apps"], aimed.io)).toBe(3);
    expect(stolen).toEqual([]);
    // localhost: 127.0.0.1 comes first and is the real host; the relay is never sent the credential.
    const named = ioFor(home, [runtime.port], "localhost");
    await runThinCall(["apps"], named.io);
    expect(stolen).toEqual([]);
    const env = ioFor(home, [], "::1");
    env.io.env["TAPLINE_PORT"] = String(runtime.port);
    expect(await runThinCall(["apps"], env.io)).toBe(3);
    expect(stolen).toEqual([]);
  });
});

describe("a queued call whose client went away never runs", () => {
  it("skips the abandoned tap when its predecessor finishes", async () => {
    const { runtime } = await realHost();
    const held: IncomingRequest[] = [];
    const { app } = await FakeApp.connect(runtime.port, { token: runtime.config.token }, (req): Reply => {
      if (req.method === "tree") {
        held.push(req);
        return "ignore";
      }
      return { ok: true, result: { element: { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 0, y: 0, width: 10, height: 10 }, actions: ["press"] } } };
    });
    apps.push(app);
    const tree = { screen: { width: 430, height: 932 }, elements: [{ ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 0, y: 0, width: 10, height: 10 }, actions: ["press"] }] };
    const send = (tool: string, body: string, signal?: AbortSignal): Promise<Response> =>
      fetch(`http://127.0.0.1:${runtime.port}/api/${tool}`, { method: "POST", headers: { authorization: `Bearer ${runtime.config.token}`, "x-agent-client": "agent-a" }, body, ...(signal !== undefined ? { signal } : {}) });
    const first = send("look", JSON.stringify({ screenshot: false })).then((r) => r.json());
    await until(() => held.length === 1);
    const cancel = new AbortController();
    const second = send("tap", JSON.stringify({ target: { id: "save" }, look: false }), cancel.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancel.abort();
    await second;
    await new Promise((resolve) => setTimeout(resolve, 100));
    app.send({ type: "response", id: held[0]?.id, ok: true, result: tree });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    // A later call from the same client still works.
    const third = send("look", JSON.stringify({ screenshot: false }));
    await until(() => held.length === 2);
    app.send({ type: "response", id: held[1]?.id, ok: true, result: tree });
    expect(((await (await third).json()) as { isError: boolean }).isError).toBe(false);
  });
});

// Links that can't be decoded -----------------------------------------------------------------

const BAD_UTF8 = "wayfare://account/%FF%64%65%6c%65%74%65";
const TOO_DEEP = "wayfare://account/%252525252564elete";

describe("policy: a link path that can't be fully decoded", () => {
  it("says so", () => {
    expect(linkReadable("wayfare://account/%44elete")).toBe(true);
    expect(linkReadable("wayfare://account/%2564elete")).toBe(true);
    expect(linkReadable("wayfare://account/100%")).toBe(true);
    expect(linkReadable(BAD_UTF8)).toBe(false);
    expect(linkReadable(TOO_DEEP)).toBe(false);
    // A bad escape in the query is cut off with the query and doesn't matter.
    expect(linkReadable("wayfare://account/ok?x=%FF")).toBe(true);
  });

  it("still gives its best words, so a word list can match what is readable", () => {
    expect(matchWord(["delete"], { text: linkWords("wayfare://delete/%FF") })).toBe("delete");
  });
});

describe("drive: a jump by a link that can't be decoded needs a person's OK", () => {
  it("stops before any request, naming the reason", async () => {
    const map = baseMap();
    map.places["trips_id"] = place(["trips", "[id]"], BAD_UTF8);
    const s = await setupDrive(hosts, apps, dirs, { map, policy: { version: 1, confirm: ["cancel"], block: [] }, world: (w) => (w.links[BAD_UTF8] = "trips") });
    const answer = await callTool(s.tools, "drive", { to: "trips_id" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(textOf(answer)).toContain("can't be decoded");
    expect(s.made("openURL")).toBe(0);
  });
});

function fixtureContext(): MapContext {
  const dir = mkdtempSync(join(tmpdir(), "tapline-relay-map-"));
  dirs.push(dir);
  const app = { id: "com.example.wayfare", name: "Wayfare" };
  const folder = join(dir, app.id);
  mkdirSync(folder, { recursive: true });
  const file: MapFile = {
    format: "agent-tools-map",
    version: 1,
    app: app.id,
    places: { home: { key: { route: ["index"] }, link: null, last: "2026-11-12T10:00:00.000Z" } },
    roads: [],
    routes: {},
    reflexes: [],
  };
  writeFileSync(join(folder, "map.json"), JSON.stringify(file));
  const map = new AppMap({ ...app, version: "1.0.0", build: "1" }, { dir: folder });
  return {
    map,
    app,
    here: async () => ({ name: "home", key: { route: ["index"] }, link: null }),
    known: async () => ({ source: "none", places: [] }),
    lists: { confirm: ["Delete"], block: [] },
    accounts: [],
  } as unknown as MapContext;
}

describe("map: a link that can't be decoded is refused and not echoed", () => {
  it("map link", async () => {
    const ctx = fixtureContext();
    for (const link of [BAD_UTF8, TOO_DEEP]) {
      const out = await runMap({ link, place: "home" }, ctx);
      expect(out.error).toBe(true);
      expect(out.text).toContain("can't be decoded");
      expect(out.text).not.toContain("%FF");
      expect(out.text).not.toContain("%25");
      expect(ctx.map.data().places["home"]?.link).toBeNull();
    }
  });

  it("a reflex that opens one (the schema and the save both refuse)", async () => {
    const ctx = fixtureContext();
    for (const url of [BAD_UTF8, TOO_DEEP]) {
      const parsed = reflexSchema.safeParse({ name: "r", when: { text: "x" }, do: { tool: "open_url", url } });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).not.toContain("%FF");
      expect(JSON.stringify(parsed.error?.issues)).not.toContain("%25");
      // The map's own save check refuses it too, for a reflex that skipped the schema.
      const out = await runMap({ reflex: { name: "r", when: { text: "x" }, do: { tool: "open_url", url } } as unknown as ReflexInput }, ctx);
      expect(out.error).toBe(true);
      expect(out.text).not.toContain("%FF");
      expect(out.text).not.toContain("%25");
    }
    expect(ctx.map.data().reflexes).toHaveLength(0);
  });
});
