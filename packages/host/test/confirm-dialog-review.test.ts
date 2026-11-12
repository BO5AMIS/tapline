import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Confirmations, type ConfirmEvent } from "../src/confirm.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitAnswer, type ElicitClient } from "../src/elicit.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { RUN_TIMEOUT_MS } from "../src/run.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// The security review of the host's dialog (1.6 task 8 follow-ups): isolation, cancel, no dialog, per-call waits.

const hosts: TaplineHost[] = [];
const runtimes: Runtime[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const pause = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDialogClient implements ElicitClient {
  readonly shown: Array<{ message: string; signal: AbortSignal }> = [];
  failing = false;
  private readonly open: Array<(answer: ElicitAnswer) => void> = [];
  canShowForm(): boolean {
    return true;
  }
  elicit(message: string, _schema: unknown, signal: AbortSignal): Promise<ElicitAnswer> {
    this.shown.push({ message, signal });
    if (this.failing) return Promise.reject(new Error("method not found"));
    return new Promise<ElicitAnswer>((resolve, reject) => {
      this.open.push(resolve);
      signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
    });
  }
  async shownCount(count: number): Promise<void> {
    for (let i = 0; i < 400 && this.shown.length < count; i++) await pause(5);
    expect(this.shown.length).toBeGreaterThanOrEqual(count);
  }
  allow(): void {
    this.open.shift()?.({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } });
  }
  decline(): void {
    this.open.shift()?.({ action: "decline" });
  }
}

const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame: { x: 115, y: 620, width: 200, height: 40 }, actions: ["press"] };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const ELEMENTS = [SAVE, DELETE];

function handler(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: { screen: { width: 430, height: 932 }, elements: ELEMENTS } };
  if (req.method === "press") {
    const target = (req.params as { target?: { testID?: string; text?: string } }).target;
    const element = ELEMENTS.find((e) => e.testID === target?.testID || e.text === target?.text);
    if (element === undefined) return { ok: false, error: { code: "not_found", message: "No element matches" } };
    return { ok: true, result: { element, point: { x: 1, y: 1 } } };
  }
  if (req.method === "perfStart") return { ok: true, result: { started: true, id: 1, dev: true, heap: true } };
  if (req.method === "perfStop") return { ok: true, result: { seconds: 0.1, frames: 6, fps: 60, fpsLowest: 60, drops: 0, busyMs: 10, heapMb: 10, heapPeakMb: 10, renders: [] } };
  return { ok: true, result: {} };
}

async function rig(options: { confirmations?: Confirmations; capabilities?: string[] } = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, options.capabilities ? { capabilities: options.capabilities } : {}, handler);
  apps.push(app);
  const confirmations = options.confirmations ?? new Confirmations();
  const client = new FakeDialogClient();
  const events: ConfirmEvent[] = [];
  confirmations.onEvent((e) => events.push(e));
  const make = (clientId: string, dialogs: Dialogs | undefined): TaplineTools =>
    new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, confirmations, clientId: () => clientId, ...(dialogs !== undefined ? { dialogs } : {}) });
  return { app, client, confirmations, events, make };
}

const presses = (app: FakeApp): number => app.requests.filter((r) => r.method === "press" && (r.params as { dryRun?: boolean } | undefined)?.dryRun !== true).length;
const tapDelete = { target: { id: "delete-trip" }, look: false } as const;

describe("the dialog's own client keeps a thin call out (review, medium)", () => {
  async function standalone() {
    const home = mkdtempSync(join(tmpdir(), "tapline-okiso-"));
    dirs.push(home);
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: home }, log: () => undefined, api: true });
    runtimes.push(runtime);
    const { app } = await FakeApp.connect(runtime.port, { token: runtime.config.token }, handler);
    apps.push(app);
    return { runtime, app };
  }
  const thin = async (runtime: Runtime, client?: string): Promise<{ text: string; isError: boolean }> => {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/api/tap`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.config.token}`, ...(client !== undefined ? { "x-agent-client": client } : {}) },
      body: JSON.stringify(tapDelete),
    });
    return (await res.json()) as { text: string; isError: boolean };
  };

  it("a thin call with no client id can't open the MCP dialog or use its grant", async () => {
    const { runtime, app } = await standalone();
    const dialog = new FakeDialogClient();
    const mcp = runtime.toolsFor(undefined);
    mcp.setDialogs(new Dialogs(dialog));
    const events: ConfirmEvent[] = [];
    runtime.confirmations.onEvent((e) => events.push(e));
    // the MCP server's own call asks in the dialog, and its person allows
    const own = mcp.tap(tapDelete);
    await dialog.shownCount(1);
    // while it waits, a thin call without a client id opens no dialog of its own
    const during = await thin(runtime);
    expect(during.text).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(dialog.shown).toHaveLength(1);
    dialog.allow();
    expect(textOf(await own)).toMatch(/allowed by a person \(in chat\)/);
    expect(presses(app)).toBe(1);
    // an OK the live view gave for the MCP server's next call is not the thin call's to use
    mcp.setDialogs(undefined);
    await mcp.tap(tapDelete);
    const request = [...events].reverse().find((e) => e.type === "confirm");
    if (request?.type !== "confirm") throw new Error("no request");
    runtime.confirmations.answer(request.id, true);
    for (const client of [undefined, "anonymous", ""]) {
      const stolen = await thin(runtime, client);
      expect(stolen.text).toMatch(/needs_confirmation/);
    }
    expect(presses(app)).toBe(1);
    expect(textOf(await mcp.tap(tapDelete))).toMatch(/allowed by a person \(in the live view\)/);
    expect(presses(app)).toBe(2);
  });
});

describe("two clients' OKs (the client is part of the key)", () => {
  it("an OK given for one client's call is not the other's, with dialogs", async () => {
    const { app, client, make } = await rig();
    const dialogs = new Dialogs(client);
    const a = make("agent-a", dialogs);
    const b = make("agent-b", dialogs);
    const first = a.tap(tapDelete);
    await client.shownCount(1);
    client.allow();
    expect(textOf(await first)).toMatch(/in chat/);
    const second = b.tap(tapDelete);
    await client.shownCount(2);
    expect(presses(app)).toBe(1);
    client.decline();
    expect(textOf(await second)).toMatch(/They declined\./);
    expect(presses(app)).toBe(1);
  });

  it("a live-view OK for one client is not used up by the other", async () => {
    const { app, confirmations, events, make } = await rig();
    const a = make("agent-a", undefined);
    const b = make("agent-b", undefined);
    await a.tap(tapDelete);
    const asked = events.find((e) => e.type === "confirm");
    if (asked?.type !== "confirm") throw new Error("no request");
    confirmations.answer(asked.id, true);
    expect(textOf(await b.tap(tapDelete))).toMatch(/needs_confirmation/);
    expect(presses(app)).toBe(0);
    expect(textOf(await a.tap(tapDelete))).toMatch(/Tapped/);
    expect(presses(app)).toBe(1);
  });
});

describe("answers in the same tick", () => {
  it("the dialog and the live view answering together touch once", async () => {
    const { app, client, confirmations, events, make } = await rig();
    const tools = make("agent-a", new Dialogs(client));
    const call = tools.tap(tapDelete);
    await client.shownCount(1);
    const asked = events.find((e) => e.type === "confirm");
    if (asked?.type !== "confirm") throw new Error("no request");
    confirmations.answer(asked.id, true);
    client.allow();
    expect(textOf(await call)).toMatch(/^Tapped .*\nNote: allowed by a person \(in the live view\)\.$/);
    await pause(20);
    expect(presses(app)).toBe(1);
    // and nothing is left over for a later call
    const next = tools.tap(tapDelete);
    await client.shownCount(2);
    client.decline();
    await next;
    expect(presses(app)).toBe(1);
  });
});

describe("a client with no dialog (review, low)", () => {
  it("an error before any answer falls back to the live view: no declined, no 60 s hold", async () => {
    const { app, client, make } = await rig();
    client.failing = true;
    const tools = make("agent-a", new Dialogs(client));
    const first = await tools.tap(tapDelete);
    expect(textOf(first)).toBe(
      `Error not_allowed: needs_confirmation: button "Delete trip" needs a person's OK (policy word "Delete"). The live view asks them now; when they allow it, make the same call again. If nobody is watching, ask your user.`,
    );
    const second = await tools.tap(tapDelete);
    expect(textOf(second)).not.toMatch(/declined/);
    expect(presses(app)).toBe(0);
  });
});

describe("a cancelled call (review, low)", () => {
  it("closes the dialog and the request and never touches", async () => {
    const { app, client, events, make } = await rig();
    const tools = make("agent-a", new Dialogs(client));
    const stop = new AbortController();
    const call = tools.withCall(stop.signal, () => tools.tap(tapDelete));
    await client.shownCount(1);
    stop.abort();
    const answer = await call;
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/cancelled/);
    expect(client.shown[0]?.signal.aborted).toBe(true);
    expect(events.some((e) => e.type === "confirm_closed")).toBe(true);
    // a late allow changes nothing
    client.allow();
    await pause(20);
    expect(presses(app)).toBe(0);
  });

  it("a call already cancelled opens no dialog", async () => {
    const { client, make } = await rig();
    const tools = make("agent-a", new Dialogs(client));
    const stop = new AbortController();
    stop.abort();
    const answer = await tools.withCall(stop.signal, () => tools.tap(tapDelete));
    expect(textOf(answer)).toMatch(/cancelled/);
    expect(client.shown).toHaveLength(0);
  });
});

describe("the wait is counted per call (review, low)", () => {
  it("one call's wait doesn't lengthen another batch's 120 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, client, make } = await rig({ confirmations: new Confirmations(() => 0) });
    const tools = make("agent-a", new Dialogs(client));
    const waiting = tools.withCall(undefined, () => tools.tap(tapDelete));
    await client.shownCount(1);
    // another call: a batch with a pause in the middle, during which the first one's wait ends 121 s later
    const batch = tools.withCall(undefined, () => tools.run({ steps: [{ tool: "wait", seconds: 0.1 }, { tool: "tap", target: { id: "save" }, look: false }] } as never));
    await pause(20);
    vi.setSystemTime(Date.now() + RUN_TIMEOUT_MS + 1000);
    client.allow();
    expect(textOf(await waiting)).toMatch(/in chat/);
    const out = await batch;
    expect(textOf(out)).toMatch(/ran longer than 120 s/);
    expect(presses(app)).toBe(1);
  });
});

describe("filmstrip and performance with a dialog", () => {
  it("filmstrip with a tap waits for the dialog and taps after the allow", async () => {
    const { app, client, make } = await rig({ capabilities: ["tree", "press", "screenshot", "dryRun"] });
    const tools = make("agent-a", new Dialogs(client));
    const call = tools.filmstrip({ tap: { id: "delete-trip" }, frames: 1 });
    await client.shownCount(1);
    expect(client.shown[0]?.message).toBe('Allow: tap "Delete trip" in Demo? (policy word "Delete")');
    expect(presses(app)).toBe(0);
    client.allow();
    const answer = await call;
    // The fake app sends no real picture, so the strip itself may fail; what matters is that the gate let it through
    // and the "before" frame was asked for (the press follows it).
    expect(textOf(answer)).not.toMatch(/needs_confirmation/);
    expect(app.requests.filter((r) => r.method === "screenshot").length).toBeGreaterThan(0);
  });

  it("filmstrip with a declined dialog touches nothing", async () => {
    const { app, client, make } = await rig({ capabilities: ["tree", "press", "screenshot", "dryRun"] });
    const tools = make("agent-a", new Dialogs(client));
    const call = tools.filmstrip({ tap: { id: "delete-trip" }, frames: 1 });
    await client.shownCount(1);
    client.decline();
    expect(textOf(await call)).toMatch(/needs_confirmation: .*They declined\. Ask your user what to do\.$/);
    expect(presses(app)).toBe(0);
  });

  it("performance with a tap waits for the dialog and taps after the allow", async () => {
    const { app, client, make } = await rig({ capabilities: ["tree", "press", "perf", "dryRun"] });
    const tools = make("agent-a", new Dialogs(client));
    const call = tools.performance({ tap: { id: "delete-trip" }, seconds: 0.1 });
    await client.shownCount(1);
    expect(presses(app)).toBe(0);
    client.allow();
    await call;
    expect(presses(app)).toBe(1);
  });

  it("performance with a declined dialog measures and touches nothing", async () => {
    const { app, client, make } = await rig({ capabilities: ["tree", "press", "perf", "dryRun"] });
    const tools = make("agent-a", new Dialogs(client));
    const call = tools.performance({ tap: { id: "delete-trip" }, seconds: 0.1 });
    await client.shownCount(1);
    client.decline();
    expect(textOf(await call)).toMatch(/needs_confirmation/);
    expect(presses(app)).toBe(0);
    expect(app.requests.filter((r) => r.method === "perfStart")).toHaveLength(0);
  });
});
