import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import { EXPLORE_TOOL_VERSION } from "../src/explore.js";
import type { ExploreReport } from "../src/explorereport.js";
import { createMcpServer } from "../src/mcp.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { btn, flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);

/** The newest run folder of the app. */
export function lastRun(s: ExploreSetup): string {
  const appDir = join(s.exploreDir, APP.id);
  const names = readdirSync(appDir).sort();
  return join(appDir, names[names.length - 1] as string);
}
export const reportOf = (s: ExploreSetup): ExploreReport => JSON.parse(readFileSync(join(lastRun(s), "report.json"), "utf8")) as ExploreReport;

describe("explore: the call (§25.2)", () => {
  it("explores the screens, saves places and roads, and answers the summary of §25.2", async () => {
    const s = await setup();
    const answer = await s.tools.explore({});
    expect(answer.isError).not.toBe(true);
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toMatch(/^Explored 6 places in 0 min \(\d+ steps\), 0 findings\. Stopped: the frontier is empty\.$/);
    expect(lines[1]).toBe("Findings: none.");
    expect(lines[2]).toMatch(/^Report: .*report\.md$/);
    // No places are known up front here: no Coverage line (§25.11).
    expect(textOf(answer)).not.toContain("Coverage:");
    await s.registry.flushAll();
    const file = s.file();
    expect(Object.keys(file.places).sort()).toEqual(["form", "home", "language", "settings", "trips", "trips_id"]);
    expect(file.roads.map((r) => `${r.from}>${r.to}`)).toEqual(expect.arrayContaining(["home>settings", "home>trips", "trips>trips_id", "settings>language"]));
    expect(file.places["home"]?.explored?.actions.find((a) => a.sig === "id:open-settings")).toMatchObject({ result: "road", to: "settings", build: "1.5.0 (220)" });
  });

  it("every default is the spec's, and the report holds the budget it ran with", async () => {
    const s = await setup();
    await s.tools.explore({});
    expect(reportOf(s)).toMatchObject({ format: "agent-tools-explore-report", version: 1, app: APP.id, build: "1.5.0 (220)", tool: "tapline", tool_version: EXPLORE_TOOL_VERSION, stopped: "frontier_empty", start_place: "home", budget: { minutes: 10, steps: 500, depth: 8 } });
  });

  it("refuses a value out of range, a reserved guide, a place the map doesn't know and a bad account (§25.2)", async () => {
    const s = await setup();
    for (const args of [{ minutes: 0 }, { minutes: 61 }, { steps: 0 }, { steps: 5001 }, { steps: 1.5 }, { depth: 0 }, { depth: 21 }]) {
      const said = textOf(await s.tools.explore(args));
      expect(said).toMatch(/^Error bad_params: (minutes|steps|depth) is /);
    }
    expect(textOf(await s.tools.explore({ guide: "agent" }))).toBe("Error unsupported: guide isn't offered yet; explore chooses by itself.");
    expect((await s.tools.explore({ guide: "none" })).isError).not.toBe(true);
    expect(textOf(await s.tools.explore({ from: "nowhere" }))).toMatch(/^Error bad_params: from names no place the map knows: "nowhere"/);
    expect(textOf(await s.tools.explore({ focus: "nowhere" }))).toMatch(/^Error bad_params: focus names no place/);
    expect(textOf(await s.tools.explore({ account: "nobody" }))).toMatch(/^Error bad_params: no account "nobody"/);
  });

  it("is a tool, but never a step of run or of a script (§25.1)", async () => {
    const s = await setup();
    const answer = await s.tools.run({ steps: [{ tool: "explore" }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: step 1: "explore" can't be a step/);
    const viaTable = await callTool(s.tools, "explore", { minutes: 0 });
    expect(textOf(viaTable)).toMatch(/^Error bad_params: minutes/);
    const unknown = await callTool(s.tools, "explore", { bogus: 1 });
    expect(textOf(unknown)).toMatch(/^Error bad_params: explore doesn't take bogus; it takes minutes, steps, depth, from, focus, fill, continue, account, guide\./);
  });

  it("says no app is connected when none is", async () => {
    const s = await setup();
    s.current().ws.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(textOf(await s.tools.explore({}))).toMatch(/^Error not_connected:/);
  });

  it("is refused while a journey runs or a script is recorded", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const scriptsDir = mkdtempSync(join(tmpdir(), "tapline-explore-scripts-"));
    dirs.push(scriptsDir);
    const s = await setup({ tools: { scriptsDir } });
    expect((await s.tools.record({ start: true, name: "x" })).isError).not.toBe(true);
    expect(textOf(await s.tools.explore({}))).toMatch(/^Error bad_params: explore can't run while a script is recorded or replayed/);
  });
});

describe("explore: coverage and determinism (§25.4, §25.11, §25.13)", () => {
  it("runs twice and explores the same places in the same order", async () => {
    const first = await setup();
    await first.tools.explore({});
    const second = await setup();
    await second.tools.explore({});
    expect(second.world.pressed).toEqual(first.world.pressed);
    expect(second.world.asked).toEqual(first.world.asked);
    const a = reportOf(first);
    const b = reportOf(second);
    expect(b.skipped).toEqual(a.skipped);
    expect(b.used.steps).toBe(a.used.steps);
    await first.registry.flushAll();
    await second.registry.flushAll();
    expect(second.file().roads.map((r) => `${r.from}>${r.to}`)).toEqual(first.file().roads.map((r) => `${r.from}>${r.to}`));
  });

  it("tries the actions of a place top to bottom, then by signature, and never twice on the same build", async () => {
    const s = await setup();
    await s.tools.explore({});
    const homePresses = s.world.pressed.slice(0, 3);
    expect(homePresses).toEqual(["open-settings", "open-trips", "open-form"]);
    // The second run finds everything tried on this build (§28.1): nothing new is touched.
    s.world.pressed.length = 0;
    const again = await s.tools.explore({});
    expect(textOf(again)).toMatch(/Stopped: the frontier is empty\./);
    expect(s.world.pressed).toEqual([]);
  });

  it("tries the first two rows of a list and says so, and scrolls to reveal what is below, then back to the start (§25.4 items 2 and 3)", async () => {
    const s = await setup();
    await s.tools.explore({});
    const row = s.world.pressed.filter((id) => id.startsWith("trip-row"));
    expect(row.filter((id) => id === "trip-row-1" || id === "trip-row-2").length).toBeGreaterThanOrEqual(2);
    expect(row).not.toContain("trip-row-3");
    expect(row).not.toContain("trip-row-4");
    expect(reportOf(s).notes).toContain("rows: first 2 of the list tried (trips)");
    const scrolls = s.world.asked.filter((m) => m === "scroll");
    // Two reveals and one scroll back to the start.
    expect(scrolls).toHaveLength(3);
    expect(s.world.revealed["trips"]).toBe(0);
    await s.registry.flushAll();
    const actions = s.file().places["trips"]?.explored?.actions.map((a) => a.sig) ?? [];
    expect(actions).toEqual(expect.arrayContaining(["row:id:trip-list#1", "row:id:trip-list#2", "id:trip-list", "back"]));
    expect(actions).not.toContain("row:id:trip-list#3");
  });

  it("counts places known up front: reached, not reached, areas, the Coverage line, and an unreachable finding at the end (§25.10, §25.11)", async () => {
    const s = await setup({
      world: (w) => {
        w.known = [
          { route: ["home"], link: "wayfare://home" },
          { route: ["settings"], link: "wayfare://settings" },
          { route: ["settings", "language"] },
          { route: ["trips"] },
          { route: ["trips", "[id]"], params: ["id"] },
          { route: ["admin", "users"] },
          { route: ["debug"] },
        ];
      },
    });
    const answer = await s.tools.explore({});
    const said = textOf(answer);
    expect(said).toContain("Coverage: 5 of 7 places known up front; 2 not reached.");
    expect(said).toContain("Findings: 2 unreachable.");
    const report = reportOf(s);
    expect(report.coverage).toMatchObject({ known_up_front: 7, reached: 5, not_reached: ["debug", "users"], frontier_left: 0 });
    expect(report.coverage.areas).toEqual({ home: { known: 1, visited: 1 }, settings: { known: 2, visited: 2 }, trips: { known: 2, visited: 2 }, admin: { known: 1, visited: 0 }, debug: { known: 1, visited: 0 } });
    expect(report.findings.filter((f) => f.kind === "unreachable").map((f) => f.place)).toEqual(["users", "debug"]);
    const map = textOf(await s.tools.map({}));
    expect(map).toMatch(/Coverage: \d+ places \(\d+ explored, \d+ frontier\); known up front, not reached: 2\./);
  });

  it("names the places from their route, and never from a screen title (§25.12)", async () => {
    const s = await setup();
    await s.tools.explore({});
    await s.registry.flushAll();
    expect(s.file().places["trips_id"]?.key).toEqual({ route: ["trips", "[id]"] });
    expect(JSON.stringify(s.file())).not.toContain("Trip to Paris");
  });
});

describe("explore: from, focus and depth (§25.4)", () => {
  it("starts at `from`, driving there first", async () => {
    const s = await setup();
    await s.tools.explore({});
    s.world.screen = "trips";
    await s.tools.explore({ from: "settings" });
    expect(reportOf(s).start_place).toBe("settings");
  });

  it("expands only the places below `focus`, and saves a road that arrives outside without expanding there", async () => {
    const s = await setup();
    await s.tools.explore({ depth: 1 });
    await s.registry.flushAll();
    s.world.pressed.length = 0;
    const focused = await s.tools.explore({ focus: "settings" });
    expect(focused.isError).not.toBe(true);
    const report = reportOf(s);
    expect(report.start_place).toBe("settings");
    // `back` from settings arrives at home, outside the focus: a real road, not expanded.
    await s.registry.flushAll();
    expect(s.file().roads.some((r) => r.from === "settings" && r.to === "home")).toBe(true);
    expect(s.world.pressed).not.toContain("open-trips");
    expect(s.world.pressed).toContain("open-language");
  });

  it("saves a place at `depth` and does not expand it", async () => {
    const s = await setup();
    const answer = await s.tools.explore({ depth: 1 });
    expect(textOf(answer)).toContain("Stopped: the frontier is empty.");
    await s.registry.flushAll();
    const file = s.file();
    expect(Object.keys(file.places).sort()).toEqual(["form", "home", "settings", "trips"]);
    expect(file.places["home"]?.explored).toBeDefined();
    expect(file.places["settings"]?.explored).toBeUndefined();
    expect(s.world.pressed).not.toContain("open-language");
  });
});

describe("explore: the map and the action log (§25.1)", () => {
  it("makes every move an ordinary action: the action log has them", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const logDir = mkdtempSync(join(tmpdir(), "tapline-explore-log-"));
    dirs.push(logDir);
    const s = await setup({ tools: { logDir } });
    await s.tools.explore({});
    const lines = readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n").filter((l) => l !== ""));
    const tools = lines.map((l) => (JSON.parse(l) as { tool?: string }).tool);
    expect(tools.filter((t) => t === "tap").length).toBeGreaterThan(5);
    expect(tools).toContain("toggle");
    expect(tools).toContain("back");
  });

  it("is an MCP tool and sends a progress notification every 10 steps, never in the answer (§25.2)", async () => {
    const s = await setup();
    const server = createMcpServer(s.tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const progress: Array<{ progress: number; message?: string }> = [];
      const answer = await client.callTool({ name: "explore", arguments: {} }, undefined, { onprogress: (p) => progress.push({ progress: p.progress, ...(p.message !== undefined ? { message: p.message } : {}) }) });
      expect(JSON.stringify(answer.content)).toContain("Explored 6 places");
      expect(progress.length).toBeGreaterThanOrEqual(3);
      expect(progress[0]?.message).toMatch(/^explored \d+ places, \d+ findings$/);
      // Once every 10 steps.
      for (let i = 1; i < progress.length; i++) expect(Math.floor((progress[i]?.progress ?? 0) / 10)).toBeGreaterThan(Math.floor((progress[i - 1]?.progress ?? 0) / 10));
      expect(JSON.stringify(answer.content)).not.toContain("explored 6 places,");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("is listed with the other tools and described", async () => {
    const s = await setup();
    const server = createMcpServer(s.tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === "explore");
      expect(tool?.description).toContain("Explore the app by itself");
      expect(Object.keys((tool?.inputSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual(["account", "continue", "depth", "fill", "focus", "from", "guide", "minutes", "steps"]);
      expect(client.getInstructions()).toContain("`explore`");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("explore: a world where a control is added later", () => {
  it("tries only what is new on a later run of the same build", async () => {
    const s = await setup();
    await s.tools.explore({});
    s.world.screens["home"]?.elements.push(btn("open-help", "Help center"));
    s.world.screens["home"]?.elements.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    s.world.pressed.length = 0;
    await s.tools.explore({});
    expect(s.world.pressed).toEqual(["open-help"]);
    expect(existsSync(lastRun(s))).toBe(true);
  });
});
