import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../src/dispatch.js";
import type { MapFile } from "../src/mapfile.js";
import type { TaplineHost } from "../src/server.js";
import { HintBook, formOpened, hintLine, isSafetyRefusal, pickHint, type CallFacts, type HintFacts, type HintId } from "../src/hints.js";
import { baseMap, button, flushDriveMaps, road, setupDrive, textOf, type El, type Setup, type SetupOptions } from "./drive-helpers.js";
import { delay, type FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.17 §30.3: the `Hint:` line.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  await flushDriveMaps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type WorldInit = NonNullable<SetupOptions["world"]>;
const setup = (options: SetupOptions = {}): Promise<Setup> => setupDrive(hosts, apps, dirs, options);
const frame = { x: 20, y: 100, width: 300, height: 44 };
const input = (ref: string, testID: string): El => ({ ref, type: "TextInput", role: "input", testID, label: testID, text: "", frame, actions: ["tap", "type"] });

const HINT_FORM = "Hint: fill the fields and save in one `run`, with an `expect` on the save step.";
const HINT_PICTURE = "Hint: the text answer had the changes; ask for a screenshot only to judge how something looks.";
const HINT_LONG = "Hint: on a long task, the main session can hand the driving to one small, fast agent; if you are that agent, carry on.";
const HINT_ERROR = "Hint: the app logged an error: `logs` shows it.";

const hintOf = (text: string): string | undefined => text.split("\n").find((line) => line.startsWith("Hint:"));
/** The answer without its `Known:` and `Hint:` lines (the Known line is its own feature). */
const plain = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("Hint:") && !line.startsWith("Known:"))
    .join("\n");
const tap = async (s: Setup, id: string, extra: Record<string, unknown> = {}): Promise<string> => textOf(await callTool(s.tools, "tap", { target: { id }, ...extra }));
const look = async (s: Setup, extra: Record<string, unknown> = {}): Promise<string> => textOf(await callTool(s.tools, "look", { screenshot: false, ...extra }));

/** The general screen becomes a form: two inputs and a button. */
const formWorld: WorldInit = (w) => {
  w.elements.general = [input("e3", "name"), input("e4", "email"), button("e5", "save", "Save")];
};

/** The app logs an error line, and the host has it. */
async function appError(s: Setup): Promise<void> {
  s.app.send({ type: "event", event: "error", data: { message: "Render failed", ts: Date.now() } });
  await delay(80);
}

/** Settings, general and language each lead on: three taps in a row along roads the map holds. */
function loopMap(): MapFile {
  const map = baseMap();
  map.roads.push(road("language", "settings", "back-row", "Back"));
  return map;
}
const loopWorld: WorldInit = (w) => {
  w.elements.language = [button("e4", "back-row", "Back")];
  w.goes["language|back-row"] = "settings";
};

describe("case 1: a form opened", () => {
  it("says it once, after the notes, and not the second time", async () => {
    const s = await setup({ world: formWorld });
    const first = await tap(s, "general-row");
    expect(first).toContain("input");
    const lines = first.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(HINT_FORM);
    expect(lines.filter((line) => line.startsWith("Hint:"))).toHaveLength(1);
    await callTool(s.tools, "open_url", { url: "wayfare://settings" });
    expect(hintOf(await tap(s, "general-row"))).toBeUndefined();
  });

  it("is off with noHints, and the answer is the same", async () => {
    const on = await setup({ world: formWorld });
    const off = await setup({ world: formWorld, tools: { noHints: true } });
    const withHint = await tap(on, "general-row");
    const without = await tap(off, "general-row");
    expect(hintOf(withHint)).toBe(HINT_FORM);
    expect(hintOf(without)).toBeUndefined();
    expect(plain(withHint)).toBe(plain(without));
  });

  it("is not said for a screen with one input", async () => {
    const s = await setup({
      world: (w) => {
        w.elements.general = [input("e3", "name"), button("e5", "save", "Save")];
      },
    });
    expect(hintOf(await tap(s, "general-row"))).toBeUndefined();
  });
});

describe("case 2: three taps along a way the map knows", () => {
  const taps = async (s: Setup): Promise<string[]> => {
    await look(s);
    const out: string[] = [];
    for (const id of ["general-row", "language-row", "back-row"]) out.push(await tap(s, id));
    return out;
  };

  it("says it on the third tap, after the notes, once", async () => {
    const s = await setup({ map: loopMap(), world: loopWorld });
    const [a, b, c] = await taps(s);
    expect(hintOf(a ?? "")).toBeUndefined();
    expect(hintOf(b ?? "")).toBeUndefined();
    expect(c?.trimEnd().split("\n").at(-1)).toBe('Hint: this way is known: `drive {"to": "settings"}` reaches settings in one call.');
    // A fourth tap on the same way: said already.
    expect(hintOf(await tap(s, "general-row"))).toBeUndefined();
  });

  it("is off with noHints, and the answer is the same", async () => {
    const on = await setup({ map: loopMap(), world: loopWorld });
    const off = await setup({ map: loopMap(), world: loopWorld, tools: { noHints: true } });
    const withHint = (await taps(on))[2] ?? "";
    const without = (await taps(off))[2] ?? "";
    expect(hintOf(withHint)).toBeDefined();
    expect(hintOf(without)).toBeUndefined();
    expect(plain(withHint)).toBe(plain(without));
  });

  it("does not count taps that left the way", async () => {
    const s = await setup({ map: loopMap(), world: loopWorld });
    await look(s);
    await tap(s, "general-row");
    await tap(s, "language-row");
    await callTool(s.tools, "scroll", { direction: "down" });
    expect(hintOf(await tap(s, "back-row"))).toBeUndefined();
  });
});

describe("case 3: a picture asked when the text had the changes", () => {
  it("says it for screenshot: true on an action, once", async () => {
    const s = await setup();
    const first = await tap(s, "general-row", { screenshot: true });
    expect(first.trimEnd().split("\n").at(-1)).toBe(HINT_PICTURE);
    await callTool(s.tools, "open_url", { url: "wayfare://settings" });
    expect(hintOf(await tap(s, "general-row", { screenshot: true }))).toBeUndefined();
  });

  it("says it for a look with a picture right after an action whose answer had the changes", async () => {
    const s = await setup();
    await tap(s, "general-row");
    const looked = await look(s, { screenshot: true });
    expect(looked.trimEnd().split("\n").at(-1)).toBe(HINT_PICTURE);
  });

  it("does not say it for a look with a picture after a look", async () => {
    const s = await setup();
    await look(s);
    expect(hintOf(await look(s, { screenshot: true }))).toBeUndefined();
  });

  it("is off with noHints, and the answer is the same", async () => {
    const on = await setup();
    const off = await setup({ tools: { noHints: true } });
    const withHint = await tap(on, "general-row", { screenshot: true });
    const without = await tap(off, "general-row", { screenshot: true });
    expect(hintOf(withHint)).toBe(HINT_PICTURE);
    expect(hintOf(without)).toBeUndefined();
    expect(plain(withHint)).toBe(plain(without));
  });
});

describe("case 4: a long task", () => {
  it("says it on the 20th call, once", async () => {
    const s = await setup();
    const answers: string[] = [];
    for (let i = 0; i < 22; i++) answers.push(await look(s));
    answers.forEach((text, i) => {
      if (i === 19) expect(text.trimEnd().split("\n").at(-1)).toBe(HINT_LONG);
      else expect(hintOf(text)).toBeUndefined();
    });
  });

  it("is off with noHints, and the answer is the same", async () => {
    const on = await setup();
    const off = await setup({ tools: { noHints: true } });
    let withHint = "";
    let without = "";
    for (let i = 0; i < 20; i++) {
      withHint = await look(on);
      without = await look(off);
    }
    expect(hintOf(withHint)).toBe(HINT_LONG);
    expect(hintOf(without)).toBeUndefined();
    expect(plain(withHint)).toBe(plain(without));
  });
});

describe("case 5: the app logged an error", () => {
  it("says it once, after the notes", async () => {
    const s = await setup();
    await appError(s);
    const first = await look(s);
    expect(first.trimEnd().split("\n").at(-1)).toBe(HINT_ERROR);
    await appError(s);
    expect(hintOf(await look(s))).toBeUndefined();
  });

  it("is cleared by reading logs", async () => {
    const s = await setup();
    await appError(s);
    const read = textOf(await callTool(s.tools, "logs", {}));
    expect(hintOf(read)).toBeUndefined();
    expect(hintOf(await look(s))).toBeUndefined();
  });

  it("is not triggered by a tool error such as not_found", async () => {
    const s = await setup();
    const missing = await tap(s, "no-such-button");
    expect(missing).toMatch(/^Error not_found/);
    expect(hintOf(missing)).toBeUndefined();
    expect(hintOf(await look(s))).toBeUndefined();
  });

  it("is off with noHints, and the answer is the same", async () => {
    const on = await setup();
    const off = await setup({ tools: { noHints: true } });
    await appError(on);
    await appError(off);
    const withHint = await look(on);
    const without = await look(off);
    expect(hintOf(withHint)).toBe(HINT_ERROR);
    expect(hintOf(without)).toBeUndefined();
    expect(plain(withHint)).toBe(plain(without));
  });
});

describe("order and refusals", () => {
  it("shows the error hint before the form hint; the form hint waits for a later answer", async () => {
    const s = await setup({ world: formWorld });
    await appError(s);
    const first = await tap(s, "general-row");
    expect(first).toContain("input");
    expect(hintOf(first)).toBe(HINT_ERROR);
    await callTool(s.tools, "open_url", { url: "wayfare://settings" });
    expect(hintOf(await tap(s, "general-row"))).toBe(HINT_FORM);
  });

  it("never adds a hint to a refusal for safety, and keeps it for a later answer", async () => {
    const s = await setup({ policy: { version: 1, confirm: ["delete"], block: [] } });
    await appError(s);
    const refused = await tap(s, "delete-trip");
    expect(refused).toMatch(/^Error not_allowed/);
    expect(hintOf(refused)).toBeUndefined();
    expect(hintOf(await look(s))).toBe(HINT_ERROR);
  });
});

describe("pickHint (pure)", () => {
  const none: HintFacts = { error: false, way: null, form: false, picture: false, calls: 1 };
  const all: HintFacts = { error: true, way: "settings", form: true, picture: true, calls: 25 };

  it("picks in the order error, way, form, picture, long", () => {
    const shown = new Set<HintId>();
    const order: Array<HintId | null> = [];
    for (let i = 0; i < 6; i++) {
      const id = pickHint(all, shown);
      order.push(id);
      if (id !== null) shown.add(id);
    }
    expect(order).toEqual(["error", "way", "form", "picture", "long", null]);
  });

  it("picks nothing when no case applies, and long only from the 20th call", () => {
    expect(pickHint(none, new Set())).toBeNull();
    expect(pickHint({ ...none, calls: 19 }, new Set())).toBeNull();
    expect(pickHint({ ...none, calls: 20 }, new Set())).toBe("long");
  });

  it("words the way hint with the place", () => {
    expect(hintLine("way", { ...none, way: "trips" })).toBe('Hint: this way is known: `drive {"to": "trips"}` reaches trips in one call.');
  });

  it("knows a safety refusal and a form", () => {
    expect(isSafetyRefusal("Error not_allowed: needs_confirmation: tap Delete", true)).toBe(true);
    expect(isSafetyRefusal("Error paused: a person paused you", true)).toBe(true);
    expect(isSafetyRefusal("Error not_found: nothing", true)).toBe(false);
    expect(formOpened("Screen 430x932 pt\ne1 input x\ne2 input y\ne3 button Save")).toBe(true);
    expect(formOpened("Same screen. Changes:\n+ e1 input x\n+ e2 input y\n+ e3 button Save")).toBe(false);
  });

  it("a book keeps its own state per session", () => {
    const facts = (over: Partial<CallFacts> = {}): CallFacts => ({ tool: "look", args: {}, text: "Screen 1x1 pt", isError: false, errorSeq: undefined, way: undefined, logMark: 0, ...over });
    const book = new HintBook(0);
    for (let i = 0; i < 19; i++) expect(book.note("a", facts())).toBeNull();
    expect(book.note("a", facts())).toBe(HINT_LONG);
    expect(book.note("b", facts())).toBeNull();
  });
});
