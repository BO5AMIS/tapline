import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import { DEFAULT_CONFIRM, loadPolicy } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// The fixes from the 1.1 review: the policy fails closed and covers swipe and filmstrip; the log holds no
// typed text; a confirmed mark never leaks to the next action; init stays inside the project.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame: { x: 0, y: 600, width: 200, height: 40 }, actions: ["press"] };
const EMAIL = { ref: "e4", type: "TextInput", role: "textfield", testID: "email", label: "Email", text: "", value: "me@example.com", frame: { x: 0, y: 100, width: 300, height: 44 }, actions: ["press", "type"] };

async function setup(handler: (req: IncomingRequest) => Reply, logDir?: string) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, ...(logDir !== undefined ? { logDir } : {}) });
  return { app, tools };
}

describe("the policy after the review", () => {
  it("fails closed: when the check can't be made, nothing is touched", async () => {
    const { app, tools } = await setup((req) => {
      const dry = (req.params as { dryRun?: boolean }).dryRun === true;
      if (req.method === "press" && dry) return { ok: false, error: { code: "timeout", message: "the app took too long" } };
      if (req.method === "press") return { ok: true, result: { element: DELETE } };
      return { ok: true, result: {} };
    });
    const answer = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(answer)).toMatch(/^Error timeout: /);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
  });

  it("guards a swipe that starts on a policy word, and filmstrip's tap", async () => {
    const { app, tools } = await setup((req) => {
      if (req.method === "swipe") return { ok: true, result: { element: DELETE, from: { x: 10, y: 610 }, to: { x: 12, y: 610 } } };
      if (req.method === "press") return { ok: true, result: { element: DELETE } };
      if (req.method === "screenshot") return { ok: true, result: { mime: "image/jpeg", data: "" } };
      return { ok: true, result: {} };
    });
    const swiped = await tools.swipe({ x0: 10, y0: 610, x1: 12, y1: 610, look: false });
    expect(textOf(swiped)).toMatch(/^Error not_allowed: needs_confirmation: button "Delete trip"/);
    expect(app.requests.filter((r) => r.method === "swipe")).toHaveLength(0);
    const filmed = await tools.filmstrip({ tap: { id: "delete-trip" } });
    expect(textOf(filmed)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
  });

  it("a policy file with only block words keeps the built-in confirm words", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-pol-"));
    dirs.push(dir);
    const file = join(dir, "p.json");
    writeFileSync(file, JSON.stringify({ version: 1, block: ["Erase"] }));
    expect(loadPolicy(file).confirm).toEqual(DEFAULT_CONFIRM);
    writeFileSync(file, JSON.stringify({ version: 1, confirm: [], block: ["Erase"] }));
    expect(loadPolicy(file).confirm).toEqual([]);
  });
});

describe("the action log after the review", () => {
  it("never holds typed text, not even as the field's value; a confirmed mark doesn't leak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-log2-"));
    dirs.push(dir);
    const { tools } = await setup((req) => {
      if (req.method === "type") return { ok: true, result: { element: EMAIL, value: "me@example.com" } };
      if (req.method === "toggle") return { ok: true, result: { element: { ...EMAIL, role: "switch", testID: "remind", text: "Remind" }, value: true, unchanged: true } };
      return { ok: true, result: {} };
    }, dir);
    await tools.typeText({ target: { id: "email" }, text: "me@example.com", look: false });
    const log = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(log).not.toContain("me@example.com");
    expect(log).toContain('"chars":14');
  });
});

describe("tapline init after the review", () => {
  function project(pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "tapline-init2-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  }

  it("never edits a main that climbs out of the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "tapline-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "x.js"), "console.log('mine');\n");
    const dir = project({ main: `../${outside.split(/[\\/]/).pop() ?? ""}/x.js`, dependencies: { expo: "57.0.0", "react-native": "0.86.0" } });
    const result = runInit({ project: dir, install: false });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(outside, "x.js"), "utf8")).toBe("console.log('mine');\n");
  });

  it("leaves main alone when an index.js exists that isn't Expo Router's entry", () => {
    const dir = project(
      { main: "expo-router/entry", dependencies: { expo: "57.0.0", "expo-router": "6.0.0", "react-native": "0.86.0" } },
      { "index.js": "module.exports = { helper: true };\n", "app/_layout.tsx": "export default function L() { return null; }\n" },
    );
    runInit({ project: dir, install: false });
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).main).toBe("expo-router/entry");
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe("module.exports = { helper: true };\n");
  });
});
