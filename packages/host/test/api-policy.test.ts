import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiAnswer } from "../src/api.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "../src/runtime.js";
import { FakeApp, type IncomingRequest, type Reply } from "./helpers.js";

// Policy and confirmation stay in the host: a thin call goes through the same TaplineTools path as MCP
// (AGENT-TOOLS 1.13 §18.10, plan rule 5).

const runtimes: Runtime[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete", frame: { x: 115, y: 620, width: 200, height: 40 }, actions: ["press"] };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const CLOSE = { ref: "e14", type: "Pressable", role: "button", testID: "close", text: "Close account", frame: { x: 24, y: 700, width: 200, height: 40 }, actions: ["press"] };
const TREE = { screen: { width: 430, height: 932 }, elements: [SAVE, DELETE, CLOSE] };

function handler(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: TREE };
  if (req.method === "press") {
    const target = (req.params as { target?: { testID?: string; text?: string } }).target;
    const hit = TREE.elements.find((e) => e.testID === target?.testID || e.text === target?.text);
    return { ok: true, result: { element: hit ?? SAVE } };
  }
  return { ok: true, result: {} };
}

async function standalone(options: Partial<RuntimeOptions> = {}): Promise<{ runtime: Runtime; app: FakeApp }> {
  const home = mkdtempSync(join(tmpdir(), "tapline-apipol-"));
  dirs.push(home);
  const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: home }, log: () => undefined, api: true, ...options });
  runtimes.push(runtime);
  const { app } = await FakeApp.connect(runtime.port, { token: runtime.config.token }, handler);
  apps.push(app);
  return { runtime, app };
}

async function call(runtime: Runtime, tool: string, args: unknown, client = "agent-a"): Promise<ApiAnswer> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/api/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.config.token}`, "x-agent-client": client },
    body: JSON.stringify(args),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ApiAnswer;
}

const presses = (app: FakeApp): number => app.requests.filter((r) => r.method === "press").length;

describe("policy over POST /api/<tool>", () => {
  it("the default policy: a Delete button answers needs_confirmation and nothing is pressed", async () => {
    const { runtime, app } = await standalone();
    const answer = await call(runtime, "tap", { target: { text: "Delete" }, look: false });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(answer.text).toContain('"Delete"');
    expect(presses(app)).toBe(0);
    // asking again is still held, never a way round
    const again = await call(runtime, "tap", { target: { text: "Delete" }, look: false });
    expect(again.text).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(presses(app)).toBe(0);
  });

  it("the default policy lets an ordinary button through", async () => {
    const { runtime, app } = await standalone();
    const answer = await call(runtime, "tap", { target: { id: "save" }, look: false });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("Tapped");
    expect(presses(app)).toBe(1);
  });

  it("a blocked word is refused outright", async () => {
    const home = mkdtempSync(join(tmpdir(), "tapline-apipol-file-"));
    dirs.push(home);
    const file = join(home, "policy.json");
    writeFileSync(file, JSON.stringify({ version: 1, confirm: [], block: ["Close account"] }));
    const { runtime, app } = await standalone({ policy: file });
    const answer = await call(runtime, "tap", { target: { text: "Close account" }, look: false });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^Error not_allowed: blocked: /);
    expect(presses(app)).toBe(0);
  });

  it("run steps go through the same checks", async () => {
    const { runtime, app } = await standalone();
    const answer = await call(runtime, "run", { steps: [{ tool: "tap", target: { text: "Delete" } }] });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("needs_confirmation");
    expect(presses(app)).toBe(0);
  });

  it("--no-policy at host start lifts it (the person's choice, made at start, not per call)", async () => {
    const { runtime, app } = await standalone({ noPolicy: true });
    const answer = await call(runtime, "tap", { target: { text: "Delete" }, look: false });
    expect(answer.isError).toBe(false);
    expect(presses(app)).toBe(1);
  });

  it("an OK a person gave for one client's call is not spent by another client", async () => {
    const { runtime, app } = await standalone();
    // Agent A asks; the live viewer's person allows it.
    const first = await call(runtime, "tap", { target: { text: "Delete" }, look: false }, "agent-a");
    expect(first.text).toMatch(/needs_confirmation/);
    const open = runtime.confirmations.open();
    expect(open).toHaveLength(1);
    const request = open[0];
    expect(request).toBeDefined();
    runtime.confirmations.answer(request?.id ?? "", true);
    // Agent B calls first: it gets its own question, not A's OK.
    const other = await call(runtime, "tap", { target: { text: "Delete" }, look: false }, "agent-b");
    expect(other.text).toMatch(/needs_confirmation/);
    expect(presses(app)).toBe(0);
    // Agent A repeats its call and uses its own OK.
    const mine = await call(runtime, "tap", { target: { text: "Delete" }, look: false }, "agent-a");
    expect(mine.isError).toBe(false);
    expect(presses(app)).toBe(1);
  });
});
