import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { FakeApp, type IncomingRequest, type Reply } from "./helpers.js";

// Closing the runtime writes the maps: a change made less than a second ago must reach the file (AGENT-TOOLS 1.13 §18.9).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("closing the runtime", () => {
  it("flushes a dirty map before the host closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "tapline-close-"));
    dirs.push(home);
    const mapsDir = join(home, "maps-here");
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, maps: mapsDir });
    let screen: "a" | "b" = "a";
    const handler = (req: IncomingRequest): Reply => {
      if (req.method === "press") {
        screen = "b";
        return { ok: true, result: { element: { ref: "e1", role: "button", testID: "go", text: "Go" }, settledMs: 10 } };
      }
      if (req.method === "tree") {
        return { ok: true, result: { elements: [{ ref: "e1", role: "button", testID: "go", text: "Go", frame: { x: 0, y: 0, width: 100, height: 40 }, actions: ["press"] }], place: { route: [screen === "a" ? "home" : "next"] } } };
      }
      return { ok: true, result: {} };
    };
    const { app } = await FakeApp.connect(
      runtime.port,
      { token: runtime.config.token, app: { name: "Wayfare", id: "com.example.wayfare", version: "1.0.0", build: "1" }, capabilities: ["tree", "press"] },
      handler,
    );
    try {
      const tools = runtime.toolsFor(undefined);
      await tools.look({ screenshot: false });
      await tools.tap({ target: { id: "go" } });
      // The first write was a moment ago; the road is waiting for the next one.
      await runtime.close();
      const saved = JSON.parse(readFileSync(join(mapsDir, "com.example.wayfare", "map.json"), "utf8")) as { places: Record<string, unknown>; roads: unknown[] };
      expect(Object.keys(saved.places).sort()).toEqual(["home", "next"]);
      expect(saved.roads).toHaveLength(1);
    } finally {
      app.ws.terminate();
    }
  });
});
