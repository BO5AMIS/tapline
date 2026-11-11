import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpServer } from "../src/mcp.js";
import type { TaplineHost } from "../src/server.js";
import { CORE_INSTRUCTIONS, CORE_TOOL_TEXT, EXTRA_TOOL_TEXT, TAPLINE_ADDS } from "../src/tool-text-data.js";
import { INSTRUCTIONS, joinToolText, toolDescription } from "../src/tool-text.js";
import { TaplineTools, ambiguousBlock, describeError, toolShapes } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";
import { TaplineError } from "../src/server.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

async function setup(handler: (req: IncomingRequest) => Reply) {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" } });
  return { host, app, tools };
}

const BUTTON = {
  ref: "e3",
  type: "Pressable",
  role: "button",
  testID: "login-button",
  label: "Log in",
  text: "Log in",
  frame: { x: 24, y: 610, width: 354, height: 48 },
  actions: ["press"],
};
const TREE = { screen: { width: 402, height: 874, scale: 3 }, elements: [BUTTON] };

function candidate(ref: string, y: number) {
  return { ref, type: "Text", role: "text", text: "Nutrition", frame: { x: 76, y, width: 263, height: 23 }, actions: [] };
}

describe("ambiguous wording (AGENT-TOOLS §4)", () => {
  it("prints the exact block for two candidates", () => {
    const error = new TaplineError("ambiguous", '2 elements match text "Nutrition".', {
      candidates: [
        { ref: "e32", type: "Text", role: "text", text: "Nutrition", frame: { x: 76, y: 730, width: 263, height: 23 }, actions: [] },
        { ref: "e46", type: "Tab", role: "tab", text: "Nutrition", frame: null, actions: ["press"] },
      ],
    });
    expect(describeError(error)).toBe(
      [
        'Error ambiguous: 2 elements match text "Nutrition".',
        "Candidates:",
        '  e32 text "Nutrition" @76,730 263x23',
        '  e46 tab "Nutrition"',
        'Retry with one of the refs, or add "index" (0-based).',
      ].join("\n"),
    );
  });

  it("lists 5 candidates then a (+N more) line, with N from the message's count", async () => {
    const { tools } = await setup((req) =>
      req.method === "press"
        ? {
            ok: false,
            error: {
              code: "ambiguous",
              message: '8 elements match text "Nutrition".',
              candidates: [1, 2, 3, 4, 5].map((n) => candidate(`e${n}`, 100 * n)),
            },
          }
        : { ok: true, result: TREE },
    );
    const lines = textOf(await tools.tap({ target: { text: "Nutrition" } })).split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('Error ambiguous: 8 elements match text "Nutrition".');
    expect(lines[1]).toBe("Candidates:");
    expect(lines.slice(2, 7).every((l) => l.startsWith("  e"))).toBe(true);
    expect(lines[7]).toBe('  (+3 more; use a ref or "index")');
    expect(lines[8]).toBe('Retry with one of the refs, or add "index" (0-based).');
  });

  it("caps at 5 even when the app sends more candidates", () => {
    const error = new TaplineError("ambiguous", '7 elements match text "x".', {
      candidates: [1, 2, 3, 4, 5, 6, 7].map((n) => candidate(`e${n}`, n)),
    });
    const lines = describeError(error).split("\n");
    expect(lines.filter((l) => /^ {2}e\d/.test(l))).toHaveLength(5);
    expect(lines).toContain('  (+2 more; use a ref or "index")');
  });

  it("shows no more-line when all candidates fit", () => {
    expect(ambiguousBlock("x", ["a", "b"], 2)).not.toContain("more");
  });

  it("open_app uses the same block shape", async () => {
    const { host, tools } = await setup(() => ({ ok: true, result: TREE }));
    const { app } = await FakeApp.connect(host.boundPort() ?? 0, { device: { platform: "ios", name: "Second", id: "second" } });
    apps.push(app);
    const lines = textOf(tools.openApp({ app: "demo" })).split("\n");
    expect(lines[0]).toBe('Error ambiguous: 2 connected apps match "demo".');
    expect(lines[1]).toBe("Candidates:");
    expect(lines.slice(2, 4).every((l) => l.startsWith("  "))).toBe(true);
  });
});

describe("the cap note", () => {
  const withCap = (cap: unknown) => (req: IncomingRequest): Reply =>
    req.method === "press"
      ? { ok: true, result: { element: BUTTON, settledMs: 2000, ...(cap !== undefined ? { settleCapMs: cap } : {}) } }
      : req.method === "screenshot"
        ? { ok: false, error: { code: "unsupported", message: "no view-shot" } }
        : { ok: true, result: TREE };

  it("ends the answer with the cap note, after Settled in and other notes", async () => {
    const { tools } = await setup(withCap(2000));
    const lines = textOf(await tools.tap({ target: { id: "login-button" }, screenshot: true })).split("\n");
    expect(lines.at(-1)).toBe("Note: the screen was still changing after 2 s (an animation or video); positions may be mid-change.");
    const settled = lines.indexOf("Settled in 2.00 s.");
    expect(settled).toBeGreaterThan(0);
    expect(lines.slice(settled + 1).every((l) => l.startsWith("Note: "))).toBe(true);
  });

  it("writes the cap without trailing zeros", async () => {
    const { tools } = await setup(withCap(2500));
    expect(textOf(await tools.tap({ target: { id: "login-button" } }))).toContain("after 2.5 s (an animation");
  });

  it("adds nothing without a cap, or when it is 0 or not a number", async () => {
    for (const cap of [undefined, 0, "2000"]) {
      const { tools } = await setup(withCap(cap));
      expect(textOf(await tools.tap({ target: { id: "login-button" } }))).not.toContain("still changing");
    }
  });
});

describe("the change block is a literal diff, including the element acted on", () => {
  /** A field that keeps its value; the tree answers with what changed since it last served one. */
  function fieldApp() {
    let value = "egg";
    let served = "egg";
    const field = () => ({ ref: "e7", type: "TextInput", role: "input", testID: "item", value, frame: { x: 20, y: 100, width: 300, height: 40 }, actions: ["type"] });
    return (req: IncomingRequest): Reply => {
      if (req.method === "type") {
        value = String((req.params as { text: string }).text);
        return { ok: true, result: { element: field(), value, settledMs: 120 } };
      }
      if (req.method === "tree") {
        const wasValue = served;
        served = value;
        const changed = wasValue === value ? [] : [{ ref: "e7", was: { value: wasValue } }];
        return {
          ok: true,
          result: { screen: TREE.screen, elements: [field()], changes: { sameRoute: true, added: [], removed: [], changed, moved: [] } },
        };
      }
      return { ok: true, result: {} };
    };
  }

  it("typing eggs over egg shows ~ with the old value; typing it again shows No visible change", async () => {
    const { tools } = await setup(fieldApp());
    await tools.look({ screenshot: false });
    const first = textOf(await tools.typeText({ text: "eggs", target: { id: "item" } })).split("\n");
    expect(first[0]).toMatch(/^Typed into e7 input .*Value is now "eggs"\.$/);
    expect(first[1]).toBe("Same screen. Changes:");
    expect(first[2]).toMatch(/^~ e7 input .*value="eggs".* \(was "egg"\)$/);
    const second = textOf(await tools.typeText({ text: "eggs", target: { id: "item" } })).split("\n");
    expect(second[1]).toBe("Same screen. Changes:");
    expect(second[2]).toBe("No visible change.");
    expect(second.join("\n")).not.toContain("~ ");
  });
});

describe("shared tool text (TOOL-TEXT)", () => {
  async function listed() {
    const { tools } = await setup(() => ({ ok: true, result: TREE }));
    const server = createMcpServer(tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools: all } = await client.listTools();
    const instructions = client.getInstructions();
    await client.close();
    await server.close();
    return { all, instructions };
  }

  it("the joiner puts the Tapline line on its own line, and none for a tool without one", () => {
    expect(joinToolText("shared", "Tapline: x")).toBe("shared\nTapline: x");
    expect(joinToolText("shared")).toBe("shared");
  });

  it("instructions are the core block, a blank line, then the Tapline block", async () => {
    const { instructions } = await listed();
    expect(instructions).toBe(`${CORE_INSTRUCTIONS}\n\n${TAPLINE_ADDS}`);
    expect(INSTRUCTIONS).toBe(instructions);
    expect(instructions).toContain("Workflow\n- `apps` lists what you can drive.");
    expect(instructions).toContain("Tapline works inside one React Native app");
    expect(instructions).not.toContain("Tapwright");
  });

  it("look and tap descriptions equal the joined text", async () => {
    const { all } = await listed();
    const byName = new Map(all.map((t) => [t.name, t.description]));
    expect(byName.get("look")).toBe(joinToolText(CORE_TOOL_TEXT.look.shared, CORE_TOOL_TEXT.look.tapline));
    expect(byName.get("look")?.split("\n")[1]).toBe("Tapline: reads the app's React tree; the header may add `Route:` and `Network:`.");
    expect(byName.get("tap")).toBe(joinToolText(CORE_TOOL_TEXT.tap.shared, CORE_TOOL_TEXT.tap.tapline));
    expect(byName.get("tap")?.endsWith("\nTapline: calls the element's `onPress`.")).toBe(true);
  });

  it("wait has the shared paragraph only; extras get their paragraph; no tool mentions Tapwright", async () => {
    const { all } = await listed();
    const byName = new Map(all.map((t) => [t.name, t.description ?? ""]));
    expect("tapline" in CORE_TOOL_TEXT.wait).toBe(false);
    expect(byName.get("wait")).toBe(CORE_TOOL_TEXT.wait.shared);
    expect(byName.get("logs")).toBe(EXTRA_TOOL_TEXT.logs);
    expect(byName.get("pair")).toBe(EXTRA_TOOL_TEXT.pair);
    for (const description of byName.values()) expect(description).not.toContain("Tapwright");
  });

  it("every registered tool uses the shared text", async () => {
    const { all } = await listed();
    for (const tool of all) expect(tool.description).toBe(toolDescription(tool.name as Parameters<typeof toolDescription>[0]));
  });
});

describe("parameter schemas match the shared text", () => {
  it("look's width is 160 to 1320 and its description says so with the default", () => {
    const look = z.object(toolShapes.look);
    expect(look.safeParse({ width: 160 }).success).toBe(true);
    expect(look.safeParse({ width: 1320 }).success).toBe(true);
    expect(look.safeParse({ width: 159 }).success).toBe(false);
    expect(look.safeParse({ width: 1321 }).success).toBe(false);
    expect(toolShapes.look.width.description).toContain("160 to 1320");
    expect(toolShapes.look.width.description).toContain("default 600");
    expect(toolShapes.look.screenshot.description).toContain("default true");
  });

  it("action tools' screenshot defaults to false", () => {
    expect(toolShapes.tap.screenshot.description).toContain("default false");
  });
});
