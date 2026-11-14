import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMap, type MapFile } from "../src/mapfile.js";
import { MapRegistry } from "../src/places.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { APP, BUILD } from "./drive-helpers.js";
import { FakeApp, startHost, TOKEN, type IncomingRequest, type Reply } from "./helpers.js";

// A fake app of a few screens for `explore` (AGENT-TOOLS 1.15 §25): a list, a form, Delete and Sign out buttons, an icon-only trash
// button, a toggle, a link out, and a crash button that makes the fake app report a JS crash.

export { APP, BUILD };

export interface ExEl {
  id?: string;
  label?: string;
  text?: string;
  role?: string;
  type?: string;
  actions?: string[];
  row?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  value?: unknown;
  checked?: boolean;
  placeholder?: string;
  disabled?: boolean;
  exploreSkip?: boolean;
  exploreFill?: boolean | string;
}

export const btn = (id: string, text: string, extra: Partial<ExEl> = {}): ExEl => ({ id, label: text, text, role: "button", type: "Pressable", actions: ["press"], ...extra });
/** An icon button: no label and no text, only an id. */
export const icon = (id: string, extra: Partial<ExEl> = {}): ExEl => ({ id, role: "button", type: "Pressable", actions: ["press"], ...extra });
export const toggle = (id: string, label: string, extra: Partial<ExEl> = {}): ExEl => ({ id, label, role: "switch", type: "Switch", actions: ["toggle"], ...extra });
export const input = (id: string, label: string, extra: Partial<ExEl> = {}): ExEl => ({ id, label, role: "input", type: "TextInput", actions: ["press", "type"], ...extra });
export const row = (id: string, text: string, extra: Partial<ExEl> = {}): ExEl => ({ id, label: text, text, role: "button", type: "Pressable", actions: ["press"], row: true, ...extra });
export const list = (id: string): ExEl => ({ id, role: "scroll", type: "ScrollView", actions: ["scroll"], frame: { x: 0, y: 60, width: 430, height: 800 } });
export const label = (text: string): ExEl => ({ text, role: "text", type: "Text", actions: [] });

export interface ExScreen {
  route: string[];
  elements: ExEl[];
  /** Elements below the screen: each scroll down shows one more. */
  hidden?: ExEl[];
  /** Where `back` goes; none: `back` is refused. */
  parent?: string;
}

export interface ExWorld {
  screen: string;
  initial: string;
  screens: Record<string, ExScreen>;
  /** `screen|id` to the screen a press leads to. */
  goes: Record<string, string>;
  /** A toggle's value by id. */
  toggles: Record<string, boolean>;
  revealed: Record<string, number>;
  /** Pressing these ids crashes the app (a fatal JS error, then the connection goes). */
  crashOn: Set<string>;
  /** Pressing these ids sends the app to the background (a link out). */
  leaveOn: Set<string>;
  /** Pressing these ids logs an error line. */
  errorOn: Record<string, string | string[]>;
  /** Pressing these ids takes this long to settle (ms). */
  slowOn: Record<string, number>;
  /** A press on these ids is refused. */
  refuse: Record<string, { code: string; message: string }>;
  /** A toggle that ignores a flip back (the value stays). */
  stuckToggles: Set<string>;
  /** `back` from these screens goes nowhere known (it stays, or leaves): the way back needs a reset. */
  backBroken: Set<string>;
  /** Commands the app offers (`reset` among them when it is standard). */
  commands: string[];
  /** After a reload or a reset the app shows this screen. */
  onReset?: () => void;
  /** Places known up front. */
  known: Array<{ route: string[]; link?: string; params?: string[] }>;
  audit: Record<string, Array<{ type: string; problem: string; fix: string }>>;
  ux: Record<string, Array<{ kind: string; problem: string }>>;
  /** What the app typed into inputs, as it received it. */
  typed: Array<{ id: string | undefined; text: string }>;
  /** The ids pressed for real (dry runs apart), in order. */
  pressed: string[];
  /** Milliseconds each request takes on the fake clock. */
  msPerRequest: number;
  /** Per request: what the app was asked, for order checks. */
  asked: string[];
  /** Screenshots are available. */
  reloads: number;
  resets: number;
  /** Set when the app was sent away: the next requests answer in_background until `comeBack`. */
  away: boolean;
  /** A press on this id lands on this element (its actionable parent): the dry run and the policy see it, not the named one. */
  recipient: Record<string, ExEl>;
  /** Called after each real press, with its id. */
  onPress?: (id: string) => void;
  /** Pressing these ids opens a system alert (a permission prompt) that blocks every touch until a reload or a reset. */
  alertOn: Set<string>;
  alertOpen: boolean;
  /** After a link out the app comes back to the front after this many ms (real time); none: it stays away. */
  comeBackMs?: number;
  /** After a crash the app opens again after this many ms (real time); none: it stays closed. */
  reopenAfterCrashMs?: number;
}

const FATAL = (message: string) => ({
  message,
  stack: ["TypeError: " + message, "    at TripDetail (/app/src/TripDetail.tsx:48:13)", "    at renderWithHooks (/app/node_modules/react-native/Libraries/Renderer/x.js:1:1)"].join("\n"),
  fatal: true,
  name: "TypeError",
  componentStack: "    at TripDetail (File.js:1)\n    at TripScreen (File.js:2)\n    at Stack (File.js:3)",
});

/** The default world: home, settings, language, trips (a list), a trip, a form, a danger zone, a link out and a crash button. */
export function wayfare(): ExWorld {
  const screens: Record<string, ExScreen> = {
    home: {
      route: ["home"],
      elements: [
        btn("open-settings", "Settings"),
        btn("open-trips", "Trips"),
        btn("open-form", "Form"),
        btn("delete-all", "Delete all"),
        btn("sign-out", "Sign out"),
        icon("delete-row"),
        btn("pay-now", "Pay now"),
        btn("send-note", "Send"),
        btn("report-user", "Report"),
        btn("block-user", "Block"),
      ],
    },
    settings: {
      route: ["settings"],
      parent: "home",
      elements: [toggle("notify-switch", "Notifications", { checked: false }), btn("open-language", "Language"), btn("reset-switch-label", "About")],
    },
    language: { route: ["settings", "language"], parent: "settings", elements: [label("English"), btn("pick-english", "English")] },
    trips: {
      route: ["trips"],
      parent: "home",
      elements: [list("trip-list"), row("trip-row-1", "Trip to Paris"), row("trip-row-2", "Trip to Rome"), row("trip-row-3", "Trip to Oslo")],
      hidden: [row("trip-row-4", "Trip to Lima"), row("trip-row-5", "Trip to Kyiv")],
    },
    trip: { route: ["trips", "[id]"], parent: "trips", elements: [label("Day 1"), btn("share-trip", "Share trip")] },
    form: {
      route: ["form"],
      parent: "home",
      elements: [input("name-test-safe", "Name"), input("email-test-safe", "Email"), input("password", "Password"), input("nickname", "Nickname"), btn("save-profile", "Save"), btn("help", "Help")],
    },
  };
  return {
    screen: "home",
    initial: "home",
    screens,
    goes: {
      "home|open-settings": "settings",
      "home|open-trips": "trips",
      "home|open-form": "form",
      "settings|open-language": "language",
      "trips|trip-row-1": "trip",
      "trips|trip-row-2": "trip",
      "trips|trip-row-3": "trip",
      "help-unused|x": "home",
    },
    toggles: { "notify-switch": false },
    revealed: {},
    crashOn: new Set(),
    leaveOn: new Set(),
    errorOn: {},
    slowOn: {},
    refuse: {},
    stuckToggles: new Set(),
    backBroken: new Set(),
    commands: [],
    known: [],
    audit: {},
    ux: {},
    typed: [],
    pressed: [],
    msPerRequest: 0,
    recipient: {},
    alertOn: new Set(),
    alertOpen: false,
    asked: [],
    reloads: 0,
    resets: 0,
    away: false,
  };
}

const frameOf = (index: number): NonNullable<ExEl["frame"]> => ({ x: 20, y: 100 + index * 60, width: 300, height: 44 });

/** The elements on the screen now, with their refs and frames. */
export function visible(world: ExWorld): ExEl[] {
  const screen = world.screens[world.screen] as ExScreen;
  const shown = [...screen.elements, ...(screen.hidden ?? []).slice(0, world.revealed[world.screen] ?? 0)];
  return shown;
}

function wire(world: ExWorld, el: ExEl, index: number): Record<string, unknown> {
  const checked = el.id !== undefined && el.role === "switch" ? world.toggles[el.id] : el.checked;
  return {
    ref: `e${index + 1}`,
    type: el.type ?? "View",
    role: el.role,
    ...(el.id !== undefined ? { testID: el.id } : {}),
    ...(el.label !== undefined ? { label: el.label } : {}),
    ...(el.text !== undefined ? { text: el.text } : {}),
    ...(el.placeholder !== undefined ? { placeholder: el.placeholder } : {}),
    frame: el.frame ?? frameOf(index),
    actions: el.actions ?? [],
    ...(el.row === true ? { row: true } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(el.value !== undefined ? { value: el.value } : {}),
    ...(el.disabled === true ? { disabled: true } : {}),
    ...(el.exploreSkip === true ? { exploreSkip: true } : {}),
    ...(el.exploreFill !== undefined ? { exploreFill: el.exploreFill } : {}),
  };
}

type Wire = { ref?: string; testID?: string; text?: string; label?: string; index?: number };

function find(world: ExWorld, target: Wire | undefined): { el: ExEl; index: number } | undefined {
  const all = visible(world);
  const matches = all
    .map((el, index) => ({ el, index }))
    .filter(({ el, index }) => {
      if (target === undefined) return false;
      if (target.ref !== undefined) return `e${index + 1}` === target.ref;
      if (target.testID !== undefined) return el.id === target.testID;
      if (target.label !== undefined) return (el.label ?? el.text ?? "").toLowerCase() === target.label.toLowerCase();
      if (target.text !== undefined) return (el.text ?? "").includes(target.text);
      return false;
    });
  return matches[target?.index ?? 0];
}

export interface ExploreSetup {
  tools: TaplineTools;
  world: ExWorld;
  host: TaplineHost;
  port: number;
  /** The app connected now (a reload or a restart makes a new one). */
  current: () => FakeApp;
  mapsDir: string;
  exploreDir: string;
  folder: string;
  file: () => MapFile;
  clock: { now: number };
  registry: MapRegistry;
  /** Reconnects the app (the person opened it again), at the initial screen. */
  reopen: () => Promise<void>;
  /** Sends the progress lines `explore` told, in order. */
  progress: Array<{ line: string; steps: number }>;
}

export interface ExploreSetupOptions {
  world?: (world: ExWorld) => void;
  map?: MapFile;
  policy?: PolicyFile;
  tools?: Partial<ToolsOptions>;
  capabilities?: string[];
  /** Advance the fake clock by this much per request. */
  msPerRequest?: number;
  hostOptions?: Parameters<typeof startHost>[0];
}

export const EXPLORE_CAPS = ["tree", "press", "logs", "dryRun", "place", "places", "audit", "uxCheck", "screenshot"];

const openRegistries = new Set<MapRegistry>();

/** Waits for every explore test's map saves, then forgets the registries (call it in afterEach, before deleting folders). */
export async function flushExploreMaps(): Promise<void> {
  const all = [...openRegistries];
  openRegistries.clear();
  await Promise.all(all.map((registry) => registry.flushAll().catch(() => undefined)));
}

export async function setupExplore(hosts: TaplineHost[], apps: FakeApp[], dirs: string[], options: ExploreSetupOptions = {}): Promise<ExploreSetup> {
  const { host, port } = await startHost(options.hostOptions ?? {});
  hosts.push(host);
  const mapsDir = mkdtempSync(join(tmpdir(), "tapline-explore-maps-"));
  const exploreDir = mkdtempSync(join(tmpdir(), "tapline-explore-out-"));
  dirs.push(mapsDir, exploreDir);
  const folder = join(mapsDir, APP.id);
  mkdirSync(join(folder, "routes"), { recursive: true });
  if (options.map !== undefined) writeFileSync(join(folder, "map.json"), JSON.stringify(options.map));
  const world = wayfare();
  options.world?.(world);
  const clock = { now: 1_000_000 };
  const progress: ExploreSetup["progress"] = [];
  let current: FakeApp | undefined;
  const capabilities = options.capabilities ?? EXPLORE_CAPS;

  const placeOf = (): { route: string[] } => ({ route: (world.screens[world.screen] as ExScreen).route });

  const press = (method: "press" | "toggle", params: Record<string, unknown>): Reply => {
    const dry = params["dryRun"] === true;
    const target = params["target"] as Wire | undefined;
    const found = find(world, target);
    if (found === undefined) return { ok: false, error: { code: "not_found", message: "No element matches" } };
    // A control with no id is named by its text in these tables.
    const id = found.el.id ?? found.el.text ?? "";
    const refused = world.refuse[id];
    if (refused !== undefined) return { ok: false, error: refused };
    if (world.alertOpen) return { ok: false, error: { code: "not_actionable", message: "behind_alert: An alert is open; answer it first" } };
    if (found.el.disabled === true) return { ok: false, error: { code: "not_actionable", message: "disabled: the element is disabled" } };
    const landing = world.recipient[id];
    const element = landing !== undefined ? wire(world, landing, found.index) : wire(world, found.el, found.index);
    if (dry) return { ok: true, result: { element } };
    world.pressed.push(id);
    world.onPress?.(id);
    let settledMs = 20;
    if (method === "toggle") {
      const wanted = typeof params["value"] === "boolean" ? params["value"] : !(world.toggles[id] ?? false);
      if (!world.stuckToggles.has(id) || world.toggles[id] === undefined || params["value"] === undefined) world.toggles[id] = wanted;
      return { ok: true, result: { element: wire(world, found.el, found.index), value: world.toggles[id], settledMs } };
    }
    settledMs = world.slowOn[id] ?? settledMs;
    const logTo = (line: string): void => current?.send({ type: "event", event: "error", data: { message: line, level: "error", ts: Date.now() } });
    const logged = world.errorOn[id];
    if (logged !== undefined) for (const line of Array.isArray(logged) ? logged : [logged]) logTo(line);
    if (world.crashOn.has(id)) {
      const app = current;
      app?.send({ type: "event", event: "error", data: { ...FATAL("undefined is not an object (evaluating 'trip.days.map')"), ts: Date.now() } });
      setTimeout(() => app?.ws.terminate(), 30);
      if (world.reopenAfterCrashMs !== undefined) setTimeout(() => void reopen(), world.reopenAfterCrashMs);
      return "ignore";
    }
    if (world.leaveOn.has(id)) {
      const app = current;
      app?.send({ type: "event", event: "appState", data: { state: "background" } });
      if (world.comeBackMs !== undefined) setTimeout(() => app?.send({ type: "event", event: "appState", data: { state: "active" } }), world.comeBackMs);
      return { ok: true, result: { element, settledMs } };
    }
    if (world.alertOn.has(id)) {
      world.alertOpen = true;
      return { ok: true, result: { element, settledMs } };
    }
    const landed = world.goes[`${world.screen}|${id}`];
    if (landed !== undefined) {
      world.screen = landed;
      world.revealed[landed] = 0;
    }
    return { ok: true, result: { element, settledMs } };
  };

  const handle = (req: IncomingRequest): Reply => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const dry = params["dryRun"] === true;
    if (!dry) {
      world.asked.push(req.method);
      clock.now += world.msPerRequest;
    }
    if (world.away && req.method !== "tree") return { ok: false, error: { code: "in_background", message: "the app is in the background" } };
    switch (req.method) {
      case "tree": {
        const all = visible(world);
        const screen = world.screens[world.screen] as ExScreen;
        const below = (screen.hidden?.length ?? 0) - (world.revealed[world.screen] ?? 0);
        return {
          ok: true,
          result: {
            screen: { width: 430, height: 932, scale: 3 },
            elements: all.map((el, i) => wire(world, el, i)),
            ...(below > 0 ? { offScreen: { above: 0, below } } : {}),
            route: { names: screen.route },
            place: placeOf(),
            ...(world.alertOpen ? { alerts: [{ kind: "alert", title: "Allow notifications?", message: null, buttons: [{ text: "Don't allow", style: "cancel" }, { text: "Allow", style: "default" }], standIn: false }] } : {}),
          },
        };
      }
      case "place":
        return { ok: true, result: { ...placeOf(), seenAt: Date.now() } };
      case "places":
        return { ok: true, result: { source: "expo-router", places: world.known.map((k) => ({ route: k.route, link: k.link ?? null, params: k.params ?? [] })) } };
      case "press":
      case "toggle":
        return press(req.method, params);
      case "back": {
        const here = world.screens[world.screen] as ExScreen;
        if (dry) return { ok: true, result: { route: here.route } };
        if (here.parent === undefined || world.backBroken.has(world.screen)) {
          if (world.backBroken.has(world.screen)) return { ok: true, result: { settledMs: 10 } };
          return { ok: false, error: { code: "not_actionable", message: "no_action: there is nothing to go back to" } };
        }
        world.screen = here.parent;
        return { ok: true, result: { settledMs: 10 } };
      }
      case "scroll": {
        const screen = world.screens[world.screen] as ExScreen;
        if (params["to"] === "start") {
          world.revealed[world.screen] = 0;
          return { ok: true, result: { element: { ref: "e1", type: "ScrollView", role: "scroll" }, moved: true, settledMs: 10 } };
        }
        const have = world.revealed[world.screen] ?? 0;
        const more = (screen.hidden?.length ?? 0) > have;
        if (more) world.revealed[world.screen] = have + 1;
        return { ok: true, result: { element: { ref: "e1", type: "ScrollView", role: "scroll" }, moved: more, settledMs: 10 } };
      }
      case "type": {
        const target = params["target"] as Wire | undefined;
        const found = find(world, target);
        if (found === undefined) return { ok: false, error: { code: "not_found", message: "No input matches" } };
        const text = String(params["text"] ?? "");
        world.typed.push({ id: found.el.id, text });
        return { ok: true, result: { element: wire(world, found.el, found.index), value: text, settledMs: 10 } };
      }
      case "waitFor": {
        // What `expect` and `wait_for` ask: is it on the screen (or gone); `once` answers at once, else the app times out at once.
        const els = visible(world);
        const present = els.some((el) => {
          if (typeof params["testID"] === "string") return el.id === params["testID"];
          if (typeof params["label"] === "string") return (el.label ?? el.text ?? "").toLowerCase() === params["label"].toLowerCase();
          if (typeof params["text"] === "string") return (el.text ?? el.label ?? "").includes(params["text"]);
          return true;
        });
        const holds = params["gone"] === true ? !present : present;
        if (params["once"] === true) return { ok: true, result: { found: holds } };
        return holds ? { ok: true, result: { waitedMs: 0 } } : { ok: false, error: { code: "timeout", message: "Timed out waiting for the element" } };
      }
      case "logs":
        return { ok: true, result: { entries: [] } };
      case "commands":
        return { ok: true, result: { commands: world.commands.map((name) => ({ name, description: `${name} (test)` })) } };
      case "command": {
        const name = String(params["name"] ?? "");
        if (!world.commands.includes(name)) return { ok: false, error: { code: "not_found", message: `no command ${name}` } };
        if (name === "reset") {
          world.resets += 1;
          world.alertOpen = false;
          world.screen = world.initial;
          world.toggles["notify-switch"] = false;
          world.onReset?.();
        }
        return { ok: true, result: { result: null, settledMs: 10 } };
      }
      case "reload": {
        if (world.reloads < 0) return { ok: false, error: { code: "unsupported", message: "reload isn't available in a release build" } };
        world.reloads += 1;
        world.alertOpen = false;
        setTimeout(() => {
          void reopen();
        }, 20);
        return { ok: true, result: {} };
      }
      case "audit":
        return { ok: true, result: { issues: (world.audit[world.screen] ?? []).map((i) => ({ ...i })), checked: ["contrast"] } };
      case "uxCheck":
        return { ok: true, result: { issues: (world.ux[world.screen] ?? []).map((i) => ({ ...i, basis: "test" })), checked: ["choices"], actions: [] } };
      case "screenshot":
        return { ok: true, result: { mime: "image/jpeg", data: Buffer.from("JPEGDATA").toString("base64"), width: 300, height: 650 } };
      case "openURL":
        return { ok: true, result: { settledMs: 10 } };
      default:
        return { ok: true, result: {} };
    }
  };

  const hello = { app: APP, capabilities };
  async function reopen(): Promise<void> {
    const old = current;
    world.screen = world.initial;
    world.away = false;
    world.toggles["notify-switch"] = false;
    const next = await FakeApp.connect(port, hello, handle);
    apps.push(next.app);
    current = next.app;
    old?.ws.terminate();
  }

  const first = await FakeApp.connect(port, hello, handle);
  apps.push(first.app);
  current = first.app;
  const registry = new MapRegistry({ mapsDir });
  openRegistries.add(registry);
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    maps: registry,
    clock: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
    wallClock: () => Date.UTC(2026, 10, 14, 9, 15, 0) + clock.now - 1_000_000,
    exploreDir,
    exploreGraceMs: 300,
    reloadSettleMs: 0,
    reloadWaitMs: 3000,
    policy: options.policy ?? { version: 1, confirm: [], block: [] },
    ...options.tools,
  });
  void TOKEN;
  void options.msPerRequest;
  if (options.msPerRequest !== undefined) world.msPerRequest = options.msPerRequest;
  return {
    tools,
    world,
    host,
    port,
    current: () => current as FakeApp,
    mapsDir,
    exploreDir,
    folder,
    file: () => loadMap(folder, APP.id).map,
    clock,
    registry,
    reopen,
    progress,
  };
}
