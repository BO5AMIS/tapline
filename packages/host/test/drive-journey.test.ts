import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import type { MapFile } from "../src/mapfile.js";
import type { MapRegistry } from "../src/places.js";
import type { TaplineHost } from "../src/server.js";
import { ALL_CAPS, baseMap, button, place, road, setupDrive, textOf, type Setup, type SetupOptions, flushDriveMaps } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.12: `drive` in a user's-eyes journey takes roads made of taps a person could make, aimed by visible text.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
const registries: MapRegistry[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  // A drive marks its roads as driven and the registry saves that map in the background. Wait for the save to end before the folder
  // goes, or the delete races the map's temp file and lock (ENOTEMPTY on Windows).
  await Promise.all(registries.splice(0).map((r) => r.flushAll()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function setup(options: SetupOptions = {}): Promise<Setup & { journeys: string }> {
  const journeys = mkdtempSync(join(tmpdir(), "tapline-drive-journeys-"));
  dirs.push(journeys);
  const s = await setupDrive(hosts, apps, dirs, { capabilities: ALL_CAPS, ...options, tools: { journeysDir: journeys, ...options.tools } });
  registries.push(s.registry);
  return { ...s, journeys };
}
const begin = (s: Setup, extra: Record<string, unknown> = {}) => callTool(s.tools, "journey", { start: true, goal: "change the language", persona: "a first-timer", ...extra });
const linked = (): MapFile => {
  const map = baseMap();
  map.places["language"] = place(["settings", "general", "language"], "wayfare://language");
  return map;
};
const touched = (s: Setup): unknown[] =>
  s.app.requests
    .filter((r) => r.method === "move" || r.method === "press" || r.method === "openURL")
    .map((r) => (r.method === "move" ? (r.params as { method: string; params: unknown }) : { method: r.method, params: r.params }));

describe("drive in a user's eyes", () => {
  it("never jumps, and aims each move by the visible text it had", async () => {
    const s = await setup({ map: linked() });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[0]).toMatch(/^Arrived at language by 2 taps in /);
    expect(s.made("openURL")).toBe(0);
    const sent = touched(s) as Array<{ method: string; params: { target?: Record<string, unknown>; noScroll?: boolean } }>;
    expect(sent.map((m) => m.params.target)).toEqual([{ text: "General" }, { text: "Language" }]);
    // A person doesn't have the app scroll a control into view for them.
    expect(sent.every((m) => m.params.noScroll === true)).toBe(true);
    expect(s.world.screen).toBe("language");
  });

  it("reads only what is on the glass, and leaks no id, label or place name", async () => {
    const s = await setup();
    await begin(s);
    const before = s.app.requests.length;
    const answer = await callTool(s.tools, "drive", { to: "language" });
    const text = textOf(answer);
    expect(text).not.toMatch(/id=|general-row|language-row|Place:|settings > general/);
    const trees = s.app.requests.slice(before).filter((r) => r.method === "tree" && (r.params as { peek?: boolean }).peek !== true);
    expect(trees.length).toBeGreaterThan(0);
    expect(trees.every((r) => (r.params as { glass?: boolean }).glass === true)).toBe(true);
  });

  it("a stopped drive says nothing of ids or the app's place names", async () => {
    const s = await setup({ world: (w) => { w.elements.general = [button("e3", "other-row", "Elsewhere")]; } });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    const text = textOf(answer);
    expect(text.split("\n")[0]).toBe('Error off_route: stopped at step 2 of 2 (tap "Language"): it isn\'t on this screen. Done: 1 move. Nothing else was touched.');
    expect(text).not.toMatch(/id=|Now at|general-row|language-row/);
  });

  it("a road with no visible text can't be driven there", async () => {
    const map = baseMap();
    map.roads = [{ ...road("settings", "general", "general-row", "General"), names: { id: "general-row" } }];
    const s = await setup({ map });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe("Error off_route: stopped at step 1 of 1 (tap): it has no text a person could read. Done: 0 moves. Nothing else was touched.");
    expect(textOf(answer)).not.toContain("general-row");
    expect(s.count("press") + s.count("move")).toBe(0);
  });

  it("a road made of a link is not driven: only taps a person could make", async () => {
    const map = baseMap();
    map.roads = [{ ...road("settings", "general", "x", "General"), move: { tool: "open_url", url: "wayfare://general" } }];
    const s = await setup({ map });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_found: /);
    expect(s.count("openURL") + s.count("move")).toBe(0);
  });

  it("by link is refused with a reason in the journey's words", async () => {
    const s = await setup({ map: linked() });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "language", by: "link" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: in a journey, a jump is a shortcut a user doesn't have/);
    expect(s.made("openURL")).toBe(0);
  });

  it("a route whose steps use ids is refused before the app is driven anywhere", async () => {
    const map: MapFile = { ...baseMap(), routes: { go: "routes/go.json" } };
    const s = await setup({ map });
    writeFileSync(join(s.folder, "routes", "go.json"), JSON.stringify({ format: "agent-tools-script", version: 2, app: "com.example.wayfare", name: "go", start: "general", steps: [{ tool: "tap", target: { id: "language-row" } }] }));
    await begin(s);
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: step 1: in a journey, ids and labels are hidden/);
    expect(s.count("move") + s.count("press")).toBe(0);
  });

  it("a drive step inside run follows the same eyes", async () => {
    const s = await setup({ map: linked() });
    await begin(s);
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "drive", to: "language" }], trace: true });
    expect(answer.isError).not.toBe(true);
    expect(s.made("openURL")).toBe(0);
    expect(textOf(answer)).not.toMatch(/id=|language-row/);
  });

  it("every move keeps its policy check", async () => {
    const map = baseMap();
    map.roads = [{ ...road("settings", "general", "delete-trip", "Delete trip") }];
    const s = await setup({ map, policy: { version: 1, confirm: ["delete"], block: [] }, world: (w) => (w.goes["settings|delete-trip"] = "general") });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/needs_confirmation/);
    expect(s.world.screen).toBe("settings");
  });
});

describe("a dry run in a user's eyes", () => {
  it("says only how many moves and how many are unproven, with no place, link or route name", async () => {
    const s = await setup({ map: linked() });
    await begin(s);
    expect(textOf(await callTool(s.tools, "drive", { to: "language", dry_run: true }))).toBe("Would drive to language by 2 taps (all proven).");
    const old = baseMap();
    old.roads = [road("settings", "general", "general-row", "General", "1.4.0 (212)"), road("general", "language", "language-row", "Language")];
    const t = await setup({ map: old });
    await begin(t);
    expect(textOf(await callTool(t.tools, "drive", { to: "language", dry_run: true }))).toBe("Would drive to language by 2 taps (1 unproven).");
    expect(s.count("move") + s.count("press") + t.count("move") + t.count("press")).toBe(0);
  });

  it("says no link either, also when allow names drive", async () => {
    const s = await setup({ map: linked() });
    await begin(s, { allow: ["drive"] });
    const said = textOf(await callTool(s.tools, "drive", { to: "language", dry_run: true }));
    expect(said).toBe("Would drive to language by link (all proven).");
    expect(said).not.toMatch(/wayfare|>|general/);
  });

  it("a drive step in a dry run batch says the same", async () => {
    const s = await setup();
    await begin(s);
    expect(textOf(await callTool(s.tools, "run", { steps: [{ tool: "drive", to: "language" }], dry_run: true }))).toBe("Would run 1 step; step 1 would drive to language by 2 taps (all proven).");
  });
});

describe("a shortcut is noted once", () => {
  it("a plain allowed open_url is one shortcut, and a drive's jump adds its own", async () => {
    const s = await setup({ map: linked() });
    await begin(s, { allow: ["open_url", "drive"] });
    await callTool(s.tools, "open_url", { url: "wayfare://settings" });
    expect(s.tools.currentJourney()?.state.shortcuts).toHaveLength(1);
    await callTool(s.tools, "drive", { to: "language" });
    expect(s.tools.currentJourney()?.state.shortcuts).toHaveLength(2);
  });
});

describe("allow lifts only what it names", () => {
  it("drive lets a jump through, still aimed by text, and the report says a shortcut was used", async () => {
    const s = await setup({ map: linked() });
    await begin(s, { allow: ["drive"] });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[0]).toMatch(/^Arrived at language by link then 1 tap in /);
    expect(s.made("openURL")).toBe(1);
    const shortcuts = s.tools.currentJourney()?.state.shortcuts ?? [];
    expect(shortcuts.map((x) => x.tool)).toEqual(["open_url"]);
  });

  it("reflexes and fast_animations do not lift the jump ban", async () => {
    const s = await setup({ map: linked() });
    await begin(s, { allow: ["reflexes", "fast_animations"] });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(textOf(answer).split("\n")[0]).toMatch(/^Arrived at language by 2 taps in /);
    expect(s.made("openURL")).toBe(0);
  });

  it("with the agent's eyes, drive jumps as usual", async () => {
    const s = await setup({ map: linked() });
    await begin(s, { eyes: "agent" });
    expect(textOf(await callTool(s.tools, "drive", { to: "language" })).split("\n")[0]).toMatch(/^Arrived at language by link then 1 tap in /);
  });
});

describe("the journey report", () => {
  it("keeps how each drive travelled, and a repair", async () => {
    // The road names Language by id and text; the app's element has another id, and its text matches: no repair needed in a user's eyes.
    const s = await setup();
    await begin(s);
    await callTool(s.tools, "drive", { to: "language" });
    const stopped = textOf(await callTool(s.tools, "journey", { stop: true, reached: true }));
    expect(s.tools.finishedJourney()?.steps[0]?.said).toMatch(/^Arrived at language by 2 taps in /);
    const folder = /Report: (.+)$/m.exec(stopped)?.[1] ?? "";
    expect(readdirSync(folder)).toContain("report.md");
    const report = readFileSync(join(folder, "report.md"), "utf8");
    expect(report).toContain("by 2 taps");
    expect(report).not.toMatch(/language-row|general-row/);
  });

  it("counts the taps of a drive in the measures", async () => {
    const s = await setup();
    await begin(s);
    await callTool(s.tools, "drive", { to: "language" });
    expect(s.tools.currentJourney()?.state.measures.taps).toBe(2);
  });

  it("a repair line stays in the step, without the id it was", async () => {
    const s = await setup({ world: (w) => { w.elements.general = [button("e3", "lang-row", "Languag")]; w.goes["general|lang-row"] = "language"; } });
    await begin(s);
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain('Road repaired: "Languag".');
    expect(textOf(answer)).not.toMatch(/id=|language-row|lang-row/);
    const stopped = textOf(await callTool(s.tools, "journey", { stop: true, reached: true }));
    const folder = /Report: (.+)$/m.exec(stopped)?.[1] ?? "";
    const report = readFileSync(join(folder, "report.md"), "utf8");
    expect(report).toContain("Road repaired");
    expect(report).not.toMatch(/language-row|lang-row/);
    expect(button("e9", "x", "y").role).toBe("button");
  });
});
