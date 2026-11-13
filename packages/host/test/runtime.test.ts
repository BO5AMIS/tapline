import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiAnswer } from "../src/api.js";
import { CLIENT_IDLE_MS, createRuntime, type Runtime, type RuntimeOptions } from "../src/runtime.js";

// The wiring runMcp had, reusable by a standalone host (AGENT-TOOLS 1.13 §18.10).

const runtimes: Runtime[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function start(options: Partial<RuntimeOptions> = {}): Promise<Runtime> {
  const home = mkdtempSync(join(tmpdir(), "tapline-runtime-"));
  dirs.push(home);
  const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, ...options });
  runtimes.push(runtime);
  return runtime;
}

describe("createRuntime", () => {
  it("toolsFor(undefined) is the same object each time; ids differ from each other", async () => {
    const runtime = await start();
    expect(runtime.toolsFor(undefined)).toBe(runtime.toolsFor(undefined));
    expect(runtime.toolsFor("a")).toBe(runtime.toolsFor("a"));
    expect(runtime.toolsFor("a")).not.toBe(runtime.toolsFor("b"));
    expect(runtime.toolsFor("a")).not.toBe(runtime.toolsFor(undefined));
  });

  it("an idle client is dropped after 30 minutes", async () => {
    let now = 1_000_000;
    const runtime = await start({ clock: () => now });
    const first = runtime.toolsFor("a");
    now += CLIENT_IDLE_MS - 1000;
    expect(runtime.toolsFor("a")).toBe(first);
    now += CLIENT_IDLE_MS - 1000; // idle is counted from the last call
    expect(runtime.toolsFor("a")).toBe(first);
    now += CLIENT_IDLE_MS + 1000;
    expect(runtime.toolsFor("a")).not.toBe(first);
  });

  it("serves the thin call only when asked to", async () => {
    const mcp = await start();
    const standalone = await start({ api: true });
    const token = standalone.config.token;
    const refused = await fetch(`http://127.0.0.1:${mcp.port}/api/apps`, { method: "POST", headers: { authorization: `Bearer ${mcp.config.token}` }, body: "{}" });
    expect(refused.status).toBe(404);
    const served = await fetch(`http://127.0.0.1:${standalone.port}/api/apps`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(served.status).toBe(200);
    expect(((await served.json()) as ApiAnswer).isError).toBe(false);
  });

  it("a standalone host serves the live viewer, so a confirmation can be answered", async () => {
    const standalone = await start({ api: true });
    const viewer = standalone.viewerLinks[0];
    expect(viewer).toBeDefined();
    const page = await fetch(viewer ?? "");
    expect(page.status).toBe(200);
  });

  it("--viewer off serves no viewer", async () => {
    const standalone = await start({ api: true, viewer: "off" });
    const page = await fetch(`http://127.0.0.1:${standalone.port}/viewer`);
    expect(page.status).toBe(426);
  });

  it("a bad option rejects with a plain message", async () => {
    await expect(start({ viewer: "sideways" })).rejects.toThrow(/Unknown viewer mode/);
  });
});
