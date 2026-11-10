import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// `scroll` with `to: "target"` (AGENT-TOOLS v1.6): what the host sends and how it words the answer.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const LIST = { ref: "e1", type: "ScrollView", role: null, testID: "lab-scroll", text: "", frame: { x: 0, y: 0, width: 430, height: 932 }, actions: ["scroll"] };
const RESET = {
  ref: "e20",
  type: "Pressable",
  role: "button",
  testID: "lab-reset",
  label: "Reset",
  text: "Reset",
  frame: { x: 16, y: 103, width: 398, height: 48 },
  actions: ["press"],
};
const TREE = { screen: { width: 430, height: 932, scale: 3 }, elements: [LIST, RESET] };

async function setup(result: Record<string, unknown>) {
  const { host, port } = await startHost();
  hosts.push(host);
  const handler = (req: IncomingRequest): Reply =>
    req.method === "scroll" ? { ok: true, result: { settledMs: 110, ...result } } : { ok: true, result: TREE };
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
  return { app, tools };
}

describe('scroll with to: "target"', () => {
  it("sends the target and `to`, and names the scroll view and the element in its first line", async () => {
    const { app, tools } = await setup({ element: LIST, target: RESET, offset: { x: 0, y: 1070 }, moved: true, reached: true });
    const lines = textOf(await tools.scroll({ to: "target", target: { id: "lab-reset" } })).split("\n");
    expect(lines[0]).toBe(
      'Scrolled e1 scroll id=lab-scroll @0,0 430x932 to e20 button "Reset" id=lab-reset @16,103 398x48. Offset now {"x":0,"y":1070}.',
    );
    expect(lines.some((line) => line.startsWith("Note: the scroll view"))).toBe(false);
    const sent = app.requests.find((r) => r.method === "scroll");
    expect(sent?.params).toEqual({ to: "target", target: { testID: "lab-reset" } });
  });

  it("an element that is clear already: the first line says so, and the list follows as after any action", async () => {
    const { tools } = await setup({ element: RESET, target: RESET, offset: { x: 0, y: 0 }, moved: false, reached: true, unchanged: true });
    const lines = textOf(await tools.scroll({ to: "target", target: { id: "lab-reset" } })).split("\n");
    expect(lines[0]).toBe('e20 button "Reset" id=lab-reset @16,103 398x48 is already on screen.');
    expect(lines[1]).toBe("Screen 430x932 pt @3x · 2 elements");
    expect(lines.some((line) => line.startsWith("Note:"))).toBe(false);
  });

  it("says when the scroll view can't bring it clear", async () => {
    const { tools } = await setup({ element: LIST, target: RESET, offset: { x: 0, y: 0 }, moved: false, reached: false });
    const lines = textOf(await tools.scroll({ to: "target", target: { id: "lab-reset" } })).split("\n");
    expect(lines.at(-1)).toBe("Note: it doesn't scroll further: the target is as far into view as it gets.");
    expect(lines.some((line) => line.includes("already at the"))).toBe(false);
  });

  it("without a target it is bad_params, and nothing is sent", async () => {
    const { app, tools } = await setup({});
    const answer = textOf(await tools.scroll({ to: "target" }));
    expect(answer).toBe('Error bad_params: to: "target" needs a target: the element to bring onto the screen.');
    expect(app.requests.filter((r) => r.method === "scroll")).toHaveLength(0);
  });

  it("start and end read as before", async () => {
    const { tools } = await setup({ element: LIST, offset: { x: 0, y: 0 }, moved: true });
    expect(textOf(await tools.scroll({ to: "start" })).split("\n")[0]).toBe(
      'Scrolled e1 scroll id=lab-scroll @0,0 430x932 to start. Offset now {"x":0,"y":0}.',
    );
  });
});
