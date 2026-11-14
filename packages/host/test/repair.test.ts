import { HOST_VERSION } from "../src/version.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { APP, BUILD, mapWith, repairRig, textOf, type RepairRig, type RigOptions } from "./repair-helpers.js";

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

/** Two steps: home to settings (its id renamed since the recording), then the language row, each with its expect. */
const RENAMED = [
  { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } },
  { tool: "tap", target: { id: "open-language" }, expect: { id: "pick-english" } },
];

describe("repair suggest (§26.5)", () => {
  it("ranks the candidates of the first break, writes nothing and touches nothing", async () => {
    const r = await rig();
    r.script("rename", RENAMED);
    const before = r.read("rename.json");
    const answer = await r.s.tools.replay({ name: "rename", repair: "suggest" });
    const lines = textOf(answer).split("\n");
    expect(answer.isError).toBe(true);
    expect(lines[0]).toBe('Error not_found: Ran 0 of 2 steps; stopped at step 1 (tap id=open-settings-btn): No element matches');
    const at = lines.findIndex((line) => line.startsWith("Repair (suggest, not checked):"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^1\. tap id=open-settings, button "Settings" on home: score 0\.67 \(id_stem 0\.67\)\. Why: /);
    expect(lines[at + 2]).toMatch(/^2\. tap id=open-(trips|form), button "(Trips|Form)" on home: score 0\.33 \(id_stem 0\.33\)/);
    expect(lines.at(-1)).toBe('To check it: replay with repair: "apply".');
    // Only the first break is shown, nothing was touched, written or logged.
    expect(r.s.world.pressed).toEqual([]);
    expect(r.files()).toEqual(["rename.json"]);
    expect(r.read("rename.json")).toBe(before);
    expect(r.lines).toEqual([]);
  });

  it("a replay without repair answers as it always did, with no suggestion", async () => {
    const r = await rig();
    r.script("rename", RENAMED);
    const answer = textOf(await r.s.tools.replay({ name: "rename" }));
    expect(answer).not.toContain("Repair");
  });

  it("says ambiguous when the best two scores are less than 0.02 apart, and tries nothing", async () => {
    const r = await rig();
    r.script("tie", [{ tool: "tap", target: { id: "open-xyz" }, expect: { id: "notify-switch" } }]);
    const said = textOf(await r.s.tools.replay({ name: "tie", repair: "suggest" }));
    expect(said).toContain("Repair (suggest, not checked): ambiguous.");
    expect(said).toContain("less than 0.02 apart");
    expect(r.s.world.pressed).toEqual([]);
    const applied = textOf(await r.s.tools.replay({ name: "tie", repair: "apply" }));
    expect(applied.split("\n")[0]).toMatch(/^Error not_found: Ran 0 of 1 steps/);
    expect(applied).toContain("Repair: none.");
    expect(r.s.world.pressed).toEqual([]);
    expect(r.files()).toEqual(["tie.json"]);
  });

  it("works through the tool call the way a model sends it (a name and repair)", async () => {
    const r = await rig();
    r.script("rename", RENAMED);
    const said = textOf(await callTool(r.s.tools, "replay", { name: "rename", repair: "suggest" }));
    expect(said).toContain("Repair (suggest, not checked):");
  });

  it("an expect that fails is a finding of kind expect_failed, never a suggestion", async () => {
    const r = await rig();
    r.script("bug", [{ tool: "tap", target: { id: "open-settings" }, expect: { id: "no-such-element" }, place: "home" }]);
    const said = textOf(await r.s.tools.replay({ name: "bug", repair: "suggest" }));
    expect(said.split("\n")[0]).toMatch(/^Error expect_failed: Ran 0 of 1 steps; stopped at step 1 \(tap id=open-settings\): its action ran, but id "no-such-element" didn't appear/);
    expect(said).toContain("Repair (suggest): none. An expect that fails is a finding, never a break to repair.");
    expect(said).toContain('Finding f1 (expect_failed) at step 1 of "bug"');
    const json = said.split("\n").find((line) => line.startsWith("Finding: {")) as string;
    const finding = JSON.parse(json.slice("Finding: ".length)) as Record<string, unknown>;
    expect(finding).toMatchObject({ id: "f1", kind: "expect_failed", app: APP.id, app_version: "1.5.0", build: "220", tool: "tapline", tool_version: HOST_VERSION, place: "home", path_from: "home", picture: null, count: 1 });
    expect(finding["path"]).toEqual([{ tool: "tap", target: { id: "open-settings" } }]);
  });
});

describe("repair apply: the breaks it repairs (§26.1, §26.4)", () => {
  it("a renamed testID: repairs it, checks the step's expect, writes the repaired script and the notes, and leaves the original", async () => {
    const r = await rig();
    const path = r.script("rename", RENAMED);
    const before = readFileSync(path, "utf8");
    const answer = await r.s.tools.replay({ name: "rename", repair: "apply" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toBe(
      [
        "Ran 2 of 2 steps in 0.0 s, with 1 repair (not adopted).",
        "Repaired: step 1 tap id=open-settings-btn to id=open-settings (score 0.67).",
        "Wrote rename.repaired.json and rename.repair.md. The original is unchanged.",
      ].join("\n"),
    );
    expect(r.files()).toEqual(["rename.json", "rename.repair.md", "rename.repaired.json"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    const repaired = JSON.parse(r.read("rename.repaired.json")) as { repaired: unknown; steps: Array<Record<string, unknown>>; name: string };
    expect(repaired.name).toBe("rename");
    expect(repaired.repaired).toEqual({ from: "rename.json", at: "2026-11-14T09:15:00Z", tool: "tapline", build: "1.5.0 (220)", count: 1 });
    expect(repaired.steps[0]).toMatchObject({ tool: "tap", target: { id: "open-settings" }, expect: { id: "notify-switch" }, repaired: { was: { id: "open-settings-btn" }, score: 0.67 } });
    expect(repaired.steps[1]).toEqual(RENAMED[1]);
    const notes = r.read("rename.repair.md");
    expect(notes).toContain(`# Repairs for rename (2026-11-14, tapline ${HOST_VERSION}, build 1.5.0 (220))`);
    expect(notes).toContain('1. Step 1 (tap). Was id=open-settings-btn; now id=open-settings (button "Settings", place home).');
    expect(notes).toContain("   - Score 0.67: id_stem 0.67.");
    expect(notes).toContain('   - Accepted: the step\'s expect (id "notify-switch") held, and the whole run passed.');
    // The run, then the replay of the repaired script as written.
    expect(r.s.world.pressed).toEqual(["open-settings", "open-language", "open-settings", "open-language"]);
  });

  it("the repaired script replays by itself, and the audit log has one line for the repair", async () => {
    const r = await rig();
    r.script("rename", RENAMED);
    await r.s.tools.replay({ name: "rename", repair: "apply" });
    expect(r.lines).toEqual([{ kind: "repair", app: APP.id, name: "rename", detail: "step 1: tap id=open-settings-btn to id=open-settings (score 0.67), accepted" }]);
    r.s.world.screen = "home";
    const again = await r.s.tools.replay({ path: join(r.scriptsDir, "rename.repaired.json") });
    expect(again.isError).not.toBe(true);
    expect(textOf(again)).toMatch(/^Ran 2 of 2 steps/);
  });

  it("a moved button (another id and another place on the screen)", async () => {
    const r = await rig({
      world: (w) => {
        const home = w.screens["home"];
        if (home !== undefined) home.elements = home.elements.map((el) => (el.id === "open-form" ? btn("open-form-button", "Form", { frame: { x: 200, y: 800, width: 100, height: 44 } }) : el));
        w.goes["home|open-form-button"] = "form";
      },
    });
    r.script("moved", [{ tool: "tap", target: { id: "form-btn" }, expect: { id: "name-test-safe" } }]);
    const answer = textOf(await r.s.tools.replay({ name: "moved", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    expect(answer).toContain("step 1 tap id=form-btn to id=open-form-button (score 0.67)");
    expect(JSON.parse(r.read("moved.repaired.json")).steps[0].target).toEqual({ id: "open-form-button" });
  });

  it("a new screen in the way: inserts the proven road before the step and checks the step's expect", async () => {
    const map = mapWith({ home: ["home"], welcome: ["welcome"], settings: ["settings"], language: ["settings", "language"] }, [{ from: "welcome", to: "settings", id: "continue", text: "Continue" }]);
    const r = await rig({
      map,
      world: (w) => {
        w.screens["welcome"] = { route: ["welcome"], elements: [btn("continue", "Continue")] };
        w.goes["home|open-settings"] = "welcome";
        w.goes["welcome|continue"] = "settings";
      },
    });
    r.script("way", [
      { tool: "tap", target: { id: "open-settings" }, place: "home" },
      { tool: "tap", target: { id: "open-language" }, place: "settings", expect: { id: "pick-english" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "way", repair: "apply" }));
    expect(answer).toBe(
      [
        "Ran 2 of 2 steps in 0.0 s, with 1 repair (not adopted).",
        "Repaired: step 2 inserted before it: tap id=continue (welcome to settings).",
        "Wrote way.repaired.json and way.repair.md. The original is unchanged.",
      ].join("\n"),
    );
    const repaired = JSON.parse(r.read("way.repaired.json")) as { steps: Array<Record<string, unknown>> };
    expect(repaired.steps.map((step) => [step["tool"], (step["target"] as { id: string }).id, step["repaired"]])).toEqual([
      ["tap", "open-settings", undefined],
      ["tap", "continue", { inserted: true }],
      ["tap", "open-language", undefined],
    ]);
    expect(r.lines[0]?.detail).toBe("step 2: tap id=open-language, before it: tap id=continue (welcome to settings), accepted");
    // The run, then the replay of the repaired script as written.
    expect(r.s.world.pressed).toEqual(["open-settings", "continue", "open-language", "open-settings", "continue", "open-language"]);
  });

  it("a new screen after a step: the recording's route says where it ended, and the road is put after it", async () => {
    const map = mapWith({ home: ["home"], welcome: ["welcome"], settings: ["settings"], language: ["settings", "language"] }, [{ from: "welcome", to: "settings", id: "continue", text: "Continue" }]);
    const r = await rig({
      map,
      world: (w) => {
        w.screens["welcome"] = { route: ["welcome"], elements: [btn("continue", "Continue")] };
        w.goes["home|open-settings"] = "welcome";
        w.goes["welcome|continue"] = "settings";
      },
    });
    r.script("ended", [
      { tool: "tap", target: { id: "open-settings" }, route: ["settings"] },
      { tool: "tap", target: { id: "open-language" }, route: ["settings", "language"], expect: { id: "pick-english" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "ended", repair: "apply" }));
    expect(answer.split("\n")[0]).toBe("Ran 2 of 2 steps in 0.0 s, with 1 repair (not adopted).");
    expect(answer).toContain("step 1 inserted after it: tap id=continue (welcome to settings)");
    // The run, then the replay of the repaired script as written.
    expect(r.s.world.pressed).toEqual(["open-settings", "continue", "open-language", "open-settings", "continue", "open-language"]);
  });

  it("a row now behind a scroll: scrolls down until it shows, then acts", async () => {
    const r = await rig({
      world: (w) => {
        w.goes["trips|trip-row-5"] = "trip";
      },
    });
    r.script("scrolled", [
      { tool: "tap", target: { id: "open-trips" } },
      { tool: "tap", target: { id: "trip-row-5" }, expect: { id: "share-trip" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "scrolled", repair: "apply" }));
    expect(answer.split("\n")[0]).toBe("Ran 2 of 2 steps in 0.0 s, with 1 repair (not adopted).");
    expect(answer).toContain("step 2 inserted before it: scroll down 2 times");
    const repaired = JSON.parse(r.read("scrolled.repaired.json")) as { steps: Array<Record<string, unknown>> };
    expect(repaired.steps.map((step) => step["tool"])).toEqual(["tap", "scroll", "scroll", "tap"]);
    expect(repaired.steps[1]).toMatchObject({ direction: "down", repaired: { inserted: true } });
    // The run, then the replay of the repaired script as written.
    expect(r.s.world.pressed).toEqual(["open-trips", "trip-row-5", "open-trips", "trip-row-5"]);
  });

  it("a step with no expect is checked by the target of the next step", async () => {
    const r = await rig();
    r.script("next", [
      { tool: "tap", target: { id: "open-settings-btn" } },
      { tool: "tap", target: { id: "open-language" }, expect: { id: "pick-english" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "next", repair: "apply" }));
    expect(answer.split("\n")[0]).toBe("Ran 2 of 2 steps in 0.0 s, with 1 repair (not adopted).");
    expect(r.read("next.repair.md")).toContain("the next step's target (id=open-language) resolved to one element, and the whole run passed.");
  });

  it("a last step with no expect has no check, so it isn't repaired", async () => {
    const r = await rig();
    r.script("last", [{ tool: "tap", target: { id: "open-settings-btn" } }]);
    const answer = textOf(await r.s.tools.replay({ name: "last", repair: "apply" }));
    expect(answer.split("\n")[0]).toMatch(/^Error not_found: Ran 0 of 1 steps/);
    expect(answer).toContain("Repair: none. The step has no check");
    expect(r.s.world.pressed).toEqual([]);
    expect(r.files()).toEqual(["last.json"]);
  });
});

describe("repair apply: what it never repairs (§26.2)", () => {
  const untouched = (r: RepairRig, name: string): void => {
    expect(r.files()).toEqual([`${name}.json`]);
    expect(r.lines).toEqual([]);
    expect(r.s.world.pressed).toEqual([]);
  };

  it("a step whose target carries a policy word (the floor's too), even under an empty policy", async () => {
    const r = await rig();
    r.script("word", [
      { tool: "tap", target: { id: "sign-out-button" }, expect: { id: "open-settings" } },
      { tool: "tap", target: { label: "Pay nowx" }, expect: { id: "open-settings" } },
    ]);
    const first = textOf(await r.s.tools.replay({ name: "word", repair: "apply" }));
    expect(first).toContain('Repair: none. Its target carries the policy word "Sign out", so it is never repaired.');
    untouched(r, "word");
  });

  it("a type_text step: nothing that types is repaired, so a repair can't move a value to another field", async () => {
    const r = await rig();
    r.script("typing", [{ tool: "tap", target: { id: "open-form" } }, { tool: "type_text", target: { id: "name-field" }, text: "Sam", expect: { id: "save-profile" } }]);
    const said = textOf(await r.s.tools.replay({ name: "typing", repair: "apply" }));
    expect(said).toMatch(/Error not_found: Ran 1 of 2 steps; stopped at step 2 \(type_text id=name-field\)/);
    expect(said).toContain("Repair: none. A type_text step is never repaired.");
    expect(r.s.world.typed).toEqual([]);
    expect(r.files()).toEqual(["typing.json"]);
  });

  it("a native Back (a tap on a control named Back)", async () => {
    const r = await rig();
    r.script("goback", [{ tool: "tap", target: { label: "Back" }, expect: { id: "open-settings" } }]);
    const said = textOf(await r.s.tools.replay({ name: "goback", repair: "apply" }));
    expect(said).toContain("Repair: none. A native Back is never repaired.");
    untouched(r, "goback");
  });

  it("a toggle is repaired only to an element of the recorded role (the original's role comes from the map)", async () => {
    const recorded = mapWith({ home: ["home"], settings: ["settings"], language: ["settings", "language"] }, []);
    const place = recorded.places["settings"];
    if (place !== undefined) place.explored = { last: "2026-11-12T10:00:00.000Z", actions: [{ sig: "id:notify-sw", result: "same", role: "switch", build: BUILD, last: "2026-11-12T10:00:00.000Z" }], frontier: [] };
    const same = await rig({ map: recorded, world: (w) => void (w.screen = "settings") });
    same.script("flip", [{ tool: "toggle", target: { id: "notify-sw" }, expect: { id: "open-language" }, place: "settings" }]);
    const ok = textOf(await same.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(ok).toContain("step 1 toggle id=notify-sw to id=notify-switch");
    const other = await rig({
      map: recorded,
      world: (w) => {
        w.screen = "settings";
        const settings = w.screens["settings"];
        if (settings !== undefined) settings.elements = [btn("notify-switch", "Notifications"), btn("open-language", "Language")];
      },
    });
    other.script("flip", [{ tool: "toggle", target: { id: "notify-sw" }, expect: { id: "open-language" }, place: "settings" }]);
    const refused = textOf(await other.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(refused).toContain("Repair: none. Nothing on the screen can take the step's toggle");
    expect(other.s.world.pressed).toEqual([]);
    expect(other.files()).toEqual(["flip.json"]);
  });

  it("a step in a drafts-only route", async () => {
    const r = await rig();
    r.script("drafty", RENAMED, { version: 2, draftsOnly: true });
    const said = textOf(await r.s.tools.replay({ path: join(r.scriptsDir, "drafty.json"), repair: "apply" }));
    expect(said).toContain("Repair: none. A step in a drafts-only route is never repaired.");
    untouched(r, "drafty");
  });

  it("an expect that fails is a finding in a real run, and nothing is written", async () => {
    const r = await rig();
    r.script("bug", [
      { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } },
      { tool: "tap", target: { id: "open-language" }, expect: { id: "no-such-id" } },
    ]);
    const said = textOf(await r.s.tools.replay({ name: "bug", repair: "apply" }));
    expect(said.split("\n")[0]).toMatch(/^Error expect_failed: Ran 1 of 2 steps; stopped at step 2 /);
    expect(said).toContain("Note: 1 repair was made before it stopped; nothing was written.");
    expect(said).toContain('Finding f1 (expect_failed) at step 2 of "bug"');
    expect(r.files()).toEqual(["bug.json"]);
    // The line for the repair that had been accepted is followed by one that says the run failed.
    expect(r.lines.map((l) => l.detail)).toEqual([
      "step 1: tap id=open-settings-btn to id=open-settings (score 0.67), accepted",
      "step 1: tap id=open-settings-btn to id=open-settings (score 0.67), rejected (the run failed at step 2)",
    ]);
  });
});

describe("repair apply: the limits and the audit log (§26.4, §26.7)", () => {
  it("rejects a candidate that fails its check, logs it, and takes the app back to where the step started", async () => {
    const r = await rig({
      map: mapWith({ home: ["home"], settings: ["settings"], trips: ["trips"], form: ["form"] }, [{ from: "trips", to: "home", id: "back-home", text: "Home" }]),
      world: (w) => {
        // Every candidate leads somewhere else than the step's expect.
        w.goes["home|open-settings"] = "trips";
        const trips = w.screens["trips"];
        if (trips !== undefined) trips.elements = [...trips.elements, btn("back-home", "Home")];
        w.goes["trips|back-home"] = "home";
      },
    });
    r.script("all-wrong", [{ tool: "tap", target: { id: "open-set-btn" }, expect: { id: "notify-switch" } }]);
    const said = textOf(await r.s.tools.replay({ name: "all-wrong", repair: "apply" }));
    expect(said.split("\n")[0]).toMatch(/^Error not_found: Ran 0 of 1 steps/);
    expect(said).toContain("Repair: the candidates were tried and none passed the check.");
    expect(r.files()).toEqual(["all-wrong.json"]);
    expect(r.lines.map((l) => l.detail)).toEqual([
      expect.stringMatching(/^step 1: tap id=open-set-btn to id=open-settings \(score 0\.67\), rejected \(.*notify-switch/),
      expect.stringMatching(/to id=open-(trips|form) \(score 0\.33\), rejected/),
      expect.stringMatching(/to id=open-(trips|form) \(score 0\.33\), rejected/),
    ]);
    // Each trial pressed its candidate, and the app was taken back home (by the proven road) before the next.
    expect(r.s.world.screen).toBe("home");
    expect(r.s.world.pressed[0]).toBe("open-settings");
  });

  it("when the audit line can't be written, the repair isn't made", async () => {
    const r = await rig({ auditFails: true });
    r.script("rename", RENAMED);
    const said = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(said.split("\n")[0]).toMatch(/^Error not_found: Ran 0 of 2 steps/);
    expect(said).toContain("Note: the audit log couldn't be written, so no repair was made.");
    expect(r.files()).toEqual(["rename.json"]);
  });

  it("without an audit log no repair is made either", async () => {
    const r = await rig({ noAudit: true });
    r.script("rename", RENAMED);
    const said = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(said).toContain("the audit log couldn't be written");
    expect(r.files()).toEqual(["rename.json"]);
  });

  it("a script that passes with nothing to repair answers as a plain replay and writes nothing", async () => {
    const r = await rig();
    r.script("fine", [{ tool: "tap", target: { id: "open-settings" }, expect: { id: "notify-switch" } }]);
    const answer = await r.s.tools.replay({ name: "fine", repair: "apply" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
    expect(r.files()).toEqual(["fine.json"]);
    expect(r.lines).toEqual([]);
  });

  it("stops after 5 repairs: a script with more breaks is left to a person", async () => {
    const world = (w: import("./explore-helpers.js").ExWorld): void => {
      const home = w.screens["home"];
      if (home === undefined) return;
      home.elements = ["a", "b", "c", "d", "e", "f"].map((k) => btn(`item-${k}-live`, `Item ${k.toUpperCase()}`));
    };
    const r = await rig({ world });
    r.script(
      "many",
      ["a", "b", "c", "d", "e", "f"].map((k) => ({ tool: "tap", target: { id: `item-${k}-liv` }, expect: { id: `item-${k}-live` } })),
    );
    const said = textOf(await r.s.tools.replay({ name: "many", repair: "apply" }));
    expect(said.split("\n")[0]).toMatch(/^Error not_found: Ran 5 of 6 steps; stopped at step 6 /);
    expect(said).toContain("Note: 5 repairs were made and the script still breaks; more than 5 breaks are left to a person.");
    expect(said).toContain("Note: 5 repairs were made before it stopped; nothing was written.");
    expect(r.files()).toEqual(["many.json"]);
  });
});

describe("record saves each step's place (§26.6)", () => {
  it("a recorded step carries the name of the place where it ran, and the recording replays", async () => {
    const r = await rig();
    await r.s.tools.look({ screenshot: false });
    await r.s.tools.record({ action: "start", name: "placed" });
    await r.s.tools.tap({ target: { id: "open-settings" } });
    await r.s.tools.look({ screenshot: false });
    await r.s.tools.tap({ target: { id: "open-language" } });
    await r.s.tools.record({ action: "stop" });
    const saved = JSON.parse(r.read("placed.json")) as { steps: Array<Record<string, unknown>> };
    expect(saved.steps.map((step) => step["place"])).toEqual(["home", "settings"]);
    // The key is a step field, never a parameter: the script runs again as it is.
    r.s.world.screen = "home";
    const again = await r.s.tools.replay({ name: "placed" });
    expect(again.isError).not.toBe(true);
  });
});

describe("repair: the map receives roads only (§18.9, §26.5)", () => {
  const mapAt = (r: RepairRig): string => JSON.stringify(r.s.file());

  it("a passing apply updates the road with the repaired move, proven for the build, and writes nothing else", async () => {
    const map = mapWith({ home: ["home"], settings: ["settings"] }, [{ from: "home", to: "settings", id: "open-settings-btn", text: "Settings" }]);
    const r = await rig({ map });
    r.script("rename", RENAMED);
    await r.s.tools.replay({ name: "rename", repair: "apply" });
    await r.s.registry.flushAll();
    const file = r.s.file();
    const road = file.roads.find((x) => x.from === "home" && x.to === "settings");
    expect(road?.move).toEqual({ tool: "tap", target: { id: "open-settings" } });
    expect(road?.names).toEqual({ id: "open-settings" });
    expect(road?.build).toBe("1.5.0 (220)");
    expect(road?.seen).toBe(3);
    // The places are as they were: no explored record, no new place, and no other road.
    expect(Object.keys(file.places).sort()).toEqual(["home", "settings"]);
    expect(file.roads).toHaveLength(1);
    expect(file.places["home"]).toEqual(map.places["home"]);
    expect(JSON.stringify(file.places["settings"])).not.toContain("explored");
  });

  it("suggest, a failed apply and a repair with no road leave the map as it was", async () => {
    const map = mapWith({ home: ["home"], settings: ["settings"] }, [{ from: "home", to: "settings", id: "open-settings-btn", text: "Settings" }]);
    const r = await rig({ map });
    await r.s.registry.flushAll();
    const before = mapAt(r);
    r.script("rename", RENAMED);
    await r.s.tools.replay({ name: "rename", repair: "suggest" });
    r.script("bug", [{ tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } }, { tool: "tap", target: { id: "open-language" }, expect: { id: "nope" } }]);
    await r.s.tools.replay({ name: "bug", repair: "apply" });
    await r.s.registry.flushAll();
    expect(mapAt(r)).toBe(before);
    // A repaired step that no road has leaves the map alone too.
    const plain = await rig({ map: mapWith({ home: ["home"], settings: ["settings"] }, []) });
    await plain.s.registry.flushAll();
    const start = mapAt(plain);
    plain.script("rename", RENAMED);
    await plain.s.tools.replay({ name: "rename", repair: "apply" });
    await plain.s.registry.flushAll();
    expect(mapAt(plain)).toBe(start);
  });
});

describe("repair: adopt is a person's choice (§26.5)", () => {
  it("replay has no parameter that adopts: the tool call's adopt is ignored", async () => {
    const r = await rig();
    const path = r.script("rename", RENAMED);
    const before = readFileSync(path, "utf8");
    const answer = textOf(await callTool(r.s.tools, "replay", { name: "rename", repair: "apply", adopt: true }));
    expect(answer).toContain("replay doesn't take adopt");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(r.scriptsDir, "rename.orig.json"))).toBe(false);
    expect(r.lines.map((l) => l.detail)).not.toContain("adopted");
  });

  it("the command line's adopt replaces the original, keeps the first original once, removes the repaired file and keeps the notes", async () => {
    const r = await rig();
    const path = r.script("rename", RENAMED);
    const original = readFileSync(path, "utf8");
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }, { adopt: true }));
    expect(answer).toBe(
      [
        "Ran 2 of 2 steps in 0.0 s, with 1 repair (adopted).",
        "Repaired: step 1 tap id=open-settings-btn to id=open-settings (score 0.67).",
        "Adopted: rename.json now holds the repaired script; the original is kept as rename.orig.json. Wrote rename.repair.md.",
      ].join("\n"),
    );
    expect(r.files()).toEqual(["rename.json", "rename.orig.json", "rename.repair.md"]);
    expect(r.read("rename.orig.json")).toBe(original);
    const adopted = JSON.parse(r.read("rename.json")) as { steps: Array<{ target: { id: string } }>; repaired: { count: number } };
    expect(adopted.steps[0]?.target.id).toBe("open-settings");
    expect(adopted.repaired.count).toBe(1);
    expect(r.lines.map((l) => l.detail)).toEqual(["step 1: tap id=open-settings-btn to id=open-settings (score 0.67), accepted", "adopted"]);
    // A second break and a second adopt: the first original is never lost.
    r.s.world.screen = "home";
    const home = r.s.world.screens["settings"];
    if (home !== undefined) home.elements = home.elements.map((el) => (el.id === "open-language" ? btn("open-language-row", "Language") : el));
    r.s.world.goes["settings|open-language-row"] = "language";
    await r.s.tools.replay({ name: "rename", repair: "apply" }, { adopt: true });
    expect(r.read("rename.orig.json")).toBe(original);
    expect((JSON.parse(r.read("rename.json")) as { steps: Array<{ target: { id: string } }> }).steps[1]?.target.id).toBe("open-language-row");
  });

  it("nothing is adopted when the run fails", async () => {
    const r = await rig();
    const path = r.script("bug", [{ tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } }, { tool: "tap", target: { id: "open-language" }, expect: { id: "nope" } }]);
    const before = readFileSync(path, "utf8");
    await r.s.tools.replay({ name: "bug", repair: "apply" }, { adopt: true });
    expect(r.files()).toEqual(["bug.json"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(r.lines.map((l) => l.detail)).not.toContain("adopted");
  });

  it("is not adopted when the adopted line can't be written", async () => {
    // The accepted line is written, the adopted one is refused.
    let calls = 0;
    const r = await rig();
    const sink = { write: (): boolean => ++calls < 2 };
    (r.s.tools as unknown as { options: { audit: typeof sink } }).options.audit = sink;
    const path = r.script("rename", RENAMED);
    const before = readFileSync(path, "utf8");
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }, { adopt: true }));
    expect(answer).toContain("so the script was not adopted");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
