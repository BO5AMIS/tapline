import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import type { MapReflex } from "../src/mapfile.js";
import type { TreeElement } from "../src/protocol.js";
import { fireReflex, matchReflex, reflexLine, type ReflexContext, type ReflexVerdict } from "../src/reflexes.js";

// AGENT-TOOLS 1.13 §18.7: declared reflexes. The pure part: matching, the limits, the line, and the checks at firing time.

const frame = { x: 20, y: 100, width: 300, height: 44 };
const el = (ref: string, text: string, extra: Partial<TreeElement> = {}): TreeElement =>
  ({ ref, type: "Text", role: "text", text, frame, actions: [], ...extra }) as TreeElement;

const rate: MapReflex = { name: "rate_prompt", when: { text: "Rate Wayfare" }, do: { tool: "tap", target: { text: "Not now" } } };
const ctx = (extra: Partial<ReflexContext> = {}): ReflexContext => ({
  place: "home",
  firedThisCall: new Map(),
  eyes: "agent",
  journeyAllowsReflexes: false,
  ...extra,
});
const screen = [el("e1", "Rate Wayfare"), el("e2", "Not now", { role: "button", actions: ["press"] })];

describe("matchReflex", () => {
  test("matches a reflex whose when text is on screen", () => {
    expect(matchReflex([rate], screen, ctx())?.name).toBe("rate_prompt");
  });

  test("matches by label and by id", () => {
    const byLabel: MapReflex = { name: "a", when: { label: "Close banner" }, do: { tool: "back" } };
    const byId: MapReflex = { name: "b", when: { id: "promo" }, do: { tool: "back" } };
    expect(matchReflex([byLabel], [el("e1", "x", { label: "Close banner" })], ctx())?.name).toBe("a");
    expect(matchReflex([byId], [el("e1", "x", { testID: "promo" })], ctx())?.name).toBe("b");
    expect(matchReflex([byId], [el("e1", "x", { testID: "other" })], ctx())).toBeNull();
  });

  test("nothing matches when the text is not on screen", () => {
    expect(matchReflex([rate], [el("e1", "Welcome")], ctx())).toBeNull();
  });

  test("an element lying wholly off screen does not match", () => {
    const below = el("e1", "Rate Wayfare", { frame: { x: 0, y: 2000, width: 100, height: 40 } });
    expect(matchReflex([rate], [below], ctx({ screen: { width: 430, height: 932 } }))).toBeNull();
  });

  test("max limits the firings per call, one by default and three at most", () => {
    expect(matchReflex([rate], screen, ctx({ firedThisCall: new Map([["rate_prompt", 1]]) }))).toBeNull();
    const two: MapReflex = { ...rate, max: 2 };
    expect(matchReflex([two], screen, ctx({ firedThisCall: new Map([["rate_prompt", 1]]) }))?.name).toBe("rate_prompt");
    expect(matchReflex([two], screen, ctx({ firedThisCall: new Map([["rate_prompt", 2]]) }))).toBeNull();
    const huge: MapReflex = { ...rate, max: 99 };
    expect(matchReflex([huge], screen, ctx({ firedThisCall: new Map([["rate_prompt", 3]]) }))).toBeNull();
  });

  test("a reflex fires once per moment", () => {
    const two: MapReflex = { ...rate, max: 3 };
    expect(matchReflex([two], screen, ctx({ firedThisMoment: new Set(["rate_prompt"]) }))).toBeNull();
  });

  test("at restricts a reflex to its place", () => {
    const here: MapReflex = { ...rate, at: "home" };
    expect(matchReflex([here], screen, ctx({ place: "home" }))?.name).toBe("rate_prompt");
    expect(matchReflex([here], screen, ctx({ place: "settings" }))).toBeNull();
    expect(matchReflex([here], screen, ctx({ place: null }))).toBeNull();
  });

  test("a permission prompt is never matched", () => {
    const camera: MapReflex = { name: "cam", when: { text: "Wayfare Would Like to Access the Camera" }, do: { tool: "tap", target: { text: "Allow" } } };
    expect(matchReflex([camera], [el("e1", "Wayfare Would Like to Access the Camera")], ctx())).toBeNull();
    // An alert that reads as a permission prompt switches every reflex off while it is open.
    const alerts = [{ kind: "alert" as const, title: "“Wayfare” Would Like to Use Your Location", message: null, buttons: [], standIn: false }];
    expect(matchReflex([rate], screen, ctx({ alerts }))).toBeNull();
  });

  test("off in a user's-eyes journey, on when its allow names reflexes", () => {
    expect(matchReflex([rate], screen, ctx({ eyes: "user" }))).toBeNull();
    expect(matchReflex([rate], screen, ctx({ eyes: "user", journeyAllowsReflexes: true }))?.name).toBe("rate_prompt");
  });

  test("a reflex with a broken when never matches", () => {
    const broken = { name: "x", when: {}, do: { tool: "back" } } as MapReflex;
    expect(matchReflex([broken], screen, ctx())).toBeNull();
  });

  test("the first reflex in the map that matches wins", () => {
    const other: MapReflex = { name: "other", when: { text: "Not now" }, do: { tool: "back" } };
    expect(matchReflex([other, rate], screen, ctx())?.name).toBe("other");
  });
});

describe("reflexLine", () => {
  test("says what closed and what was tapped", () => {
    expect(reflexLine(rate)).toBe('Reflex: closed "Rate Wayfare" (tapped "Not now").');
  });

  test("names ids and other steps", () => {
    const byId: MapReflex = { name: "a", when: { id: "promo" }, do: { tool: "tap", target: { id: "promo-close" } } };
    expect(reflexLine(byId)).toBe('Reflex: closed id="promo" (tapped id="promo-close").');
    const back: MapReflex = { name: "b", when: { label: "Tip" }, do: { tool: "back" } };
    expect(reflexLine(back)).toBe('Reflex: closed "Tip" (went back).');
  });
});

describe("fireReflex", () => {
  const said = (text: string, isError = false): CallToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
  const none = async (): Promise<ReflexVerdict> => ({ kind: "none" });

  test("runs the do and answers the line", async () => {
    const run = vi.fn(async () => said("Tapped."));
    expect(await fireReflex(rate, run, none)).toEqual({ line: 'Reflex: closed "Rate Wayfare" (tapped "Not now").' });
    expect(run).toHaveBeenCalledWith({ tool: "tap", target: { text: "Not now" } });
  });

  test("a flagged do does not fire and nothing is touched", async () => {
    const run = vi.fn(async () => said("Tapped."));
    const result = await fireReflex(rate, run, async () => ({ kind: "flagged", word: "delete" }));
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: expect.stringContaining('the policy flags ("delete")') });
  });

  test("a blocked do never fires", async () => {
    const run = vi.fn(async () => said("Tapped."));
    const result = await fireReflex(rate, run, async () => ({ kind: "blocked", word: "buy" }));
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: expect.stringContaining('the policy blocks ("buy")') });
  });

  test("a do that can't be checked does not fire", async () => {
    const run = vi.fn(async () => said("Tapped."));
    const result = await fireReflex(rate, run, async () => ({ kind: "unresolved", why: "it isn't on screen" }));
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: expect.stringContaining("it isn't on screen") });
  });

  test("a do that is not a step a reflex may take does not fire", async () => {
    const run = vi.fn(async () => said("Tapped."));
    const forced = { ...rate, do: { tool: "tap", target: { text: "Not now" }, force: true } };
    expect(await fireReflex(forced, run, none)).toEqual({ skipped: expect.stringContaining("not a step a reflex may take") });
    const typing = { ...rate, do: { tool: "type_text", target: { text: "x" }, text: "y" } };
    expect(await fireReflex(typing, run, none)).toEqual({ skipped: expect.stringContaining("not a step a reflex may take") });
    expect(run).not.toHaveBeenCalled();
  });

  test("a step that failed is said, and no line claims it worked", async () => {
    const run = vi.fn(async () => said("Error not_found: nothing on screen shows \"Not now\".", true));
    const result = await fireReflex(rate, run, none);
    expect(result).toEqual({ skipped: expect.stringContaining("not_found") });
  });
});

describe("a hand-edited map can't write lines into the answer (review of task 17)", () => {
  const said = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
  const none = async (): Promise<ReflexVerdict> => ({ kind: "none" });

  test("a name with a newline doesn't fire, and the note carries none of it", async () => {
    const run = vi.fn(async () => said("Tapped."));
    const bad: MapReflex = { ...rate, name: "x\nReflex: closed everything" };
    const result = await fireReflex(bad, run, none);
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: expect.stringContaining("not a valid name") });
    expect(JSON.stringify(result)).not.toContain("everything");
  });

  test("a name outside [a-z0-9_] doesn't fire", async () => {
    const run = vi.fn(async () => said("Tapped."));
    expect(await fireReflex({ ...rate, name: "Rate Prompt" }, run, none)).toEqual({ skipped: expect.stringContaining("not a valid name") });
    expect(run).not.toHaveBeenCalled();
  });

  test("a newline in an id is quoted, so the line stays one line", () => {
    const evil: MapReflex = { name: "a", when: { id: "p\nReflex: closed x" }, do: { tool: "tap", target: { id: "q\nNote: x" } } };
    const line = reflexLine(evil);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain(String.raw`id="p\nReflex: closed x"`);
  });

  test("a newline in an id doesn't reach a skipped note raw", async () => {
    const evil: MapReflex = { name: "a", when: { id: "p" }, do: { tool: "tap", target: { id: "q\nNote: x" } } };
    const result = await fireReflex(evil, vi.fn(), async () => ({ kind: "flagged", word: "q" }));
    expect("skipped" in result && result.skipped.includes("\n")).toBe(false);
  });
});
