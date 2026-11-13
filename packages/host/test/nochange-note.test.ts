import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, type ToolsOptions } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §3, "A tap that changes nothing": after `No visible change.` the host watches at least
// 0.5 s, reads the changes once more, and adds one note with one clause.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

const SAVE = { ref: "e1", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 20, y: 40, width: 200, height: 44 }, actions: ["press"] };
const CARD = { ref: "e5", type: "Pressable", role: "button", text: "Card", frame: { x: 0, y: 100, width: 400, height: 80 }, actions: ["press"] };
const NEW_TEXT = { ref: "e9", type: "Text", role: "text", text: "Saved", frame: { x: 20, y: 300, width: 100, height: 20 }, actions: [] };
const SCREEN = { width: 430, height: 932, scale: 3 };
const SAME = { sameRoute: true, added: [] as string[], removed: [] as unknown[], changed: [] as unknown[], moved: [] as string[] };

function wantsChanges(req: IncomingRequest): boolean {
  return typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
}

interface Setup {
  /** What press and longPress answer. */
  pressed?: Record<string, unknown>;
  /** The tree answers, by the number of the tree call that wants changes (0 is the first one after the action). */
  tree?: (n: number) => Record<string, unknown>;
  capabilities?: string[];
  /** Makes the tree call that wants changes fail (by its number). */
  treeFails?: (n: number) => boolean;
  options?: Partial<ToolsOptions>;
}

async function setup(config: Setup = {}) {
  const { host, port } = await startHost();
  hosts.push(host);
  let wanted = 0;
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "tree") {
      if (!wantsChanges(req)) return { ok: true, result: { screen: SCREEN, elements: [SAVE] } };
      if (config.treeFails?.(wanted) === true) {
        wanted++;
        return { ok: false, error: { code: "internal", message: "the app broke" } };
      }
      const n = wanted++;
      const extra = config.tree?.(n) ?? {};
      return { ok: true, result: { screen: SCREEN, elements: [SAVE], changes: SAME, ...extra } };
    }
    if (req.method === "screenshot") return { ok: true, result: { mime: "image/jpeg", data: "AAAA", width: 10, height: 10 } };
    return { ok: true, result: { element: SAVE, settledMs: 120, ...(config.pressed ?? {}) } };
  };
  const hello = { capabilities: config.capabilities ?? ["tree", "press", "longPress", "logs", "dryRun", "pressFacts"] };
  const { app } = await FakeApp.connect(port, hello, handler);
  apps.push(app);
  // A clock the test moves by the sleeps the host asks for.
  const state = { now: 1_000_000, slept: [] as number[] };
  const options: Partial<ToolsOptions> = {
    clock: () => state.now,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
    },
    ...config.options,
  };
  const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, ...options });
  await tools.look({ screenshot: false });
  return { tools, app, state };
}

const NOTE = /^Note: the tap was delivered, and nothing on screen changed within (\d+\.\d) s\./m;

describe("a tap that changes nothing", () => {
  it("watches 0.5 s, then notes it with the clause", async () => {
    const { tools, state } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const answer = textOf(await tools.tap({ target: { id: "save" } }));
    expect(answer).toContain("No visible change.");
    const match = NOTE.exec(answer);
    expect(match).not.toBeNull();
    // At least 0.5 s, one decimal.
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(0.5);
    expect(match?.[1]).toMatch(/^\d+\.\d$/);
    expect(answer).toContain("Its onPress ran and returned.");
    // The host slept up to the 0.5 s floor, counted from the touch (the app settled for 0.12 s of it).
    expect(state.slept).toHaveLength(1);
    expect(state.slept[0]).toBeGreaterThan(0);
    expect(state.slept[0]).toBeLessThanOrEqual(500);
  });

  it("the note sits on one line with its clause, after the Settled line", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const rows = textOf(await tools.tap({ target: { id: "save" } })).split("\n");
    const at = rows.findIndex((row) => row.startsWith("Note: the tap was delivered"));
    expect(at).toBeGreaterThan(rows.findIndex((row) => row.startsWith("Settled in")));
    expect(rows[at]).toMatch(/ Its onPress ran and returned\.$/);
  });

  it("a change after 0.3 s gives the change block and no note", async () => {
    const { tools } = await setup({
      pressed: { handler: { kind: "own" }, startedRequests: 0 },
      tree: (n) => (n === 0 ? {} : { elements: [SAVE, NEW_TEXT], changes: { ...SAME, added: ["e9"] } }),
    });
    const answer = textOf(await tools.tap({ target: { id: "save" } }));
    expect(answer).toContain('+ e9 text "Saved"');
    expect(answer).not.toContain("No visible change.");
    expect(answer).not.toContain("the tap was delivered");
  });

  it("a threw clause carries the message and points at the logs", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own", threw: "nothing to save" }, startedRequests: 0 } });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain("Its onPress threw: nothing to save (see logs).");
  });

  it("the message is cut to 120 characters and loses control characters", async () => {
    const message = `bad\u0007 ${"x".repeat(200)}`;
    const { tools } = await setup({ pressed: { handler: { kind: "own", threw: message }, startedRequests: 0 } });
    const answer = textOf(await tools.tap({ target: { id: "save" } }));
    expect(answer).not.toContain("\u0007");
    const said = /threw: (.*) \(see logs\)\./.exec(answer)?.[1] ?? "";
    expect(said.length).toBeLessThanOrEqual(120);
    expect(said.startsWith("bad xxx")).toBe(true);
  });

  it("a parent clause names the parent", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "parent", element: CARD }, startedRequests: 0 } });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain('It has no handler of its own; e5 button "Card" took it.');
  });

  it("a request clause: a request began and is still running", async () => {
    const { tools } = await setup({
      pressed: { handler: { kind: "own" }, startedRequests: 1 },
      tree: () => ({ network: { inFlight: 1 } }),
    });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain("It started a request that is still running: wait_for network_idle.");
  });

  it("a request that already finished is not named: ran and returned", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 1 } });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain("Its onPress ran and returned.");
  });

  it("the order: threw wins over parent wins over request wins over ran", async () => {
    const network = { network: { inFlight: 1 } };
    const all = await setup({ pressed: { handler: { kind: "parent", element: CARD, threw: "boom" }, startedRequests: 2 }, tree: () => network });
    const first = textOf(await all.tools.tap({ target: { id: "save" } }));
    expect(first).toContain("Its onPress threw: boom (see logs).");
    expect(first).not.toContain("took it");
    expect(first).not.toContain("still running");
    const parent = await setup({ pressed: { handler: { kind: "parent", element: CARD }, startedRequests: 2 }, tree: () => network });
    const second = textOf(await parent.tools.tap({ target: { id: "save" } }));
    expect(second).toContain("took it.");
    expect(second).not.toContain("still running");
    const request = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 2 }, tree: () => network });
    const third = textOf(await request.tools.tap({ target: { id: "save" } }));
    expect(third).toContain("still running");
    expect(third).not.toContain("ran and returned");
  });

  it("long_press says the long press was delivered and names onLongPress", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const answer = textOf(await tools.longPress({ target: { id: "save" } }));
    expect(answer).toMatch(/^Note: the long press was delivered, and nothing on screen changed within \d+\.\d s\. Its onLongPress ran and returned\./m);
  });

  it("an app without the capability gets the note and no handler clause", async () => {
    const { tools } = await setup({ capabilities: ["tree", "press", "logs", "dryRun"], pressed: { handler: { kind: "own", threw: "x" } } });
    const answer = textOf(await tools.tap({ target: { id: "save" } }));
    expect(answer).toMatch(NOTE);
    expect(answer).not.toContain("Its onPress");
  });

  it("an app without the capability still names a request that is running (from the Network: line)", async () => {
    const { tools } = await setup({ capabilities: ["tree", "press", "logs", "dryRun"], tree: () => ({ network: { inFlight: 2 } }) });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain("A request is still running: wait_for network_idle.");
  });

  it("no note with look:false", async () => {
    const { tools, state } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const answer = textOf(await tools.tap({ target: { id: "save" }, look: false }));
    expect(answer).not.toContain("the tap was delivered");
    expect(state.slept).toHaveLength(0);
  });

  it("no note in run steps", async () => {
    const { tools, state } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const answer = textOf(await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }] }));
    expect(answer).not.toContain("the tap was delivered");
    expect(state.slept).toHaveLength(0);
  });

  it("no note in a dry run", async () => {
    const { tools, state } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const answer = textOf(await tools.tap({ target: { id: "save" }, dry_run: true }));
    expect(answer).not.toContain("the tap was delivered");
    expect(state.slept).toHaveLength(0);
  });

  it("the note survives brief", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    const answer = textOf(await tools.tap({ target: { id: "save" }, brief: true }));
    expect(answer).toMatch(NOTE);
    expect(answer).toContain("Its onPress ran and returned.");
    expect(answer).not.toContain("Settled in");
  });

  it("a second look that fails gives that error, not a note about a quiet screen", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 }, treeFails: (n) => n === 1 });
    const answer = await tools.tap({ target: { id: "save" } });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("the app broke");
    expect(textOf(answer)).not.toContain("the tap was delivered");
  });

  it("a screen that changes on the first look causes no wait", async () => {
    const { tools, state } = await setup({
      pressed: { handler: { kind: "own" }, startedRequests: 0 },
      tree: () => ({ elements: [SAVE, NEW_TEXT], changes: { ...SAME, added: ["e9"] } }),
    });
    expect(textOf(await tools.tap({ target: { id: "save" } }))).toContain('+ e9 text "Saved"');
    expect(state.slept).toEqual([]);
  });

  it("a screenshot on a no-change tap is taken once, on the final look", async () => {
    const { tools, app } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0 } });
    await tools.tap({ target: { id: "save" }, screenshot: true });
    expect(app.requests.filter((r) => r.method === "screenshot")).toHaveLength(1);
  });

  it("a screenshot on a tap that changed the screen is taken once too", async () => {
    const { tools, app } = await setup({
      pressed: { handler: { kind: "own" }, startedRequests: 0 },
      tree: () => ({ elements: [SAVE, NEW_TEXT], changes: { ...SAME, added: ["e9"] } }),
    });
    const answer = await tools.tap({ target: { id: "save" }, screenshot: true });
    expect(app.requests.filter((r) => r.method === "screenshot")).toHaveLength(1);
    expect(answer.content.some((block) => block.type === "image")).toBe(true);
  });

  it("a handler that threw is said in every answer: changed screen, look:false, once when nothing changed", async () => {
    const pressed = { handler: { kind: "own", threw: "nothing to save" }, startedRequests: 0 };
    const changed = await setup({ pressed, tree: () => ({ elements: [SAVE, NEW_TEXT], changes: { ...SAME, added: ["e9"] } }) });
    expect(textOf(await changed.tools.tap({ target: { id: "save" } }))).toContain("Note: its onPress threw: nothing to save (see logs).");
    const quiet = await setup({ pressed });
    const noLook = textOf(await quiet.tools.tap({ target: { id: "save" }, look: false }));
    expect(noLook).toContain("Note: its onPress threw: nothing to save (see logs).");
    const same = textOf(await quiet.tools.tap({ target: { id: "save" } }));
    expect(same.split("threw: nothing to save")).toHaveLength(2);
    expect(same).toContain("Its onPress threw: nothing to save (see logs).");
    const long = await setup({ pressed });
    expect(textOf(await long.tools.longPress({ target: { id: "save" }, look: false }))).toContain("Note: its onLongPress threw: nothing to save (see logs).");
  });

  it("a step of run whose handler threw stops the batch as internal, with the text in the trace", async () => {
    const { tools } = await setup({ pressed: { handler: { kind: "own", threw: "nothing to save" }, startedRequests: 0 } });
    const answer = textOf(await tools.run({ steps: [{ tool: "tap", target: { id: "save" } }, { tool: "tap", target: { id: "save" } }], trace: true }));
    expect(answer).toMatch(/^Error internal: Ran 0 of 2 steps; stopped at step 1 .*its onPress threw: nothing to save \(see logs\)\./);
  });

  it("a tap that already took 0.6 s is not delayed: N is what was watched", async () => {
    const { tools, state } = await setup({ pressed: { handler: { kind: "own" }, startedRequests: 0, settledMs: 600 } });
    const answer = textOf(await tools.tap({ target: { id: "save" } }));
    expect(state.slept).toHaveLength(0);
    expect(Number(NOTE.exec(answer)?.[1])).toBeGreaterThanOrEqual(0.6);
  });
});
