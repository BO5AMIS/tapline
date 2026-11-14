import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { TYPED, redactFinding } from "../src/findings.js";
import type { TaplineHost } from "../src/server.js";
import type { MapFile } from "../src/mapfile.js";
import { APP, place, road } from "./drive-helpers.js";
import { btn, flushExploreMaps, list, setupExplore, type ExEl, type ExWorld, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// PR 13 security review, Codex cycle 2 (R4) and the two open CodeRabbit items.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);

/** The two private doors the tests use: the repair scope and the single dispatch gate. */
interface Internals {
  repairScope: <T>(go: () => Promise<T>) => Promise<T>;
  sendRequest: (method: string, params: unknown, options?: unknown) => Promise<unknown>;
}
const internals = (s: ExploreSetup): Internals => s.tools as unknown as Internals;

describe("R4 item 6: a finding's text is redacted whole", () => {
  const vault = "abc${x}def";
  const scrub = (text: string): string => text.split(vault).join("<hidden>");
  it("a vault value that crosses a placeholder-shaped span is hidden", () => {
    const out = redactFinding({ got: `saw ${vault} here`, expected: vault, logs: [`error ${vault}`] }, scrub);
    expect(out.got).toBe("saw <hidden> here");
    expect(out.expected).toBe("<hidden>");
    expect(out.logs[0]).toBe("error <hidden>");
  });
  it("keeps the placeholder the tool generated, even when a vault value is a piece of it", () => {
    const out = redactFinding({ path: [{ tool: "type_text", text: TYPED }] }, (text) => text.split("typed").join("<hidden>"));
    expect(out.path[0]?.text).toBe(TYPED);
  });
});

const markedTrips = (w: Parameters<NonNullable<ExploreSetupOptions["world"]>>[0]): void => {
  const trips = w.screens["trips"];
  if (trips !== undefined) trips.elements[0] = { ...list("trip-list"), exploreSkip: true };
  w.screen = "trips";
};

describe("R4 item 2: a scroll view marked skip is never scrolled", () => {
  it("explore sends no scroll to a skip-marked list that holds hidden rows", async () => {
    const s = await setup({ world: markedTrips });
    await s.tools.explore({ fill: "none", steps: 12 });
    expect(s.world.asked).not.toContain("scroll");
    expect(s.world.revealed["trips"] ?? 0).toBe(0);
  });

  it("repair's scope refuses a scroll aimed at a marked scroll view", async () => {
    const s = await setup({ world: markedTrips });
    const out = await internals(s).repairScope(() => internals(s).sendRequest("scroll", { direction: "down", fraction: 0.8 }).then(() => "sent", (e: Error) => e.message));
    expect(out).toMatch(/explore skip/);
    expect(s.world.asked).not.toContain("scroll");
  });

  it("a pipelined move that scrolls meets the same gate", async () => {
    const s = await setup({ world: markedTrips });
    const out = await internals(s).repairScope(() =>
      internals(s)
        .sendRequest("move", { method: "scroll", params: { direction: "down", fraction: 0.8 } })
        .then(() => "sent", (e: Error) => e.message),
    );
    expect(out).toMatch(/explore skip/);
    expect(s.world.asked).not.toContain("scroll");
  });

  it("an unmarked list is still scrolled (the gate is no blanket refusal)", async () => {
    const s = await setup({ world: (w) => void (w.screen = "trips") });
    await s.tools.explore({ fill: "none", steps: 12 });
    expect(s.world.asked).toContain("scroll");
  });
});

/** home -> profile -> settings by saved roads; profile is titled "Account" and has a neutral "Change" button. */
const throughProfile = (profileName = "profile", profileRoute = ["profile"]): MapFile => ({
  format: "agent-tools-map",
  version: 1,
  app: APP.id,
  places: { home: place(["home"]), [profileName]: place(profileRoute), settings: place(["settings"]) },
  roads: [road("home", profileName, "open-profile", "Profile"), road(profileName, "settings", "to-settings", "Settings")],
  routes: {},
  reflexes: [],
});
const header = (text: string): ExEl => ({ text, role: "header", type: "Text", actions: [] });
const withProfile = (titled: boolean, route = ["profile"]) => (w: ExWorld): void => {
  w.screens["home"]?.elements.push(btn("open-profile", "Profile"));
  w.screens["profile"] = { route, parent: "home", elements: [...(titled ? [header("Account")] : []), btn("change", "Change"), btn("to-settings", "Settings")] };
  w.goes["home|open-profile"] = "profile";
  w.goes["profile|to-settings"] = "settings";
};

describe("R4 item 3: saved navigation never taps on a protected place", () => {
  it("explore from settings goes by roads through a place titled Account: no tap on it, Change is never pressed", async () => {
    const s = await setup({ map: throughProfile(), world: withProfile(true) });
    await s.tools.explore({ from: "settings", steps: 2, fill: "none" });
    expect(s.world.pressed).not.toContain("change");
    expect(s.world.pressed).not.toContain("to-settings");
  });

  it("a place a person named account_page is protected by its name alone (no title, generic route)", async () => {
    const s = await setup({ map: throughProfile("account_page", ["p1"]), world: withProfile(false, ["p1"]) });
    await s.tools.explore({ from: "settings", steps: 2, fill: "none" });
    expect(s.world.pressed).not.toContain("change");
    expect(s.world.pressed).not.toContain("to-settings");
  });

  it("the gate refuses a touch while the app stands on such a place, and lets back through", async () => {
    const s = await setup({
      map: throughProfile(),
      world: (w) => {
        withProfile(true)(w);
        w.screen = "profile";
      },
    });
    const out = await internals(s).repairScope(() => internals(s).sendRequest("press", { target: { testID: "change" } }).then(() => "sent", (e: Error) => e.message));
    expect(out).toMatch(/explore skip: floor/);
    expect(s.world.pressed).toEqual([]);
    const back = await internals(s).repairScope(() => internals(s).sendRequest("back", {}).then(() => "sent", (e: Error) => e.message));
    expect(back).toBe("sent");
  });
});
