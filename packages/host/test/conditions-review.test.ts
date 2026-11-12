import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { Confirmations } from "../src/confirm.js";
import type { PolicyFile } from "../src/policy.js";
import type { Step } from "../src/run.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// Review fixes for `if` and `optional` (1.6 task 4): dry runs, bad input, the safety checks, a failing check, long texts.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const textOf = (result: CallToolResult): string => result.content.map((b) => (b.type === "text" ? b.text : `<${b.type}>`)).join("\n");

const frame = { x: 24, y: 610, width: 354, height: 48 };
const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame, actions: ["press"] };
const DELETE = { ref: "e12", type: "Pressable", role: "button", testID: "delete-trip", text: "Delete trip", frame, actions: ["press"] };
const ERASE = { ref: "e20", type: "Pressable", role: "button", testID: "erase", text: "Delete account", frame, actions: ["press"] };
const ELEMENTS = [SAVE, DELETE, ERASE];

interface Options {
  policy?: PolicyFile;
  capabilities?: string[];
  /** Answers a `waitFor` with once; by default "found". */
  once?: (params: Record<string, unknown>) => Reply;
}

async function setup(options: Options = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === "tree") return { ok: true, result: { screen: { width: 402, height: 874, scale: 3 }, elements: ELEMENTS } };
    if (req.method === "waitFor" && params["once"] === true) return options.once?.(params) ?? { ok: true, result: { found: true } };
    if (req.method === "press") {
      const target = (params["target"] ?? {}) as { testID?: string; text?: string };
      const element = ELEMENTS.find((e) => e.testID === target.testID || e.text === target.text) ?? SAVE;
      return { ok: true, result: { element, point: { x: 50, y: 630 }, settledMs: 30 } };
    }
    return { ok: true, result: {} };
  };
  const { app } = await FakeApp.connect(port, { capabilities: options.capabilities ?? ["tree", "press", "waitFor", "waitOnce", "dryRun"] }, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, confirmations: new Confirmations(), ...(options.policy ? { policy: options.policy } : {}) });
  return { app, tools };
}

const pressed = (app: FakeApp): number => app.requests.filter((r) => r.method === "press").length;

describe("dry_run on a run checks step 1's if and optional", () => {
  it("says step 1 would be skipped, for an if that doesn't hold", async () => {
    const { app, tools } = await setup({ once: () => ({ ok: true, result: { found: false } }) });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: "Rate this app" } }, { tool: "back" }], dry_run: true });
    expect(answer.isError).toBeUndefined();
    expect(textOf(answer)).toBe('Would run 2 steps; step 1 would be skipped (if: "Rate this app" isn\'t on screen).');
    expect(pressed(app)).toBe(0);
  });

  it("says it for an optional whose target isn't there", async () => {
    const { tools } = await setup({ once: () => ({ ok: true, result: { found: false } }) });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { text: "Not now" }, optional: true }], dry_run: true });
    expect(textOf(answer)).toBe('Would run 1 step; step 1 would be skipped (optional: "Not now" isn\'t on screen).');
  });

  it("goes on to the usual dry run when the condition holds", async () => {
    const { tools } = await setup();
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, optional: true }], dry_run: true });
    expect(textOf(answer)).toMatch(/^Would run 1 step; step 1 would tap/);
  });
});

describe("bad if and optional", () => {
  it("an empty text, id or label answers bad_params and nothing runs", async () => {
    const { app, tools } = await setup();
    for (const given of [{ text: "" }, { id: "" }, { label: "" }]) {
      const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: given } as Step] });
      expect(answer.isError).toBe(true);
      expect(textOf(answer)).toMatch(/^Error bad_params: step 1 \(tap id=save\): if (text|id|label) can't be empty/);
    }
    expect(pressed(app)).toBe(0);
  });

  it("a non-object if and a non-boolean optional answer clear bad_params", async () => {
    const { app, tools } = await setup();
    const notObject = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: "Not now" } as unknown as Step] });
    expect(textOf(notObject)).toBe('Error bad_params: step 1 (tap id=save): if is an object with one of text, id or label (and gone), not "Not now".');
    const notBool = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, optional: "yes" } as unknown as Step] });
    expect(textOf(notBool)).toBe('Error bad_params: step 1 (tap id=save): optional is true or false, not "yes".');
    expect(pressed(app)).toBe(0);
  });
});

describe("a condition never skips a safety check", () => {
  const confirm: PolicyFile = { version: 1, confirm: ["Delete"], block: [] };
  const block: PolicyFile = { version: 1, confirm: [], block: ["Delete account"] };

  it("an optional tap on a Delete button that is there asks for a person's OK, stops the run, and isn't called skipped", async () => {
    const { app, tools } = await setup({ policy: confirm });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "delete-trip" }, optional: true }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: Ran 0 of 1 steps; stopped at step 1 .*needs_confirmation/);
    expect(textOf(answer)).not.toContain("skipped");
    expect(pressed(app)).toBe(0);
  });

  it("a blocked word is refused the same way", async () => {
    const { app, tools } = await setup({ policy: block });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { text: "Delete account" }, optional: true }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_allowed: Ran 0 of 1 steps; stopped at step 1 .*blocked/);
    expect(textOf(answer)).not.toContain("skipped");
    expect(pressed(app)).toBe(0);
  });

  it("an if that holds in front of a flagged step still stops the run", async () => {
    const { app, tools } = await setup({ policy: confirm });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "delete-trip" }, if: { text: "Delete trip" } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/needs_confirmation/);
    expect(pressed(app)).toBe(0);
  });
});

describe("a check that can't be made", () => {
  it("a waitFor error counts as holds: the step runs and fails by itself", async () => {
    const { app, tools } = await setup({ once: () => ({ ok: false, error: { code: "internal", message: "boom" } }) });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, optional: true }] });
    expect(pressed(app)).toBe(1);
    expect(textOf(answer)).not.toContain("skipped");
  });
});

describe("a text longer than the app's list shows", () => {
  const long = "x".repeat(201);

  it("goes to the app's once when it has one", async () => {
    const asked: Record<string, unknown>[] = [];
    const { tools } = await setup({
      once: (params) => {
        asked.push(params);
        return { ok: true, result: { found: false } };
      },
    });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: long } }] });
    expect(asked).toHaveLength(1);
    expect(textOf(answer)).toContain("skipped (if:");
  });

  it("without once, says the condition can't be checked and runs nothing", async () => {
    const { app, tools } = await setup({ capabilities: ["tree", "press", "waitFor", "dryRun"] });
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, if: { text: long } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error bad_params: Ran 0 of 1 steps; stopped at step 1 \(tap id=save\): its if text is longer than the app's list shows/);
    expect(pressed(app)).toBe(0);
  });
});
