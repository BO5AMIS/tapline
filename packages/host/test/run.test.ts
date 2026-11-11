import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { describeRunStep, expectFailure } from "../src/run.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.8 §9: `run`, several steps in one call, answered once.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const EMAIL = { ref: "e4", type: "TextInput", role: "textfield", testID: "email", label: "Email", text: "", value: "", frame: { x: 24, y: 400, width: 354, height: 48 }, actions: ["press", "type"] };
const TREE = { screen: { width: 402, height: 874, scale: 3 }, elements: [EMAIL, SAVE] };

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

async function setup(handler: (req: IncomingRequest) => Reply) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { app, tools: new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } }) };
}

const handler = (req: IncomingRequest): Reply => {
  switch (req.method) {
    case "tree":
      return { ok: true, result: TREE };
    case "press":
      return { ok: true, result: { element: SAVE, settledMs: 50 } };
    case "type":
      return { ok: true, result: { element: { ...EMAIL, value: "a@b.co" }, value: "a@b.co", closedKeyboard: false } };
    case "waitFor":
      return { ok: true, result: { found: true } };
    default:
      return { ok: true, result: {} };
  }
};

describe("run", () => {
  it("runs the steps in order and answers once: Ran n of n, then the changes since the list before it", async () => {
    const { app, tools } = await setup(handler);
    const answer = await tools.run({
      steps: [
        { tool: "type_text", target: { id: "email" }, text: "a@b.co" },
        { tool: "tap", target: { id: "save" }, expect: { text: "Saved" } },
      ],
    });
    expect(answer.isError).toBeUndefined();
    expect(textOf(answer)).toMatch(/^Ran 2 of 2 steps in \d+\.\d s\.\n/);
    const methods = app.requests.map((r) => r.method).filter((m) => m !== "tree" && m !== "screenshot");
    expect(methods).toEqual(["type", "press", "waitFor"]);
    expect(app.requests.find((r) => r.method === "waitFor")?.params).toMatchObject({ text: "Saved" });
    // the batch is one call: no "N actions ago" note about its own steps
    expect(textOf(answer)).not.toContain("actions ago");
  });

  it("stops at the first failing step with that step's own code, and runs nothing after it", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "press" ? { ok: false, error: { code: "not_actionable", message: "covered: e3 button \"Save\" is covered by e9 sheet; close it first." } } : handler(req),
    );
    const answer = await tools.run({
      steps: [
        { tool: "type_text", target: { id: "email" }, text: "a@b.co" },
        { tool: "tap", target: { text: "Save" } },
        { tool: "back" },
      ],
    });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe(
      'Error not_actionable: Ran 1 of 3 steps; stopped at step 2 (tap "Save"): covered: e3 button "Save" is covered by e9 sheet; close it first.',
    );
    expect(app.requests.some((r) => r.method === "back")).toBe(false);
  });

  it("a failed expectation answers expect_failed, naming the step and what didn't happen", async () => {
    const { tools } = await setup((req) =>
      req.method === "waitFor" ? { ok: false, error: { code: "timeout", message: "text \"Saved\" didn't appear within 0.5 s" } } : handler(req),
    );
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, expect: { text: "Saved", timeout: 0.5 } }] });
    expect(answer.isError).toBe(true);
    expect(textOf(answer).split("\n")[0]).toBe(
      'Error expect_failed: Ran 0 of 1 steps; stopped at step 1 (tap id=save): text "Saved" didn\'t appear within 0.5 s',
    );
  });

  it("checks a value: a switch reads on or off, an input its text", async () => {
    let checked = false;
    const sw = { ref: "e5", type: "Switch", role: "switch", testID: "remind", label: "Remind me", text: "", checked: false, frame: { x: 330, y: 230, width: 63, height: 28 }, actions: ["toggle"] };
    const { tools } = await setup((req) => {
      if (req.method === "toggle") {
        checked = true;
        return { ok: true, result: { element: { ...sw, checked: true } } };
      }
      if (req.method === "tree") return { ok: true, result: { ...TREE, elements: [...TREE.elements, { ...sw, checked }] } };
      return handler(req);
    });
    const ok = await tools.run({ steps: [{ tool: "toggle", target: { id: "remind" }, expect: { id: "remind", value: "on" } }] });
    expect(ok.isError).toBeUndefined();
    // the list says checked=true: "true" works for a switch too (AGENT-TOOLS 1.8 §9.2)
    const asList = await tools.run({ steps: [{ tool: "wait_for", id: "remind", expect: { id: "remind", value: "true" } }] });
    expect(asList.isError).toBeUndefined();
    const no = await tools.run({ steps: [{ tool: "tap", target: { id: "save" }, expect: { id: "email", value: "x@y.z", timeout: 0.5 } }] });
    expect(textOf(no)).toContain('id "email" didn\'t have the value "x@y.z" within 0.5 s (it has "")');
  });

  it("refuses steps that read rather than act, and bad step parameters, before running anything", async () => {
    const { app, tools } = await setup(handler);
    const look = await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }, { tool: "look" }] });
    expect(textOf(look)).toMatch(/^Error bad_params: step 2: "look" can't be a step/);
    const bad = await tools.run({ steps: [{ tool: "tap" }] });
    expect(textOf(bad)).toMatch(/^Error bad_params: step 1 \(tap\): target/);
    expect(app.requests.some((r) => r.method === "press")).toBe(false);
  });

  it("labels each step's notes with the step", async () => {
    const { tools } = await setup((req) =>
      req.method === "press" ? { ok: true, result: { element: SAVE, closedKeyboard: true } } : handler(req),
    );
    const answer = await tools.run({ steps: [{ tool: "type_text", target: { id: "email" }, text: "a" }, { tool: "tap", target: { id: "save" } }] });
    expect(textOf(answer)).toContain("Note (step 2): closed the keyboard first.");
  });

  it("trace lists each step that ran", async () => {
    const { tools } = await setup(handler);
    const answer = await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }], trace: true });
    expect(textOf(answer)).toMatch(/\n {2}1\. Tapped e3 button "Save" id=save\. \(\d+\.\d s\)/);
  });
});

describe("run's wording", () => {
  it("names steps as the agent wrote them", () => {
    expect(describeRunStep({ tool: "tap", target: { text: "Save" } })).toBe('tap "Save"');
    expect(describeRunStep({ tool: "tap", target: { id: "save" } })).toBe("tap id=save");
    expect(describeRunStep({ tool: "type_text", target: { label: "Email" }, text: "x" })).toBe('type_text "Email"');
    expect(describeRunStep({ tool: "scroll", direction: "down" })).toBe("scroll down");
    expect(describeRunStep({ tool: "wait", seconds: 1 })).toBe("wait 1.0");
  });

  it("says what didn't happen", () => {
    expect(expectFailure({ text: "Saved" }, 2)).toBe('text "Saved" didn\'t appear within 2 s');
    expect(expectFailure({ id: "spinner", gone: true }, 2)).toBe('id "spinner" didn\'t go away within 2 s');
  });
});

describe("secure fields (AGENT-TOOLS 1.8 §3.3)", () => {
  it("typing into one answers that the value is hidden, without even the bullets", async () => {
    const { tools } = await setup((req) =>
      req.method === "type" ? { ok: true, result: { element: { ...EMAIL, label: "Password", value: "•••" }, value: "•••", secure: true } } : handler(req),
    );
    const said = textOf(await tools.typeText({ target: { id: "email" }, text: "abc", look: false }));
    expect(said).toContain("The value is hidden (secure field).");
    expect(said).not.toContain("Value is now");
  });
});

describe("record keeps the index of a shared label or text (AGENT-TOOLS 1.8 §9.4)", () => {
  it("a ref saved as text that two elements have gets the element's index among them", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "tapline-index-"));
    const first = { ref: "e1", type: "Pressable", role: "button", text: "Edit", frame: { x: 0, y: 100, width: 100, height: 40 }, actions: ["press"] };
    const second = { ...first, ref: "e2", frame: { x: 0, y: 200, width: 100, height: 40 } };
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, (req) => {
      if (req.method === "tree") return { ok: true, result: { ...TREE, elements: [first, second] } };
      if (req.method === "press") return { ok: true, result: { element: second } };
      return { ok: true, result: {} };
    });
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, scriptsDir: dir });
    try {
      await tools.record({ start: true, name: "second" });
      await tools.tap({ target: { ref: "e2" }, look: false });
      await tools.record({ stop: true });
      const script = JSON.parse(readFileSync(join(dir, "second.json"), "utf8")) as { steps: Array<Record<string, unknown>> };
      expect(script.steps[0]).toMatchObject({ tool: "tap", target: { text: "Edit", index: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
