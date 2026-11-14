import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiAnswer } from "../src/api.js";
import { LEASE_MAX_TTL_MS, PhoneLease } from "../src/control.js";
import { createRuntime, HOST_FACTS_TOOL, LEASE_TOOL, type Runtime } from "../src/runtime.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, delay, startHost, TOKEN, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.14 §22.3 (PR 12 finding 7): a scheduled run holds a run-wide lease on the host; other agents' actions wait or get `busy`.

function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PhoneLease", () => {
  it("another agent's action waits while the lease stands, then runs when it is released", async () => {
    const time = fakeTime();
    const lease: PhoneLease = new PhoneLease({
      now: time.now,
      giveUpMs: 30_000,
      sleep: async (ms) => {
        await time.sleep(ms);
        if (time.now() >= 2000) lease.release("schedule-daily");
      },
    });
    expect(lease.acquire("schedule-daily", 45_000, false)).toEqual({ ok: true });
    const ran: number[] = [];
    await lease.run("other", async () => ran.push(time.now()));
    expect(ran).toHaveLength(1);
    expect(ran[0]).toBeGreaterThanOrEqual(2000);
    expect(ran[0]).toBeLessThan(30_000);
  });

  it("an action of another agent answers busy after giving up, and the holder's own actions go straight through", async () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep, giveUpMs: 30_000 });
    lease.acquire("schedule-daily", 120_000, false);
    await expect(lease.run("other", async () => "ran")).rejects.toMatchObject({ code: "busy" });
    expect(time.now()).toBeGreaterThanOrEqual(30_000);
    const before = time.now();
    await expect(lease.run("schedule-daily", async () => "ran")).resolves.toBe("ran");
    expect(time.now()).toBe(before);
  });

  it("is refused while another agent's action runs, while a person drives, and while another run holds it", async () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep });
    let finish: () => void = () => undefined;
    const running = lease.run("other", () => new Promise<void>((resolve) => (finish = resolve)));
    expect(lease.acquire("schedule-daily", 45_000, false)).toEqual({ ok: false, by: "agent" });
    finish();
    await running;
    expect(lease.acquire("schedule-daily", 45_000, true)).toEqual({ ok: false, by: "person" });
    expect(lease.acquire("schedule-daily", 45_000, false)).toEqual({ ok: true });
    expect(lease.acquire("schedule-other", 45_000, false)).toEqual({ ok: false, by: "lease" });
  });

  it("expires without a renewal, renews as the holder, and is released only by its owner", () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep });
    lease.acquire("a", 10_000, false);
    expect(lease.release("b")).toBe(false);
    expect(lease.heldBy()).toBe("a");
    time.advance(9000);
    expect(lease.acquire("a", 10_000, false)).toEqual({ ok: true });
    time.advance(9000);
    expect(lease.heldBy()).toBe("a");
    time.advance(2000);
    expect(lease.heldBy()).toBeNull();
    expect(lease.acquire("b", 10_000, false)).toEqual({ ok: true });
  });

  it("a ttl is capped, so a run that asks for a day never holds the phone for a day", () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep });
    lease.acquire("a", 86_400_000, false);
    time.advance(LEASE_MAX_TTL_MS + 1);
    expect(lease.heldBy()).toBeNull();
  });
});

describe("the lease through the tools", () => {
  const hosts: TaplineHost[] = [];
  const apps: FakeApp[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) app.ws.terminate();
    await Promise.all(hosts.splice(0).map((h) => h.close()));
  });
  const frame = { x: 20, y: 100, width: 300, height: 44 };
  const OPEN = { ref: "e1", type: "Pressable", role: "button", testID: "open", text: "Open", frame, actions: ["press"] };
  const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

  async function rig(giveUpMs: number): Promise<{ lease: PhoneLease; scheduled: TaplineTools; other: TaplineTools; presses: () => string[] }> {
    const { host, port } = await startHost();
    hosts.push(host);
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [OPEN], route: { names: ["home"] } } };
      if (req.method === "press") return { ok: true, result: { element: OPEN, settledMs: 10 } };
      return { ok: true, result: {} };
    };
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "logs"] }, handler);
    apps.push(app);
    const lease = new PhoneLease({ giveUpMs, pollMs: 10 });
    const make = (id: string): TaplineTools => new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, lease, clientId: () => id, reloadWaitMs: 50 });
    return { lease, scheduled: make("schedule-daily"), other: make("agent-2"), presses: () => app.requests.filter((r) => r.method === "press").map((r) => r.method) };
  }

  it("while a scheduled run holds the lease another agent's tap answers busy and touches nothing; the run's own tap goes through", async () => {
    const r = await rig(80);
    expect(r.lease.acquire("schedule-daily", 45_000, false)).toEqual({ ok: true });
    const blocked = await r.other.tap({ target: { id: "open" }, look: false });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/^Error busy: A scheduled run is using the phone/);
    expect(r.presses()).toEqual([]);
    const own = await r.scheduled.tap({ target: { id: "open" }, look: false });
    expect(own.isError).not.toBe(true);
    expect(r.presses()).toEqual(["press"]);
  });

  it("another agent's tap waits for the lease and runs as soon as the run lets go", async () => {
    const r = await rig(5000);
    r.lease.acquire("schedule-daily", 45_000, false);
    const waiting = r.other.tap({ target: { id: "open" }, look: false });
    await delay(60);
    expect(r.presses()).toEqual([]);
    r.lease.release("schedule-daily");
    const answer = await waiting;
    expect(answer.isError).not.toBe(true);
    expect(r.presses()).toEqual(["press"]);
  });
});

describe("a running host's lease and facts", () => {
  const runtimes: Runtime[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function start(extra: Parameters<typeof createRuntime>[0] = {}): Promise<Runtime> {
    const home = mkdtempSync(join(tmpdir(), "tapline-lease-"));
    dirs.push(home);
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, api: true, ...extra });
    runtimes.push(runtime);
    return runtime;
  }
  const call = async (runtime: Runtime, tool: string, body: Record<string, unknown>, client: string, token = runtime.config.token): Promise<{ status: number; answer?: ApiAnswer }> => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/${tool}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-agent-client": client },
      body: JSON.stringify(body),
    });
    return response.status === 200 ? { status: 200, answer: (await response.json()) as ApiAnswer } : { status: response.status };
  };

  it("the facts are paths and flags only, behind the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-facts-"));
    dirs.push(dir);
    const runtime = await start({ maps: join(dir, "maps") });
    expect((await call(runtime, HOST_FACTS_TOOL, {}, "x", "wrong-token")).status).toBe(401);
    const facts = JSON.parse((await call(runtime, HOST_FACTS_TOOL, {}, "x")).answer?.text ?? "{}") as Record<string, unknown>;
    expect(Object.keys(facts).sort()).toEqual(["accounts", "maps", "noPolicy", "policy", "version"]);
    expect(facts).toMatchObject({ version: 1, policy: null, noPolicy: false, accounts: null });
    expect(String(facts["maps"]).toLowerCase()).toContain("maps");
    expect(JSON.stringify(facts)).not.toContain(TOKEN);
    expect(JSON.stringify(facts)).not.toContain(runtime.config.token);
  });

  it("a --no-policy host says so", async () => {
    const runtime = await start({ noPolicy: true });
    const facts = JSON.parse((await call(runtime, HOST_FACTS_TOOL, {}, "x")).answer?.text ?? "{}") as { noPolicy?: boolean };
    expect(facts.noPolicy).toBe(true);
  });

  it("with --viewer off (no control queue) a run still can't take the phone while another client's action is in flight, and gets it after (PR 12 CodeRabbit)", async () => {
    const runtime = await start({ viewer: "off" });
    const OPEN = { ref: "e1", type: "Pressable", role: "button", testID: "open", text: "Open", frame: { x: 20, y: 100, width: 300, height: 44 }, actions: ["press"] };
    let held: IncomingRequest | undefined;
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [OPEN], route: { names: ["home"] } } };
      if (req.method === "press") {
        held = req;
        return "ignore";
      }
      return { ok: true, result: {} };
    };
    const { app } = await FakeApp.connect(runtime.port, { token: runtime.config.token, capabilities: ["tree", "press", "logs"] }, handler);
    try {
      const asked = async (action: string, client: string): Promise<Record<string, unknown>> =>
        JSON.parse((await call(runtime, LEASE_TOOL, { action }, client)).answer?.text ?? "{}") as Record<string, unknown>;
      const tap = call(runtime, "tap", { target: { id: "open" }, look: false }, "agent-2");
      for (let i = 0; i < 100 && held === undefined; i++) await delay(20);
      expect(held).toBeDefined();
      expect(await asked("acquire", "schedule-a")).toEqual({ ok: false, by: "agent" });
      app.ws.send(JSON.stringify({ type: "response", id: held?.id, ok: true, result: { element: OPEN, settledMs: 10 } }));
      await tap;
      expect(await asked("acquire", "schedule-a")).toEqual({ ok: true });
    } finally {
      app.ws.terminate();
    }
  });

  it("acquire, renew and release belong to the client that asks; a second run is refused; another client can't release it", async () => {
    const runtime = await start();
    const asked = async (action: string, client: string): Promise<Record<string, unknown>> =>
      JSON.parse((await call(runtime, LEASE_TOOL, { action }, client)).answer?.text ?? "{}") as Record<string, unknown>;
    expect(await asked("acquire", "schedule-a")).toEqual({ ok: true });
    expect(await asked("acquire", "schedule-b")).toEqual({ ok: false, by: "lease" });
    expect(await asked("renew", "schedule-b")).toEqual({ ok: false, by: "lost" });
    expect(await asked("release", "schedule-b")).toEqual({ ok: false });
    expect(await asked("renew", "schedule-a")).toEqual({ ok: true });
    expect(await asked("release", "schedule-a")).toEqual({ ok: true });
    expect(await asked("acquire", "schedule-b")).toEqual({ ok: true });
  });
});
