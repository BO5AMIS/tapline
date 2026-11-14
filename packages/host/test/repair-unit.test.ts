import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseCli } from "../src/cli.js";
import type { TreeElement, TreeResult } from "../src/protocol.js";
import {
  MAX_CANDIDATES,
  MAX_REPAIRS,
  NEAR_TIE,
  REPAIR_WEIGHTS,
  canTake,
  carriesSecret,
  closestRefs,
  editSimilarity,
  expectedPlace,
  formatParts,
  idStem,
  idWords,
  isNativeBack,
  isNearTie,
  neverRepaired,
  positionPart,
  rankScored,
  scoreParts,
  two,
  weightedScore,
  wordsMatch,
  wordsPart,
  type NeverContext,
} from "../src/repair.js";
import { analyse, parseBreak, runWithRepair, suggestionText, type RepairHost } from "../src/repairrun.js";
import type { Step } from "../src/run.js";
import { failureWithRepair, junitXml, readScript, toToolStep } from "../src/script.js";
import { readScheduleFile } from "../src/schedule.js";
import { toolShapes } from "../src/tools.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const el = (ref: string, id: string | undefined, label: string | undefined, extra: Partial<TreeElement> = {}): TreeElement => ({
  ref,
  type: "Pressable",
  role: "button",
  ...(id !== undefined ? { testID: id } : {}),
  ...(label !== undefined ? { label, text: label } : {}),
  frame: { x: 20, y: 100, width: 300, height: 44 },
  actions: ["press"],
  ...extra,
});

describe("the score (§26.3)", () => {
  it("splits ids on - _ and case changes, lower-cased", () => {
    expect(idWords("login-btn")).toEqual(["login", "btn"]);
    expect(idWords("loginButton_Primary")).toEqual(["login", "button", "primary"]);
    expect(idWords("HTTPServer-ok")).toEqual(["http", "server", "ok"]);
  });

  it("two words match when equal, or the shorter has 3 characters and its letters appear in order with the same first letter", () => {
    expect(wordsMatch("btn", "button")).toBe(true);
    expect(wordsMatch("button", "btn")).toBe(true);
    expect(wordsMatch("ab", "abc")).toBe(false);
    expect(wordsMatch("btn", "bottle")).toBe(false);
    expect(wordsMatch("tbn", "button")).toBe(false);
    expect(wordsMatch("same", "same")).toBe(true);
  });

  it("id_stem is the matching words over the larger word count: login-btn and login-button is 1.0", () => {
    expect(idStem("login-btn", "login-button")).toBe(1);
    expect(idStem("login-btn", "help-button")).toBe(0.5);
    expect(idStem("open-settings-btn", "open-settings")).toBeCloseTo(2 / 3, 5);
    expect(idStem(undefined, "x")).toBeNull();
    expect(idStem("x", "")).toBeNull();
    // One word matches one word: a repeated word doesn't count twice.
    expect(idStem("a-a-a", "a-b")).toBeCloseTo(1 / 3, 5);
  });

  it("words is the best of label with label, text with text, and a label with a text", () => {
    expect(editSimilarity("Log in", "Log in")).toBe(1);
    expect(editSimilarity("Skip", "Not now")).toBeLessThan(0.3);
    expect(wordsPart({ label: "Sign in" }, { label: "Something", text: "Sign in" })).toBe(1);
    expect(wordsPart({ text: "Save" }, { label: "Save " })).toBe(1);
    expect(wordsPart({}, { label: "x" })).toBeNull();
    expect(wordsPart({ label: "x" }, {})).toBeNull();
  });

  it("position is 1 for the same bucket, 0.5 for a neighbour (diagonals too), else 0", () => {
    expect(positionPart("c1r3", "c1r3")).toBe(1);
    expect(positionPart("c1r3", "c2r3")).toBe(0.5);
    expect(positionPart("c1r3", "c2r4")).toBe(0.5);
    expect(positionPart("c1r3", "c3r3")).toBe(0);
    expect(positionPart("c1r3", undefined)).toBeNull();
    expect(positionPart("nope", "c1r1")).toBeNull();
  });

  it("the score is the weighted mean of the parts that exist on both sides", () => {
    const all = scoreParts({ id: "login-btn", label: "Log in", role: "button", bucket: "c1r6", component: "Pressable" }, { id: "login-button", label: "Log in", role: "button", bucket: "c1r6", component: "Pressable" });
    expect(all).toEqual({ role: 1, id_stem: 1, words: 1, position: 1, component: 1 });
    expect(weightedScore(all)).toBe(1);
    // A part missing on a side leaves both sums.
    expect(scoreParts({ id: "a-b" }, { id: "a-c", label: "x" })).toEqual({ id_stem: 0.5 });
    expect(weightedScore({ id_stem: 0.5 })).toBe(0.5);
    expect(weightedScore({})).toBe(0);
    const some = { role: 1, id_stem: 0.85, words: 1, position: 1, component: 1 };
    const expected = (REPAIR_WEIGHTS.role + REPAIR_WEIGHTS.id_stem * 0.85 + REPAIR_WEIGHTS.words + REPAIR_WEIGHTS.position + REPAIR_WEIGHTS.component) / 1;
    expect(weightedScore(some)).toBeCloseTo(expected, 10);
    expect(two(weightedScore(some))).toBe("0.95");
    expect(formatParts(some)).toBe("role 1.00, id_stem 0.85, words 1.00, position 1.00, component 1.00");
  });

  it("Tapline's weights are positive and sum to 1", () => {
    for (const weight of Object.values(REPAIR_WEIGHTS)) expect(weight).toBeGreaterThan(0);
    expect(Object.values(REPAIR_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("orders by score, equal scores in reading order, and two scores less than 0.02 apart are a tie", () => {
    const a = { element: el("e1", "a", "A", { frame: { x: 200, y: 100, width: 10, height: 10 } }), score: 0.5, parts: {} };
    const b = { element: el("e2", "b", "B", { frame: { x: 10, y: 100, width: 10, height: 10 } }), score: 0.5, parts: {} };
    const c = { element: el("e3", "c", "C", { frame: { x: 10, y: 20, width: 10, height: 10 } }), score: 0.5, parts: {} };
    const d = { element: el("e4", "d", "D"), score: 0.9, parts: {} };
    expect(rankScored([a, b, c, d]).map((x) => x.element.ref)).toEqual(["e4", "e3", "e2", "e1"]);
    expect(NEAR_TIE).toBe(0.02);
    expect(isNearTie([{ score: 0.93 }, { score: 0.92 }])).toBe(true);
    expect(isNearTie([{ score: 0.93 }, { score: 0.91 }])).toBe(false);
    expect(isNearTie([{ score: 0.5 }])).toBe(false);
    expect(isNearTie([])).toBe(false);
    expect(MAX_CANDIDATES).toBe(3);
    expect(MAX_REPAIRS).toBe(5);
  });

  it("which elements can take an action", () => {
    expect(canTake("tap", el("e1", "a", "A"))).toBe(true);
    expect(canTake("tap", el("e1", "a", "A", { disabled: true }))).toBe(false);
    expect(canTake("tap", el("e1", "a", "A", { role: "text", actions: [] }))).toBe(false);
    expect(canTake("toggle", el("e1", "a", "A", { role: "switch", actions: ["toggle"] }))).toBe(true);
    expect(canTake("toggle", el("e1", "a", "A"))).toBe(false);
    expect(canTake("scroll", el("e1", "a", undefined, { role: "scroll", actions: ["scroll"] }))).toBe(true);
    expect(canTake("swipe", el("e1", "a", "A"))).toBe(false);
  });
});

describe("what is never repaired (§26.2)", () => {
  const ctx: NeverContext = { draftsOnly: false, policyHit: (subject) => (/delete|sign out/i.test(`${subject.label ?? ""} ${subject.text ?? ""} ${(subject.testID ?? "").replace(/-/g, " ")}`) ? "Delete" : null) };
  const tap = (target: Record<string, unknown>, extra: Record<string, unknown> = {}): Step => ({ tool: "tap", target, ...extra }) as Step;

  it("repairs a plain tap, long press, toggle or scroll with a named target", () => {
    expect(neverRepaired(tap({ id: "go" }), ctx)).toBeNull();
    expect(neverRepaired({ tool: "long_press", target: { label: "Row" } } as Step, ctx)).toBeNull();
    expect(neverRepaired({ tool: "toggle", target: { id: "sw" } } as Step, ctx)).toBeNull();
    expect(neverRepaired({ tool: "scroll", target: { id: "list" } } as Step, ctx)).toBeNull();
  });

  it("a type_text step, and a step of any other tool", () => {
    expect(neverRepaired({ tool: "type_text", target: { id: "name" }, text: "x" } as Step, ctx)).toMatch(/type_text/);
    for (const tool of ["swipe", "open_url", "wait_for", "app_command", "back", "wait", "compare_screen", "performance", "drive"]) {
      expect(neverRepaired({ tool, target: { id: "x" } } as Step, ctx)).not.toBeNull();
    }
  });

  it("a step with an account, vault or one-time-code reference", () => {
    expect(carriesSecret(tap({ id: "x" }, { account: "tester" }))).toBe(true);
    expect(carriesSecret(tap({ id: "x" }, { text: "${account.password}" }))).toBe(true);
    expect(carriesSecret(tap({ id: "x" }, { note: "${vault.home.street}" }))).toBe(true);
    expect(carriesSecret(tap({ id: "x" }, { note: "${otp}" }))).toBe(true);
    expect(carriesSecret(tap({ id: "x" }))).toBe(false);
    expect(neverRepaired(tap({ id: "x" }, { account: "tester" }), ctx)).toMatch(/typed value|account/);
  });

  it("a native Back: the back tool, a control named Back, an id that says only back", () => {
    expect(neverRepaired({ tool: "back" } as Step, ctx)).toMatch(/native Back/);
    expect(neverRepaired(tap({ label: "Back" }), ctx)).toMatch(/native Back/);
    expect(neverRepaired(tap({ text: " back " }), ctx)).toMatch(/native Back/);
    expect(isNativeBack({ id: "header-back-button" })).toBe(true);
    expect(isNativeBack({ id: "backButton" })).toBe(true);
    expect(isNativeBack({ id: "back-to-trips" })).toBe(false);
    expect(isNativeBack({ label: "Back to trips" })).toBe(false);
  });

  it("a target with a policy word, whether it is named by label, text or id", () => {
    expect(neverRepaired(tap({ label: "Delete trip" }), ctx)).toMatch(/policy word/);
    expect(neverRepaired(tap({ id: "sign-out-button" }), ctx)).toMatch(/policy word/);
  });

  it("a step in a drafts-only route, a point, a ref and a row by index", () => {
    expect(neverRepaired(tap({ id: "go" }), { ...ctx, draftsOnly: true })).toMatch(/drafts-only/);
    expect(neverRepaired(tap({ x: 10, y: 20 }), ctx)).toMatch(/without a target/);
    expect(neverRepaired(tap({ row: true, index: 1 }), ctx)).toMatch(/without a target/);
    expect(neverRepaired({ tool: "tap" } as Step, ctx)).toMatch(/without a target/);
  });

  it("the place a step expected: its own, else the route of the step before it", () => {
    const steps = [{ tool: "tap", route: ["settings", "language"] }, { tool: "tap" }, { tool: "tap", place: "trips_id" }] as Step[];
    const name = (route: string[]): string => route.join("_");
    expect(expectedPlace(steps, 1, name)).toBe("settings_language");
    expect(expectedPlace(steps, 0, name)).toBeNull();
    expect(expectedPlace(steps, 2, name)).toBe("trips_id");
    expect(closestRefs('nothing on screen. Closest: e12 button "Save draft" id=save-draft, e30 text "Saved" (off screen, below).')).toEqual(["e12", "e30"]);
    expect(closestRefs("no closest")).toEqual([]);
  });
});

// A stub host: the screen is a list of elements, a step passes when its target id is one of `valid`.
interface Stub {
  host: RepairHost;
  trials: string[][];
  audit: string[];
}

function stub(options: { elements: TreeElement[]; valid: Set<string>; place?: string | null; ways?: Record<string, Step[] | null>; drafts?: boolean; auditOk?: boolean; offScreenBelow?: number }): Stub {
  const trials: string[][] = [];
  const audit: string[] = [];
  const tree = (): TreeResult => ({ elements: options.elements, screen: { width: 430, height: 932 }, ...(options.offScreenBelow !== undefined ? { offScreen: { above: 0, below: options.offScreenBelow } } : {}) }) as TreeResult;
  const fail = (index: number, total: number, step: Step, message: string, code = "not_found"): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: `Error ${code}: Ran ${index} of ${total} steps; stopped at step ${index + 1} (${step.tool} id=${(step as { target?: { id?: string } }).target?.id ?? ""}): ${message}` }],
  });
  const host: RepairHost = {
    script: "stubbed",
    runSteps: (steps) => {
      trials.push(steps.map((s) => (s as { target?: { id?: string } }).target?.id ?? s.tool));
      for (const [i, step] of steps.entries()) {
        const id = (step as { target?: { id?: string } }).target?.id;
        if (step.tool === "tap" && (id === undefined || !options.valid.has(id))) return Promise.resolve(fail(i, steps.length, step, "No element matches"));
      }
      return Promise.resolve({ content: [{ type: "text", text: `Ran ${steps.length} of ${steps.length} steps in 0.0 s.` }] });
    },
    tree: () => Promise.resolve(tree()),
    place: () => Promise.resolve(options.place ?? null),
    placeName: (route) => route.join("_"),
    way: (from, to) => options.ways?.[`${from}>${to}`] ?? null,
    returnTo: () => Promise.resolve(true),
    back: () => Promise.resolve(true),
    match: (target, elements) => elements.filter((e) => (target.id !== undefined ? e.testID === target.id : target.label !== undefined ? (e.label ?? "").toLowerCase() === target.label.toLowerCase() : false)),
    never: { draftsOnly: options.drafts === true, policyHit: (subject) => (/delete/i.test(`${subject.label ?? ""} ${(subject.testID ?? "").replace(/-/g, " ")}`) ? "Delete" : null) },
    audit: (detail) => {
      if (options.auditOk === false) return false;
      audit.push(detail);
      return true;
    },
    now: () => 0,
  };
  return { host, trials, audit };
}

const breakOf = (code: string, message: string, index = 0): { index: number; code: string; message: string } => ({ index, code, message });
const tapStep = (id: string, extra: Record<string, unknown> = {}): Step => ({ tool: "tap", target: { id }, expect: { id: "somewhere" }, ...extra }) as Step;

describe("the candidates of a break (§26.1)", () => {
  it("reads the break from a failed batch's first line", () => {
    const answer: CallToolResult = { isError: true, content: [{ type: "text", text: 'Error not_found: Ran 3 of 7 steps; stopped at step 4 (tap id=login-btn): no element matches id "login-btn".\nMore.' }] };
    expect(parseBreak(answer)).toEqual({ index: 3, code: "not_found", message: 'no element matches id "login-btn".' });
    expect(parseBreak({ content: [{ type: "text", text: "Ran 1 of 1 steps." }] })).toBeNull();
    expect(parseBreak({ isError: true, content: [{ type: "text", text: "Error bad_params: nope" }] })).toBeNull();
  });

  it("off_screen: the candidate is a scroll, and no other element is offered", async () => {
    const s = stub({ elements: [el("e1", "login-button", "Log in")], valid: new Set(["login-button"]) });
    const out = await analyse(s.host, [tapStep("login-btn")], 0, breakOf("not_actionable", "off_screen: it lies below"));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.list.map((c) => c.kind)).toEqual(["scroll"]);
    expect(suggestionText(out).join("\n")).toContain("scroll down (up to 5 times) until id=login-btn shows");
  });

  it("not_found for a row a list hasn't made: a scroll first, then the elements that look like it", async () => {
    const s = stub({ elements: [el("e1", "trip-row-1", "Trip 1", { row: true })], valid: new Set(), offScreenBelow: 3 });
    const out = await analyse(s.host, [tapStep("trip-row-9")], 0, breakOf("not_found", "No element matches"));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.list[0]?.kind).toBe("scroll");
    expect(out.list[1]?.kind).toBe("target");
  });

  it("the Closest elements are candidates even when their names are unlike the old one", async () => {
    const s = stub({ elements: [el("e1", "unrelated", "Other"), el("e2", "welcome-cta", "Start")], valid: new Set() });
    const out = await analyse(s.host, [tapStep("get-started")], 0, breakOf("not_found", 'nothing on screen has id "get-started". Closest: e2 button "Start" id=welcome-cta.'));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.list.map((c) => c.newTarget)).toEqual([{ id: "welcome-cta" }]);
  });

  it("an element that carries a policy word is never a candidate", async () => {
    const s = stub({ elements: [el("e1", "delete-all", "Delete all")], valid: new Set() });
    const out = await analyse(s.host, [tapStep("delete-everything-x")], 0, breakOf("not_found", 'Closest: e1 button "Delete all" id=delete-all.'));
    expect(out.kind).toBe("none");
  });

  it("ambiguous: the candidates are the elements it listed; scores less than 0.02 apart are a tie", async () => {
    const s = stub({ elements: [el("e1", "save-a", "Save"), el("e2", "save-b", "Save"), el("e3", "cancel", "Cancel")], valid: new Set() });
    const step = { tool: "tap", target: { label: "Save" }, expect: { id: "somewhere" } } as Step;
    const out = await analyse(s.host, [step], 0, breakOf("ambiguous", "2 elements match"));
    expect(out.kind).toBe("tie");
    expect(suggestionText(out)[0]).toMatch(/^Repair \(suggest, not checked\): ambiguous\./);
  });

  it("a break that isn't one of the three is a finding: covered, disabled, expect_failed", async () => {
    const s = stub({ elements: [el("e1", "login-button", "Log in")], valid: new Set() });
    for (const code of ["not_actionable", "covered", "disabled", "expect_failed", "timeout"]) {
      const out = await analyse(s.host, [tapStep("login-btn")], 0, breakOf(code, "covered: something is in front"));
      expect(out.kind).toBe("none");
    }
  });

  it("a step whose last position has no check is not repaired", async () => {
    const s = stub({ elements: [el("e1", "login-button", "Log in")], valid: new Set(["login-button"]) });
    const out = await analyse(s.host, [{ tool: "tap", target: { id: "login-btn" } } as Step], 0, breakOf("not_found", "No element matches"));
    expect(out).toMatchObject({ kind: "none" });
    // A target in the step after it is the check.
    const next = await analyse(s.host, [{ tool: "tap", target: { id: "login-btn" } } as Step, { tool: "tap", target: { id: "x" } } as Step], 0, breakOf("not_found", "No element matches"));
    expect(next.kind).toBe("ok");
  });

  it("a new screen in the way: the proven road from where the app is to the expected place", async () => {
    const road: Step[] = [{ tool: "tap", target: { id: "continue" }, place: "welcome" } as Step];
    const s = stub({ elements: [], valid: new Set(), place: "welcome", ways: { "welcome>settings": road } });
    const step = tapStep("open-language", { place: "settings" });
    const out = await analyse(s.host, [step], 0, breakOf("not_found", "No element matches"));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.list[0]).toMatchObject({ kind: "road", moves: road });
    // No proven road, or a road whose move carries a policy word, is no repair.
    const none = stub({ elements: [], valid: new Set(), place: "welcome", ways: {} });
    expect((await analyse(none.host, [step], 0, breakOf("not_found", "No element matches"))).kind).toBe("none");
    const bad = stub({ elements: [], valid: new Set(), place: "welcome", ways: { "welcome>settings": [{ tool: "tap", target: { id: "delete-account" } } as Step] } });
    expect((await analyse(bad.host, [step], 0, breakOf("not_found", "No element matches"))).kind).toBe("none");
  });
});

describe("the limits (§26.4)", () => {
  it("at most 3 candidates are tried per step, in score order", async () => {
    // Four candidates, the one that would pass is the lowest.
    const ids = ["go-alpha-beta-gamma-x", "go-alpha-beta-x", "go-alpha-x", "go-x"];
    const s = stub({ elements: ids.map((id, i) => el(`e${i + 1}`, id, undefined)), valid: new Set(["go-x"]) });
    const run = await runWithRepair(s.host, [tapStep("go-alpha-beta-gamma")]);
    expect(run.ok).toBe(false);
    // The first run, then the three trials; the fourth candidate is never tried.
    expect(s.trials).toEqual([["go-alpha-beta-gamma"], ["go-alpha-beta-gamma-x"], ["go-alpha-beta-x"], ["go-alpha-x"]]);
    expect(s.audit.filter((line) => line.includes("rejected"))).toHaveLength(3);
    expect(run.notes.join("\n")).toContain("the first 3 candidates were tried and none passed the check");
  });

  it("a near-tie is not repaired and nothing is tried", async () => {
    const s = stub({ elements: [el("e1", "open-aaa", undefined), el("e2", "open-bbb", undefined)], valid: new Set(["open-aaa", "open-bbb"]) });
    const run = await runWithRepair(s.host, [tapStep("open-xyz")]);
    expect(run.ok).toBe(false);
    expect(s.trials).toHaveLength(1);
    expect(run.notes.join("\n")).toContain("less than 0.02 apart");
  });

  it("at most 5 repairs: the sixth break ends the run", async () => {
    const letters = ["a", "b", "c", "d", "e", "f"];
    const valid = new Set(letters.map((k) => `item-${k}-live`));
    const s = stub({ elements: letters.map((k, i) => el(`e${i + 1}`, `item-${k}-live`, undefined)), valid });
    const run = await runWithRepair(
      s.host,
      letters.map((k) => tapStep(`item-${k}-liv`)),
    );
    expect(run.ok).toBe(false);
    expect(run.repairs).toHaveLength(5);
    expect(run.notes.join("\n")).toContain("5 repairs were made and the script still breaks");
    expect(run.notes.join("\n")).toContain("5 repairs were made before it stopped; nothing was written.");
  });

  it("a script that passes after its repairs is ok, with the work the repaired file is built from", async () => {
    const s = stub({ elements: [el("e1", "login-button", "Log in")], valid: new Set(["login-button"]) });
    const run = await runWithRepair(s.host, [tapStep("login-btn")]);
    expect(run.ok).toBe(true);
    expect(run.repairs).toHaveLength(1);
    expect(run.repairs[0]).toMatchObject({ step: 1, tool: "tap", kind: "target", was: { id: "login-btn" }, now: { id: "login-button" }, score: 1 });
    expect(run.work.map((w) => w.repaired?.was)).toEqual([{ id: "login-btn" }]);
    expect(s.audit).toEqual(["step 1: tap id=login-btn to id=login-button (score 1.00), accepted"]);
  });

  it("a rejected trial that moved the app is taken back before the next, or the repair stops", async () => {
    const elements = [el("e1", "go-alpha", undefined), el("e2", "go-alpha-x", undefined)];
    const moved = stub({ elements, valid: new Set(["nothing"]), place: "start" });
    let placeNow = "start";
    moved.host.runSteps = (steps) => {
      if ((steps[0] as { target?: { id?: string } }).target?.id !== "go-alp") placeNow = "elsewhere";
      return Promise.resolve({ isError: true, content: [{ type: "text", text: `Error not_found: Ran 0 of ${steps.length} steps; stopped at step 1 (tap id=x): No element matches` }] });
    };
    moved.host.place = () => Promise.resolve(placeNow);
    let returned = 0;
    moved.host.returnTo = () => {
      returned++;
      placeNow = "start";
      return Promise.resolve(true);
    };
    await runWithRepair(moved.host, [tapStep("go-alp")]);
    expect(returned).toBeGreaterThanOrEqual(1);
    // When it can't go back (no road, and back is refused), the repair stops after the first rejected trial.
    placeNow = "start";
    const stuck = stub({ elements, valid: new Set(["nothing"]), place: "start" });
    let trials = 0;
    stuck.host.runSteps = (steps) => {
      trials++;
      if ((steps[0] as { target?: { id?: string } }).target?.id !== "go-alp") placeNow = "elsewhere";
      return Promise.resolve({ isError: true, content: [{ type: "text", text: `Error not_found: Ran 0 of ${steps.length} steps; stopped at step 1 (tap id=x): No element matches` }] });
    };
    stuck.host.place = () => Promise.resolve(placeNow);
    stuck.host.returnTo = () => Promise.resolve(false);
    stuck.host.back = () => Promise.resolve(false);
    const run = await runWithRepair(stuck.host, [tapStep("go-alp")]);
    expect(run.ok).toBe(false);
    expect(trials).toBe(2);
    expect(run.notes.join("\n")).toContain("couldn't be taken back");
  });

  it("a repair isn't made when its audit line can't be written", async () => {
    const s = stub({ elements: [el("e1", "login-button", "Log in")], valid: new Set(["login-button"]), auditOk: false });
    const run = await runWithRepair(s.host, [tapStep("login-btn")]);
    expect(run.ok).toBe(false);
    expect(run.repairs).toEqual([]);
    expect(run.notes.join("\n")).toContain("no repair was made");
  });
});

describe("the surfaces", () => {
  it("replay takes repair (suggest or apply) and has no adopt", () => {
    expect(Object.keys(toolShapes.replay)).toContain("repair");
    expect(Object.keys(toolShapes.replay)).not.toContain("adopt");
    expect(toolShapes.replay.repair.safeParse("suggest").success).toBe(true);
    expect(toolShapes.replay.repair.safeParse("apply").success).toBe(true);
    expect(toolShapes.replay.repair.safeParse("adopt").success).toBe(false);
  });

  it("the command line takes --repair and --adopt", () => {
    const { values } = parseCli(["replay", "sign_in", "--repair", "apply", "--adopt", "--junit", "out.xml"]);
    expect(values.repair).toBe("apply");
    expect(values.adopt).toBe(true);
    expect(values.junit).toBe("out.xml");
  });

  it("--adopt without --repair apply, and a bad --repair, are refused before anything starts (exit 2)", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["replay", "sign_in", "--adopt"])).toBe(2);
    expect(await main(["replay", "sign_in", "--repair", "suggest", "--adopt"])).toBe(2);
    expect(await main(["replay", "sign_in", "--repair", "bogus"])).toBe(2);
    const said = err.mock.calls.map((call) => String(call[0])).join("");
    expect(said).toContain("--adopt goes with --repair apply");
    expect(said).toContain("--repair is suggest or apply");
  });

  it("JUnit: the suggestion is in the failure message", () => {
    const failure = [
      "Error not_found: Ran 3 of 7 steps; stopped at step 4 (tap id=login-btn): no element matches",
      "Repair (suggest, not checked):",
      '1. tap id=login-button, button "Log in" on welcome: score 0.93 (id_stem 0.85). Why: close.',
      'To check it: replay with repair: "apply".',
    ].join("\n");
    const message = failureWithRepair(failure).split("\n")[0] as string;
    expect(message).toContain("[Repair (suggest, not checked): 1. tap id=login-button");
    expect(message).not.toContain("To check it");
    expect(failureWithRepair("Error not_found: Ran 0 of 1 steps; stopped at step 1 (tap): x")).toBe("Error not_found: Ran 0 of 1 steps; stopped at step 1 (tap): x");
    const xml = junitXml([{ name: "sign_in", seconds: 1, failure: failureWithRepair(failure) }]);
    expect(xml).toContain('<failure message="Error not_found: Ran 3 of 7 steps; stopped at step 4 (tap id=login-btn): no element matches [Repair (suggest, not checked): 1. tap id=login-button, button &quot;Log in&quot;');
  });

  it("a schedule file has no repair key: a scheduled run never repairs", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-repair-sched-"));
    dirs.push(dir);
    const path = join(dir, "nightly.json");
    writeFileSync(path, JSON.stringify({ version: 1, tool: "tapline", route: "sign_in", at: "02:00 daily", repair: "apply" }));
    const read = readScheduleFile(path);
    expect(read.ok).toBe(true);
    if (read.ok) expect(Object.keys(read.schedule)).not.toContain("repair");
  });

  it("a recorded step keeps its place, and a script keeps the keys a replay ignores", () => {
    const step = toToolStep({ method: "press", params: { target: { testID: "go" } }, route: ["home"], place: "home" });
    expect(step).toEqual({ tool: "tap", target: { id: "go" }, route: ["home"], place: "home" });
    const text = JSON.stringify({ format: "agent-tools-script", version: 1, name: "s", fresh: false, repaired: { from: "s.json", count: 1 }, steps: [{ tool: "tap", target: { id: "go" }, place: "home", repaired: { was: { id: "g" }, score: 0.9 } }] });
    const read = readScript(text);
    expect(read?.steps[0]).toMatchObject({ place: "home", repaired: { score: 0.9 } });
  });
});
