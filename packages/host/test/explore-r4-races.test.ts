import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// PR 13 CodeRabbit (R4 item 7): start-up races. Explore and record, replay and journey exclude each other in every order, also while
// one of them is paused in the middle of starting.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => {
  const scriptsDir = mkdtempSync(join(tmpdir(), "tapline-r4-scripts-"));
  dirs.push(scriptsDir);
  return setupExplore(hosts, apps, dirs, { ...options, tools: { scriptsDir, ...options.tools } });
};
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

/** Answers every held request of a method with `result` and stops holding it. */
function release(s: ExploreSetup, method: string, result: unknown): void {
  s.world.hold.delete(method);
  for (const request of s.world.held.splice(0)) {
    if (request.method === method) s.current().send({ type: "response", id: request.id, ok: true, result });
  }
}

describe("R4 item 7: record and replay hold their exclusion from their very first step", () => {
  it("explore is refused while a route recording waits for the app's place; a second recording is too", async () => {
    const s = await setup();
    s.world.hold.add("place");
    const first = s.tools.record({ start: true, route: "sign_in" });
    await until(() => s.world.held.length > 0);
    const explore = textOf(await s.tools.explore({ steps: 1, fill: "none" }));
    expect(explore).toMatch(/can't run while a script is recorded or replayed/);
    expect(textOf(await s.tools.record({ start: true, name: "other" }))).toMatch(/already recording/);
    release(s, "place", { route: ["home"], seenAt: Date.now() });
    expect(textOf(await first)).toMatch(/Recording route "sign_in"/);
    await s.tools.record({ action: "discard" });
  });

  it("a recording that fails to find the place releases its hold", async () => {
    const s = await setup();
    s.world.hold.add("place");
    const first = s.tools.record({ start: true, route: "sign_in" });
    await until(() => s.world.held.some((r) => r.method === "place"));
    s.world.hold.delete("place");
    for (const request of s.world.held.splice(0)) s.current().send({ type: "response", id: request.id, ok: false, error: { code: "internal", message: "no place" } });
    expect(textOf(await first)).toMatch(/Error/);
    const again = await s.tools.record({ start: true, name: "plain" });
    expect(again.isError).not.toBe(true);
    await s.tools.record({ action: "discard" });
  });

  it("explore is refused while a replay waits for its fresh start", async () => {
    const scriptsDir = mkdtempSync(join(tmpdir(), "tapline-r4-race-"));
    dirs.push(scriptsDir);
    const s = await setup({ tools: { scriptsDir } });
    writeFileSync(
      join(scriptsDir, "x.json"),
      JSON.stringify({ format: "agent-tools-script", version: 1, name: "x", app: APP.id, steps: [{ tool: "tap", target: { id: "open-settings" } }] }),
    );
    s.world.hold.add("reload");
    const replay = s.tools.replay({ name: "x" });
    await until(() => s.world.held.length > 0);
    const explore = textOf(await s.tools.explore({ steps: 1, fill: "none" }));
    expect(explore).toMatch(/can't run while a script is recorded or replayed/);
    s.world.hold.delete("reload");
    for (const request of s.world.held.splice(0)) s.current().send({ type: "response", id: request.id, ok: false, error: { code: "unsupported", message: "no reload here" } });
    await replay;
    // The hold is gone with the replay: explore starts now.
    expect(textOf(await s.tools.explore({ steps: 1, fill: "none" }))).not.toMatch(/can't run while/);
  });
});

describe("R4 item 7: explore holds its exclusion from its very first step", () => {
  it("record, replay and a journey are refused while explore waits for its first screen, and a second explore answers busy", async () => {
    const scriptsDir = mkdtempSync(join(tmpdir(), "tapline-r4-race-"));
    dirs.push(scriptsDir);
    const s = await setup({ tools: { scriptsDir } });
    writeFileSync(join(scriptsDir, "x.json"), JSON.stringify({ format: "agent-tools-script", version: 1, name: "x", app: APP.id, steps: [] }));
    s.world.hold.add("tree");
    const running = s.tools.explore({ steps: 3, fill: "none" });
    await until(() => s.world.held.length > 0);
    expect(textOf(await s.tools.record({ start: true, name: "a" }))).toMatch(/explore is running/);
    expect(textOf(await s.tools.record({ start: true, route: "r" }))).toMatch(/explore is running/);
    expect(textOf(await s.tools.replay({ name: "x" }))).toMatch(/explore is running/);
    expect(textOf(await s.tools.journey({ start: true, goal: "go" }))).toMatch(/explore is running/);
    expect(textOf(await s.tools.explore({ steps: 1 }))).toMatch(/already running/);
    s.world.hold.delete("tree");
    for (const request of s.world.held.splice(0)) s.current().send({ type: "response", id: request.id, ok: false, error: { code: "not_found", message: "no screen" } });
    await running;
    expect((await s.tools.record({ start: true, name: "a" })).isError).not.toBe(true);
    await s.tools.record({ action: "discard" });
  });
});
