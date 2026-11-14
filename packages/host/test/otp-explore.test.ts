import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOtpService } from "../src/otpclient.js";
import type { MapFile } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { APP, place } from "./drive-helpers.js";
import { flushExploreMaps, input, setupExplore } from "./explore-helpers.js";
import { FAKE_CODE, FAKE_TOKEN, startFakeTapwright, tapwrightHome, type FakeDaemon } from "./fake-tapwright.js";
import type { FakeApp } from "./helpers.js";

// A one-time code is asked for only after explore's own gates (AGENT-TOOLS 1.16.2 §18.11, §25.6): a saved route that types a code
// inside an explore run is refused before the daemon is asked.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
const daemons: FakeDaemon[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const routeMap = (): MapFile => ({
  format: "agent-tools-map",
  version: 1,
  app: APP.id,
  places: { home: place(["home"]), settings: place(["settings"]) },
  roads: [],
  routes: { go: "routes/go.json" },
  reflexes: [],
});

describe("explore and a saved route with a one-time code step", () => {
  it("the route's code step is refused by explore's gate, and the daemon is asked for nothing", async () => {
    const daemon = await startFakeTapwright();
    daemons.push(daemon);
    const home = tapwrightHome({ port: daemon.port, token: FAKE_TOKEN });
    dirs.push(home.dir);
    const otp = createOtpService({ home: home.dir, settleMs: 5, timeoutMs: 3000 });
    const s = await setupExplore(hosts, apps, dirs, {
      map: routeMap(),
      capabilities: ["tree", "press", "type", "logs", "dryRun", "place", "places", "audit", "uxCheck", "screenshot"],
      tools: { otp },
      world: (w) => {
        w.screens["home"]?.elements.push(input("code", "Code"));
      },
    });
    writeFileSync(
      join(s.folder, "routes", "go.json"),
      JSON.stringify({
        format: "agent-tools-script",
        version: 2,
        app: APP.id,
        name: "go",
        start: "home",
        end: "settings",
        steps: [
          { tool: "type_text", target: { id: "code" }, text: `\${otp.${APP.id}}` },
          { tool: "tap", target: { id: "open-settings" } },
        ],
      }),
    );
    await s.tools.explore({ from: "settings", fill: "none", steps: 1 });
    expect(daemon.requests.filter((r) => r.url === "/otp")).toHaveLength(0);
    expect(s.world.typed).toEqual([]);
    expect(JSON.stringify(s.world.typed)).not.toContain(FAKE_CODE);
  });
});
