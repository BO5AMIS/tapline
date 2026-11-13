import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadMap, type MapFile, type MapPlace, type MapRoad } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// A map fixture and a fake app that changes place when a button is pressed (AGENT-TOOLS 1.13 §18.4).

export const APP = { name: "Wayfare", id: "com.example.wayfare", version: "1.5.0", build: "220" };
export const BUILD = "1.5.0 (220)";
export const OLD_BUILD = "1.4.0 (212)";
const frame = { x: 20, y: 100, width: 300, height: 44 };

export const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

export interface El {
  ref: string;
  type: string;
  role: string;
  testID?: string;
  label?: string;
  row?: boolean;
  text?: string;
  frame: typeof frame;
  actions: string[];
}
export const button = (ref: string, testID: string, text: string): El => ({ ref, type: "Pressable", role: "button", testID, label: text, text, frame, actions: ["press"] });
export const note = (ref: string, text: string): El => ({ ref, type: "Text", role: "text", text, frame, actions: [] });

export function place(route: string[], link: string | null = null): MapPlace {
  return { key: { route }, link, last: "2026-11-12T10:00:00.000Z" };
}
export function road(from: string, to: string, id: string, text: string, build = BUILD, last = "2026-11-12T10:00:00.000Z"): MapRoad {
  return { from, to, move: { tool: "tap", target: { id } }, names: { id, label: text, text }, by: "tapline", seen: 2, failed: 0, ms: 500, last, build };
}

export type Screen = "settings" | "general" | "language" | "trips" | "welcome";
export const ROUTES: Record<Screen, string[]> = {
  settings: ["settings"],
  general: ["settings", "general"],
  language: ["settings", "general", "language"],
  trips: ["trips", "[id]"],
  welcome: ["welcome"],
};

export function baseMap(): MapFile {
  return {
    format: "agent-tools-map",
    version: 1,
    app: APP.id,
    places: {
      settings: place(ROUTES.settings),
      general: place(ROUTES.general),
      language: place(ROUTES.language),
      trips_id: place(ROUTES.trips, "wayfare://trips/[id]"),
    },
    roads: [road("settings", "general", "general-row", "General"), road("general", "language", "language-row", "Language")],
    routes: {},
    reflexes: [],
  };
}

export interface World {
  screen: Screen;
  elements: Record<Screen, El[]>;
  /** What pressing a testID on a screen leads to, "screen|testID". */
  goes: Record<string, Screen>;
  links: Record<string, Screen>;
  /** The next press lands here instead, once. */
  landOnce?: Screen;
  /** Called after each press, with the testID. */
  onPress?: (testID: string) => void;
  /** The phone resolves a touch to this testID instead of the target the host checked (a guard must catch it). */
  swapTo?: string;
  /** What the app says of the next target, instead of looking for it. */
  nextState?: "covered" | "moving";
  /** Open alerts the tree reports. */
  alerts?: unknown[];
  /** Answer `move` with this error code once, as the app's guard would. */
  moveError?: { code: string; message: string };
  /** A touch that resolves to the element with this ref lands on this element instead: its actionable parent. */
  parents?: Record<string, El>;
  /** A touch on this testID is refused (a sheet covers it), dry runs too. */
  refuse?: (testID: string, screen: Screen) => { code: string; message: string } | undefined;
}

export function baseWorld(): World {
  return {
    screen: "settings",
    elements: {
      settings: [button("e1", "general-row", "General"), button("e2", "delete-trip", "Delete trip")],
      general: [button("e3", "language-row", "Language")],
      language: [note("e4", "English")],
      trips: [note("e5", "Trip to Paris")],
      welcome: [button("e6", "continue", "Continue")],
    },
    goes: { "settings|general-row": "general", "general|language-row": "language", "settings|delete-trip": "trips", "welcome|continue": "settings" },
    links: { "wayfare://settings": "settings", "wayfare://trips/42": "trips", "wayfare://language": "general" },
  };
}

type Wire = { testID?: string; text?: string; label?: string };
const findOn = (world: World, target: Wire | undefined): El | undefined =>
  world.elements[world.screen].find((e) => (target?.testID !== undefined && e.testID === target.testID) || (target?.text !== undefined && e.text === target.text) || (target?.label !== undefined && e.label === target.label));

/** The element a touch really lands on: the named one, or its actionable parent. */
const recipientOf = (world: World, named: El | undefined): El | undefined => (named === undefined ? undefined : (world.parents?.[named.ref] ?? named));
const fingerprintOf = (element: El): Record<string, string | null> => ({ id: element.testID ?? null, label: element.label ?? null, text: element.text ?? null, role: element.role });

export interface Setup {
  tools: TaplineTools;
  app: FakeApp;
  world: World;
  registry: MapRegistry;
  folder: string;
  file: () => MapFile;
  /** The methods the app was asked, in order (dry runs apart). */
  methods: () => string[];
  count: (method: string) => number;
  /** The requests that made this plain method, also inside a `move`. */
  made: (method: string) => number;
}

export interface SetupOptions {
  map?: MapFile;
  world?: (world: World) => void;
  capabilities?: string[];
  policy?: PolicyFile;
  tools?: Partial<ToolsOptions>;
  hello?: Record<string, unknown>;
}

export const ALL_CAPS = ["tree", "press", "logs", "dryRun", "place", "places", "move"];

/** Every map registry a test made: their background saves must end before the test deletes its folders. */
const openRegistries = new Set<MapRegistry>();

/** Waits for every drive test's map saves, then forgets the registries (call it in afterEach, before deleting folders). */
export async function flushDriveMaps(): Promise<void> {
  const all = [...openRegistries];
  openRegistries.clear();
  await Promise.all(all.map((registry) => registry.flushAll().catch(() => undefined)));
}

export async function setupDrive(hosts: TaplineHost[], apps: FakeApp[], dirs: string[], options: SetupOptions = {}): Promise<Setup> {
  const { host, port } = await startHost();
  hosts.push(host);
  const mapsDir = mkdtempSync(join(tmpdir(), "tapline-drive-"));
  dirs.push(mapsDir);
  const folder = join(mapsDir, APP.id);
  mkdirSync(join(folder, "routes"), { recursive: true });
  writeFileSync(join(folder, "map.json"), JSON.stringify(options.map ?? baseMap()));
  const world = baseWorld();
  options.world?.(world);

  const perform = (method: string, params: Record<string, unknown>): Reply => {
    switch (method) {
      case "press":
      case "longPress":
      case "toggle": {
        const element = recipientOf(world, findOn(world, params["target"] as Wire | undefined));
        if (element === undefined) return { ok: false, error: { code: "not_found", message: "No element matches" } };
        const refused = world.refuse?.(element.testID ?? "", world.screen);
        if (refused !== undefined) return { ok: false, error: refused };
        if (params["dryRun"] !== true) {
          const landed = world.landOnce ?? world.goes[`${world.screen}|${element.testID ?? ""}`];
          delete world.landOnce;
          world.onPress?.(element.testID ?? "");
          if (landed !== undefined) world.screen = landed;
        }
        return { ok: true, result: { element, settledMs: 20, ...(params["dryRun"] === true ? { dryRun: true } : {}) } };
      }
      case "back":
        return { ok: true, result: { settledMs: 20 } };
      case "type": {
        const target = params["target"] as Wire | undefined;
        const secure = target?.testID === "password";
        const text = String(params["text"] ?? "");
        return { ok: true, result: { element: { ref: "e90", type: "TextInput", role: "input", testID: target?.testID }, value: secure ? "•".repeat(text.length) : text, ...(secure ? { secure: true } : {}), settledMs: 10 } };
      }
      case "openURL": {
        const landed = world.landOnce ?? world.links[String(params["url"])];
        delete world.landOnce;
        if (landed !== undefined) world.screen = landed;
        return { ok: true, result: { settledMs: 20 } };
      }
      default:
        return { ok: true, result: {} };
    }
  };

  const handler = (req: IncomingRequest): Reply => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: { width: 430, height: 932 }, elements: world.elements[world.screen], ...(world.alerts !== undefined ? { alerts: world.alerts } : {}), route: { names: ROUTES[world.screen] }, place: { route: ROUTES[world.screen] } } };
      case "place":
        return { ok: true, result: { route: ROUTES[world.screen], seenAt: Date.now() } };
      case "places":
        return { ok: true, result: { source: "expo-router", places: [{ route: ROUTES.settings, link: "wayfare://settings", params: [] }, { route: ROUTES.trips, link: "wayfare://trips/[id]", params: ["id"] }] } };
      case "move": {
        const inner = (params["params"] ?? {}) as Record<string, unknown>;
        const guard = params["guard"] as Record<string, string | null | undefined> | undefined;
        if (world.moveError !== undefined) {
          const error = world.moveError;
          delete world.moveError;
          return { ok: false, error };
        }
        const method = String(params["method"]);
        if (guard !== undefined) {
          const element = world.swapTo !== undefined ? world.elements[world.screen].find((e) => e.testID === world.swapTo) : recipientOf(world, findOn(world, inner["target"] as Wire | undefined));
          // Like the app: every field of the recipient must equal the guard's, and a missing field means absent, never "any".
          if (element !== undefined) {
            const actual = fingerprintOf(element);
            if (Object.keys(actual).some((key) => (guard[key] ?? null) !== actual[key])) {
              return { ok: false, error: { code: "stale", message: "stale: the target is another element now" } };
            }
          }
        }
        const done = perform(method, inner);
        if (done === "ignore" || !done.ok) return done;
        const next = params["next"] as { target?: Wire } | undefined;
        const found = next?.target !== undefined ? recipientOf(world, findOn(world, next.target)) : undefined;
        return {
          ok: true,
          result: {
            done: done.result,
            place: { route: ROUTES[world.screen] },
            ...(next !== undefined && world.nextState === "covered" ? { next: { state: "covered", waitedMs: 5 } } : {}),
            ...(next !== undefined && world.nextState === undefined ? { next: found !== undefined ? { state: "ready", element: found, waitedMs: 5 } : { state: "missing", waitedMs: 5 } } : {}),
          },
        };
      }
      default:
        return perform(req.method, params);
    }
  };

  const { app } = await FakeApp.connect(port, { app: APP, capabilities: options.capabilities ?? ALL_CAPS, ...options.hello }, handler);
  apps.push(app);
  const registry = new MapRegistry({ mapsDir });
  openRegistries.add(registry);
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    maps: registry,
    clock: () => 1000,
    policy: options.policy ?? { version: 1, confirm: [], block: [] },
    ...options.tools,
  });
  const methods = (): string[] => app.requests.map((r) => r.method);
  return { tools, app, world, registry, folder, file: () => loadMap(folder, APP.id).map, methods, count: (method) => methods().filter((m) => m === method).length,
    made: (method) => app.requests.filter((r) => r.method === method || (r.method === "move" && (r.params as { method?: string }).method === method)).length,
  };
}
