import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlQueue } from "../src/control.js";
import { callTool } from "../src/dispatch.js";
import type { MapFile, MapReflex } from "../src/mapfile.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { ALL_CAPS, baseMap, button, note, setupDrive, textOf, type El, type Setup, type SetupOptions, type World, flushDriveMaps } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// Review of 1.6 task 17: a reflex step never asks a person, its checks are re-made, a retry needs the same element, and its
// flags belong to its own call.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const COVERED = { code: "not_actionable", message: 'covered: e1 button "General" is behind e20 text "Rate Wayfare"; close that first.' };
const rate: MapReflex = { name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Not now" } } };
const app = { id: "com.example.wayfare", name: "Wayfare" };
const sheet = (): El[] => [note("e20", "Rate Wayfare"), button("e21", "not-now", "Not now")];
const withoutSheet = (elements: El[]): El[] => elements.filter((e) => e.testID !== "not-now" && e.text !== "Rate Wayfare");
const mapWith = (...reflexes: MapReflex[]): MapFile => ({ ...baseMap(), reflexes });
const reflexLines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("Reflex:"));
const presses = (s: Setup, name: string): number =>
  s.app.requests.filter((r) => (r.method === "press" || (r.method === "move" && (r.params as { method?: string }).method === "press")) && JSON.stringify(r.params).includes(name) && !JSON.stringify(r.params).includes('"dryRun"')).length;

/** A sheet over settings: it covers every touch except the ones in `free`. */
function sheetWorld(free: string[] = ["not-now"], onClose?: (w: World) => void) {
  return (w: World): void => {
    w.elements.settings = [...w.elements.settings, ...sheet()];
    w.refuse = (testID, screen) => (screen === "settings" && w.elements.settings.some((e) => e.testID === "not-now") && !free.includes(testID) ? COVERED : undefined);
    w.onPress = (testID) => {
      if (testID !== "not-now") return;
      w.elements.settings = withoutSheet(w.elements.settings);
      onClose?.(w);
    };
  };
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const journeys = mkdtempSync(join(tmpdir(), "tapline-reflex-review-"));
  dirs.push(journeys);
  return setupDrive(hosts, apps, dirs, { capabilities: ALL_CAPS, ...options, tools: { journeysDir: journeys, ...options.tools } });
}

describe("a reflex step never asks a person", () => {
  it("a screen change between the verdict and the tap is a skip, not a question", async () => {
    const hidden: MapReflex = { name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { id: "dismiss" } } };
    let looks = 0;
    const s = await setup({
      map: mapWith(hidden),
      policy: { version: 1, confirm: ["delete"], block: [] } satisfies PolicyFile,
      world: (w) => {
        sheetWorld(["not-now", "dismiss"])(w);
        const dismiss = button("e22", "dismiss", "Not now");
        w.elements.settings = [...w.elements.settings, dismiss];
        const was = w.refuse;
        w.refuse = (testID, screen) => {
          // The second look at "dismiss" (the tap's own check) finds another label there.
          if (testID === "dismiss" && ++looks === 2) {
            dismiss.label = "Delete trip";
            dismiss.text = "Delete trip";
          }
          return was?.(testID, screen);
        };
      },
    });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    const text = textOf(answer);
    expect(answer.isError).toBe(true);
    expect(text).toContain("didn't fire");
    expect(text).toContain("never asks");
    expect(text).not.toContain("The live view asks");
    expect(reflexLines(text)).toEqual([]);
    expect(presses(s, "dismiss")).toBe(0);
    expect(looks).toBeGreaterThanOrEqual(2);
  });
});

describe("a retry needs the same element", () => {
  it("another element under the same words after the reflex: the original failure, plus the Reflex line", async () => {
    const s = await setup({
      map: mapWith(rate),
      world: sheetWorld(["not-now"], (w) => {
        // After the sheet closes, "General" is a different control (another id).
        const row = w.elements.settings.find((e) => e.text === "General");
        if (row !== undefined) row.testID = "other-row";
      }),
    });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    const text = textOf(answer);
    expect(answer.isError).toBe(true);
    expect(text).toContain("covered");
    expect(reflexLines(text)).toHaveLength(1);
    expect(s.world.screen).toBe("settings");
  });

  it("two matches after the reflex: not retried", async () => {
    const s = await setup({
      map: mapWith(rate),
      world: sheetWorld(["not-now"], (w) => {
        w.elements.settings = [...w.elements.settings, button("e30", "general-copy", "General")];
      }),
    });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(reflexLines(textOf(answer))).toHaveLength(1);
    expect(s.world.screen).toBe("settings");
  });

  it("an index target is never retried", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld() });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" }, index: 0 });
    expect(answer.isError).toBe(true);
    expect(reflexLines(textOf(answer))).toHaveLength(1);
    expect(s.world.screen).toBe("settings");
  });

  it("the same element after the reflex is retried, as before", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld() });
    const answer = await callTool(s.tools, "tap", { target: { id: "general-row" } });
    expect(answer.isError).not.toBe(true);
    expect(reflexLines(textOf(answer))).toHaveLength(1);
    expect(s.world.screen).toBe("general");
  });
});

describe("skips use no firings", () => {
  it("three reflexes that don't fire don't keep a fourth from firing", async () => {
    const skipper = (name: string): MapReflex => ({ name, when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Delete trip" } } });
    const s = await setup({
      map: mapWith(skipper("a1"), skipper("a2"), skipper("a3"), rate),
      policy: { version: 1, confirm: ["delete"], block: [] },
      world: sheetWorld(["not-now", "delete-trip"]),
    });
    const answer = await callTool(s.tools, "tap", { target: { id: "general-row" } });
    const text = textOf(answer);
    expect(reflexLines(text)).toHaveLength(1);
    expect(text.split("\n").filter((l) => l.includes("didn't fire"))).toHaveLength(3);
    expect(presses(s, "Not now")).toBe(1);
  });
});

describe("a reflex step's flags belong to its own call", () => {
  it("a call running beside a reflex step still records its road", async () => {
    class Gated extends ControlQueue {
      count = 0;
      release: () => void = () => {};
      reached: () => void = () => {};
      readonly held = new Promise<void>((resolve) => (this.release = resolve));
      readonly reachedPromise = new Promise<void>((resolve) => (this.reached = resolve));
      override async runAgent<T>(fn: () => Promise<T>): Promise<T> {
        // The reflex step's request is the second one: it waits while the other call runs.
        if (++this.count === 2) {
          this.reached();
          await this.held;
        }
        return fn();
      }
    }
    const control = new Gated();
    const s = await setup({
      map: mapWith(rate),
      world: (w) => {
        sheetWorld()(w);
        w.refuse = (testID) => (testID === "general-row" && w.elements.settings.some((e) => e.testID === "not-now") ? COVERED : undefined);
      },
      tools: { control },
    });
    const first = callTool(s.tools, "tap", { target: { id: "general-row" } });
    await control.reachedPromise;
    const other = await callTool(s.tools, "tap", { target: { id: "delete-trip" }, look: false });
    expect(other.isError).not.toBe(true);
    control.release();
    await first;
    await s.registry.forApp(app)?.flush();
    expect(s.file().roads.some((r) => r.from === "settings" && r.to === "trips_id")).toBe(true);
  });
});
