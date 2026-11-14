import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps, toggle, type ExEl } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { APP, BUILD, mapWith, repairRig, textOf, type RepairRig, type RigOptions } from "./repair-helpers.js";

// PR 13 security review, round 2: repair's safety. Every move a repair makes meets the whole explore floor on the element that
// really receives it, a destination repair meets the same rules as any other, a toggle is repaired only to its own role.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const rig = (options: RigOptions = {}): Promise<RepairRig> => repairRig(hosts, apps, dirs, options);

const RENAMED = [
  { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } },
  { tool: "tap", target: { id: "open-language" }, expect: { id: "pick-english" } },
];

describe("R2 finding 1: the floor holds on the real recipient of every move a repair makes", () => {
  it("rejects a candidate whose real recipient is Delete, under an empty policy, and presses nothing", async () => {
    const r = await rig({
      world: (w) => {
        w.recipient["open-settings"] = btn("open-settings", "Delete");
      },
    });
    r.script("rename", RENAMED);
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(r.s.world.pressed).not.toContain("open-settings");
    expect(answer).not.toContain("with 1 repair");
    expect(r.files()).toEqual(["rename.json"]);
    const rejected = r.lines.filter((line) => (line.detail ?? "").includes("id=open-settings (") && (line.detail ?? "").includes("rejected"));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.detail).toMatch(/rejected \(.*(Delete|delete).*\)/);
    expect(r.lines.some((line) => (line.detail ?? "").endsWith("accepted"))).toBe(false);
  });

  it("rejects a candidate the app marks exploreSkip", async () => {
    const r = await rig({
      world: (w) => {
        const home = w.screens["home"];
        if (home !== undefined) home.elements = home.elements.map((el) => (el.id === "open-settings" ? { ...el, exploreSkip: true } : el));
      },
    });
    r.script("rename", RENAMED);
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(r.s.world.pressed).not.toContain("open-settings");
    expect(answer).not.toContain("with 1 repair");
    expect(r.files()).toEqual(["rename.json"]);
    expect(r.lines.some((line) => (line.detail ?? "").includes("id=open-settings (") && (line.detail ?? "").includes("rejected"))).toBe(true);
  });

  it("rejects a candidate named by a policy word the app's own empty lists would have replaced (the union)", async () => {
    const r = await rig({ policy: { version: 1, confirm: ["Settings"], block: [], apps: { [APP.id]: { confirm: [], block: [] } } } });
    r.script("rename", RENAMED);
    await r.s.tools.replay({ name: "rename", repair: "apply" });
    expect(r.s.world.pressed).not.toContain("open-settings");
    expect(r.files()).toEqual(["rename.json"]);
  });

  it("rejects a candidate that would submit a form, on a screen that has an input", async () => {
    const r = await rig({
      world: (w) => {
        w.screen = "form";
        w.initial = "form";
        w.goes["form|save-profile"] = "home";
      },
    });
    r.script("submit", [
      { tool: "tap", target: { id: "save-profile-btn" }, expect: { id: "open-settings" } },
      { tool: "tap", target: { id: "open-settings" } },
    ]);
    await r.s.tools.replay({ name: "submit", repair: "apply" });
    expect(r.s.world.pressed).not.toContain("save-profile");
    expect(r.files()).toEqual(["submit.json"]);
    expect(r.lines.some((line) => (line.detail ?? "").includes("save-profile (") && (line.detail ?? "").includes("rejected"))).toBe(true);
  });

  it("rejects an inserted road move whose real recipient is a protected control", async () => {
    const map = mapWith({ home: ["home"], welcome: ["welcome"], settings: ["settings"], language: ["settings", "language"] }, [{ from: "welcome", to: "settings", id: "continue", text: "Continue" }]);
    const r = await rig({
      map,
      world: (w) => {
        w.screens["welcome"] = { route: ["welcome"], elements: [btn("continue", "Continue")] };
        w.goes["home|open-settings"] = "welcome";
        w.goes["welcome|continue"] = "settings";
        w.recipient["continue"] = btn("continue", "Pay now");
      },
    });
    r.script("way", [
      { tool: "tap", target: { id: "open-settings" }, place: "home" },
      { tool: "tap", target: { id: "open-language" }, place: "settings", expect: { id: "pick-english" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "way", repair: "apply" }));
    expect(r.s.world.pressed).not.toContain("continue");
    expect(answer).not.toContain("with 1 repair");
    expect(r.files()).toEqual(["way.json"]);
  });

  it("a plain replay still presses what the script says, whatever its words (the floor is for repair's own moves)", async () => {
    const r = await rig();
    r.script("plain", [{ tool: "tap", target: { id: "open-settings" }, expect: { id: "notify-switch" } }]);
    const answer = await r.s.tools.replay({ name: "plain", repair: "apply" });
    expect(answer.isError).not.toBe(true);
    expect(r.s.world.pressed).toEqual(["open-settings"]);
  });
});

const WELCOME_MAP = (): ReturnType<typeof mapWith> => mapWith({ home: ["home"], welcome: ["welcome"], settings: ["settings"], language: ["settings", "language"] }, [{ from: "welcome", to: "settings", id: "continue", text: "Continue" }]);
const welcomeWorld = (w: Parameters<NonNullable<RigOptions["world"]>>[0]): void => {
  w.screens["welcome"] = { route: ["welcome"], elements: [btn("continue", "Continue")], parent: "home" };
  w.goes["home|open-settings"] = "welcome";
  w.goes["welcome|continue"] = "settings";
};

describe("R2 finding 2: a destination repair meets the same rules and is proven as emitted", () => {
  it("never repairs a type_text step that ended on another place than it was recorded to", async () => {
    const map = mapWith({ home: ["home"], form: ["form"], settings: ["settings"] }, [{ from: "form", to: "settings", id: "help", text: "Help" }]);
    const r = await rig({
      map,
      world: (w) => {
        w.screen = "form";
        w.goes["form|help"] = "settings";
      },
    });
    r.script("typed", [
      { tool: "type_text", target: { id: "nickname" }, text: "Sam", route: ["settings"] },
      { tool: "tap", target: { id: "open-language" }, expect: { id: "pick-english" } },
    ]);
    const said = textOf(await r.s.tools.replay({ name: "typed", repair: "apply" }));
    expect(said).toContain("Repair: none. A type_text step is never repaired.");
    expect(r.s.world.pressed).not.toContain("help");
    expect(r.files()).toEqual(["typed.json"]);
    expect(r.lines).toEqual([]);
  });

  it("never repairs a last step that has no expect and no step after it", async () => {
    const r = await rig({ map: WELCOME_MAP(), world: welcomeWorld });
    r.script("last", [{ tool: "tap", target: { id: "open-settings" }, route: ["settings"] }]);
    const said = textOf(await r.s.tools.replay({ name: "last", repair: "apply" }));
    expect(said.split("\n")[0]).toMatch(/^Error expect_failed: Ran 0 of 1 steps/);
    expect(said).toContain("Repair: none. The step has no check");
    expect(r.s.world.pressed).toEqual(["open-settings"]);
    expect(r.files()).toEqual(["last.json"]);
    expect(r.lines).toEqual([]);
  });

  it("moves the route assertion behind the inserted navigation, so the repaired script replays by itself", async () => {
    const r = await rig({ map: WELCOME_MAP(), world: welcomeWorld });
    r.script("ended", [
      { tool: "tap", target: { id: "open-settings" }, route: ["settings"] },
      { tool: "tap", target: { id: "open-language" }, route: ["settings", "language"], expect: { id: "pick-english" } },
    ]);
    const said = textOf(await r.s.tools.replay({ name: "ended", repair: "apply" }));
    expect(said.split("\n")[0]).toBe("Ran 2 of 2 steps in 0.0 s, with 1 repair (not adopted).");
    const repaired = JSON.parse(r.read("ended.repaired.json")) as { steps: Array<Record<string, unknown>> };
    expect(repaired.steps.map((step) => [(step["target"] as { id: string }).id, step["route"]])).toEqual([
      ["open-settings", undefined],
      ["continue", ["settings"]],
      ["open-language", ["settings", "language"]],
    ]);
    // A fresh, ordinary replay of the file as written passes.
    r.s.world.screen = "home";
    const again = await r.s.tools.replay({ path: join(r.scriptsDir, "ended.repaired.json") });
    expect(again.isError).not.toBe(true);
    expect(textOf(again)).toMatch(/^Ran 3 of 3 steps/);
  });

  it("writes nothing when the emitted script fails its own replay", async () => {
    const r = await rig({
      world: (w) => {
        // After the first run the app behaves differently: the repaired step's target now leads elsewhere.
        w.onPress = (id) => {
          if (id === "open-language") w.goes["home|open-settings"] = "trips";
        };
      },
    });
    r.script("flaky", RENAMED);
    const said = textOf(await r.s.tools.replay({ name: "flaky", repair: "apply" }));
    expect(said).not.toContain("with 1 repair");
    expect(said).toContain("nothing was written");
    expect(r.files()).toEqual(["flaky.json"]);
    expect(r.lines.some((line) => (line.detail ?? "").endsWith("accepted"))).toBe(true);
    expect(r.lines.some((line) => (line.detail ?? "").includes("rejected (the repaired script failed"))).toBe(true);
  });
});

const checkbox = (id: string, label: string): ExEl => ({ id, label, role: "checkbox", type: "Checkbox", actions: ["toggle"], checked: false });

function withToggleRole(role: string | undefined): ReturnType<typeof mapWith> {
  const map = mapWith({ home: ["home"], settings: ["settings"], language: ["settings", "language"] }, []);
  const settings = map.places["settings"];
  if (settings !== undefined && role !== undefined) {
    settings.explored = { last: "2026-11-12T10:00:00.000Z", actions: [{ sig: "id:notify-sw", result: "same", role, build: BUILD, last: "2026-11-12T10:00:00.000Z" }], frontier: [] };
  }
  return map;
}

describe("R2 finding 3: a toggle is repaired only to its own role", () => {
  const flip = [{ tool: "toggle", target: { id: "notify-sw" }, expect: { id: "open-language" }, place: "settings" }];
  const settingsWith = (replace: ExEl) => (w: Parameters<NonNullable<RigOptions["world"]>>[0]): void => {
    w.screen = "settings";
    const settings = w.screens["settings"];
    if (settings !== undefined) settings.elements = [replace, btn("open-language", "Language")];
  };

  it("refuses a checkbox where the recorded role is a switch", async () => {
    const r = await rig({ map: withToggleRole("switch"), world: settingsWith(checkbox("notify-switch", "Notifications")) });
    r.script("flip", flip);
    const said = textOf(await r.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(said).not.toContain("with 1 repair");
    expect(r.s.world.pressed).toEqual([]);
    expect(r.files()).toEqual(["flip.json"]);
  });

  it("refuses any toggle whose original role was never recorded", async () => {
    const r = await rig({ map: withToggleRole(undefined), world: settingsWith(toggle("notify-switch", "Notifications")) });
    r.script("flip", flip);
    const said = textOf(await r.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(said).toContain("Repair: none. The toggle's original role isn't recorded");
    expect(r.s.world.pressed).toEqual([]);
    expect(r.files()).toEqual(["flip.json"]);
  });

  it("repairs a switch to a switch when the role was recorded", async () => {
    const r = await rig({ map: withToggleRole("switch"), world: settingsWith(toggle("notify-switch", "Notifications")) });
    r.script("flip", flip);
    const said = textOf(await r.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(said).toContain("step 1 toggle id=notify-sw to id=notify-switch");
    // The run, then the replay of the repaired script as written.
    expect(r.s.world.pressed).toEqual(["notify-switch", "notify-switch"]);
  });

  it("explore records the role of a toggle it flipped and set back", async () => {
    const r = await rig();
    await r.s.tools.explore({});
    await r.s.registry.flushAll();
    const action = r.s.file().places["settings"]?.explored?.actions.find((a) => a.sig === "id:notify-switch");
    expect(action).toMatchObject({ result: "same", role: "switch" });
  });
});

describe("R3: the repaired file's pictures", () => {
  it("copies the original's references folder beside the repaired file, once", async () => {
    const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
    const r = await rig();
    r.script("rename", RENAMED);
    const from = join(r.scriptsDir, "rename.references");
    mkdirSync(from);
    writeFileSync(join(from, "home.jpg"), "PICTURE");
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    expect(readFileSync(join(r.scriptsDir, "rename.repaired.references", "home.jpg"), "utf8")).toBe("PICTURE");
    expect(existsSync(from)).toBe(true);
  });
});
