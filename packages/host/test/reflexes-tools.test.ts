import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import { Dialogs, OK_ALLOW, OK_FIELD, type ElicitClient } from "../src/elicit.js";
import type { MapFile, MapReflex } from "../src/mapfile.js";
import type { PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { ALL_CAPS, baseMap, button, note, setupDrive, textOf, type El, type Setup, type SetupOptions, type World, flushDriveMaps } from "./drive-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.13 §18.7 and 1.13.1 item 10: declared reflexes fire by themselves at place changes and before a failure
// is answered. Every firing is in the answer, the policy is checked again when one fires, and none fires in a dry run.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const COVERED = { code: "not_actionable", message: "covered: e1 button \"General\" is behind e20 text \"Rate Wayfare\"; close that first." };
const rate: MapReflex = { name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Not now" } } };
const REFLEX_LINE = 'Reflex: closed "Rate Wayfare" (tapped "Not now").';

const sheet = (): El[] => [note("e20", "Rate Wayfare"), button("e21", "not-now", "Not now")];
const mapWith = (...reflexes: MapReflex[]): MapFile => ({ ...baseMap(), reflexes });
const withoutSheet = (elements: El[]): El[] => elements.filter((e) => e.testID !== "not-now" && e.text !== "Rate Wayfare");

/** A rating sheet over the settings screen: it covers every touch except its own "Not now"; `again` puts it back after each touch. */
function sheetWorld(state: { up: boolean; again: boolean }) {
  return (w: World): void => {
    w.elements.settings = [...w.elements.settings, ...sheet()];
    w.elements.general = [...w.elements.general];
    w.refuse = (testID) => (state.up && testID !== "not-now" ? COVERED : undefined);
    w.onPress = (testID) => {
      if (testID === "not-now") {
        state.up = false;
        for (const key of Object.keys(w.elements) as Array<keyof typeof w.elements>) w.elements[key] = withoutSheet(w.elements[key]);
      } else if (state.again) {
        state.up = true;
        w.elements.general = [...withoutSheet(w.elements.general), ...sheet()];
      }
    };
  };
}

async function setup(options: SetupOptions = {}): Promise<Setup & { journeys: string }> {
  const journeys = mkdtempSync(join(tmpdir(), "tapline-reflex-journeys-"));
  dirs.push(journeys);
  const s = await setupDrive(hosts, apps, dirs, { capabilities: ALL_CAPS, ...options, tools: { journeysDir: journeys, ...options.tools } });
  return { ...s, journeys };
}
const pressed = (s: Setup, testID: string): number =>
  s.app.requests.filter((r) => (r.method === "press" || (r.method === "move" && (r.params as { method?: string }).method === "press")) && JSON.stringify(r.params).includes(testID) && !JSON.stringify(r.params).includes('"dryRun"')).length;
const reflexLines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("Reflex:"));

describe("a declared reflex in a single call", () => {
  it("taps Not now when Rate Wayfare covers the target, and the answer says Reflex:", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    const text = textOf(answer);
    expect(answer.isError).not.toBe(true);
    expect(text.split("\n")[0]).toMatch(/^Tapped /);
    expect(reflexLines(text)).toEqual([REFLEX_LINE]);
    expect(pressed(s, "Not now")).toBe(1);
    expect(s.world.screen).toBe("general");
  });

  it("fires at a place change, before the list is built", async () => {
    const s = await setup({
      map: mapWith({ ...rate, at: "general" }),
      world: (w) => {
        w.elements.general = [...w.elements.general, ...sheet()];
        w.onPress = (testID) => {
          if (testID === "not-now") w.elements.general = withoutSheet(w.elements.general);
        };
      },
    });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    const text = textOf(answer);
    expect(reflexLines(text)).toEqual([REFLEX_LINE]);
    // The list after the answer is the one with the sheet gone.
    expect(text.split("\n").filter((l) => !l.startsWith("Reflex:")).join("\n")).not.toContain("Rate Wayfare");
    expect(text).toContain("Language");
    expect(pressed(s, "Not now")).toBe(1);
  });

  it("does nothing when no reflex is declared", async () => {
    const s = await setup({ world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("covered");
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("at restricts a reflex to its place", async () => {
    const s = await setup({ map: mapWith({ ...rate, at: "general" }), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(reflexLines(textOf(answer))).toEqual([]);
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("max limits the firings per call: one by default", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: true }) });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "tap", target: { id: "general-row" } }, { tool: "tap", target: { id: "language-row" } }] });
    const text = textOf(answer);
    expect(answer.isError).toBe(true);
    expect(text).toContain("Ran 1 of 2 steps; stopped at step 2");
    expect(reflexLines(text)).toEqual([REFLEX_LINE]);
    expect(pressed(s, "Not now")).toBe(1);
  });

  it("a reflex with max 2 fires twice in one call, and run says both", async () => {
    const s = await setup({ map: mapWith({ ...rate, max: 2 }), world: sheetWorld({ up: true, again: true }) });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "tap", target: { id: "general-row" } }, { tool: "tap", target: { id: "language-row" } }] });
    const text = textOf(answer);
    expect(answer.isError).not.toBe(true);
    expect(text.split("\n")[0]).toMatch(/^Ran 2 of 2 steps/);
    expect(reflexLines(text)).toEqual([REFLEX_LINE, REFLEX_LINE]);
    expect(pressed(s, "Not now")).toBe(2);
  });

  it("the limit is per call: the next call may fire it again", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: true }) });
    await callTool(s.tools, "tap", { target: { id: "general-row" } });
    const second = await callTool(s.tools, "tap", { target: { id: "language-row" } });
    expect(reflexLines(textOf(second))).toEqual([REFLEX_LINE]);
    expect(pressed(s, "Not now")).toBe(2);
  });

  it("the reflex's own tap is no road and no recorded step", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    await callTool(s.tools, "tap", { target: { text: "General" } });
    await s.registry.forApp(app)?.flush();
    expect(s.file().roads.every((r) => !JSON.stringify(r.move).includes("not-now"))).toBe(true);
  });
});


const app = { id: "com.example.wayfare", name: "Wayfare" };

describe("a reflex goes through the same policy as a single call", () => {
  const flagged = (word: string): PolicyFile => ({ version: 1, confirm: [word], block: [] });
  const blocked = (word: string): PolicyFile => ({ version: 1, confirm: [], block: [word] });

  it("a flagged do doesn't fire, and the answer says why", async () => {
    const s = await setup({ map: mapWith(rate), policy: flagged("not now"), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    const text = textOf(answer);
    expect(answer.isError).toBe(true);
    expect(text).toContain('Note: reflex rate_prompt didn\'t fire: it would tap "Not now", which the policy flags ("not now"); a reflex never asks for a person\'s OK.');
    expect(reflexLines(text)).toEqual([]);
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("a blocked do never fires", async () => {
    const s = await setup({ map: mapWith(rate), policy: blocked("not now"), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(textOf(answer)).toContain('which the policy blocks ("not now")');
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("the element the do reaches is checked too, not only the words the map keeps", async () => {
    const hidden: MapReflex = { name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { id: "dismiss" } } };
    const s = await setup({
      map: mapWith(hidden),
      policy: flagged("delete"),
      world: (w) => {
        sheetWorld({ up: true, again: false })(w);
        w.elements.settings = [...w.elements.settings, button("e22", "dismiss", "Delete trip")];
      },
    });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("didn't fire");
    expect(pressed(s, "dismiss")).toBe(0);
  });

  it("a do that isn't a step a reflex may take (an edited map file) doesn't fire", async () => {
    const forced = { name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Not now" }, force: true } } as MapReflex;
    const s = await setup({ map: mapWith(forced), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("not a step a reflex may take");
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("a reflex that is allowed still passes a policy that has other words", async () => {
    const s = await setup({ map: mapWith(rate), policy: flagged("delete"), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).not.toBe(true);
    expect(reflexLines(textOf(answer))).toEqual([REFLEX_LINE]);
  });
});

describe("an approved touch is no road, even when an arrival reflex runs inside it (PR 9 review, P2)", () => {
  it("a reflex that taps Not now after an approved Delete trip doesn't let the outer action save the destructive road", async () => {
    const client: ElicitClient = { canShowForm: () => true, elicit: async () => ({ action: "accept", content: { [OK_FIELD]: OK_ALLOW } }) };
    const s = await setup({
      map: mapWith({ ...rate, at: "trips_id" }),
      policy: { version: 1, confirm: ["delete"], block: [] },
      tools: { dialogs: new Dialogs(client, {}) },
      world: (w) => {
        w.elements.trips = [...w.elements.trips, ...sheet()];
        w.onPress = (testID) => {
          if (testID === "not-now") w.elements.trips = withoutSheet(w.elements.trips);
        };
      },
    });
    await callTool(s.tools, "look", { screenshot: false });
    const answer = await callTool(s.tools, "tap", { target: { id: "delete-trip" } });
    expect(answer.isError).not.toBe(true);
    expect(pressed(s, "delete-trip")).toBe(1);
    expect(pressed(s, "Not now")).toBe(1);
    expect(textOf(answer)).toContain(REFLEX_LINE);
    await s.registry.flushAll();
    expect(s.file().roads.some((r) => JSON.stringify(r.move.target).includes("delete-trip"))).toBe(false);
    expect(textOf(answer)).toContain("not saved as a road");
  });
});

describe("a reflex never fires inside a dry run", () => {
  it("tap with dry_run", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" }, dry_run: true });
    expect(reflexLines(textOf(answer))).toEqual([]);
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("run with dry_run", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "run", { steps: [{ tool: "tap", target: { id: "general-row" } }], dry_run: true });
    expect(reflexLines(textOf(answer))).toEqual([]);
    expect(pressed(s, "Not now")).toBe(0);
    expect(s.world.screen).toBe("settings");
  });

  it("drive with dry_run", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "drive", { to: "general", dry_run: true });
    expect(textOf(answer)).toMatch(/^Would drive to general/);
    expect(pressed(s, "Not now")).toBe(0);
  });
});

describe("drive and reflexes", () => {
  it("the drive's answer says , 1 reflex and lists the firing", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "drive", { to: "general" });
    const text = textOf(answer);
    expect(answer.isError).not.toBe(true);
    expect(text.split("\n")[0]).toMatch(/^Arrived at general by 1 tap, 1 reflex in /);
    expect(reflexLines(text)).toEqual([REFLEX_LINE]);
    expect(s.world.screen).toBe("general");
  });

  it("a drive without a reflex says nothing of reflexes", async () => {
    const s = await setup({ map: mapWith(rate), world: (w) => { w.elements.settings = [...w.elements.settings]; } });
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(textOf(answer).split("\n")[0]).toMatch(/^Arrived at general by 1 tap in /);
  });

  it("a drive stops with off_route when a flagged reflex won't fire", async () => {
    const s = await setup({ map: mapWith(rate), policy: { version: 1, confirm: ["not now"], block: [] }, world: sheetWorld({ up: true, again: false }) });
    const answer = await callTool(s.tools, "drive", { to: "general" });
    expect(answer.isError).toBe(true);
    expect(pressed(s, "Not now")).toBe(0);
  });
});

describe("a user's-eyes journey", () => {
  const begin = (s: Setup, extra: Record<string, unknown> = {}) => callTool(s.tools, "journey", { start: true, goal: "change the language", persona: "a first-timer", ...extra });

  it("has no reflexes: the interruption is a finding", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    await begin(s);
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(reflexLines(textOf(answer))).toEqual([]);
    expect(pressed(s, "Not now")).toBe(0);
  });

  it("has them again when its allow names reflexes", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    await begin(s, { allow: ["reflexes"] });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).not.toBe(true);
    expect(reflexLines(textOf(answer))).toEqual([REFLEX_LINE]);
    expect(pressed(s, "Not now")).toBe(1);
  });

  it("allow with other names lifts only what it names", async () => {
    const s = await setup({ map: mapWith(rate), world: sheetWorld({ up: true, again: false }) });
    await begin(s, { allow: ["drive"] });
    const answer = await callTool(s.tools, "tap", { target: { text: "General" } });
    expect(answer.isError).toBe(true);
    expect(pressed(s, "Not now")).toBe(0);
  });
});

describe("the reflex's place and moment checks read little", () => {
  it("a map with no reflexes costs no extra element read", async () => {
    const s = await setup({ world: (w) => { w.elements.settings = [...w.elements.settings]; } });
    await callTool(s.tools, "tap", { target: { id: "general-row" }, look: false });
    expect(s.app.requests.filter((r) => r.method === "tree").length).toBe(0);
  });
});

