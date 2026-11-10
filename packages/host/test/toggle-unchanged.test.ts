import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// `toggle` with a `value` the switch already has: the app does nothing and says so, and the answer
// is one line with no change block (the same words as Tapwright's).

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const SWITCH = {
  ref: "e16",
  type: "Switch",
  role: "switch",
  testID: "lab-switch",
  label: "Switch",
  text: "",
  checked: true,
  frame: { x: 351, y: 629, width: 63, height: 28 },
  actions: ["toggle"],
};
const TREE = { screen: { width: 430, height: 932, scale: 3 }, elements: [SWITCH] };

async function setup(handler: (req: IncomingRequest) => Reply) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
  return { app, tools };
}

describe("toggle to the value the switch already has", () => {
  it("answers one line, `<element> is already true.`, and asks for no list", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "toggle"
        ? { ok: true, result: { element: SWITCH, value: true, unchanged: true, settledMs: 0 } }
        : { ok: true, result: TREE },
    );
    const answer = textOf(await tools.toggle({ target: { id: "lab-switch" }, value: true }));
    expect(answer).toBe('e16 switch "Switch" id=lab-switch checked=true @351,629 63x28 is already true.');
    expect(app.requests.filter((r) => r.method === "tree")).toHaveLength(0);
  });

  it("says false for a switch that is already off", async () => {
    const off = { ...SWITCH, checked: false };
    const { tools } = await setup((req) =>
      req.method === "toggle"
        ? { ok: true, result: { element: off, value: false, unchanged: true, settledMs: 0 } }
        : { ok: true, result: TREE },
    );
    const answer = textOf(await tools.toggle({ target: { id: "lab-switch" }, value: false }));
    expect(answer).toBe('e16 switch "Switch" id=lab-switch checked=false @351,629 63x28 is already false.');
  });

  it("a real toggle still answers `Toggled … to …` with what changed", async () => {
    const { tools } = await setup((req) =>
      req.method === "toggle" ? { ok: true, result: { element: SWITCH, value: true, settledMs: 120 } } : { ok: true, result: TREE },
    );
    const lines = textOf(await tools.toggle({ target: { id: "lab-switch" }, value: true })).split("\n");
    expect(lines[0]).toBe('Toggled e16 switch "Switch" id=lab-switch checked=true @351,629 63x28 to true.');
    expect(lines).toContain("Settled in 0.12 s.");
  });
});
