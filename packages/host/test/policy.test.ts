import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Confirmations, type ConfirmEvent } from "../src/confirm.js";
import { DEFAULT_POLICY, NO_POLICY, elementKey, listsFor, loadPolicy, matchWord, type PolicyFile } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.8 §11: the safety policy, a person's OK and dry runs.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame: { x: 115, y: 620, width: 200, height: 40 }, actions: ["press"] };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const CLOSE_ACCOUNT = { ref: "e20", type: "Pressable", role: "button", testID: "", text: "Delete account", frame: { x: 0, y: 0, width: 100, height: 40 }, actions: ["press"] };
const TREE = { screen: { width: 430, height: 932 }, elements: [SAVE, DELETE, CLOSE_ACCOUNT] };

function byTarget(params: unknown): typeof SAVE | undefined {
  const target = (params as { target?: { testID?: string; text?: string } }).target;
  return TREE.elements.find((e) => (target?.testID !== undefined && e.testID === target.testID) || (target?.text !== undefined && e.text === target.text));
}

async function setup(options: { policy?: PolicyFile; capabilities?: string[]; canConfirm?: boolean; now?: () => number } = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "tree") return { ok: true, result: TREE };
    if (req.method === "press" || req.method === "longPress" || req.method === "toggle") {
      const element = byTarget(req.params);
      if (element === undefined) return { ok: false, error: { code: "not_found", message: "No element matches" } };
      return { ok: true, result: { element, point: { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 } } };
    }
    return { ok: true, result: {} };
  };
  const { app } = await FakeApp.connect(port, options.capabilities ? { capabilities: options.capabilities } : {}, handler);
  apps.push(app);
  const confirmations = new Confirmations(options.now);
  const tools = new TaplineTools(host, {
    connect: { url: "", name: "Dev PC" },
    confirmations,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.canConfirm !== undefined ? { canConfirm: options.canConfirm } : {}),
  });
  const events: ConfirmEvent[] = [];
  confirmations.onEvent((e) => events.push(e));
  return { app, tools, confirmations, events };
}

describe("the policy's words", () => {
  it("match whole words of the element's own label or text, ignoring case; never its testID", () => {
    expect(matchWord(["Delete"], { text: "Delete trip" })).toBe("Delete");
    expect(matchWord(["Delete"], { text: "delete" })).toBe("Delete");
    expect(matchWord(["Delete"], { text: "Deleted" })).toBeNull();
    expect(matchWord(["Sign out"], { label: "Sign out of Wayfare" })).toBe("Sign out");
    expect(matchWord(["Pay"], { text: "Payment details" })).toBeNull();
    expect(matchWord(["Delete"], { label: "Trash", text: "" })).toBeNull();
    expect(matchWord(["Buy"], { text: "Buy (2)" })).toBe("Buy");
  });

  it("per-app lists replace the global ones; --no-policy is empty lists", () => {
    const policy: PolicyFile = { version: 1, confirm: ["Delete"], block: [], apps: { "com.example.demo": { confirm: [], block: ["Delete account"] } } };
    expect(listsFor(policy, { id: "com.example.demo", name: "Demo" })).toEqual({ confirm: [], block: ["Delete account"] });
    expect(listsFor(policy, { id: "other", name: "Other" })).toEqual({ confirm: ["Delete"], block: [] });
    expect(listsFor(NO_POLICY, { name: "x" })).toEqual({ confirm: [], block: [] });
    expect(listsFor(DEFAULT_POLICY, undefined).confirm).toContain("Sign out");
  });

  it("reads a policy file and refuses one that isn't", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-policy-"));
    try {
      const good = join(dir, "good.json");
      writeFileSync(good, JSON.stringify({ version: 1, confirm: ["Pay"], block: ["Erase"] }));
      expect(loadPolicy(good)).toMatchObject({ confirm: ["Pay"], block: ["Erase"] });
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ confirm: "Pay" }));
      expect(() => loadPolicy(bad)).toThrow(/isn't a policy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ties an OK to the element's id, else its role, label and text", () => {
    expect(elementKey({ testID: "x", text: "Delete" })).toBe("id:x");
    expect(elementKey({ role: "button", text: "Delete" })).toBe("el:button||Delete");
  });
});

describe("a person's OK (Confirmations)", () => {
  it("one allow lets exactly one call through; a decline and an expiry say so on the retry", () => {
    let now = 1000;
    const c = new Confirmations(() => now, 120_000);
    const events: ConfirmEvent[] = [];
    c.onEvent((e) => events.push(e));
    const ask = { kind: "tap", caption: 'Tap "Delete trip"', word: "Delete" };
    const first = c.check("tap|id:d", ask);
    expect(first.granted).toBe(false);
    if (first.granted) return;
    expect(events[0]).toEqual({ type: "confirm", id: first.request.id, by: "agent", kind: "tap", caption: 'Tap "Delete trip"', word: "Delete", expires: 121_000 });
    // asked again while open: the same request, no second prompt
    const again = c.check("tap|id:d", ask);
    expect(again.granted === false && again.request.id).toBe(first.request.id);
    expect(events).toHaveLength(1);
    expect(c.answer(first.request.id, true)).toBe(true);
    expect(c.answer(first.request.id, false)).toBe(false); // the first answer wins
    expect(events[1]).toEqual({ type: "confirm_closed", id: first.request.id, allow: true });
    expect(c.check("tap|id:d", ask).granted).toBe(true);
    // used up
    const next = c.check("tap|id:d", ask);
    expect(next.granted).toBe(false);
    if (next.granted) return;
    c.answer(next.request.id, false);
    const declined = c.check("tap|id:d", ask);
    expect(declined.granted === false && declined.suffix).toBe(" They declined.");
    if (declined.granted) return;
    now += 121_000;
    expect(c.answer(declined.request.id, true)).toBe(false); // too late
    const lapsed = c.check("tap|id:d", ask);
    expect(lapsed.granted === false && lapsed.suffix).toBe(" Nobody answered.");
    c.close();
  });

  it("an allow is for the same tool on the same element only, and lapses after 120 s", () => {
    let now = 0;
    const c = new Confirmations(() => now, 120_000);
    const ask = { kind: "tap", caption: "Tap", word: "Delete" };
    const r = c.check("tap|id:d", ask);
    if (r.granted) throw new Error("granted without asking");
    c.answer(r.request.id, true);
    expect(c.check("long_press|id:d", ask).granted).toBe(false);
    expect(c.check("tap|id:other", ask).granted).toBe(false);
    now += 121_000;
    expect(c.check("tap|id:d", ask).granted).toBe(false);
    c.close();
  });
});

describe("guarded touches (§11.2)", () => {
  it("refuses a confirm word with needs_confirmation and asks the live view; an allow lets the same call through once", async () => {
    const { app, tools, confirmations, events } = await setup();
    const refused = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      `Error not_allowed: needs_confirmation: button "Delete trip" needs a person's OK (policy word "Delete"). The live view asks them now; when they allow it, make the same call again. If nobody is watching, ask your user.`,
    );
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    expect(app.dryRuns).toHaveLength(1);
    const asked = events[0];
    expect(asked).toMatchObject({ type: "confirm", by: "agent", kind: "tap", caption: 'Tap "Delete trip"', word: "Delete" });
    if (asked?.type !== "confirm") return;
    confirmations.answer(asked.id, true);
    const allowed = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(allowed.isError).not.toBe(true);
    expect(textOf(allowed)).toBe(`Tapped e12 button "Delete trip" id=delete-trip @115,620 200x40.\nNote: a person allowed this.`);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(1);
    // one use
    const third = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(third)).toMatch(/^Error not_allowed: needs_confirmation: /);
  });

  it("adds They declined. on the retry after a person said no", async () => {
    const { tools, confirmations, events } = await setup();
    await tools.tap({ target: { id: "delete-trip" }, look: false });
    const asked = events[0];
    if (asked?.type !== "confirm") throw new Error("no prompt");
    confirmations.answer(asked.id, false);
    const retry = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(retry)).toMatch(/If nobody is watching, ask your user\. They declined\.$/);
  });

  it("blocks a block word outright, whatever the person says", async () => {
    const policy: PolicyFile = { version: 1, confirm: [], block: ["Delete account"] };
    const { app, tools, events } = await setup({ policy });
    const blocked = await tools.tap({ target: { text: "Delete account" }, look: false });
    expect(textOf(blocked)).toBe(`Error not_allowed: blocked: button "Delete account" is blocked by the policy ("Delete account"); don't try another way.`);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("lets ordinary buttons straight through, after one dry run", async () => {
    const { app, tools } = await setup();
    const saved = await tools.tap({ target: { id: "save" }, look: false });
    expect(textOf(saved)).toBe(`Tapped e3 button "Save" id=save @24,610 354x48.`);
    expect(app.dryRuns).toHaveLength(1);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(1);
  });

  it("with --no-policy, asks the app nothing extra", async () => {
    const { app, tools } = await setup({ policy: NO_POLICY });
    await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(app.dryRuns).toHaveLength(0);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(1);
  });

  it("says nobody can allow it when the live view is off", async () => {
    const { tools } = await setup({ canConfirm: false });
    const refused = await tools.tap({ target: { id: "delete-trip" }, look: false });
    expect(textOf(refused)).toMatch(/The live view is off, so nobody can allow it here; ask your user\.$/);
  });

  it("checks an app without dry runs against every element the target could mean", async () => {
    const { app, tools } = await setup({ capabilities: ["tree", "press"] });
    const refused = await tools.tap({ target: { text: "Delete" }, look: false });
    expect(textOf(refused)).toMatch(/^Error not_allowed: needs_confirmation: button "Delete trip"/);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    expect(app.requests.filter((r) => r.method === "tree")).toHaveLength(1);
  });

  it("guards long_press and toggle too", async () => {
    const { tools } = await setup();
    expect(textOf(await tools.longPress({ target: { id: "delete-trip" }, look: false }))).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(textOf(await tools.toggle({ target: { id: "delete-trip" }, look: false }))).toMatch(/^Error not_allowed: needs_confirmation: /);
  });
});

describe("dry runs (§11.4)", () => {
  it("says what a tap would do and where, and whether it needs a person's OK, without asking anyone", async () => {
    const { app, tools, events } = await setup();
    const would = await tools.tap({ target: { id: "delete-trip" }, dry_run: true });
    expect(would.isError).not.toBe(true);
    expect(textOf(would)).toBe(`Would tap e12 button "Delete trip" at 215,640. It needs a person's OK (policy word "Delete").`);
    const plain = await tools.tap({ target: { id: "save" }, dry_run: true });
    expect(textOf(plain)).toBe(`Would tap e3 button "Save" at 201,634.`);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("a dry run still answers the app's refusal", async () => {
    const { tools } = await setup();
    const missing = await tools.tap({ target: { id: "nope" }, dry_run: true });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^Error not_found: /);
  });

  it("run with dry_run checks the steps and resolves step 1 only", async () => {
    const { app, tools } = await setup();
    const would = await tools.run({
      steps: [
        { tool: "tap", target: { id: "save" } },
        { tool: "type_text", target: { id: "email" }, text: "a@b.co" },
        { tool: "tap", target: { id: "delete-trip" } },
      ],
      dry_run: true,
    });
    expect(textOf(would)).toBe(`Would run 3 steps; step 1 would tap e3 button "Save" at 201,634.`);
    expect(app.requests.filter((r) => r.method === "press")).toHaveLength(0);
    const bad = await tools.run({ steps: [{ tool: "tap" }], dry_run: true });
    expect(textOf(bad)).toMatch(/^Error bad_params: step 1/);
  });
});
