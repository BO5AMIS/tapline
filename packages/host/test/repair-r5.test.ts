import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps, input, type ExWorld } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { mapWith, repairRig, textOf, type RepairRig, type RigOptions } from "./repair-helpers.js";

// PR 13 security review, Codex cycle 3 (R5): a repair never writes or answers a value the replay typed. Every value is made up.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const TYPED = "jane.quill@example.test";

/** Every 12-character piece of a value, and the value. */
const pieces = (value: string): string[] => {
  const out = [value];
  for (let i = 0; i + 12 <= value.length; i++) out.push(value.slice(i, i + 12));
  return out;
};

/** Every file under a folder, as text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** The grep gate: nothing the repair wrote (beside the script's own type_text step), the audit log or the map holds the value or a piece of it. */
function expectNoLeak(r: RepairRig, answer: string, ownFiles: string[]): void {
  const written = filesUnder(r.scriptsDir).filter((file) => !ownFiles.some((own) => file.path.endsWith(own)));
  const everything = [answer, JSON.stringify(r.lines), ...written.map((file) => file.text), ...filesUnder(r.s.folder).map((file) => file.text)];
  for (const text of everything) for (const piece of pieces(TYPED)) expect(text).not.toContain(piece);
}

const rig = (options: RigOptions = {}): Promise<RepairRig> => repairRig(hosts, apps, dirs, options);

/** The home screen has an email field, and its settings button echoes what was typed. */
const echoing = (label: string, id: string | null = "open-settings") => (w: ExWorld): void => {
  const home = w.screens["home"];
  if (home === undefined) throw new Error("no home");
  home.elements = [input("email-field", "Email"), id === null ? { ...btn("x", label), id: undefined } : btn(id, label), ...(id === null ? [] : [btn("open-trips", "Trips")])];
};

const TYPE_THEN_TAP = [
  { tool: "type_text", target: { id: "email-field" }, text: TYPED },
  { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } },
];

describe("R5: a repair never writes or answers a value the replay typed", () => {
  it("neutral ids, a label that echoes the typed email: the repair is made and nothing holds the value", async () => {
    const r = await rig({ world: echoing(`Open ${TYPED}`) });
    r.script("signin", TYPE_THEN_TAP);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    expect(r.files()).toEqual(["signin.json", "signin.repair.md", "signin.repaired.json"]);
    expect(r.read("signin.repair.md")).toContain("${typed}");
    expect(JSON.parse(r.read("signin.repaired.json")).steps[1]).toMatchObject({ target: { id: "open-settings" } });
    expectNoLeak(r, answer, ["signin.json", "signin.repaired.json"]);
    // The repaired file keeps the script's own typing step and nothing else of the value.
    const repaired = JSON.parse(r.read("signin.repaired.json")) as { steps: Array<Record<string, unknown>> };
    expect(JSON.stringify(repaired.steps.slice(1))).not.toContain(TYPED);
    expect(repaired.steps[0]?.["text"]).toBe(TYPED);
    expect(r.lines.some((line) => line.kind === "repair")).toBe(true);
  });

  it("label targets: the old label showed the typed value; the audit, the notes and the file hold a placeholder", async () => {
    const r = await rig({ world: echoing("Open jane quill at example dot test") });
    r.script("signin", [
      { tool: "type_text", target: { id: "email-field" }, text: TYPED },
      { tool: "tap", target: { label: `Open ${TYPED}` }, expect: { id: "notify-switch" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    expect(answer).toContain("${typed}");
    expect(r.lines.some((line) => line.kind === "repair" && (line.detail ?? "").includes("${typed}"))).toBe(true);
    expectNoLeak(r, answer, ["signin.json", "signin.repaired.json"]);
    const repaired = JSON.parse(r.read("signin.repaired.json")) as { steps: Array<Record<string, unknown>> };
    expect(JSON.stringify(repaired.steps.slice(1))).not.toContain(TYPED);
    expect(JSON.stringify(repaired.steps[1])).toContain("${typed}");
  });

  it("suggest: the answer shows a placeholder, never the value", async () => {
    const r = await rig({ world: echoing("Open jane quill at example dot test") });
    r.script("signin", [
      { tool: "type_text", target: { id: "email-field" }, text: TYPED },
      { tool: "tap", target: { label: `Open ${TYPED}` }, expect: { id: "notify-switch" } },
    ]);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "suggest" }));
    expect(answer).toContain("Repair (suggest");
    for (const piece of pieces(TYPED)) expect(answer).not.toContain(piece);
    expect(r.files()).toEqual(["signin.json"]);
    expect(JSON.stringify(r.lines)).not.toContain(TYPED);
  });

  it("a candidate that names the element only by a label showing the typed value is dropped, not written as a placeholder", async () => {
    // No id on the element, and its label echoes the value: the only possible target would be the label.
    const r = await rig({ world: echoing(`Open ${TYPED}`, null) });
    r.script("signin", TYPE_THEN_TAP);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
    expect(answer).toMatch(/Repair: none/);
    expect(r.files()).toEqual(["signin.json"]);
    expectNoLeak(r, answer, ["signin.json"]);
  });

  it("a rejection path writes no typed value (the trial lands somewhere the check fails)", async () => {
    const r = await rig({
      world: (w) => {
        echoing(`Open ${TYPED}`)(w);
        w.goes["home|open-settings"] = "trips";
      },
    });
    r.script("signin", TYPE_THEN_TAP);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
    expect(answer).toMatch(/nothing was written|none passed|Repair:/);
    expect(r.files()).toEqual(["signin.json"]);
    expect(r.lines.some((line) => line.kind === "repair" && (line.detail ?? "").includes("rejected"))).toBe(true);
    expectNoLeak(r, answer, ["signin.json"]);
  });

  it("a passing apply saves the repaired road in the map without the typed value", async () => {
    const r = await rig({
      world: echoing(`Open ${TYPED}`),
      map: mapWith({ home: ["home"], settings: ["settings"] }, [{ from: "home", to: "settings", id: "open-settings-btn", text: "Settings" }]),
    });
    r.script("signin", TYPE_THEN_TAP);
    const answer = textOf(await r.s.tools.replay({ name: "signin", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    await flushExploreMaps();
    expect(existsSync(join(r.s.folder, "map.json"))).toBe(true);
    expectNoLeak(r, answer, ["signin.json", "signin.repaired.json"]);
  });
});
