import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool, TOOL_META } from "../src/dispatch.js";
import { toolDescription } from "../src/tool-text.js";
import { ControlQueue } from "../src/control.js";
import type { MapFile } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { BUILD, OLD_BUILD, baseMap, button, note, place, road, setupDrive, textOf, type Setup, type SetupOptions, flushDriveMaps } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.4: `drive`, one call across the map.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const setup = (options: SetupOptions = {}): Promise<Setup> => setupDrive(hosts, apps, dirs, options);
const drive = async (s: Setup, args: Record<string, unknown>): Promise<string> => textOf(await callTool(s.tools, "drive", args));
const withRoads = (...roads: MapFile["roads"]): MapFile => ({ ...baseMap(), roads });

describe("drive: the answer", () => {
  it("arrives and answers in the exact shape", async () => {
    const s = await setup();
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toBe("Arrived at language by 2 taps in 0.0 s (settings > general > language).");
    expect(lines[1]).toBe("Place: language.");
    expect(textOf(answer)).toContain("English");
    expect(s.world.screen).toBe("language");
  });

  it("says by link, by 3 taps and by link then 1 tap", async () => {
    // By link: the settings place has a link.
    const linked = baseMap();
    linked.places["settings"] = place(["settings"], "wayfare://settings");
    const a = await setup({ map: linked, world: (w) => (w.screen = "language") });
    expect((await drive(a, { to: "settings" })).split("\n")[0]).toBe("Arrived at settings by link in 0.0 s.");
    expect(a.made("openURL")).toBe(1);
    // By 3 taps.
    const three = baseMap();
    three.places["trips_id"] = place(["trips", "[id]"]);
    three.roads.push(road("language", "trips_id", "trip-row", "Trip"));
    const b = await setup({ map: three, world: (w) => { w.screen = "settings"; w.goes["language|trip-row"] = "trips"; w.elements.language.push(button("e9", "trip-row", "Trip")); } });
    expect((await drive(b, { to: "trips_id" })).split("\n")[0]).toBe("Arrived at trips_id by 3 taps in 0.0 s (settings > general > language > trips_id).");
    // By link then 1 tap: the link opens a parent screen the map knows, and a road goes on from there.
    const parent = baseMap();
    parent.places["language"] = place(["settings", "general", "language"], "wayfare://language");
    const c = await setup({ map: parent, world: (w) => (w.screen = "settings") });
    c.world.screen = "trips";
    const said = await drive(c, { to: "language" });
    expect(said.split("\n")[0]).toBe("Arrived at language by link then 1 tap in 0.0 s (general > language).");
  });

  it("with fills a link's params, and a missing value is bad_params", async () => {
    const s = await setup();
    s.world.screen = "settings";
    const missing = await callTool(s.tools, "drive", { to: "trips_id" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe("Error bad_params: trips_id needs id (give it in with).");
    expect(s.made("openURL")).toBe(0);
    const good = await drive(s, { to: "trips_id", with: { id: "42" } });
    expect(good.split("\n")[0]).toBe("Arrived at trips_id by link in 0.0 s.");
    const sent = s.app.requests.find((r) => r.method === "move");
    expect((sent?.params as { params: unknown }).params).toEqual({ url: "wayfare://trips/42" });
  });

  it("answers exactly one of to or route", async () => {
    const s = await setup();
    expect(textOf(await callTool(s.tools, "drive", {}))).toMatch(/^Error bad_params: give exactly one of to/);
    expect(textOf(await callTool(s.tools, "drive", { to: "a", route: "b" }))).toMatch(/^Error bad_params: give exactly one of to/);
    expect(s.count("press")).toBe(0);
  });

  it("an unknown place is not_found, and no known way says how to teach one", async () => {
    const s = await setup({ map: withRoads(road("settings", "general", "general-row", "General")) });
    expect(textOf(await callTool(s.tools, "drive", { to: "nowhere" }))).toBe('Error not_found: no place named "nowhere"; map lists the places.');
    const no = await callTool(s.tools, "drive", { to: "language" });
    expect(no.isError).toBe(true);
    expect(textOf(no)).toBe("Error not_found: no known way from settings to language; drive it once (the driver), and it is remembered.");
    expect(textOf(await callTool(s.tools, "drive", { to: "language", by: "link" }))).toMatch(/^Error not_found: language has no link/);
  });

  it("already there says so and touches nothing", async () => {
    const s = await setup();
    expect((await drive(s, { to: "settings" })).split("\n")[0]).toBe("Already at settings.");
    expect(s.count("press") + s.count("move")).toBe(0);
  });

  it("an unknown start is off_route before anything is touched", async () => {
    const s = await setup({ world: (w) => (w.screen = "welcome") });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: the app's current place isn't known, so no road can be followed\. Now at: welcome \(new\)\. Nothing was touched\./);
    expect(s.count("press") + s.count("move")).toBe(0);
  });

  it("dry_run says the way and touches nothing", async () => {
    const s = await setup();
    expect(await drive(s, { to: "language", dry_run: true })).toBe("Would drive to language by 2 taps: settings > general > language (all proven).");
    const unproven = await setup({ map: withRoads(road("settings", "general", "general-row", "General", OLD_BUILD), road("general", "language", "language-row", "Language")) });
    expect(await drive(unproven, { to: "language", dry_run: true })).toBe(`Would drive to language by 2 taps: settings > general > language (unproven for build ${BUILD}: settings > general).`);
    expect(s.count("press") + s.count("move") + s.count("openURL")).toBe(0);
    expect(unproven.count("press") + unproven.count("move")).toBe(0);
  });
});

describe("drive: when the road is wrong", () => {
  it("repairs a road by another name, says so, and updates it only after arrival", async () => {
    const s = await setup({ world: (w) => { w.elements.general = [button("e3", "lang-row", "Language")]; w.goes["general|lang-row"] = "language"; w.screen = "general"; } });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain('Road repaired: "Language" (was id=language-row).');
    await s.registry.flushAll();
    expect(s.file().roads.find((r) => r.from === "general")?.move.target).toEqual({ id: "lang-row" });
  });

  it("does not update the road when the arrival check fails", async () => {
    const s = await setup({ world: (w) => { w.elements.general = [button("e3", "lang-row", "Language")]; w.goes["general|lang-row"] = "welcome"; w.screen = "general"; } });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).not.toContain("Road repaired");
    await s.registry.flushAll();
    const kept = s.file().roads.find((r) => r.from === "general" && r.to === "language");
    expect(kept?.move.target).toEqual({ id: "language-row" });
  });

  it("takes the closest match only when it is the only one, and the policy checks it", async () => {
    const one = await setup({ world: (w) => { w.elements.general = [button("e3", "langs-row", "Languages")]; w.goes["general|langs-row"] = "language"; w.screen = "general"; } });
    expect(textOf(await callTool(one.tools, "drive", { to: "language" }))).toContain('Road repaired: "Languages" (was id=language-row).');
    const two = await setup({ world: (w) => { w.elements.general = [button("e3", "a", "Languages"), button("e4", "b", "Language list")]; w.screen = "general"; } });
    const refused = await callTool(two.tools, "drive", { to: "language" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error off_route: stopped at step 1 of 1 \(tap "Language"\): it isn't on this screen\./);
    expect(two.count("press")).toBe(0);
    // The match goes through the policy like any target: "Delete language" carries a policy word.
    const flagged = await setup({
      policy: { version: 1, confirm: ["delete"], block: [] },
      world: (w) => { w.elements.general = [button("e3", "del-row", "Delete language")]; w.goes["general|del-row"] = "language"; w.screen = "general"; },
    });
    const stopped = await callTool(flagged.tools, "drive", { to: "language" });
    expect(textOf(stopped)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(flagged.count("press") + flagged.count("move")).toBe(0);
  });

  it("a known place elsewhere plans again, at most twice", async () => {
    const map = withRoads(road("settings", "general", "general-row", "General"), road("general", "language", "language-row", "Language"), road("trips_id", "language", "back-row", "Back"));
    const once = await setup({ map, world: (w) => { w.landOnce = "trips"; w.elements.trips = [button("e5", "back-row", "Back")]; w.goes["trips|back-row"] = "language"; } });
    const answer = await callTool(once.tools, "drive", { to: "language" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[0]).toMatch(/^Arrived at language by 2 taps/);
    // Always missing: settings leads to trips, trips leads back to settings, so the third plan is never made.
    const never = await setup({
      map: withRoads(road("settings", "general", "general-row", "General"), road("general", "language", "language-row", "Language"), road("trips_id", "language", "back-row", "Back")),
      world: (w) => {
        w.goes["settings|general-row"] = "trips";
        w.elements.trips = [button("e5", "back-row", "Back")];
        w.goes["trips|back-row"] = "settings";
      },
    });
    const lost = await callTool(never.tools, "drive", { to: "language" });
    expect(lost.isError).toBe(true);
    expect(textOf(lost)).toContain("Error off_route:");
    expect(never.count("move")).toBe(3);
  });

  it("off_route has the exact message, names what was done and touches nothing more", async () => {
    const s = await setup({ world: (w) => { w.elements.general = [note("e3", "Nothing to tap")]; } });
    s.world.screen = "settings";
    // The first road leads to general; there the second target is missing.
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    const text = textOf(answer);
    expect(text.split("\n")[0]).toBe('Error off_route: stopped at step 2 of 2 (tap "Language"): it isn\'t on this screen. Now at: general (known). Done: 1 move. Nothing else was touched.');
    expect(text).toContain("Nothing to tap");
    expect(s.count("move")).toBe(1);
  });

  it("an arrival is never claimed unchecked: it lands elsewhere, so off_route, never Arrived", async () => {
    const s = await setup({ world: (w) => { w.landOnce = "welcome"; } });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).not.toContain("Arrived");
    expect(textOf(answer)).toContain("Now at: welcome (new).");
  });

  it("a row road is never run: it stops with off_route", async () => {
    const row = { ...road("settings", "general", "x", "Paris"), move: { tool: "tap", target: { row: true as const } } };
    const s = await setup({ map: withRoads(row) });
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: stopped at step 1 of 1 \(tap "Paris"\): it is a list row with no id of its own/);
    expect(s.count("move") + s.count("press")).toBe(0);
  });

  it("a failed road twice is dropped and said", async () => {
    const s = await setup({ world: (w) => { w.elements.settings = [note("e1", "Gone")]; } });
    const first = textOf(await callTool(s.tools, "drive", { to: "language" }));
    expect(first).not.toContain("dropped the road");
    const second = textOf(await callTool(s.tools, "drive", { to: "language" }));
    expect(second).toContain("Note: dropped the road settings > general (it failed twice in a row).");
    await s.registry.flushAll();
    expect(s.file().roads.some((r) => r.from === "settings" && r.to === "general")).toBe(false);
  });

  it("unproven roads driven cleanly are proven again, and the note says how many", async () => {
    const s = await setup({ map: withRoads(road("settings", "general", "general-row", "General", OLD_BUILD), road("general", "language", "language-row", "Language", OLD_BUILD)) });
    const answer = textOf(await callTool(s.tools, "drive", { to: "language" }));
    expect(answer).toContain(`Note: 2 roads proven again for build ${BUILD}.`);
    await s.registry.flushAll();
    expect(s.file().roads.every((r) => r.build === BUILD)).toBe(true);
  });
});

describe("drive: people and the policy", () => {
  it("paused stops between moves with Done: n moves", async () => {
    const control = new ControlQueue({ idleMs: 0 });
    const s = await setup({ tools: { control }, world: (w) => { w.onPress = () => control.setPaused(true); } });
    const answer = await callTool(s.tools, "drive", { to: "language" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error paused: .* Done: 1 move\.$/);
    expect(s.count("move")).toBe(1);
  });

  it("a needs_confirmation move stops the drive when there is no dialog, and asks the live view", async () => {
    const map = withRoads(road("settings", "trips_id", "delete-trip", "Delete trip"));
    const s = await setup({ map, policy: { version: 1, confirm: ["delete"], block: [] } });
    const answer = await callTool(s.tools, "drive", { to: "trips_id", by: "taps" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(textOf(answer)).toContain("Stopped at step 1 of 1 (tap \"Delete trip\"). Done: 0 moves. Nothing else was touched.");
    expect(s.count("move") + s.count("press")).toBe(0);
  });

  it("a blocked move is refused outright", async () => {
    const map = withRoads(road("settings", "trips_id", "delete-trip", "Delete trip"));
    const s = await setup({ map, policy: { version: 1, confirm: [], block: ["delete"] } });
    const answer = await callTool(s.tools, "drive", { to: "trips_id", by: "taps" });
    expect(textOf(answer)).toMatch(/^Error not_allowed: blocked: /);
    expect(s.count("move") + s.count("press")).toBe(0);
  });

});

describe("drive: the tool", () => {
  it("carries TOOL-TEXT's paragraph word for word, and is not read-only", () => {
    const text = toolDescription("drive");
    expect(text.startsWith("Go to a place the map knows, in one call. `to` is a place's name (see `map`);")).toBe(true);
    expect(text).toContain("A stale road is repaired by another name or planned again; otherwise `off_route`: nothing more was touched, so go on by hand.");
    expect(text.endsWith("`dry_run: true` says the way; `brief: true` shortens the answer.")).toBe(true);
    expect(TOOL_META.drive.readOnly).toBe(false);
  });
});

describe("drive {route}", () => {
  const route = (steps: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ format: "agent-tools-script", version: 2, app: "com.example.wayfare", name: "go", start: "general", steps, ...extra });
  async function withRoute(file: string, options: SetupOptions = {}): Promise<Setup> {
    const map = { ...baseMap(), routes: { go: "routes/go.json" } };
    const s = await setup({ map, ...options });
    writeFileSync(join(s.folder, "routes", "go.json"), file);
    return s;
  }

  it("drives to the start place first, then runs the steps", async () => {
    const s = await withRoute(route([{ tool: "tap", target: { id: "language-row" } }], { end: "language" }));
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe("Arrived at language by route go in 0.0 s.");
    expect(s.world.screen).toBe("language");
    expect(s.count("move")).toBe(1);
  });

  it("an off_route on the way to the start fails the call, nothing run", async () => {
    const s = await withRoute(route([{ tool: "tap", target: { id: "language-row" } }]), { world: (w) => (w.screen = "welcome") });
    const answer = await callTool(s.tools, "drive", { route: "go" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error off_route: /);
    expect(s.count("press")).toBe(0);
  });

  it("a missing variable, an unknown route and an unneeded account are bad_params or not_found", async () => {
    const s = await withRoute(route([{ tool: "type_text", target: { id: "city" }, text: "${city}" }], { variables: ["city"] }));
    expect(textOf(await callTool(s.tools, "drive", { route: "go" }))).toMatch(/^Error bad_params: .*city/);
    expect(textOf(await callTool(s.tools, "drive", { route: "nope" }))).toBe('Error not_found: no route named "nope"; map lists the routes.');
    const plain = await withRoute(route([{ tool: "tap", target: { id: "language-row" } }]));
    expect(textOf(await callTool(plain.tools, "drive", { route: "go", account: "tester2" }))).toMatch(/^Error bad_params: account "tester2" is named but the route go types no/);
  });

  it("checks the account before anything is touched", async () => {
    const store = accountStore({ version: 1, accounts: { tester2: { username: "tester2@example.com", password: "fake-pass-9137", apps: ["com.example.wayfare"] } } });
    const file = route([{ tool: "type_text", target: { id: "email" }, text: "${account.username}" }], { variables: ["account"] });
    const s = await withRoute(file, { tools: { accounts: { store } }, hello: { capabilities: ["tree", "press", "type", "typeKind", "logs", "dryRun", "place", "places", "move"] } });
    const none = await callTool(s.tools, "drive", { route: "go" });
    expect(none.isError).toBe(true);
    expect(s.count("move") + s.count("press")).toBe(0);
    const unknown = await callTool(s.tools, "drive", { route: "go", account: "nobody" });
    expect(textOf(unknown)).toMatch(/^Error bad_params: /);
    expect(s.count("move") + s.count("press")).toBe(0);
    expect(JSON.stringify(s.app.requests)).not.toContain("fake-pass-9137");
  });
});

describe("the map after a drive", () => {
  it("note is not needed: place elements stay out of the map", async () => {
    const s = await setup();
    await drive(s, { to: "language" });
    await s.registry.flushAll();
    const text = JSON.stringify(s.file());
    expect(text).not.toContain("English");
    expect(note("e0", "x").role).toBe("text");
  });
});
