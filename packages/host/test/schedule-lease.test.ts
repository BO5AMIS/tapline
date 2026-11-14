import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiAnswer } from "../src/api.js";
import { LEASE_MAX_TTL_MS, PhoneLease } from "../src/control.js";
import { createRuntime, HOST_FACTS_TOOL, LEASE_TOOL, type Runtime } from "../src/runtime.js";
import type { TaplineHost } from "../src/server.js";
import { hashFile } from "../src/hostfacts.js";
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
  /** Takes the lease and hands back the credential it gave. */
  function take(lease: PhoneLease, owner: string, ttl = 45_000): string {
    const got = lease.acquire(owner, ttl, false);
    if (!got.ok) throw new Error("the lease was refused");
    return got.credential;
  }

  it("another agent's action waits while the lease stands, then runs when it is released", async () => {
    const time = fakeTime();
    let credential = "";
    const lease: PhoneLease = new PhoneLease({
      now: time.now,
      giveUpMs: 30_000,
      sleep: async (ms) => {
        await time.sleep(ms);
        if (time.now() >= 2000) lease.release(credential);
      },
    });
    credential = take(lease, "schedule-daily");
    const ran: number[] = [];
    await lease.run("other", async () => ran.push(time.now()));
    expect(ran).toHaveLength(1);
    expect(ran[0]).toBeGreaterThanOrEqual(2000);
    expect(ran[0]).toBeLessThan(30_000);
  });

  it("an action of another agent answers busy after giving up, and the holder's own actions go straight through", async () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep, giveUpMs: 30_000 });
    const credential = take(lease, "schedule-daily", 120_000);
    await expect(lease.run("other", async () => "ran")).rejects.toMatchObject({ code: "busy" });
    expect(time.now()).toBeGreaterThanOrEqual(30_000);
    const before = time.now();
    await expect(lease.run("schedule-daily", async () => "ran", credential)).resolves.toBe("ran");
    expect(time.now()).toBe(before);
  });

  it("a label alone is never the holder: the same name without the credential waits and answers busy (PR 12 Codex cycle 2)", async () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep, giveUpMs: 30_000 });
    const credential = take(lease, "schedule-daily", 120_000);
    await expect(lease.run("schedule-daily", async () => "ran")).rejects.toMatchObject({ code: "busy" });
    // a credential that is not the holder's is refused outright (R7 finding 5), not queued
    await expect(lease.run("schedule-daily", async () => "ran", "00".repeat(32))).rejects.toMatchObject({ code: "lease_lost" });
    await expect(lease.run("schedule-daily", async () => "ran", credential)).resolves.toBe("ran");
  });

  it("an expired credential is refused with lease_lost even when no one holds the lease now (PR 12 R7 finding 5)", async () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep, giveUpMs: 30_000 });
    const credential = take(lease, "schedule-daily", 10_000);
    time.advance(10_001);
    expect(lease.heldBy()).toBeNull();
    let ran = false;
    await expect(
      lease.run(
        "schedule-daily",
        async () => {
          ran = true;
        },
        credential,
      ),
    ).rejects.toMatchObject({ code: "lease_lost" });
    expect(ran).toBe(false);
    expect(() => lease.assertCurrent(credential)).toThrowError(expect.objectContaining({ code: "lease_lost" }));
    // no credential at all is an ordinary call and runs when no one holds the lease
    await expect(lease.run("other", async () => "ran")).resolves.toBe("ran");
    // a released credential is lost too
    const second = take(lease, "schedule-daily");
    lease.release(second);
    await expect(lease.run("schedule-daily", async () => "ran", second)).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("the credential is 32 random bytes in hex, new each time, and acquiring again under the same label doesn't renew it", () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep });
    const first = take(lease, "a");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(lease.acquire("a", 10_000, false)).toEqual({ ok: false, by: "lease" });
    expect(lease.renew(undefined, 10_000)).toBe(false);
    expect(lease.release(undefined)).toBe(false);
    expect(lease.release("a")).toBe(false);
    expect(lease.release(first)).toBe(true);
    expect(take(lease, "a")).not.toBe(first);
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
    take(lease, "schedule-daily");
    expect(lease.acquire("schedule-other", 45_000, false)).toEqual({ ok: false, by: "lease" });
  });

  it("expires without a renewal, renews with the credential, and is released only by its holder", () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep });
    const credential = take(lease, "a", 10_000);
    expect(lease.release("b")).toBe(false);
    expect(lease.heldBy()).toBe("a");
    time.advance(9000);
    expect(lease.renew(credential, 10_000)).toBe(true);
    time.advance(9000);
    expect(lease.heldBy()).toBe("a");
    time.advance(2000);
    expect(lease.heldBy()).toBeNull();
    expect(lease.renew(credential, 10_000)).toBe(false);
    expect(lease.acquire("b", 10_000, false)).toMatchObject({ ok: true });
  });

  it("a ttl is capped, so a run that asks for a day never holds the phone for a day", () => {
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep });
    take(lease, "a", 86_400_000);
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
    const got = r.lease.acquire("schedule-daily", 45_000, false);
    if (!got.ok) throw new Error("refused");
    const blocked = await r.other.tap({ target: { id: "open" }, look: false });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/^Error busy: A scheduled run is using the phone/);
    expect(r.presses()).toEqual([]);
    // the label alone is not enough, even for the same name
    const spoof = await r.scheduled.tap({ target: { id: "open" }, look: false });
    expect(textOf(spoof)).toMatch(/^Error busy: A scheduled run is using the phone/);
    expect(r.presses()).toEqual([]);
    const own = await r.scheduled.withCall(undefined, () => r.scheduled.tap({ target: { id: "open" }, look: false }), got.credential);
    expect(own.isError).not.toBe(true);
    expect(r.presses()).toEqual(["press"]);
  });

  it("another agent's tap waits for the lease and runs as soon as the run lets go", async () => {
    const r = await rig(5000);
    const got = r.lease.acquire("schedule-daily", 45_000, false);
    if (!got.ok) throw new Error("refused");
    const waiting = r.other.tap({ target: { id: "open" }, look: false });
    await delay(60);
    expect(r.presses()).toEqual([]);
    r.lease.release(got.credential);
    const answer = await waiting;
    expect(answer.isError).not.toBe(true);
    expect(r.presses()).toEqual(["press"]);
  });
});

describe("the lease is re-checked right before an action is sent (PR 12 R7 finding 5)", () => {
  const hosts: TaplineHost[] = [];
  const apps: FakeApp[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) app.ws.terminate();
    await Promise.all(hosts.splice(0).map((h) => h.close()));
  });
  const frame = { x: 20, y: 100, width: 300, height: 44 };
  const OPEN = { ref: "e1", type: "Pressable", role: "button", testID: "open", text: "Open", frame, actions: ["press"] };

  it("a lease that expires after the queue but before the press is sent: nothing is sent, the answer is lease_lost", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const time = fakeTime();
    const lease = new PhoneLease({ now: time.now, sleep: time.sleep, giveUpMs: 1000, pollMs: 10 });
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "tree") {
        // the renewal stalls: the lease runs out while the tap is being prepared
        time.advance(60_000);
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [OPEN], route: { names: ["home"] } } };
      }
      return { ok: true, result: { element: OPEN, settledMs: 10 } };
    };
    const { app } = await FakeApp.connect(port, { capabilities: ["tree", "press", "logs"] }, handler);
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, lease, clientId: () => "schedule-daily", reloadWaitMs: 50 });
    const got = lease.acquire("schedule-daily", 45_000, false);
    if (!got.ok) throw new Error("refused");
    const answer = await tools.withCall(undefined, () => tools.tap({ target: { id: "open" }, look: false }), got.credential);
    expect(answer.isError).toBe(true);
    const text = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toMatch(/^Error lease_lost:/);
    expect(app.requests.filter((r) => r.method === "press")).toEqual([]);
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
  const call = async (
    runtime: Runtime,
    tool: string,
    body: Record<string, unknown>,
    client: string,
    token = runtime.config.token,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; answer?: ApiAnswer }> => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/${tool}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-agent-client": client, ...extra },
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
    expect(Object.keys(facts).sort()).toEqual(["accounts", "accountsHash", "instance", "maps", "mapsHash", "noPolicy", "policy", "policyHash", "version"]);
    expect(facts).toMatchObject({ version: 2, policy: null, noPolicy: false, accounts: null, policyHash: null, accountsHash: null });
    expect(String(facts["instance"])).toMatch(/^[0-9a-f]{32}$/);
    expect(String(facts["mapsHash"])).toMatch(/^[0-9a-f]{64}$/);
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
      expect(await asked("acquire", "schedule-a")).toMatchObject({ ok: true });
    } finally {
      app.ws.terminate();
    }
  });

  type Lease = Record<string, unknown>;
  const lease = async (runtime: Runtime, action: string, client: string, credential?: string): Promise<Lease> =>
    JSON.parse((await call(runtime, LEASE_TOOL, { action }, client, runtime.config.token, credential !== undefined ? { "x-tapline-lease": credential } : {})).answer?.text ?? "{}") as Lease;

  it("acquire answers a credential; renew and release need it, whatever the label; a second run is refused", async () => {
    const runtime = await start();
    const first = await lease(runtime, "acquire", "schedule-a");
    expect(first).toMatchObject({ ok: true });
    const credential = String(first["credential"]);
    expect(credential).toMatch(/^[0-9a-f]{64}$/);
    expect(await lease(runtime, "acquire", "schedule-b")).toEqual({ ok: false, by: "lease" });
    // the label alone is nothing: the same name without the credential can't renew, release or take it
    expect(await lease(runtime, "renew", "schedule-a")).toEqual({ ok: false, by: "lost" });
    expect(await lease(runtime, "release", "schedule-a")).toEqual({ ok: false });
    expect(await lease(runtime, "acquire", "schedule-a")).toEqual({ ok: false, by: "lease" });
    // a wrong credential: the first hex digit changed to a DIFFERENT one (replacing it with a fixed "e" was the same
    // credential 1 time in 16, a flake seen on CI)
    const wrong = (credential[0] === "e" ? "f" : "e") + credential.slice(1);
    expect(wrong).not.toBe(credential);
    expect(await lease(runtime, "renew", "schedule-b", wrong)).toEqual({ ok: false, by: "lost" });
    expect(await lease(runtime, "renew", "schedule-a", credential)).toEqual({ ok: true });
    expect(await lease(runtime, "release", "schedule-a", credential)).toEqual({ ok: true });
    expect(await lease(runtime, "acquire", "schedule-b")).toMatchObject({ ok: true });
  });

  it("the credential is in no answer but the first acquire, and in no fact", async () => {
    const runtime = await start();
    const credential = String((await lease(runtime, "acquire", "schedule-a"))["credential"]);
    const facts = (await call(runtime, HOST_FACTS_TOOL, {}, "schedule-a")).answer?.text ?? "";
    expect(facts).not.toContain(credential);
    expect(JSON.stringify(await lease(runtime, "renew", "schedule-a", credential))).not.toContain(credential);
  });

  it("the facts hash the policy and accounts as LOADED: a file edited afterwards leaves them as they were", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-facts-"));
    dirs.push(dir);
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({ version: 2, block: ["Archive"] }));
    const runtime = await start({ policy, maps: join(dir, "maps") });
    const read = async (): Promise<Record<string, unknown>> => JSON.parse((await call(runtime, HOST_FACTS_TOOL, {}, "x")).answer?.text ?? "{}") as Record<string, unknown>;
    const before = await read();
    expect(before["policyHash"]).toBe(hashFile(policy));
    writeFileSync(policy, JSON.stringify({ version: 2, block: ["Archive", "Delete"] }));
    const after = await read();
    expect(after["policyHash"]).toBe(before["policyHash"]);
    expect(after["policyHash"]).not.toBe(hashFile(policy));
  });

  it("a call that pins another instance id is refused and runs nothing; the right one, or none, goes through", async () => {
    const runtime = await start();
    const facts = JSON.parse((await call(runtime, HOST_FACTS_TOOL, {}, "x")).answer?.text ?? "{}") as { instance: string };
    const wrong = await call(runtime, "apps", {}, "x", runtime.config.token, { "x-tapline-instance": "ab".repeat(16) });
    expect(wrong.answer?.isError).toBe(true);
    expect(wrong.answer?.text).toMatch(/^Error wrong_host:/);
    expect((await call(runtime, HOST_FACTS_TOOL, {}, "x", runtime.config.token, { "x-tapline-instance": "ab".repeat(16) })).answer?.text).toMatch(/^Error wrong_host:/);
    expect((await call(runtime, LEASE_TOOL, { action: "acquire" }, "x", runtime.config.token, { "x-tapline-instance": "ab".repeat(16) })).answer?.text).toMatch(/^Error wrong_host:/);
    expect((await call(runtime, "apps", {}, "x", runtime.config.token, { "x-tapline-instance": facts.instance })).answer?.isError).not.toBe(true);
    expect((await call(runtime, "apps", {}, "x")).answer?.isError).not.toBe(true);
  });

  it("a call that carries an expired credential answers lease_lost over /api, with nothing held now", async () => {
    let at = 0;
    const runtime = await start({ clock: () => at });
    const credential = String((await lease(runtime, "acquire", "schedule-a"))["credential"]);
    at += 10 * 60_000;
    for (const tool of ["apps", "reload", "tap"]) {
      const answer = await call(runtime, tool, {}, "schedule-a", runtime.config.token, { "x-tapline-lease": credential });
      expect(answer.answer?.text, tool).toMatch(/^Error lease_lost:/);
    }
    // without a credential the same call is an ordinary one
    expect((await call(runtime, "apps", {}, "schedule-a")).answer?.text ?? "").not.toMatch(/lease_lost/);
  });

  describe("every mutating tool is behind the lease", () => {
    async function leased(): Promise<{ runtime: Runtime; app: FakeApp; sent: () => string[]; credential: string }> {
      const runtime = await start({ viewer: "off", leaseGiveUpMs: 150 });
      const OPEN = { ref: "e1", type: "Pressable", role: "button", testID: "open", text: "Open", frame: { x: 20, y: 100, width: 300, height: 44 }, actions: ["press"] };
      const handler = (req: IncomingRequest): Reply => {
        if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [OPEN], route: { names: ["home"] } } };
        return { ok: true, result: {} };
      };
      const { app } = await FakeApp.connect(runtime.port, { token: runtime.config.token, capabilities: ["tree", "press", "logs", "reload"] }, handler);
      const credential = String((await lease(runtime, "acquire", "schedule-a"))["credential"]);
      return { runtime, app, sent: () => app.requests.map((r) => r.method), credential };
    }

    it("another agent's reload answers busy and the app never gets it; the holder's reload (with the credential) is sent", async () => {
      const r = await leased();
      try {
        const blocked = await call(r.runtime, "reload", { look: false }, "agent-2");
        expect(blocked.answer?.text).toMatch(/^Error busy: A scheduled run is using the phone/);
        expect(r.sent()).not.toContain("reload");
        // a client that merely takes the holder's name is no holder
        const spoof = await call(r.runtime, "reload", { look: false }, "schedule-a");
        expect(spoof.answer?.text).toMatch(/^Error busy: A scheduled run is using the phone/);
        expect(r.sent()).not.toContain("reload");
        await call(r.runtime, "reload", { look: false }, "schedule-a", r.runtime.config.token, { "x-tapline-lease": r.credential });
        expect(r.sent()).toContain("reload");
      } finally {
        r.app.ws.terminate();
      }
    });

    it("every tool that isn't read-only is held back for another client, and the read-only ones are not", async () => {
      const r = await leased();
      try {
        for (const tool of ["open_url", "app_command", "back", "media", "map", "record", "replay", "journey", "performance", "filmstrip", "pair", "open_app"]) {
          const blocked = await call(r.runtime, tool, {}, "agent-2");
          expect(blocked.answer?.text, tool).toMatch(/^Error busy: A scheduled run is using the phone/);
        }
        for (const tool of ["apps", "logs", "session_report", "wait"]) {
          const free = await call(r.runtime, tool, tool === "wait" ? { seconds: 0 } : {}, "agent-2");
          expect(free.answer?.text ?? "", tool).not.toMatch(/Error busy: A scheduled run/);
        }
      } finally {
        r.app.ws.terminate();
      }
    });
  });
});
