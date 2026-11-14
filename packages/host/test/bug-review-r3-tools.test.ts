import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { flushExploreMaps, setupExplore, type ExWorld, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import { FakeApp } from "./helpers.js";

// PR 14, Codex cycle 2 (R3), the tool-level cases. Every value is made up.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

interface Rig {
  s: ExploreSetup;
  bugsDir: string;
}

function broken(w: ExWorld): void {
  w.errorOn["open-form"] = "TypeError: form failed";
  w.known = [{ route: ["home"] }, { route: ["settings"] }, { route: ["trips"] }, { route: ["form"] }];
}

async function rig(options: ExploreSetupOptions = {}): Promise<Rig> {
  const bugsDir = tmp("tapline-r3t-bugs-");
  const s = await setupExplore(hosts, apps, dirs, {
    ...options,
    world: (w) => {
      broken(w);
      options.world?.(w);
    },
    tools: { bugsDir, logDir: tmp("tapline-r3t-log-"), journeysDir: tmp("tapline-r3t-j-"), ...options.tools },
  });
  return { s, bugsDir };
}

async function makeJsBug(r: Rig): Promise<string> {
  await r.s.tools.explore({});
  const appDir = join(r.s.exploreDir, APP.id);
  const run = join(appDir, readdirSync(appDir).sort().at(-1) as string);
  const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8")) as { findings: Array<{ id: string; kind: string }> };
  const f = report.findings.find((x) => x.kind === "js_error")?.id as string;
  const answer = textOf(await r.s.tools.bugReport({ finding: f, verify: false }));
  return /bug_[0-9a-f]{16}(?:_\d+)?/.exec(answer)?.[0] as string;
}

describe("R3-link: a run's findings folder that links outside gives no picture, now or later", () => {
  it("with_picture on a kept bug reads nothing through the link, and a zip export holds no such bytes", async () => {
    const r = await rig();
    await r.s.tools.explore({});
    const appDir = join(r.s.exploreDir, APP.id);
    const run = join(appDir, readdirSync(appDir).sort().at(-1) as string);
    const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8")) as { findings: Array<{ id: string; kind: string }> };
    const f = report.findings.find((x) => x.kind === "js_error")?.id as string;
    const outside = tmp("tapline-r3t-outside-");
    renameSync(join(run, "findings"), join(outside, "findings"));
    symlinkSync(join(outside, "findings"), join(run, "findings"), "junction");
    const first = textOf(await r.s.tools.bugReport({ finding: f, verify: false }));
    const id = /bug_[0-9a-f]{16}(?:_\d+)?/.exec(first)?.[0] as string;
    const dir = join(r.bugsDir, APP.id, id);
    expect(existsSync(join(dir, "picture.jpg"))).toBe(false);
    const later = textOf(await r.s.tools.bugReport({ bug: id, with_picture: true }));
    expect(later).toContain("can't be added");
    expect(existsSync(join(dir, "picture.jpg"))).toBe(false);
    expect(readdirSync(dir)).not.toContain("picture.jpg");
  });
});

describe("R3-pin: the check never sends to another app", () => {
  it("another app made current while the commands answer is pending gets no reset", async () => {
    const r = await rig({ world: (w) => void (w.commands = ["reset"]) });
    const id = await makeJsBug(r);
    r.s.world.hold.add("commands");
    const verifying = r.s.tools.bugReport({ bug: id, verify: 1, reset: "app" });
    for (let i = 0; i < 400 && r.s.world.held.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.s.world.held).toHaveLength(1);
    const other = await FakeApp.connect(r.s.port, { app: { name: "Other", id: "com.example.other", version: "2.0.0", build: "9" }, capabilities: ["tree", "press", "logs", "dryRun", "place", "places", "commands"] }, () => ({ ok: true, result: { commands: [{ name: "reset", description: "x" }] } }));
    apps.push(other.app);
    const held = r.s.world.held[0];
    r.s.current().send({ type: "response", id: held?.id, ok: true, result: { commands: [{ name: "reset", description: "x" }] } });
    await verifying;
    expect(other.app.requests.map((q) => q.method).filter((m) => m === "command")).toEqual([]);
    expect(r.s.world.resets).toBe(0);
  });
});

interface GateSpy {
  exploreTouchGate: (inner: string, method: string, rawParams: unknown, sessionId: string | undefined) => Promise<void>;
}

describe("R4-final-pin: the pin is checked again right before the touch is sent", () => {
  it("another app made current while the floor's answer is pending gets no touch, and the first app gets none either", async () => {
    const r = await rig();
    const id = await makeJsBug(r);
    const spy = r.s.tools as unknown as GateSpy;
    const original = spy.exploreTouchGate.bind(r.s.tools);
    let switched = false;
    spy.exploreTouchGate = async (inner, method, rawParams, sessionId) => {
      await original(inner, method, rawParams, sessionId); // the floor's tree answer has come back and passed
      if (inner === "press" && !switched) {
        switched = true;
        const other = await FakeApp.connect(r.s.port, { app: { name: "Other", id: "com.example.other", version: "2.0.0", build: "9" }, capabilities: ["tree", "press", "logs", "dryRun", "place", "places"] }, () => ({ ok: true, result: {} }));
        apps.push(other.app);
      }
    };
    r.s.world.pressed.length = 0;
    await r.s.tools.bugReport({ bug: id, verify: 1 });
    expect(switched).toBe(true);
    expect(r.s.world.pressed).not.toContain("open-form");
  });
});
