import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { accountStore } from "../src/accounts.js";
import { callTool, TOOL_META } from "../src/dispatch.js";
import { loadMap, type MapFile, type MapPlace, type MapRoad } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import { NO_POLICY } from "../src/policy.js";
import { NOT_IN_RUN } from "../src/run.js";
import type { TaplineHost } from "../src/server.js";
import { toolDescription } from "../src/tool-text.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.8: the `map` tool, a read plus local edits, through AppMap and saveMap.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const BUILD = "1.5.0 (220)";
const APP = { name: "Wayfare", id: "com.example.wayfare", version: "1.5.0", build: "220" };

function place(route: string[], link: string | null = null): MapPlace {
  return { key: { route }, link, last: "2026-11-12T10:00:00.000Z" };
}
function road(from: string, to: string, id: string, build = BUILD, last = "2026-11-12T10:00:00.000Z"): MapRoad {
  return { from, to, move: { tool: "tap", target: { id } }, names: { id }, by: "tapline", seen: 2, failed: 0, ms: 500, last, build };
}

function fixture(): MapFile {
  return {
    format: "agent-tools-map",
    version: 1,
    app: APP.id,
    places: {
      home: place(["index"], "wayfare://"),
      settings: place(["settings"], "wayfare://settings"),
      general: place(["settings", "general"]),
      language: place(["settings", "general", "language"]),
      trips_id: place(["trips", "[id]"], "wayfare://trips/[id]"),
    },
    roads: [road("home", "settings", "settings-tab"), road("settings", "general", "general-row"), road("general", "language", "language-row"), road("language", "trips_id", "x", "1.4.0 (212)")],
    routes: { sign_in: "routes/sign_in.json" },
    reflexes: [{ name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Not now" } } }],
  };
}

interface Setup {
  tools: TaplineTools;
  registry: MapRegistry;
  state: { route: string[] };
  mapsDir: string;
  folder: string;
  file: () => MapFile;
  requests: string[];
}

async function setup(options: { map?: MapFile | null; maps?: boolean; route?: string[]; tools?: Partial<ToolsOptions>; capabilities?: string[]; known?: unknown } = {}): Promise<Setup> {
  const { host, port } = await startHost();
  hosts.push(host);
  const mapsDir = mkdtempSync(join(tmpdir(), "tapline-map-"));
  dirs.push(mapsDir);
  const folder = join(mapsDir, APP.id);
  const seed = options.map === undefined ? fixture() : options.map;
  if (seed !== null) {
    mkdirSync(join(folder, "routes"), { recursive: true });
    writeFileSync(join(folder, "map.json"), JSON.stringify(seed));
    writeFileSync(join(folder, "routes", "sign_in.json"), JSON.stringify({ format: "agent-tools-script", version: 2, app: APP.id, name: "sign_in", start: "welcome", end: "home", variables: ["account"], steps: [] }));
  }
  const state = { route: options.route ?? ["index"] };
  const requests: string[] = [];
  const handler = (req: IncomingRequest): Reply => {
    requests.push(req.method);
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: [], route: { names: state.route }, place: { route: state.route } } };
      case "place":
        return { ok: true, result: { route: state.route, seenAt: Date.now() } };
      case "places":
        return { ok: true, result: options.known ?? { source: "none", places: [] } };
      default:
        return { ok: true, result: {} };
    }
  };
  const { app } = await FakeApp.connect(port, { app: APP, capabilities: options.capabilities ?? ["tree", "press", "logs", "dryRun", "place", "places"] }, handler);
  apps.push(app);
  const registry = new MapRegistry({ mapsDir });
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, ...(options.maps === false ? {} : { maps: registry }), ...options.tools });
  return { tools, registry, state, mapsDir, folder, file: () => loadMap(folder, APP.id).map, requests };
}

const call = async (s: Setup, args: Record<string, unknown>): Promise<string> => textOf(await callTool(s.tools, "map", args));

describe("map listing", () => {
  it("has the exact shape for a fixture map", async () => {
    const accounts = { store: accountStore({ version: 1, accounts: { tester1: { username: "t1@example.com", password: "pw-one" }, tester2: { username: "t2@example.com", password: "pw-two" } } }) };
    const s = await setup({ tools: { accounts } });
    expect(await call(s, {})).toBe(
      [
        `Map of Wayfare (com.example.wayfare), build ${BUILD}: 5 places, 4 roads (3 proven), 1 route, 1 reflex. Now at: home.`,
        "Places: home (link wayfare://), settings (link wayfare://settings), general, language, trips_id (link wayfare://trips/[id])",
        "Routes: sign_in (welcome → home; account)",
        "Reflexes: rate_prompt.",
        "Accounts: tester1, tester2.",
      ].join("\n"),
    );
  });

  it("lists names, never values", async () => {
    const accounts = { store: accountStore({ version: 1, accounts: { tester1: { username: "secret-user@example.com", password: "secret-pass-77" } } }) };
    const s = await setup({ tools: { accounts } });
    const said = await call(s, {});
    expect(said).toContain("Accounts: tester1.");
    expect(said).not.toContain("secret-user");
    expect(said).not.toContain("secret-pass");
    expect(said).not.toContain("Not now");
    expect(said).not.toContain("Rate Wayfare");
  });

  it("shows at most 60 places, then …", async () => {
    const map = fixture();
    for (let n = 0; n < 70; n++) map.places[`p${n}`] = place([`p${n}`]);
    const s = await setup({ map });
    const line = (await call(s, {})).split("\n").find((l) => l.startsWith("Places: ")) as string;
    const items = line.slice("Places: ".length).split(", ");
    expect(items).toHaveLength(61);
    expect(items[60]).toBe("…");
  });

  it("starts a map when there is none: the screen the app is on is the first place", async () => {
    const s = await setup({ map: null });
    expect((await call(s, {})).split("\n")[0]).toBe(`Map of Wayfare (com.example.wayfare), build ${BUILD}: 1 place, 0 roads, 0 routes, 0 reflexes. Now at: index.`);
  });

  it("lists places known up front on a line of their own, with no roads", async () => {
    const known = { source: "expo-router", places: [{ route: ["settings"], link: "wayfare://settings", params: [] }, { route: ["profile", "[id]"], link: "wayfare://profile/[id]", params: ["id"] }] };
    const s = await setup({ known });
    const lines = (await call(s, {})).split("\n");
    // `settings` was visited: it is not listed twice.
    expect(lines).toContain("Known up front, not visited: profile_id (link wayfare://profile/[id]; needs id).");
    expect(lines.join("\n")).not.toMatch(/Known up front.*settings/);
    // They don't count as saved places.
    expect(lines[0]).toContain("5 places");
  });

  it("answers unsupported when the host keeps no maps", async () => {
    const s = await setup({ maps: false });
    expect(await call(s, {})).toMatch(/^Error unsupported: /);
  });

  it("answers not_connected with no app", async () => {
    const { host } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, maps: new MapRegistry({ mapsDir: tmpdir() }) });
    expect(textOf(await callTool(tools, "map", {}))).toMatch(/^Error not_connected: /);
  });
});

describe("map arguments", () => {
  it("takes one argument at a time", async () => {
    const s = await setup();
    expect(await call(s, { to: "language", name: "x" })).toBe("Error bad_params: map takes one argument at a time; you gave to, name.");
    expect(await call(s, { forget: "language", forget_reflex: "rate_prompt" })).toMatch(/^Error bad_params: map takes one argument at a time/);
  });

  it("takes place only with link", async () => {
    const s = await setup();
    expect(await call(s, { place: "home" })).toBe("Error bad_params: place goes with link.");
    expect(await call(s, { to: "language", place: "home" })).toMatch(/^Error bad_params: /);
  });

  it("refuses an argument it doesn't have", async () => {
    const s = await setup();
    expect(await call(s, { show: true })).toMatch(/^Error bad_params: map doesn't take show; it takes /);
  });

  it("is not allowed as a run step", async () => {
    expect(NOT_IN_RUN).toContain("map");
    const s = await setup();
    const said = textOf(await s.tools.run({ steps: [{ tool: "map" }] }));
    expect(said).toMatch(/^Error /);
    expect(said).toContain("map");
  });

  it("is a tool with the shared text, that touches nothing", async () => {
    expect(TOOL_META.map).toEqual({ title: "The app's map", readOnly: false });
    expect(toolDescription("map")).toMatch(/^The app's map, learned as you drive: /);
    const s = await setup();
    s.requests.length = 0;
    await call(s, {});
    // A read of where the app is, and of its places: never an action.
    expect(s.requests.filter((m) => !["place", "places", "tree"].includes(m))).toEqual([]);
  });
});

describe("map to", () => {
  it("answers the way drive would take, in the dry-run wording", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { to: "language" })).toBe(`Would drive to language by 2 taps: settings > general > language (all proven).`);
  });

  it("says which roads are unproven", async () => {
    const map = fixture();
    (map.roads[1] as MapRoad).build = "1.4.0 (212)";
    const s = await setup({ map, route: ["settings"] });
    expect(await call(s, { to: "language" })).toBe(`Would drive to language by 2 taps: settings > general > language (unproven for build ${BUILD}: settings > general).`);
  });

  it("breaks a tie by the most recently used way (an unproven road counts double)", async () => {
    const map = fixture();
    // The direct road is unproven (cost 2), as dear as the two proven moves; it was used last.
    map.roads.push(road("settings", "language", "shortcut", "1.4.0 (212)", "2026-11-13T10:00:00.000Z"));
    const s = await setup({ map, route: ["settings"] });
    expect(await call(s, { to: "language" })).toBe(`Would drive to language by 1 tap: settings > language (unproven for build ${BUILD}: settings > language).`);
  });

  it("uses a link when the place has one", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { to: "trips_id" })).toBe("Would drive to trips_id by link (wayfare://trips/[id]).");
  });

  it("says when it is already there", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { to: "settings" })).toBe("Already at settings.");
  });

  it("answers not_found when no road leads there", async () => {
    const s = await setup({ route: ["settings", "general", "language"] });
    expect(await call(s, { to: "general" })).toBe("Error not_found: no known way from language to general; drive it once (the driver), and it is remembered.");
  });

  it("a visited place keeps the link the app declares up front for it (found on the phone, 1.6.1)", async () => {
    // `general` is saved without a link of its own; the app declares one for its route.
    const known = { source: "react-navigation", places: [{ route: ["settings", "general"], link: "wayfare://general", params: [] }] };
    const s = await setup({ route: ["settings", "general", "language"], known });
    expect(await call(s, { to: "general" })).toMatch(/^Would drive to general by link \(wayfare:\/\/general/);
  });

  it("answers not_found for a place it doesn't know", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { to: "nowhere" })).toBe('Error not_found: no place named "nowhere"; map lists the places.');
  });

  it("never plans over a road another tool drove", async () => {
    const map = fixture();
    (map.roads[1] as MapRoad).by = "tapwright";
    const s = await setup({ map, route: ["settings"] });
    expect(await call(s, { to: "language" })).toMatch(/^Error not_found: no known way/);
  });
});

describe("map name", () => {
  it("renames the current place, keeping its roads", async () => {
    const s = await setup({ route: ["settings", "general"] });
    expect(await call(s, { name: "preferences" })).toBe("Named the current place preferences (was general).");
    const file = s.file();
    expect(file.places["preferences"]).toBeDefined();
    expect(file.places["general"]).toBeUndefined();
    expect(file.roads.map((r) => `${r.from}>${r.to}`)).toEqual(["home>settings", "settings>preferences", "preferences>language", "language>trips_id"]);
  });

  it("refuses a name another place has", async () => {
    const s = await setup({ route: ["settings", "general"] });
    expect(await call(s, { name: "language" })).toBe('Error bad_params: a place named "language" already exists; pick another name.');
  });

  it("refuses a name that is not [a-z0-9_]", async () => {
    const s = await setup({ route: ["settings", "general"] });
    expect(await call(s, { name: "Check Out" })).toMatch(/^Error bad_params: /);
  });

  it("says so when the place already has that name", async () => {
    const s = await setup({ route: ["settings", "general"] });
    expect(await call(s, { name: "general" })).toBe("The current place is already general.");
  });
});

describe("map link", () => {
  it("keeps the link as given, for the current place by default", async () => {
    const s = await setup({ route: ["settings", "general"] });
    expect(await call(s, { link: "wayfare://settings/general" })).toBe("Added link wayfare://settings/general to general.");
    expect(s.file().places["general"]?.link).toBe("wayfare://settings/general");
  });

  it("takes the place by name", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { link: "wayfare://x", place: "language" })).toBe("Added link wayfare://x to language.");
    expect(s.file().places["language"]?.link).toBe("wayfare://x");
  });

  it("says what a link replaces", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { link: "wayfare://prefs", place: "settings" })).toBe("Added link wayfare://prefs to settings (was wayfare://settings).");
  });

  it("answers not_found for an unknown place", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { link: "wayfare://x", place: "nowhere" })).toBe('Error not_found: no place named "nowhere"; map lists the places.');
  });

  it("keeps a pattern with a param", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { link: "wayfare://orders/[id]", place: "language" })).toBe("Added link wayfare://orders/[id] to language.");
  });

  it.each([
    ["a long number", "wayfare://trips/482913"],
    ["a uuid", "wayfare://trips/3fa85f64-5717-4562-b3fc-2c963f66afa6"],
    ["long hex", "wayfare://invite/9c01e7a5d2b84f36a1"],
    ["a token-like segment", "wayfare://reset/Zk3pQ9xW2mN8vB5cT1yR7"],
  ])("refuses a value in the path: %s", async (_label, link) => {
    const s = await setup({ route: ["settings"] });
    const said = await call(s, { link, place: "language" });
    expect(said).toMatch(/^Error bad_params: .*looks like a value/);
    expect(said).toContain("[id]");
    expect(s.file().places["language"]?.link).toBeNull();
    // The refusal doesn't repeat the value.
    expect(said).not.toContain("482913");
  });

  it("refuses a query, a fragment and credentials", async () => {
    const s = await setup({ route: ["settings"] });
    for (const link of ["wayfare://reset?token=abc", "wayfare://reset#abc", "https://user:pw@example.com/x"]) {
      const said = await call(s, { link, place: "language" });
      expect(said).toMatch(/^Error bad_params: /);
      expect(said).not.toContain("token=abc");
      expect(said).not.toContain("pw@");
    }
    expect(s.file().places["language"]?.link).toBeNull();
  });

  it("refuses a long segment with no separator, and a JWT", async () => {
    const s = await setup({ route: ["settings"] });
    for (const link of ["wayfare://reset/abcdefghijklmnopqrstuvwxyz", "wayfare://t/aaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbb.cccccccc"]) {
      expect(await call(s, { link, place: "language" })).toMatch(/^Error bad_params: .*looks like a value/);
    }
    expect(await call(s, { link: "https://example.com/terms", place: "language" })).toBe("Added link https://example.com/terms to language.");
  });

  it("prints a route's start and end only when they are names, cut short", async () => {
    const s = await setup();
    writeFileSync(
      join(s.folder, "routes", "sign_in.json"),
      JSON.stringify({ start: "Chat with Sara <script>", end: `home${"x".repeat(80)}`, variables: ["account"] }),
    );
    const line = (await call(s, {})).split("\n").find((l) => l.startsWith("Routes: ")) as string;
    expect(line).not.toContain("Sara");
    expect(line).not.toContain("x".repeat(41));
  });

  it("refuses text that is not a link", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { link: "settings", place: "language" })).toMatch(/^Error bad_params: a link is scheme:\/\/path/);
  });
});

describe("map reflex", () => {
  const rate = { name: "cookie_banner", when: { text: "Accept cookies?" }, do: { tool: "tap", target: { text: "Not now" } }, max: 2, at: "home" };

  it("adds a reflex and lists it", async () => {
    const s = await setup();
    expect(await call(s, { reflex: rate })).toBe("Added reflex cookie_banner.");
    expect(s.file().reflexes.map((r) => r.name)).toEqual(["rate_prompt", "cookie_banner"]);
    expect((await call(s, {})).split("\n")).toContain("Reflexes: rate_prompt, cookie_banner.");
  });

  it("replaces a reflex of the same name", async () => {
    const s = await setup();
    expect(await call(s, { reflex: { ...rate, name: "rate_prompt" } })).toBe("Replaced reflex rate_prompt.");
    expect(s.file().reflexes).toHaveLength(1);
    expect(s.file().reflexes[0]?.when).toEqual({ text: "Accept cookies?" });
  });

  it("is refused when the policy flags its do", async () => {
    const s = await setup({ tools: { policy: { version: 1, confirm: ["delete", "buy"], block: ["sign out"] } } });
    const flagged = await call(s, { reflex: { name: "gone", when: { text: "Sure?" }, do: { tool: "tap", target: { text: "Delete account" } } } });
    expect(flagged).toBe('Error not_allowed: blocked: reflex "gone" would tap "Delete account", which the policy flags ("delete"); a reflex may not do what needs a person\'s OK. Nothing was saved.');
    expect(await call(s, { reflex: { name: "gone", when: { text: "Sure?" }, do: { tool: "tap", target: { id: "sign-out-button" } } } })).toMatch(/^Error not_allowed: blocked: .*"sign out"/);
    expect(s.file().reflexes.map((r) => r.name)).toEqual(["rate_prompt"]);
  });

  it("sees the words of a camelCase id", async () => {
    const s = await setup({ tools: { policy: { version: 1, confirm: ["delete"], block: [] } } });
    const said = await call(s, { reflex: { name: "gone", when: { text: "Sure?" }, do: { tool: "tap", target: { id: "deleteAccountButton" } } } });
    expect(said).toMatch(/^Error not_allowed: blocked: .*\("delete"\)/);
    expect(s.file().reflexes.map((r) => r.name)).toEqual(["rate_prompt"]);
  });

  it("checks an open_url do: the policy sees the path words, and a value or a query is refused without being echoed", async () => {
    const s = await setup({ tools: { policy: { version: 1, confirm: ["delete"], block: [] } } });
    const flagged = await call(s, { reflex: { name: "a", when: { text: "x" }, do: { tool: "open_url", url: "wayfare://account/delete" } } });
    expect(flagged).toMatch(/^Error not_allowed: blocked: .*\("delete"\)/);
    for (const url of ["wayfare://trips/482913", "wayfare://reset?token=zzqq", "wayfare://a#zzfrag", "https://u:pw@example.com/x"]) {
      const said = await call(s, { reflex: { name: "a", when: { text: "x" }, do: { tool: "open_url", url } } });
      expect(said).toMatch(/^Error bad_params: /);
      for (const secret of ["482913", "zzqq", "zzfrag", "pw@"]) expect(said).not.toContain(secret);
    }
    expect(await call(s, { reflex: { name: "ok", when: { text: "x" }, do: { tool: "open_url", url: "wayfare://trips/[id]" } } })).toBe("Added reflex ok.");
  });

  it.each([
    ["force", { tool: "tap", target: { text: "Ok" }, force: true }],
    ["index", { tool: "tap", target: { text: "Ok" }, index: 1 }],
    ["account", { tool: "tap", target: { text: "Ok" }, account: "tester1" }],
    ["text on a tap", { tool: "tap", target: { text: "Ok" }, text: "hi" }],
    ["secure", { tool: "toggle", target: { id: "a" }, secure: true }],
    ["two names in a target", { tool: "tap", target: { id: "a", text: "b" } }],
    ["a point", { tool: "tap", target: { x: 1, y: 2 } }],
    ["a back with a target", { tool: "back", target: { text: "x" } }],
    ["a swipe without a point", { tool: "swipe", x0: 1, y0: 2, x1: 3 }],
    ["an open_url with force", { tool: "open_url", url: "wayfare://x", force: true }],
    ["a scroll with an unknown key", { tool: "scroll", direction: "down", force: true }],
  ])("accepts only a step's own keys: %s", async (_label, step) => {
    const s = await setup();
    expect(await call(s, { reflex: { name: "a", when: { text: "x" }, do: step } })).toMatch(/^Error bad_params: /);
    expect(s.file().reflexes).toHaveLength(1);
  });

  it("accepts the steps with their own keys", async () => {
    const s = await setup();
    for (const [name, step] of [
      ["t", { tool: "long_press", target: { label: "More" } }],
      ["b", { tool: "back" }],
      ["w", { tool: "swipe", x0: 1, y0: 2, x1: 3, y1: 4, seconds: 0.5 }],
      ["c", { tool: "scroll", direction: "down", amount: 0.5 }],
    ] as const) expect(await call(s, { reflex: { name, when: { id: "banner" }, do: step } })).toBe(`Added reflex ${name}.`);
  });

  it("is accepted when the policy is off", async () => {
    const s = await setup({ tools: { policy: NO_POLICY } });
    expect(await call(s, { reflex: { name: "gone", when: { text: "Sure?" }, do: { tool: "tap", target: { text: "Delete account" } } } })).toBe("Added reflex gone.");
  });

  it.each([
    ["no when", { name: "a", do: { tool: "tap", target: { text: "Ok" } } }],
    ["two whens", { name: "a", when: { text: "x", id: "y" }, do: { tool: "tap", target: { text: "Ok" } } }],
    ["a ref target", { name: "a", when: { text: "x" }, do: { tool: "tap", target: { ref: "e3" } } }],
    ["a bad name", { name: "Rate Prompt", when: { text: "x" }, do: { tool: "tap", target: { text: "Ok" } } }],
    ["max over 3", { name: "a", when: { text: "x" }, do: { tool: "tap", target: { text: "Ok" } }, max: 4 }],
    ["type_text", { name: "a", when: { text: "x" }, do: { tool: "type_text", text: "hi" } }],
  ])("refuses a bad reflex: %s", async (_label, reflex) => {
    const s = await setup();
    expect(await call(s, { reflex })).toMatch(/^Error bad_params: /);
    expect(s.file().reflexes).toHaveLength(1);
  });

  it("refuses an `at` that is not a place", async () => {
    const s = await setup();
    expect(await call(s, { reflex: { ...rate, at: "nowhere" } })).toBe('Error not_found: no place named "nowhere"; map lists the places.');
  });

  it("forgets a reflex by name", async () => {
    const s = await setup();
    expect(await call(s, { forget_reflex: "rate_prompt" })).toBe("Forgot reflex rate_prompt.");
    expect(s.file().reflexes).toEqual([]);
    expect(await call(s, { forget_reflex: "rate_prompt" })).toBe('Error not_found: no reflex named "rate_prompt".');
  });

  it("stays forgotten after the map is written again", async () => {
    const s = await setup();
    await call(s, { forget_reflex: "rate_prompt" });
    await call(s, { name: "x1" }).catch(() => undefined);
    await s.registry.flushAll();
    expect(s.file().reflexes).toEqual([]);
  });
});

describe("map forget", () => {
  it("drops a place with its roads, routes and reflexes", async () => {
    const map = fixture();
    map.reflexes.push({ name: "at_general", when: { id: "banner" }, do: { tool: "back" }, at: "general" });
    const s = await setup({ map, route: ["settings"] });
    expect(await call(s, { forget: "general" })).toBe("Forgot place general, with 2 roads and 1 reflex.");
    const file = s.file();
    expect(file.places["general"]).toBeUndefined();
    expect(file.roads.map((r) => `${r.from}>${r.to}`)).toEqual(["home>settings", "language>trips_id"]);
    expect(file.reflexes.map((r) => r.name)).toEqual(["rate_prompt"]);
  });

  it("drops the routes that start or end there", async () => {
    const s = await setup({ route: ["settings"] });
    expect(await call(s, { forget: "home" })).toBe("Forgot place home, with 1 road and 1 route.");
    expect(s.file().routes).toEqual({});
    expect((await call(s, {})).split("\n").join("\n")).not.toContain("sign_in");
  });

  it("answers not_found for an unknown place", async () => {
    const s = await setup();
    expect(await call(s, { forget: "nowhere" })).toBe('Error not_found: no place named "nowhere"; map lists the places.');
  });

  it("stays forgotten when another tool had the old file", async () => {
    const s = await setup({ route: ["settings"] });
    await call(s, { forget: "language" });
    await s.registry.flushAll();
    expect(Object.keys(s.file().places)).not.toContain("language");
  });
});

describe("map edits", () => {
  it("go through the map file's own writer, and the file stays valid", async () => {
    const s = await setup({ route: ["settings"] });
    await call(s, { link: "wayfare://x", place: "language" });
    const parsed = JSON.parse(readFileSync(join(s.folder, "map.json"), "utf8")) as MapFile;
    expect(parsed.format).toBe("agent-tools-map");
    expect(parsed.places["language"]?.link).toBe("wayfare://x");
    expect(dirname(join(s.folder, "map.json"))).toBe(s.folder);
  });
});
