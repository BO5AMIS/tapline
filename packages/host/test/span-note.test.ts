import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// A change block is measured from the agent's last list. After actions answered with `look: false`
// it covers those too, so the answer says how far back the list is (a first-time agent closed a
// sheet it had opened with look: false and read "No visible change." as "the tap did nothing").

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const BUTTON = {
  ref: "e3",
  type: "Pressable",
  role: "button",
  testID: "open-sheet",
  label: "Open sheet",
  text: "Open sheet",
  frame: { x: 24, y: 610, width: 354, height: 48 },
  actions: ["press"],
};
const TREE = { screen: { width: 402, height: 874, scale: 3 }, elements: [BUTTON] };
const SAME = { ...TREE, changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } };
const OTHER_ROUTE = { ...TREE, changes: { sameRoute: false, added: [], removed: [], changed: [], moved: [] } };

async function setup(treeAfter: (req: IncomingRequest) => unknown = () => SAME) {
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply => {
    if (req.method === "press") return { ok: true, result: { element: BUTTON, settledMs: 100 } };
    const params = req.params as { changes?: boolean } | undefined;
    return { ok: true, result: params?.changes === true ? treeAfter(req) : TREE };
  };
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
  return { tools };
}

const NOTE = /^Note: changes are since your last list, (\d+) actions ago\.$/;
const noteOf = (answer: string): string | undefined => answer.split("\n").find((line) => NOTE.test(line));

describe("Note: changes are since your last list", () => {
  it("is absent when every action answered with its changes", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    expect(noteOf(textOf(await tools.tap({ target: { id: "open-sheet" } })))).toBeUndefined();
    expect(noteOf(textOf(await tools.tap({ target: { id: "open-sheet" } })))).toBeUndefined();
  });

  it("follows one action with look: false, counting that action and this one", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "open-sheet" }, look: false });
    const lines = textOf(await tools.tap({ target: { id: "open-sheet" } })).split("\n");
    expect(lines).toContain("No visible change.");
    expect(lines.at(-1)).toBe("Note: changes are since your last list, 2 actions ago.");
    // Said once: the next answer is measured from this one.
    expect(noteOf(textOf(await tools.tap({ target: { id: "open-sheet" } })))).toBeUndefined();
  });

  it("counts every action since the list", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "open-sheet" }, look: false });
    await tools.tap({ target: { id: "open-sheet" }, look: false });
    await tools.tap({ target: { id: "open-sheet" }, look: false });
    expect(noteOf(textOf(await tools.tap({ target: { id: "open-sheet" } })))).toBe(
      "Note: changes are since your last list, 4 actions ago.",
    );
  });

  it("a look in between starts over", async () => {
    const { tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "open-sheet" }, look: false });
    await tools.look({ screenshot: false });
    expect(noteOf(textOf(await tools.tap({ target: { id: "open-sheet" } })))).toBeUndefined();
  });

  it("is left out when the answer carries the full list", async () => {
    const { tools } = await setup(() => OTHER_ROUTE);
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "open-sheet" }, look: false });
    const answer = textOf(await tools.tap({ target: { id: "open-sheet" } }));
    expect(answer).toContain("Screen 402x874 pt @3x · 1 element");
    expect(noteOf(answer)).toBeUndefined();
  });
});
