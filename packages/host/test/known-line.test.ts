import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import type { MapFile } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { APP, ROUTES, baseMap, note, place, setupDrive, textOf, flushDriveMaps, type Setup, type SetupOptions } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.17 §30.2: the `Known:` line, once, in the first answer that shows the app.

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
const look = async (s: Setup): Promise<string> => textOf(await callTool(s.tools, "look", { screenshot: false }));
const knownOf = (text: string): string | undefined => text.split("\n").find((line) => line.startsWith("Known:"));
const TAIL = "(one call each: drive {\"to\": ...})";

/** A map of the current place plus places that each have a link with no value to fill. */
function linked(names: string[], extra: Partial<MapFile> = {}): MapFile {
  const places: MapFile["places"] = { settings: place(ROUTES.settings) };
  names.forEach((name, i) => {
    places[name] = { ...place([name], `wayfare://${name}`), last: `2026-11-12T10:00:${String(10 + i).padStart(2, "0")}.000Z` };
  });
  return { format: "agent-tools-map", version: 1, app: APP.id, places, roads: [], routes: {}, reflexes: [], ...extra };
}

describe("the Known: line", () => {
  it("lists three reachable places in the first look, after Place:, and not in the second", async () => {
    const s = await setup({ map: linked(["a", "b", "c"]) });
    const first = (await look(s)).split("\n");
    // Most recently reached first.
    expect(knownOf(first.join("\n"))).toBe(`Known: c, b, a ${TAIL}`);
    const at = first.findIndex((line) => line.startsWith("Known:"));
    expect(first[at - 1]).toBe("Place: settings.");
    expect(knownOf(await look(s))).toBeUndefined();
  });

  it("shows 8 names and then +N more", async () => {
    const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];
    const s = await setup({ map: linked(names) });
    expect(knownOf(await look(s))).toBe(`Known: p10, p9, p8, p7, p6, p5, p4, p3, +2 more ${TAIL}`);
  });

  it("leaves out the current place and places no call reaches; nothing reachable gives no line", async () => {
    const map = linked(["a"]);
    // A link that needs a value, and a place no road or link leads to.
    map.places["trips_id"] = place(ROUTES.trips, "wayfare://trips/[id]");
    map.places["island"] = place(["island"]);
    const s = await setup({ map });
    expect(knownOf(await look(s))).toBe(`Known: a ${TAIL}`);
    const empty = await setup({ map: { ...baseMap(), places: {}, roads: [] } });
    expect(knownOf(await look(empty))).toBeUndefined();
    const none = await setup({ map: linked([]) });
    expect(knownOf(await look(none))).toBeUndefined();
  });

  it("follows roads from where the app is, not only links", async () => {
    const s = await setup();
    expect(knownOf(await look(s))).toBe(`Known: general, language ${TAIL}`);
  });

  it("names a place that drive reaches", async () => {
    const map = linked(["welcome"]);
    map.places["welcome"] = { ...place(ROUTES.welcome, "wayfare://welcome"), last: "2026-11-12T10:00:30.000Z" };
    const s = await setup({
      map,
      world: (w) => {
        w.links["wayfare://welcome"] = "welcome";
      },
    });
    const line = knownOf(await look(s));
    expect(line).toBe(`Known: welcome ${TAIL}`);
    const answer = await callTool(s.tools, "drive", { to: "welcome" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[0]).toContain("Arrived at welcome");
    expect(s.world.screen).toBe("welcome");
  });

  it("never takes a name from screen text", async () => {
    const map = linked(["chat"]);
    map.places["chat"] = { ...place(["chat"], "wayfare://chat"), titles: { en: "Chat with Sara" } };
    const s = await setup({
      map,
      world: (w) => {
        w.elements.settings.push(note("e20", "Chat with Sara"));
      },
    });
    const text = await look(s);
    expect(text).toContain("Chat with Sara");
    expect(knownOf(text)).toBe(`Known: chat ${TAIL}`);
    expect(knownOf(text)).not.toContain("Sara");
  });

  it("is off with noHints, and the rest of the answer is the same", async () => {
    const on = await setup({ map: linked(["a", "b"]) });
    const off = await setup({ map: linked(["a", "b"]), tools: { noHints: true } });
    const withLine = await look(on);
    const without = await look(off);
    expect(knownOf(without)).toBeUndefined();
    expect(withLine.split("\n").filter((line) => !line.startsWith("Known:")).join("\n")).toBe(without);
  });

  it("goes on the first action's answer when no look came before, once", async () => {
    const s = await setup({ map: linked(["a"]) });
    const first = textOf(await callTool(s.tools, "tap", { target: { id: "general-row" } }));
    expect(knownOf(first)).toBe(`Known: a, settings ${TAIL}`);
    expect(knownOf(await look(s))).toBeUndefined();
  });
});

