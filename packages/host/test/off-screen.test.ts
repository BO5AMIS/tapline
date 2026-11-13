import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Confirmations } from "../src/confirm.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.12 §16.2: tap, long_press, toggle and type_text on an off-screen target scroll first (the
// app does it); the host words the answer, runs the policy before the scroll, and keeps `Closest:` in a
// failed run step.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const SAVE = { ref: "e41", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 1500, width: 380, height: 48 }, actions: ["press"] };
const DELETE = { ref: "e42", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame: { x: 24, y: 1600, width: 380, height: 48 }, actions: ["press"] };
const SWITCH = { ref: "e43", type: "Switch", role: "switch", testID: "notify", text: "", label: "Notify", checked: false, frame: { x: 300, y: 1700, width: 60, height: 30 }, actions: ["toggle"] };
const FIELD = { ref: "e44", type: "TextInput", role: "input", testID: "name", text: "", frame: { x: 20, y: 1800, width: 300, height: 40 }, actions: ["type"] };
const BY_ID: Record<string, typeof SAVE | typeof SWITCH | typeof FIELD> = { save: SAVE, "delete-trip": DELETE, notify: SWITCH, name: FIELD };
const TREE = { screen: { width: 430, height: 932, scale: 3 }, elements: [SAVE] };

function targetOf(params: unknown): typeof SAVE | typeof SWITCH | typeof FIELD | undefined {
  const target = (params as { target?: { testID?: string } }).target;
  return target?.testID !== undefined ? BY_ID[target.testID] : undefined;
}

/** What the app says about an off-screen target: scrolled before acting, or (dry run) would scroll. */
function offScreenApp(req: IncomingRequest): Reply {
  if (req.method === "tree") return { ok: true, result: TREE };
  const element = targetOf(req.params);
  if (element === undefined) return { ok: false, error: { code: "not_found", message: "nothing on screen has id \"x\"; look, then pick another target." } };
  const dry = (req.params as { dryRun?: boolean }).dryRun === true;
  if (dry) return { ok: true, result: { element, dryRun: true, scrolls: true, point: { x: 215, y: 640 }, value: true, settledMs: 0 } };
  return { ok: true, result: { element, value: element === SWITCH ? true : "Ada", scrolled: true, settledMs: 10 } };
}

async function setup(handler: (req: IncomingRequest) => Reply = offScreenApp) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const confirmations = new Confirmations();
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, confirmations });
  return { app, tools, confirmations };
}

describe("act after scroll: the first line", () => {
  it("tap", async () => {
    const { tools } = await setup();
    const answer = textOf(await tools.tap({ target: { id: "save" }, look: false }));
    expect(answer).toBe('Scrolled to it, then tapped e41 button "Save" id=save.');
  });

  it("long_press", async () => {
    const { tools } = await setup();
    expect(textOf(await tools.longPress({ target: { id: "save" }, look: false }))).toBe('Scrolled to it, then long-pressed e41 button "Save" id=save.');
  });

  it("toggle", async () => {
    const { tools } = await setup();
    const answer = textOf(await tools.toggle({ target: { id: "notify" }, look: false }));
    expect(answer).toMatch(/^Scrolled to it, then toggled e43 switch /);
    expect(answer).toMatch(/ to true\.$/);
  });

  it("type_text", async () => {
    const { tools } = await setup();
    const answer = textOf(await tools.typeText({ target: { id: "name" }, text: "Ada", look: false }));
    expect(answer).toMatch(/^Scrolled to it, then typed into e44 input /);
  });

  it("an action that did not scroll reads as before", async () => {
    const { tools } = await setup((req) =>
      req.method === "tree" ? { ok: true, result: TREE } : { ok: true, result: { element: SAVE, settledMs: 0 } },
    );
    expect(textOf(await tools.tap({ target: { id: "save" }, look: false }))).toBe('Tapped e41 button "Save" id=save.');
  });
});

describe("act after scroll: dry_run", () => {
  it("says it would scroll, with the point expected after the scroll", async () => {
    const { app, tools } = await setup();
    expect(textOf(await tools.tap({ target: { id: "save" }, dry_run: true }))).toBe('Would scroll to it, then tap e41 button "Save" id=save at 215,640.');
    expect(textOf(await tools.longPress({ target: { id: "save" }, dry_run: true }))).toBe('Would scroll to it, then long-press e41 button "Save" id=save at 215,640.');
    expect(textOf(await tools.toggle({ target: { id: "notify" }, dry_run: true }))).toMatch(/^Would scroll to it, then toggle e43 switch .* to true at 215,640\.$/);
    expect(textOf(await tools.typeText({ target: { id: "name" }, text: "x", dry_run: true }))).toMatch(/^Would scroll to it, then type into e44 input .* at 215,640\.$/);
    // nothing but dry runs reached the app
    expect(app.requests.filter((r) => ["press", "longPress", "toggle", "type"].includes(r.method))).toHaveLength(0);
  });

  it("an on-screen target still reads `Would tap …`", async () => {
    const { tools } = await setup((req) =>
      req.method === "tree"
        ? { ok: true, result: TREE }
        : { ok: true, result: { element: SAVE, dryRun: true, point: { x: 100, y: 200 }, settledMs: 0 } },
    );
    expect(textOf(await tools.tap({ target: { id: "save" }, dry_run: true }))).toBe('Would tap e41 button "Save" at 100,200.');
  });
});

describe("act after scroll: the policy first", () => {
  it("a confirm word is asked before any scroll: the app is only dry-run", async () => {
    const { app, tools } = await setup();
    const refused = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    expect(app.dryRuns.map((r) => r.method)).toEqual(["press"]);
  });

  it("a dry run reports the policy beside the scroll", async () => {
    const { tools } = await setup();
    expect(textOf(await tools.tap({ target: { id: "delete-trip" }, dry_run: true }))).toMatch(
      /^Would scroll to it, then tap e42 button "Delete trip" id=delete-trip at 215,640\. It needs a person's OK \(policy word "Delete"\)\.$/,
    );
  });

  it("once allowed, the call scrolls and taps", async () => {
    const { app, tools, confirmations } = await setup();
    const events: string[] = [];
    let id = "";
    confirmations.onEvent((e) => {
      if (e.type === "confirm") id = e.id;
      events.push(e.type);
    });
    await tools.tap({ target: { id: "delete-trip" }, look: false });
    confirmations.answer(id, true);
    const answer = textOf(await tools.tap({ target: { id: "delete-trip" }, look: false }));
    expect(answer).toBe('Scrolled to it, then tapped e42 button "Delete trip" id=delete-trip.\nNote: allowed by a person (in the live view).');
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(1);
  });
});

describe("act after scroll: refused when no scroll helps", () => {
  it("the app's reason reaches the agent as `not_actionable: off_screen`", async () => {
    const reason = "e41 button \"Save\" id=save is off screen (at 24,1500; the screen is 430x932). It isn't inside a scroll view, so no scroll can bring it on screen; pass force: true to call its handler anyway.";
    const { tools } = await setup((req) =>
      req.method === "tree" ? { ok: true, result: TREE } : { ok: false, error: { code: "not_actionable", message: `off_screen: ${reason}` } },
    );
    const answer = await tools.tap({ target: { id: "save" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe(`Error not_actionable: off_screen: ${reason}`);
  });
});

describe("not_found with the closest matches", () => {
  const CLOSEST = 'nothing on screen has id "save-draf"; look, then pick another target. Closest: e12 button "Save draft" id=save-draft, e30 text "Saved" (off screen, below).';
  const notFound = (req: IncomingRequest): Reply =>
    req.method === "tree" ? { ok: true, result: TREE } : { ok: false, error: { code: "not_found", message: CLOSEST } };

  it("the answer carries the app's Closest part", async () => {
    const { tools } = await setup(notFound);
    const answer = await tools.tap({ target: { id: "save-draf" }, look: false });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe(`Error not_found: ${CLOSEST}`);
  });

  it("a run step that fails with not_found keeps it in the stop message", async () => {
    const { tools } = await setup(notFound);
    const answer = textOf(await tools.run({ steps: [{ tool: "tap", target: { id: "save-draf" } }] }));
    expect(answer.split("\n")[0]).toMatch(/^Error not_found: Ran 0 of 1 steps; stopped at step 1 \(.*\): nothing on screen has id "save-draf"; look, then pick another target\. Closest: e12 button "Save draft" id=save-draft, e30 text "Saved" \(off screen, below\)\.$/);
  });
});
