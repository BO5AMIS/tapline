import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TreeElement } from "../src/protocol.js";
import { idStemOf, readSeen, seenBucket, seenOf } from "../src/seen.js";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps, toggle, type ExEl } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { mapWith, repairRig, textOf, type RepairRig, type RigOptions } from "./repair-helpers.js";

// AGENT-TOOLS 1.16 section 9.4, 26.3, 26.6: a recorded step's `seen`, and the repair score that compares it.

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

type World = Parameters<NonNullable<RigOptions["world"]>>[0];

const el = (extra: Partial<TreeElement>): TreeElement => ({ ref: "e1", ...extra }) as TreeElement;

describe("the id stem (section 9.4)", () => {
  it("lower-cases and removes trailing digits and the listed words again and again, with their separators", () => {
    expect(idStemOf("save-button")).toBe("save");
    expect(idStemOf("trip-row-1")).toBe("trip");
    expect(idStemOf("Login_Btn")).toBe("login");
    expect(idStemOf("saveButton")).toBe("save");
    expect(idStemOf("trip-row-item-12")).toBe("trip");
    expect(idStemOf("open-settings")).toBe("open-settings");
  });

  it("is the whole id (lower-cased) when nothing would be left (a bare word of the list stays), and null without an id", () => {
    expect(idStemOf("button")).toBe("button");
    expect(idStemOf("Tab-2")).toBe("tab");
    expect(idStemOf("42")).toBe("42");
    expect(idStemOf(undefined)).toBeNull();
    expect(idStemOf("")).toBeNull();
  });
});

describe("the 3 by 3 bucket", () => {
  const screen = { width: 300, height: 900 };
  it("counts columns c1 to c3 and rows r1 to r3 from 1 at the top left", () => {
    expect(seenBucket({ x: 0, y: 0, width: 10, height: 10 }, screen)).toBe("c1r1");
    expect(seenBucket({ x: 145, y: 445, width: 10, height: 10 }, screen)).toBe("c2r2");
    expect(seenBucket({ x: 290, y: 890, width: 10, height: 10 }, screen)).toBe("c3r3");
    expect(seenBucket({ x: 140, y: 800, width: 20, height: 20 }, screen)).toBe("c2r3");
    expect(seenBucket({ x: 0, y: 0, width: 10, height: 10 }, null)).toBeNull();
  });
});

describe("what seen holds", () => {
  const screen = { width: 300, height: 900 };
  const frame = { x: 100, y: 800, width: 100, height: 40 };

  it("has the four facts, and never a label, a text or a value", () => {
    const seen = seenOf(el({ role: "button", type: "SaveButton", testID: "save-button-2", label: "Save trip", text: "Save trip", value: "secret", frame }), [], screen);
    expect(seen).toEqual({ role: "button", bucket: "c2r3", component: "SaveButton", id_stem: "save" });
    expect(JSON.stringify(seen)).not.toMatch(/Save trip|secret/);
    expect(Object.keys(seen ?? {}).sort()).toEqual(["bucket", "component", "id_stem", "role"]);
  });

  it("leaves out the bucket inside a scroll view, and a fact the element lacks", () => {
    const scroll = el({ ref: "e9", role: "scroll", frame: { x: 0, y: 0, width: 300, height: 900 } });
    expect(seenOf(el({ role: "button", frame }), [scroll], screen)).toEqual({ role: "button" });
    expect(seenOf(el({}), [], screen)).toBeNull();
  });

  it("is read back only in its own shape (anything else is ignored)", () => {
    expect(readSeen({ tool: "tap", seen: { role: "button", bucket: "c1r2" } })).toEqual({ role: "button", bucket: "c1r2" });
    expect(readSeen({ tool: "tap", seen: { role: "button", text: "Skip" } })).toBeUndefined();
    expect(readSeen({ tool: "tap", seen: { bucket: "c4r1" } })).toBeUndefined();
    expect(readSeen({ tool: "tap" })).toBeUndefined();
  });
});

describe("record writes seen", () => {
  const stepsOf = (r: RepairRig, name: string): Array<Record<string, unknown>> => (JSON.parse(readFileSync(join(r.scriptsDir, `${name}.json`), "utf8")) as { steps: Array<Record<string, unknown>> }).steps;

  it("on a step that targets an element, with the facts of the element and no text", async () => {
    const r = await rig();
    await r.s.tools.record({ start: true, name: "rec" });
    await r.s.tools.tap({ target: { id: "open-settings" } });
    await r.s.tools.record({ stop: true });
    const [step] = stepsOf(r, "rec");
    expect(step?.["seen"]).toEqual({ role: "button", bucket: "c2r1", component: "Pressable", id_stem: "open-settings" });
    expect(JSON.stringify(step?.["seen"])).not.toContain("Settings");
  });

  it("with no bucket for an element inside a scroll view", async () => {
    const r = await rig();
    await r.s.tools.record({ start: true, name: "rows" });
    await r.s.tools.tap({ target: { id: "open-trips" } });
    await r.s.tools.tap({ target: { id: "trip-row-1" } });
    await r.s.tools.record({ stop: true });
    const steps = stepsOf(r, "rows");
    expect(steps[1]?.["seen"]).toEqual({ role: "button", component: "Pressable", id_stem: "trip" });
  });

  it("never in a step that has no element, and a replay never passes it to the call", async () => {
    const r = await rig();
    await r.s.tools.record({ start: true, name: "mixed" });
    await r.s.tools.tap({ target: { id: "open-settings" } });
    await r.s.tools.record({ stop: true });
    const answer = await r.s.tools.replay({ name: "mixed" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
    const run = await r.s.tools.run({ steps: [{ tool: "wait", seconds: 0.5 }] });
    expect(run.isError).not.toBe(true);
  });

  it("an older script without seen still loads and replays", async () => {
    const r = await rig();
    r.script("old", [{ tool: "tap", target: { id: "open-settings" }, expect: { id: "notify-switch" } }]);
    const answer = await r.s.tools.replay({ name: "old" });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toMatch(/^Ran 1 of 1 steps/);
  });
});

describe("repair compares seen with each candidate (section 26.3)", () => {
  /** Home with three look-alike buttons; the one the recording used was at the top, and is now called Not now. */
  const relabeled = (w: World): void => {
    const home = w.screens["home"];
    if (home !== undefined) home.elements = [btn("open-settings", "Not now"), btn("open-trips", "Learn more", { type: "Chip" }), btn("open-form", "Open form", { type: "Chip" })];
  };
  const SEEN = { role: "button", bucket: "c2r1", component: "Pressable" };

  it("repairs a relabel such as Skip to Not now, and shows the parts it took from seen", async () => {
    const r = await rig({ world: relabeled });
    r.script("skip", [{ tool: "tap", target: { text: "Skip" }, seen: SEEN, expect: { id: "notify-switch" } }]);
    const said = textOf(await r.s.tools.replay({ name: "skip", repair: "suggest" }));
    const first = said.split("\n").find((line) => line.startsWith("1. "));
    expect(first).toMatch(/^1\. tap id=open-settings, button "Not now" on home: score 0\.\d\d \(role 1\.00, words 0\.\d\d, position 1\.00, component 1\.00\)/);
    const applied = textOf(await r.s.tools.replay({ name: "skip", repair: "apply" }));
    expect(applied).toContain('step 1 tap "Skip" to');
    expect(r.s.world.pressed).toContain("open-settings");
  });

  it("without seen those parts are absent, as before", async () => {
    const r = await rig({ world: relabeled });
    r.script("skip", [{ tool: "tap", target: { text: "Skip" }, expect: { id: "notify-switch" } }]);
    const said = textOf(await r.s.tools.replay({ name: "skip", repair: "suggest" }));
    expect(said).not.toMatch(/position \d|component \d/);
  });

  it("a repaired step carries the seen of the element that was accepted", async () => {
    const r = await rig({ world: relabeled });
    r.script("skip", [{ tool: "tap", target: { text: "Skip" }, seen: { ...SEEN, id_stem: "gone" }, expect: { id: "notify-switch" } }]);
    await r.s.tools.replay({ name: "skip", repair: "apply" });
    const files = r.files().filter((file) => file.endsWith(".json"));
    const saved = files.map((file) => JSON.parse(r.read(file)) as { steps: Array<{ target?: unknown; seen?: unknown }> });
    const repaired = saved.find((script) => script.steps.some((step) => JSON.stringify(step.target ?? {}).includes("open-settings")));
    expect(repaired?.steps[0]?.seen).toEqual({ role: "button", bucket: "c2r1", component: "Pressable", id_stem: "open-settings" });
    expect(JSON.stringify(repaired?.steps[0]?.seen)).not.toContain("Not now");
  });

  it("compares the id stem, so a rename in the listed words still matches", async () => {
    const r = await rig();
    r.script("rename", [{ tool: "tap", target: { id: "open-settings-btn" }, seen: { id_stem: "open-settings" }, expect: { id: "notify-switch" } }]);
    const said = textOf(await r.s.tools.replay({ name: "rename", repair: "suggest" }));
    expect(said).toMatch(/1\. tap id=open-settings, button "Settings" on home: score 1\.00 \(id_stem 1\.00\)/);
  });
});

describe("a toggle's role check may use seen.role (section 26.3)", () => {
  const checkbox = (id: string, label: string): ExEl => ({ id, label, role: "checkbox", type: "Checkbox", actions: ["toggle"], checked: false });
  const settingsWith = (replace: ExEl) => (w: World): void => {
    w.screen = "settings";
    const settings = w.screens["settings"];
    if (settings !== undefined) settings.elements = [replace, btn("open-language", "Language")];
  };
  const flip = (seen: Record<string, string>) => [{ tool: "toggle", target: { id: "notify-sw" }, seen, expect: { id: "open-language" }, place: "settings" }];
  const noRole = mapWith({ home: ["home"], settings: ["settings"], language: ["settings", "language"] }, []);

  it("repairs a switch to a switch with no explored record, when seen says switch", async () => {
    const r = await rig({ map: noRole, world: settingsWith(toggle("notify-switch", "Notifications")) });
    r.script("flip", flip({ role: "switch" }));
    const said = textOf(await r.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(said).toContain("step 1 toggle id=notify-sw to id=notify-switch");
  });

  it("still refuses a checkbox where seen says switch", async () => {
    const r = await rig({ map: noRole, world: settingsWith(checkbox("notify-switch", "Notifications")) });
    r.script("flip", flip({ role: "switch" }));
    const said = textOf(await r.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(said).not.toContain("with 1 repair");
    expect(r.s.world.pressed).toEqual([]);
  });

  it("and refuses a toggle with neither a record nor a seen role", async () => {
    const r = await rig({ map: noRole, world: settingsWith(toggle("notify-switch", "Notifications")) });
    r.script("flip", flip({ bucket: "c1r1" }));
    const said = textOf(await r.s.tools.replay({ name: "flip", repair: "apply" }));
    expect(said).toContain("Repair: none. The toggle's original role isn't recorded");
  });
});
