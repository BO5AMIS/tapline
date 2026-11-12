import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { formatChanges, formatTree, networkLine } from "../src/format.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";
import type { PolicyFile } from "../src/policy.js";

// AGENT-TOOLS 1.11 §16.4: the `network` app command, and the header line while a condition is on.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const SCREEN = { width: 402, height: 874, scale: 3 };

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

/** A fake app that keeps the mode `network` was last set to and reports it in its tree, as the SDK does. */
async function setup(policy?: PolicyFile) {
  let mode = "normal";
  const handler = (req: IncomingRequest): Reply => {
    switch (req.method) {
      case "tree":
        return { ok: true, result: { screen: SCREEN, elements: [SAVE], ...(mode !== "normal" ? { network: { condition: mode } } : {}) } };
      case "command": {
        const params = req.params as { name?: string; args?: { mode?: string } };
        if (params.name === "network") {
          mode = params.args?.mode ?? "normal";
          const covers = "It covers the app's own fetch and XMLHttpRequest requests; WebSockets, images the native side loads and native SDKs are not affected.";
          return { ok: true, result: { name: "network", result: mode === "normal" ? { mode } : { mode, covers } }, };
        }
        return { ok: true, result: { name: params.name, result: null } };
      }
      default:
        return { ok: true, result: {} };
    }
  };
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { app, host, tools: new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, ...(policy !== undefined ? { policy } : {}) }) };
}

describe("network line", () => {
  it("is the spec's line", () => {
    expect(networkLine("3g")).toBe("Network: 3g (Tapline).");
  });

  it("is in the list header and the change header while a condition is on, beside the in-flight line", () => {
    const tree = { screen: SCREEN, elements: [], network: { condition: "lossy" as const, inFlight: 2 } };
    const lines = formatTree(tree).split("\n");
    expect(lines).toContain("Network: lossy (Tapline).");
    expect(lines).toContain("Network: 2 requests in flight");
    expect(lines.indexOf("Network: lossy (Tapline).")).toBeLessThan(lines.indexOf("Network: 2 requests in flight"));
    expect(formatTree({ screen: SCREEN, elements: [] })).not.toContain("Network:");
    const withChanges = { screen: SCREEN, elements: [{ ...SAVE }], network: { condition: "offline" as const } };
    const changes = formatChanges(
      { ...withChanges, changes: { sameRoute: true, added: [], removed: [], changed: [], moved: [] } },
      {},
    );
    expect(changes).toContain("Network: offline (Tapline).");
  });
});

describe("network app command", () => {
  it("answers the one line and what it covers, then every look carries the line until normal", async () => {
    const { app, tools } = await setup();
    const said = textOf(await tools.appCommand({ name: "network", args: { mode: "3g" } }));
    expect(app.requests[0]).toMatchObject({ method: "command", params: { name: "network", args: { mode: "3g" } } });
    expect(said.split("\n")[0]).toMatch(/^Network: 3g \(Tapline\)\. It covers the app's own fetch and XMLHttpRequest requests; /);
    expect(said).toContain("native SDKs are not affected");
    // the answer's own header (the screen after the command) already carries the line
    expect(said.split("\n").filter((line) => line === "Network: 3g (Tapline).")).toHaveLength(1);

    expect(textOf(await tools.look({ screenshot: false }))).toContain("Network: 3g (Tapline).");

    const back = textOf(await tools.appCommand({ name: "network", args: { mode: "normal" } }));
    expect(back.split("\n")[0]).toBe("Network: normal (Tapline).");
    expect(textOf(await tools.look({ screenshot: false }))).not.toContain("(Tapline).");
  });

  it("runs as a step in run", async () => {
    const { app, tools } = await setup();
    const answer = await tools.run({
      steps: [
        { tool: "app_command", name: "network", args: { mode: "offline" } },
        { tool: "app_command", name: "network", args: { mode: "normal" } },
      ],
      look: false,
    });
    expect(answer.isError).toBeUndefined();
    expect(textOf(answer)).toMatch(/^Ran 2 of 2 steps/);
    const commands = app.requests.filter((r) => r.method === "command").map((r) => r.params);
    expect(commands).toEqual([
      { name: "network", args: { mode: "offline" } },
      { name: "network", args: { mode: "normal" } },
    ]);
  });

  it("a run that ends with a condition on still shows the line in its final look", async () => {
    const { tools } = await setup();
    const answer = textOf(await tools.run({ steps: [{ tool: "app_command", name: "network", args: { mode: "lossy" } }] }));
    expect(answer).toContain("Network: lossy (Tapline).");
  });
});

describe("a policy that blocks network (AGENT-TOOLS 1.11 §16.4)", () => {
  it("refuses a condition, names where, and always lets normal through", async () => {
    const { tools } = await setup({ version: 1, confirm: [], block: ["Network"] });
    const refused = await tools.appCommand({ name: "network", args: { mode: "offline" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("Error not_allowed: blocked: the safety policy blocks network here.");
    const normal = await tools.appCommand({ name: "network", args: { mode: "normal" }, look: false });
    expect(normal.isError).not.toBe(true);
  });

  it("names the app when its own list blocks it", async () => {
    const probe = await setup();
    const name = probe.host.current()?.app.name ?? "";
    const { tools } = await setup({ version: 1, confirm: [], block: [], apps: { [name]: { block: ["network"] } } });
    expect(textOf(await tools.appCommand({ name: "network", args: { mode: "3g" } }))).toBe(`Error not_allowed: blocked: the safety policy blocks network for ${name}.`);
  });

  it("leaves other commands alone", async () => {
    const { tools } = await setup({ version: 1, confirm: [], block: ["network"] });
    expect((await tools.appCommand({ name: "appearance", args: { scheme: "dark" }, look: false })).isError).not.toBe(true);
  });
});
