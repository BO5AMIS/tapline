import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActionLog, loggedTarget } from "../src/actionlog.js";
import { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.8 §12: the action log, one JSON line per action, typed text never in it.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const PASSWORD = { ref: "e4", type: "TextInput", role: "textfield", testID: "password", label: "Password", text: "", value: "•••", frame: null, actions: ["type"] };

function lines(dir: string): Array<Record<string, unknown>> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}

async function setup(handler: (req: IncomingRequest) => Reply) {
  const dir = mkdtempSync(join(tmpdir(), "tapline-log-"));
  dirs.push(dir);
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { dir, tools: new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir: dir }) };
}

describe("the action log", () => {
  it("writes one line per action with the shared fields; typed text only as its length", async () => {
    const { dir, tools } = await setup((req) => {
      if (req.method === "press") return { ok: true, result: { element: SAVE } };
      if (req.method === "type") return { ok: true, result: { element: PASSWORD, value: "•••", secure: true } };
      if (req.method === "tree") return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [SAVE] } };
      return { ok: true, result: {} };
    });
    await tools.typeText({ target: { id: "password" }, text: "hunter2", look: false });
    await tools.tap({ target: { id: "save" }, look: false });
    const log = lines(dir);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ source: "tapline", by: "agent", tool: "type_text", target: { id: "password" }, chars: 7, ok: true, app: "com.example.demo" });
    expect(log[1]).toMatchObject({ tool: "tap", element: 'button "Save" id=save @24,610 354x48', ok: true });
    expect(typeof log[1]?.["ms"]).toBe("number");
    expect(String(log[0]?.["t"])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(readdirSync(dir).join("\n")).not.toContain("hunter2");
    expect(readFileSync(join(dir, readdirSync(dir)[0] ?? ""), "utf8")).not.toContain("hunter2");
  });

  it("logs a refusal with its code and reason, and a batch's steps with the batch id and step", async () => {
    const { dir, tools } = await setup((req) => {
      if (req.method === "press") return { ok: false, error: { code: "not_actionable", message: "covered: e3 button is covered" } };
      if (req.method === "tree") return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [SAVE] } };
      return { ok: true, result: {} };
    });
    await tools.run({ steps: [{ tool: "back" }, { tool: "tap", target: { id: "save" } }], look: false });
    const log = lines(dir);
    expect(log.map((l) => l["tool"])).toEqual(["back", "tap"]);
    expect(log[1]).toMatchObject({ ok: false, code: "not_actionable", reason: "covered", batch: { step: 2 } });
    expect((log[0]?.["batch"] as { id: string }).id).toBe((log[1]?.["batch"] as { id: string }).id);
  });

  it("keeps 14 days: older files are deleted when the log opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-log-old-"));
    dirs.push(dir);
    const old = join(dir, "actions-2026-10-01.jsonl");
    const recent = join(dir, "actions-2026-11-10.jsonl");
    writeFileSync(old, "{}\n");
    writeFileSync(recent, "{}\n");
    const now = new Date("2026-11-12T00:00:00Z");
    utimesSync(old, new Date("2026-10-01"), new Date("2026-10-01"));
    utimesSync(recent, new Date("2026-11-10"), new Date("2026-11-10"));
    new ActionLog(dir, () => now).open();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("keeps the target as given and only the length of text", () => {
    expect(loggedTarget({ target: { id: "a" }, text: "héllo", replace: true })).toEqual({ target: { id: "a" }, chars: 5 });
    expect(loggedTarget({ target: { testID: "save", index: 1 } })).toEqual({ target: { id: "save", index: 1 } });
    expect(loggedTarget(undefined)).toEqual({});
  });
});

describe("the action-log backstop leaves the structural fields alone (PR 12 review)", () => {
  it("a vault value equal to agent, chat or call doesn't turn by, confirmed_by or via into a placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-log-"));
    dirs.push(dir);
    const log = new ActionLog(dir);
    log.open();
    const swap = (value: unknown): unknown => {
      if (typeof value === "string") return value === "agent" || value === "chat" || value === "call" || value === "fast" ? "<vault>" : value;
      if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
      return value;
    };
    log.setBackstop(swap);
    log.write({ by: "agent", tool: "tap", ok: true, confirmed_by: "chat", via: "call", animations: "fast", reason: "agent" });
    const [entry] = lines(dir);
    expect(entry).toMatchObject({ by: "agent", confirmed_by: "chat", via: "call", animations: "fast", reason: "<vault>" });
  });
});
