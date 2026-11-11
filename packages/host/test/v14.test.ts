import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, until, type IncomingRequest, type Reply } from "./helpers.js";

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
  testID: "login-button",
  label: "Log in",
  text: "Log in",
  frame: { x: 24, y: 610, width: 354, height: 48 },
  actions: ["press"],
};
const TREE = { screen: { width: 402, height: 874, scale: 3 }, elements: [BUTTON] };

async function setup(handler: (req: IncomingRequest) => Reply, options: Parameters<typeof startHost>[0] = {}) {
  const { host, port } = await startHost(options);
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const tools = new TaplineTools(host, {
    connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
    reloadWaitMs: 300,
    reloadSettleMs: 10,
  });
  return { host, app, tools, port };
}

/** An app whose actions answer with `result` (merged over the button), and whose tree is TREE. */
function answering(extra: Record<string, unknown>): (req: IncomingRequest) => Reply {
  return (req) => {
    if (["press", "longPress", "toggle", "type"].includes(req.method)) {
      return { ok: true, result: { element: BUTTON, value: "x", settledMs: 120, ...extra } };
    }
    return { ok: true, result: TREE };
  };
}

const NOTE = "Note: closed the keyboard first.";

describe("Note: closed the keyboard first. (v1.4)", () => {
  it("ends the answer of tap, long_press, toggle and type_text when the app says it closed the keyboard", async () => {
    const { tools } = await setup(answering({ closedKeyboard: true }));
    const answers = [
      await tools.tap({ target: { id: "login-button" } }),
      await tools.longPress({ target: { id: "login-button" } }),
      await tools.toggle({ target: { id: "login-button" } }),
      await tools.typeText({ target: { id: "login-button" }, text: "x" }),
    ].map(textOf);
    for (const answer of answers) {
      const lines = answer.split("\n");
      expect(lines.at(-1)).toBe(NOTE);
      expect(lines.filter((l) => l === NOTE)).toHaveLength(1);
    }
  });

  it("with look: false it is the line right after the first line", async () => {
    const { tools } = await setup(answering({ closedKeyboard: true }));
    expect(textOf(await tools.tap({ target: { id: "login-button" }, look: false }))).toBe(
      `Tapped e3 button "Log in" id=login-button.\n${NOTE}`,
    );
  });

  it("comes after the other notes", async () => {
    const { tools } = await setup(answering({ closedKeyboard: true, settleCapMs: 2000 }));
    const lines = textOf(await tools.tap({ target: { id: "login-button" } })).split("\n");
    expect(lines.at(-1)).toBe(NOTE);
    expect(lines.at(-2)).toMatch(/^Note: the screen was still changing after 2 s/);
    const plain = textOf(await tools.tap({ target: { id: "login-button" }, look: false }));
    const plainLines = plain.split("\n");
    expect(plainLines).toHaveLength(3);
    expect(plainLines[1]).toMatch(/^Note: the screen was still changing/);
    expect(plainLines[2]).toBe(NOTE);
  });

  it("is absent when the field is missing, false or not true", async () => {
    for (const extra of [{}, { closedKeyboard: false }, { closedKeyboard: "true" }, { closedKeyboard: 1 }, { closedKeyboard: null }]) {
      const { tools } = await setup(answering(extra));
      expect(textOf(await tools.tap({ target: { id: "login-button" } }))).not.toContain("closed the keyboard");
    }
  });

  it("is not added to other tools", async () => {
    const { tools } = await setup((req) =>
      req.method === "scroll" ? { ok: true, result: { element: BUTTON, closedKeyboard: true } } : { ok: true, result: TREE },
    );
    expect(textOf(await tools.scroll({ direction: "down" }))).not.toContain("closed the keyboard");
  });
});

describe("back closing a sheet (v1.4)", () => {
  const backApp = (result: Record<string, unknown>) => (req: IncomingRequest): Reply =>
    req.method === "back" ? { ok: true, result: { settledMs: 200, ...result } } : { ok: true, result: TREE };

  it('starts with "Closed the sheet." when the app says closed: "sheet"', async () => {
    const { tools } = await setup(backApp({ closed: "sheet", route: ["Home", "Profile"] }));
    const lines = textOf(await tools.back({})).split("\n");
    expect(lines[0]).toBe("Closed the sheet.");
    expect(lines).toContain("Settled in 0.20 s.");
    expect(lines.some((l) => l.includes("e3 button"))).toBe(true);
  });

  it("keeps the usual first line without it, or with another value", async () => {
    for (const extra of [{}, { closed: "modal" }, { closed: true }]) {
      const { tools } = await setup(backApp({ route: ["Home", "Profile"], ...extra }));
      expect(textOf(await tools.back({})).split("\n")[0]).toBe("Went back from Home › Profile.");
    }
  });

  it("with look: false it is only that line", async () => {
    const { tools } = await setup(backApp({ closed: "sheet" }));
    expect(textOf(await tools.back({ look: false }))).toBe("Closed the sheet.");
  });
});

describe("not_answering (v1.4)", () => {
  it("a tool call to a connected app that doesn't answer says so and what to do", async () => {
    const { tools } = await setup(() => "ignore", { requestTimeoutMs: 80 });
    const result = await tools.tap({ target: { id: "login-button" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Error not_answering: Demo is connected but did not answer "press" within 0.1 s. Try once more; if it repeats, ask the user to close the app and open it again.',
    );
  });

  it("wait_for's own timeout from the app keeps the code timeout", async () => {
    const { tools } = await setup(
      (req) =>
        req.method === "waitFor"
          ? { ok: false, error: { code: "timeout", message: 'Waited 5 s for text "Saved" to appear; it didn\'t happen.' } }
          : { ok: true, result: TREE },
      { requestTimeoutMs: 80 },
    );
    expect(textOf(await tools.waitFor({ text: "Saved", timeout: 5 }))).toMatch(/^Error timeout: Waited 5 s/);
  });

  it("after the silence sweep dropped the app, calls answer not_answering with the time, until an app connects", async () => {
    const { host, app, tools, port } = await setup(() => "ignore", { silenceTimeoutMs: 200, sweepIntervalMs: 30 });
    await until(() => host.sessions().length === 0);
    const result = await tools.tap({ target: { id: "login-button" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^Error not_answering: Demo stopped answering at \d\d:\d\d:\d\d \(nothing from it for \d+ s while connected\)\. Ask the user to close the app and open it again; it reconnects by itself then\.$/,
    );
    // The other tools that need an app say the same.
    expect(textOf(await tools.look({}))).toMatch(/^Error not_answering: Demo stopped answering at /);
    expect(textOf(tools.apps())).toContain("Demo stopped answering at ");
    // The host closed the socket; the client's side sees that a moment later.
    await until(() => app.ws.readyState !== app.ws.OPEN);
    // A later connection clears it.
    const next = await FakeApp.connect(port, {}, answering({}));
    apps.push(next.app);
    expect(textOf(await tools.tap({ target: { id: "login-button" } }))).toContain("Tapped e3 button");
  });

  it("a drop that wasn't silence keeps the old not_connected text", async () => {
    const { host, app, tools } = await setup(answering({}));
    app.ws.close();
    await until(() => host.sessions().length === 0);
    expect(textOf(await tools.tap({ target: { id: "login-button" } }))).toMatch(/^Error not_connected: No app is connected to Tapline\./);
  });

  it("reload counts a silent drop as the reload having worked", async () => {
    const { tools } = await setup(
      (req) => (req.method === "reload" ? "ignore" : { ok: true, result: TREE }),
      { silenceTimeoutMs: 200, sweepIntervalMs: 30 },
    );
    const result = await tools.reload({});
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toMatch(/^Reload requested/);
  });
});
