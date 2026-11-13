import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import {
  JUDGMENT_LINE,
  NO_UX_RULES,
  formatUxCheck,
  loadUxRules,
  parseUxRules,
  uxResultSchema,
  type UxAction,
  type UxJourneyHook,
  type UxResult,
} from "../src/uxcheck.js";
import { FakeApp, startHost } from "./helpers.js";

// AGENT-TOOLS 1.12 §17.3: ux_check's answer, and the house rules.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const BASE = ["choices", "main_action", "thumb_reach", "icon_only", "cut_off_text", "contrast", "target_size", "dead_end"];
const RESULT: UxResult = {
  checked: BASE,
  choices: 9,
  actions: [],
  issues: [
    { kind: "choices", element: null, problem: "9 choices compete for attention on this screen (more than 7)", basis: "best practice: Hick's law, more than 7 choices" },
    {
      kind: "icon_only",
      element: { ref: "e4", role: "button", testID: "menu", frame: { x: 340, y: 60, width: 48, height: 48 } },
      problem: "icon-only button with no accessibility label",
      basis: "best practice: an icon-only button needs an accessibility label",
      at: { file: "/work/app/src/Header.tsx", line: 31, direct: true },
    },
    {
      kind: "contrast",
      element: { ref: "e9", role: "text", text: "Terms", frame: { x: 16, y: 700, width: 60, height: 18 } },
      problem: "contrast 2.8:1 is below 4.5:1 (#9b9b9b on #ffffff)",
      basis: "measured",
    },
  ],
};

describe("the ux_check answer", () => {
  it("has the header, one numbered line per finding with its basis, the source line, the checks and the ask for judgment", () => {
    expect(formatUxCheck("Home", RESULT, { journeyRunning: false }, (f) => f.replace("/work/app/", ""))).toBe(
      [
        'UX check of "Home": 3 findings.',
        "1. choices: the screen: 9 choices compete for attention on this screen (more than 7) (best practice: Hick's law, more than 7 choices)",
        "2. icon_only: e4 button id=menu @340,60 48x48: icon-only button with no accessibility label (best practice: an icon-only button needs an accessibility label)",
        "   at src/Header.tsx:31",
        '3. contrast: e9 text "Terms" @16,700 60x18: contrast 2.8:1 is below 4.5:1 (#9b9b9b on #ffffff) (measured)',
        "Checked: competing choices, main action, thumb reach, icon-only buttons, cut-off text, contrast, target size, error and empty states. Not checked here: naming across screens (no journey is running).",
        "Add your own judgment from the screenshot, and label it as judgment.",
      ].join("\n"),
    );
  });

  it("says one finding in the singular and none as 0 findings", () => {
    const one = formatUxCheck("Home", { ...RESULT, issues: RESULT.issues.slice(0, 1) }, { journeyRunning: false });
    expect(one.split("\n")[0]).toBe('UX check of "Home": 1 finding.');
    const none = formatUxCheck("Home", { ...RESULT, issues: [] }, { journeyRunning: false });
    expect(none.split("\n")[0]).toBe('UX check of "Home": 0 findings.');
    expect(none.split("\n").at(-1)).toBe(JUDGMENT_LINE);
  });

  it("lists naming as checked when the app ran it, and otherwise says why not (a journey with no earlier screens)", () => {
    const withNaming = formatUxCheck("Home", { ...RESULT, issues: [], checked: [...BASE, "naming"] }, { journeyRunning: true });
    expect(withNaming).toContain("naming across screens");
    expect(withNaming).not.toContain("Not checked here");
    expect(formatUxCheck("Home", { ...RESULT, issues: [] }, { journeyRunning: true })).toContain("Not checked here: naming across screens (no earlier screens yet).");
  });

  it("lists text rules after the facts and before the checks, and the way-back rule among the checks", () => {
    const out = formatUxCheck(
      "Home",
      { ...RESULT, issues: [], checked: [...BASE, "way_back"] },
      { journeyRunning: false, textRules: ["core features within 2 taps of home", "one idea per screen"] },
    ).split("\n");
    expect(out[1]).toBe('House rules to judge: "core features within 2 taps of home"; "one idea per screen".');
    expect(out[2]).toMatch(/^Checked: .*way back \(house rule\)/);
  });

  it("stops at 30 findings", () => {
    const many: UxResult = { ...RESULT, issues: Array.from({ length: 33 }, () => ({ kind: "choices", element: null, problem: "p", basis: "measured" })) };
    const out = formatUxCheck("X", many, { journeyRunning: false });
    expect(out).toContain("30. choices: the screen: p (measured)");
    expect(out).not.toContain("31. ");
    expect(out).toContain("(+3 more findings.)");
  });

  it("names what is known of a finding without an element", () => {
    const result: UxResult = {
      ...RESULT,
      issues: [{ kind: "target_size", element: null, where: { label: "Close", frame: { x: 1, y: 2, width: 3, height: 4 } }, problem: "p", basis: "measured" }],
    };
    expect(formatUxCheck("X", result, { journeyRunning: false }).split("\n")[1]).toBe('1. target_size: an element "Close" at @1,2 3x4: p (measured)');
  });

  it("is read from the app's answer by its schema", () => {
    expect(uxResultSchema.safeParse({ issues: [], checked: [] }).success).toBe(true);
    expect(uxResultSchema.safeParse({ issues: [{ kind: "x" }], checked: [] }).success).toBe(false);
  });
});

async function connect(handler: (method: string, params: unknown) => unknown, capabilities = ["tree", "uxCheck"]): Promise<{ app: FakeApp; host: TaplineHost }> {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, { capabilities }, (req) => {
    if (req.method === "tree") return { ok: true, result: { screen: { width: 400, height: 800 }, elements: [], route: { names: ["Root", "Feed"] } } };
    return { ok: true, result: handler(req.method, req.params) };
  });
  apps.push(app);
  return { app, host };
}

describe("the ux_check tool", () => {
  it("asks the app, names the screen by its route, and answers the report (file lines come from the app, as for audit)", async () => {
    const { app, host } = await connect(() => RESULT);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const out = textOf(await tools.uxCheck({}));
    expect(out.split("\n")[0]).toBe('UX check of "Feed": 3 findings.');
    expect(out).toMatch(/\n {3}at .*Header\.tsx:31\n/);
    expect(out.split("\n").at(-1)).toBe(JUDGMENT_LINE);
    expect(app.requests.find((r) => r.method === "uxCheck")?.params).toEqual({});
  });

  it("refuses kindly on an older app", async () => {
    const { host } = await connect(() => ({}), ["tree"]);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    expect(textOf(await tools.uxCheck({}))).toMatch(/^Error unsupported: this app's Tapline is too old for ux_check/);
  });

  it("without a journey asks nothing about earlier screens, and says naming was not checked", async () => {
    const { app, host } = await connect(() => ({ ...RESULT, issues: [] }));
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const out = textOf(await tools.uxCheck({}));
    expect(out).toContain("Not checked here: naming across screens (no journey is running).");
    expect(app.requests.find((r) => r.method === "uxCheck")?.params).not.toHaveProperty("earlier");
  });

  it("hands a journey's earlier actions to the app, and tells the journey what the screen held", async () => {
    const { app, host } = await connect(() => ({
      ...RESULT,
      checked: [...BASE, "naming"],
      actions: [{ label: "Done", id: "done" }],
    }));
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const earlier: UxAction[] = [{ label: "Save", id: "save" }];
    const seen: Array<{ screen: string; actions: UxAction[]; kinds: string[] }> = [];
    const hook: UxJourneyHook = {
      earlier: () => earlier,
      seen: (screen, actions, findings) => seen.push({ screen, actions, kinds: findings.map((f) => f.kind) }),
    };
    tools.uxJourney = hook;
    const out = textOf(await tools.uxCheck({}));
    expect(app.requests.find((r) => r.method === "uxCheck")?.params).toEqual({ earlier });
    expect(out).not.toContain("Not checked here");
    expect(seen).toEqual([{ screen: "Feed", actions: [{ label: "Done", id: "done" }], kinds: ["choices", "icon_only", "contrast"] }]);
  });

  it("asks the app to check the way back when the house rules say so, and lists the text rules", async () => {
    const { app, host } = await connect(() => ({ ...RESULT, issues: [], checked: [...BASE, "way_back"] }));
    const rules = parseUxRules({ version: 1, rules: ["core features within 2 taps of home", { max_taps_to_goal: 4 }, { way_back: true }] }, "rules.json");
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, uxRules: rules });
    const out = textOf(await tools.uxCheck({}));
    expect(app.requests.find((r) => r.method === "uxCheck")?.params).toEqual({ wayBack: true });
    expect(out).toContain('House rules to judge: "core features within 2 taps of home".');
    expect(out).toContain("way back (house rule)");
  });

  it("reports a way_back finding in the house-rule words", async () => {
    const { host } = await connect(() => ({
      ...RESULT,
      checked: [...BASE, "way_back"],
      issues: [{ kind: "way_back", element: null, problem: "no back button, close control or tab bar is visible", basis: "house rule: every screen has a way back" }],
    }));
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, uxRules: { text: [], wayBack: true } });
    expect(textOf(await tools.uxCheck({}))).toContain(
      "1. way_back: the screen: no back button, close control or tab bar is visible (house rule: every screen has a way back)",
    );
  });

  it("exposes max_taps_to_goal for the journey, and checks nothing itself", async () => {
    const { app, host } = await connect(() => ({ ...RESULT, issues: [] }));
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, uxRules: { text: [], wayBack: false, maxTapsToGoal: 4 } });
    expect(tools.maxTapsToGoal).toBe(4);
    await tools.uxCheck({});
    expect(app.requests.find((r) => r.method === "uxCheck")?.params).toEqual({});
    expect(new TaplineTools(host, { connect: { url: "", name: "Dev PC" } }).maxTapsToGoal).toBeUndefined();
  });
});

describe("the house rules file", () => {
  it("reads text rules, max_taps_to_goal and way_back", () => {
    expect(parseUxRules({ version: 1, rules: ["core features within 2 taps of home", { max_taps_to_goal: 4 }, { way_back: true }] }, "f")).toEqual({
      text: ["core features within 2 taps of home"],
      wayBack: true,
      maxTapsToGoal: 4,
    });
    expect(parseUxRules({ version: 1, rules: [] }, "f")).toEqual(NO_UX_RULES);
    expect(parseUxRules({ version: 1, rules: [{ way_back: false }] }, "f").wayBack).toBe(false);
  });

  it("refuses an unknown key, naming it", () => {
    expect(() => parseUxRules({ version: 1, rules: [{ max_clicks: 3 }] }, "rules.json")).toThrow(/rules\.json isn't a set of UX rules: unknown key "max_clicks" in rule 1/);
    expect(() => parseUxRules({ version: 1, rules: [], extra: 1 }, "f")).toThrow(/unknown key "extra"/);
  });

  it("refuses wrong shapes with a plain message", () => {
    const bad = (json: unknown): void => expect(() => parseUxRules(json, "f")).toThrow(/^f isn't a set of UX rules: /);
    bad(null);
    bad([]);
    bad({ rules: [] });
    bad({ version: 2, rules: [] });
    bad({ version: 1 });
    bad({ version: 1, rules: "text" });
    bad({ version: 1, rules: [3] });
    bad({ version: 1, rules: [" "] });
    bad({ version: 1, rules: [{}] });
    bad({ version: 1, rules: [{ way_back: true, max_taps_to_goal: 2 }] });
    bad({ version: 1, rules: [{ way_back: "yes" }] });
    bad({ version: 1, rules: [{ max_taps_to_goal: 0 }] });
    bad({ version: 1, rules: [{ max_taps_to_goal: 2.5 }] });
    bad({ version: 1, rules: [{ max_taps_to_goal: "4" }] });
  });

  it("loads a file, and fails plainly on a missing or malformed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-ux-"));
    dirs.push(dir);
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ version: 1, rules: ["a rule", { max_taps_to_goal: 3 }] }));
    expect(loadUxRules(good)).toEqual({ text: ["a rule"], wayBack: false, maxTapsToGoal: 3 });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(() => loadUxRules(broken)).toThrow(/^couldn't read the UX rules .*broken\.json/);
    expect(() => loadUxRules(join(dir, "missing.json"))).toThrow(/^couldn't read the UX rules /);
    const unknown = join(dir, "unknown.json");
    writeFileSync(unknown, JSON.stringify({ version: 1, rules: [{ nope: true }] }));
    expect(() => loadUxRules(unknown)).toThrow(/unknown key "nope"/);
  });
});
