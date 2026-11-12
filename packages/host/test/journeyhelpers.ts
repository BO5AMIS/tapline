import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import type { TreeElement } from "../src/protocol.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

/** Shared by the journey report, export and stress tests: a fake app with two screens and pictures. */

export const SCREEN = { width: 402, height: 874, scale: 3 };
const frame = (y: number) => ({ x: 24, y, width: 354, height: 48 });

export const HOME: TreeElement[] = [
  { ref: "e1", type: "Text", role: "header", testID: "home-title", text: "Home", frame: frame(60), actions: [] },
  { ref: "e2", type: "Pressable", role: "button", testID: "open-settings", text: "Settings", frame: frame(120), actions: ["press"] },
  { ref: "e3", type: "Pressable", role: "button", testID: "add", text: "Add egg", frame: frame(180), actions: ["press"] },
  { ref: "e4", type: "TextInput", role: "textfield", testID: "name-input", label: "Name", text: "", placeholder: "Your name", value: "2 eggs", frame: frame(240), actions: ["press", "type"] },
];
export const SETTINGS: TreeElement[] = [
  { ref: "e1", type: "Text", role: "header", testID: "settings-title", text: "Settings", frame: frame(60), actions: [] },
  { ref: "e2", type: "Pressable", role: "button", testID: "dark-mode", text: "Dark mode", frame: frame(120), actions: ["press"] },
];

/** A JPEG of one colour (or noise, which compresses badly: for the GIF cap), as base64. */
export function shot(colour: [number, number, number], width = 360, height = 780, noisy = false): string {
  const data = Buffer.alloc(width * height * 4);
  let seed = colour[0] * 7919 + colour[1] * 104729 + colour[2];
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = noisy ? (seed >> 8) & 255 : 0;
    data[i * 4] = noisy ? n : colour[0];
    data[i * 4 + 1] = noisy ? (n * 3) & 255 : colour[1];
    data[i * 4 + 2] = noisy ? (n * 7) & 255 : colour[2];
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 85).data.toString("base64");
}

export function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

export interface JourneyWorld {
  route: string[];
  /** Picture colours by screen; noisy pictures make a big GIF. */
  noisy: boolean;
  /** The phone is turned: the screen's width and height swap. */
  rotated?: boolean;
}

export interface Rig {
  tools: TaplineTools;
  host: TaplineHost;
  app: FakeApp;
  world: JourneyWorld;
  dir: string;
  advance: (ms: number) => void;
  /** Every app that connected, newest last (a reload makes a new one). */
  apps: FakeApp[];
  cleanup: () => Promise<void>;
}

export interface RigOptions {
  tools?: Partial<ToolsOptions>;
  /** Answers first; undefined falls through to the defaults. */
  onRequest?: (req: IncomingRequest, world: JourneyWorld) => Reply | undefined;
  capabilities?: string[];
  noisy?: boolean;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "tapline-journey-"));
  const world: JourneyWorld = { route: ["home"], noisy: options.noisy ?? false };
  let now = new Date(2026, 10, 12, 15, 30).getTime();
  const apps: FakeApp[] = [];
  let port = 0;
  let lastRoute = world.route.join("/");
  const elementsFor = (): TreeElement[] => (world.route[0] === "settings" ? SETTINGS : HOME);
  const handler = (req: IncomingRequest): Reply => {
    const custom = options.onRequest?.(req, world);
    if (custom !== undefined) return custom;
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case "tree": {
        const route = world.route.join("/");
        const sameRoute = route === lastRoute;
        if (params["peek"] !== true) lastRoute = route;
        return { ok: true, result: { screen: world.rotated === true ? { ...SCREEN, width: SCREEN.height, height: SCREEN.width } : SCREEN, elements: elementsFor(), route: { names: world.route }, ...(params["changes"] === true ? { changes: { sameRoute, added: [], removed: [], changed: [], moved: [] } } : {}) } };
      }
      case "screenshot": {
        const colour: [number, number, number] = world.route[0] === "settings" ? [30, 160, 90] : [40, 90, 200];
        return { ok: true, result: { mime: "image/jpeg", data: shot(colour, 360, 780, world.noisy), width: 360, height: 780 } };
      }
      case "press": {
        const target = params["target"] as { text?: string; ref?: string; testID?: string; x?: number } | undefined;
        if (target?.text === "Covered") return { ok: false, error: { code: "not_actionable", message: "covered: Settings is behind the open sheet" } };
        if (target?.text === "Missing") return { ok: false, error: { code: "not_found", message: 'nothing on screen shows "Missing"' } };
        if (target?.text === "Settings" || target?.ref === "e2") world.route = ["settings"];
        const element = target?.text === "Add egg" || target?.ref === "e3" ? HOME[2] : elementsFor()[1];
        // A double tap (`again`): the app makes the second tap itself, that many ms later.
        const again = params["again"];
        const second = typeof again === "number" ? { second: { done: true, afterMs: again } } : {};
        return { ok: true, result: { element, ...second, settledMs: 310 } };
      }
      case "back":
        world.route = ["home"];
        return { ok: true, result: { route: ["settings"], settledMs: 200 } };
      case "type":
        return { ok: true, result: { element: HOME[3], value: String(params["text"] ?? ""), settledMs: 100 } };
      case "command": {
        const name = String(params["name"]);
        const args = (params["args"] ?? {}) as Record<string, unknown>;
        if (name === "network") return { ok: true, result: { name, result: { mode: args["mode"] } } };
        return { ok: true, result: { name, result: null } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { host, port: p } = await startHost();
  port = p;
  const first = (await FakeApp.connect(port, { capabilities: options.capabilities ?? ["tree", "press", "screenshot", "uxCheck"] }, handler)).app;
  apps.push(first);
  const tools = new TaplineTools(host, {
    connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
    clock: () => now,
    journeysDir: join(dir, "journeys"),
    reloadWaitMs: 3000,
    reloadSettleMs: 10,
    ...options.tools,
  });
  return {
    tools,
    host,
    app: first,
    world,
    dir,
    advance: (ms) => {
      now += ms;
    },
    apps,
    /** Closes everything and removes the temp folder. */
    cleanup: async () => {
      for (const a of apps.splice(0)) a.ws.terminate();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wires a `reload` that ends the app's connection and brings a new session up (a development build). */
export function reloadable(get: () => Rig): (req: IncomingRequest) => Reply | undefined {
  return (req) => {
    if (req.method !== "reload") return undefined;
    setTimeout(() => {
      const r = get();
      r.apps[r.apps.length - 1]?.ws.close();
      const port = r.host.boundPort() ?? 0;
      void FakeApp.connect(port, { capabilities: ["tree", "press", "screenshot", "uxCheck"] }, (next) => {
        if (next.method === "tree") return { ok: true, result: { screen: SCREEN, elements: r.world.route[0] === "settings" ? SETTINGS : HOME, route: { names: r.world.route } } };
        return { ok: true, result: {} };
      }).then(({ app }) => {
        r.apps.push(app);
      });
    }, 30);
    return { ok: true, result: {} };
  };
}
