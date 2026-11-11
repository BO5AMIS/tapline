import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const SHEET = { ref: "e5", type: "View", role: null, testID: "lab-sheet2", text: "Backdrop sheet", frame: { x: 0, y: 690, width: 430, height: 242 }, actions: [] };
const TREE = { screen: { width: 430, height: 932, scale: 3 }, elements: [SHEET] };

async function setup(reply: (req: IncomingRequest) => Reply, scriptsDir?: string) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, (req) => (req.method === "tree" ? { ok: true, result: TREE } : reply(req)));
  apps.push(app);
  return { tools: new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, ...(scriptsDir ? { scriptsDir } : {}) }), app };
}

describe("swipe", () => {
  it("sends the points and seconds, and names what took the drag", async () => {
    const { tools, app } = await setup(() => ({ ok: true, result: { element: SHEET, from: { x: 215, y: 720 }, to: { x: 215, y: 900 }, settledMs: 120 } }));
    const answer = textOf(await tools.swipe({ x0: 215, y0: 720, x1: 215, y1: 900, seconds: 0.3, look: false }));
    expect(answer.split("\n")[0]).toBe('Swiped from (215, 720) to (215, 900) on e5 other "Backdrop sheet" id=lab-sheet2 @0,690 430x242.');
    expect(app.requests.find((r) => r.method === "swipe")?.params).toEqual({ x0: 215, y0: 720, x1: 215, y1: 900, seconds: 0.3 });
  });

  it("without an element to name, says only where", async () => {
    const { tools } = await setup(() => ({ ok: true, result: { element: null, settledMs: 50 } }));
    expect(textOf(await tools.swipe({ x0: 10, y0: 10, x1: 300, y1: 10, look: false })).split("\n")[0]).toBe("Swiped from (10, 10) to (300, 10).");
  });

  it("passes the app's refusal through", async () => {
    const { tools } = await setup(() => ({ ok: false, error: { code: "not_actionable", message: "no_action: Nothing took the swipe from (10, 10)" } }));
    expect(textOf(await tools.swipe({ x0: 10, y0: 10, x1: 300, y1: 10 }))).toMatch(/^Error not_actionable: no_action: Nothing took the swipe/);
  });
});

describe("swipe in a recording", () => {
  it("is recorded with its points and replayed as a step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-swipe-"));
    const { tools, app } = await setup(() => ({ ok: true, result: { element: SHEET, settledMs: 50 } }), dir);
    await tools.record({ action: "start", name: "swipe-close" });
    await tools.swipe({ x0: 215, y0: 720, x1: 215, y1: 900, look: false });
    const stopped = textOf(await tools.record({ action: "stop" }));
    expect(stopped).toContain("1 step");
    expect(app.requests.filter((r) => r.method === "swipe")).toHaveLength(1);
    const replayed = textOf(await tools.replay({ name: "swipe-close" }));
    expect(replayed).toContain("swipe 215,720 → 215,900");
    expect(app.requests.filter((r) => r.method === "swipe")).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
