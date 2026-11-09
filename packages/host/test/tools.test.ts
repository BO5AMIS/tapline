import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools, targetSchema } from "../src/tools.js";
import { FakeApp, TOKEN, startHost, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const TREE = {
  screen: { width: 402, height: 874, scale: 3 },
  elements: [
    {
      ref: "e3",
      type: "Pressable",
      role: "button",
      testID: "login-button",
      label: "Log in",
      text: "Log in",
      frame: { x: 24, y: 610, width: 354, height: 48 },
      actions: ["press", "longPress"],
    },
  ],
};
const SHOT = { mime: "image/jpeg", data: "QUJD", width: 600, height: 1305 };

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `<${block.type}>`))
    .join("\n");
}

function setup(handler: (req: IncomingRequest) => Reply) {
  return async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, handler);
    apps.push(app);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      settleMs: 0,
    });
    return { host, app, tools };
  };
}

const defaultHandler = (req: IncomingRequest): Reply => {
  switch (req.method) {
    case "tree":
      return { ok: true, result: TREE };
    case "screenshot":
      return { ok: true, result: SHOT };
    case "press":
      return { ok: true, result: { element: TREE.elements[0] } };
    default:
      return { ok: true, result: {} };
  }
};

describe("target validation", () => {
  it("accepts exactly one kind of target", () => {
    expect(targetSchema.safeParse({ ref: "e1" }).success).toBe(true);
    expect(targetSchema.safeParse({ testID: "a" }).success).toBe(true);
    expect(targetSchema.safeParse({ label: "a" }).success).toBe(true);
    expect(targetSchema.safeParse({ text: "a", index: 1 }).success).toBe(true);
    expect(targetSchema.safeParse({ x: 1, y: 2 }).success).toBe(true);
  });
  it("rejects none, several, half a point, or a stray index", () => {
    expect(targetSchema.safeParse({}).success).toBe(false);
    expect(targetSchema.safeParse({ ref: "e1", testID: "a" }).success).toBe(false);
    expect(targetSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(targetSchema.safeParse({ ref: "e1", index: 0 }).success).toBe(false);
  });
});

describe("press", () => {
  it("returns the result line and the fresh element list, without a screenshot", async () => {
    const { app, tools } = await setup(defaultHandler)();
    const result = await tools.press({ target: { testID: "login-button" } });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('Pressed e3 button "Log in".');
    expect(text).toContain('e3 button "Log in" testID=login-button @24,610 354x48 [press, longPress]');
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    expect(app.requests.map((r) => r.method)).toEqual(["press", "tree"]);
    expect(app.requests[0]?.params).toEqual({ target: { testID: "login-button" } });
  });

  it("passes force through to press, long_press and toggle only when set", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.press({ target: { ref: "e3" }, force: true, look: false });
    await tools.longPress({ target: { ref: "e3" }, force: true, look: false });
    await tools.toggle({ target: { ref: "e3" }, force: true, look: false });
    await tools.press({ target: { ref: "e3" }, look: false });
    expect(app.requests.map((r) => r.params)).toEqual([
      { target: { ref: "e3" }, force: true },
      { target: { ref: "e3" }, force: true },
      { target: { ref: "e3" }, force: true },
      { target: { ref: "e3" } },
    ]);
  });

  it("skips the look when look is false", async () => {
    const { app, tools } = await setup(defaultHandler)();
    const result = await tools.press({ target: { ref: "e3" }, look: false });
    expect(textOf(result)).toBe('Pressed e3 button "Log in".');
    expect(app.requests.map((r) => r.method)).toEqual(["press"]);
  });

  it("reports not_found as a tool error with the app's message", async () => {
    const { tools } = await setup((req) =>
      req.method === "press"
        ? { ok: false, error: { code: "not_found", message: 'No element matches testID "nope"' } }
        : defaultHandler(req),
    )();
    const result = await tools.press({ target: { testID: "nope" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error not_found: No element matches testID "nope"');
  });

  it("lists candidates for ambiguous", async () => {
    const { tools } = await setup((req) =>
      req.method === "press"
        ? {
            ok: false,
            error: {
              code: "ambiguous",
              message: 'Text "Delete" matches 2 elements',
              candidates: [
                { ref: "e5", role: "button", text: "Delete", frame: { x: 0, y: 100, width: 80, height: 40 }, actions: ["press"] },
                { ref: "e9", role: "button", text: "Delete", frame: { x: 0, y: 300, width: 80, height: 40 }, actions: ["press"] },
              ],
            },
          }
        : defaultHandler(req),
    )();
    const result = await tools.press({ target: { text: "Delete" } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Error ambiguous");
    expect(text).toContain('e5 button "Delete" @0,100 80x40 [press]');
    expect(text).toContain('e9 button "Delete" @0,300 80x40 [press]');
    expect(text).toContain("index");
  });

  it("accepts refs-only candidates", async () => {
    const { tools } = await setup(() => ({
      ok: false,
      error: { code: "ambiguous", message: "2 matches", refs: ["e5", "e9"] },
    }))();
    const text = textOf(await tools.press({ target: { text: "Delete" } }));
    expect(text).toContain("  e5");
    expect(text).toContain("  e9");
  });
});

describe("labels and layout checks", () => {
  const grey = jpeg.encode({ data: Buffer.alloc(300 * 600 * 4, 128), width: 300, height: 600 }, 80).data.toString("base64");
  const realShot = (req: IncomingRequest): Reply =>
    req.method === "screenshot" ? { ok: true, result: { mime: "image/jpeg", data: grey, width: 300, height: 600 } } : defaultHandler(req);

  it("draws element boxes and refs on the screenshot only when labels is set", async () => {
    const { tools } = await setup(realShot)();
    const plain = await tools.look({});
    const labeled = await tools.look({ labels: true });
    const imageOf = (result: CallToolResult): string | undefined =>
      result.content.find((block) => block.type === "image")?.type === "image"
        ? (result.content.find((block) => block.type === "image") as { data: string }).data
        : undefined;
    expect(imageOf(plain)).toBe(grey);
    expect(imageOf(labeled)).toBeDefined();
    expect(imageOf(labeled)).not.toBe(grey);
  });

  it("lists layout findings by ref, or says none were found", async () => {
    const findings = [
      { kind: "small_target", ref: "e3", message: "tap area 32x28 pt is smaller than 44x44" },
      { kind: "overlap", ref: "e4", other: "e7", message: "overlaps e7 by 60% of the smaller element" },
    ];
    const { app, tools } = await setup((req) => (req.method === "check" ? { ok: true, result: { findings } } : defaultHandler(req)))();
    const text = textOf(await tools.checkLayout({}));
    expect(app.requests.map((r) => r.method)).toEqual(["check"]);
    expect(text).toContain("2 findings");
    expect(text).toContain("e3 small_target: tap area 32x28 pt is smaller than 44x44");
    expect(text).toContain("e4 overlap: overlaps e7 by 60% of the smaller element");

    const { tools: clean } = await setup((req) => (req.method === "check" ? { ok: true, result: { findings: [] } } : defaultHandler(req)))();
    expect(textOf(await clean.checkLayout({}))).toContain("No layout problems found");
  });
});

describe("changes after actions", () => {
  const BASKET = {
    screen: { width: 402, height: 874, scale: 3 },
    route: { names: ["basket"] },
    elements: [
      { ref: "e1", type: "Text", role: "text", text: "Basket", frame: { x: 0, y: 0, width: 200, height: 30 }, actions: [] },
      { ref: "e2", type: "Text", role: "text", text: "$8", frame: { x: 0, y: 40, width: 200, height: 30 }, actions: [] },
      { ref: "e5", type: "Text", role: "text", text: "Free delivery", frame: { x: 0, y: 130, width: 200, height: 30 }, actions: [] },
      { ref: "e4", type: "Pressable", role: "button", text: "Pay", frame: { x: 0, y: 650, width: 200, height: 48 }, actions: ["press"] },
    ],
  };
  const CHANGES = {
    sameRoute: true,
    added: ["e5"],
    removed: [{ ref: "e3", type: "Pressable", role: "button", text: "Use coupon", frame: { x: 0, y: 80, width: 200, height: 40 }, actions: ["press"] }],
    changed: [{ ref: "e2", was: { text: "$10" } }],
    moved: ["e4"],
  };

  function basket(changes: unknown) {
    return (req: IncomingRequest): Reply => {
      if (req.method === "tree") {
        const wants = typeof req.params === "object" && req.params !== null && (req.params as { changes?: unknown }).changes === true;
        return { ok: true, result: wants ? { ...BASKET, changes } : BASKET };
      }
      return defaultHandler(req);
    };
  }

  it("shows only what changed once the agent has had a full list", async () => {
    const { app, tools } = await setup(basket(CHANGES))();
    await tools.look({ screenshot: false });
    const text = textOf(await tools.press({ target: { ref: "e3" } }));
    expect(app.requests.filter((r) => r.method === "tree").map((r) => r.params)).toEqual([{}, { changes: true }]);
    expect(text).toContain("same screen");
    expect(text).toContain('+ e5 text "Free delivery"');
    expect(text).toContain('- button "Use coupon"');
    expect(text).toContain('~ e2 text "$8" @0,40 200x30 (was text="$10")');
    expect(text).toContain('↕ e4 button "Pay" @0,650 200x48');
    expect(text).not.toContain('e1 text "Basket"');
    expect(text).toContain("call look for the full list");
  });

  it("gives the full list when the agent hasn't had one yet", async () => {
    const { app, tools } = await setup(basket(CHANGES))();
    const text = textOf(await tools.press({ target: { ref: "e3" } }));
    expect(app.requests.filter((r) => r.method === "tree").map((r) => r.params)).toEqual([{}]);
    expect(text).toContain('e1 text "Basket"');
  });

  it("gives the full list when the screen changed", async () => {
    const { tools } = await setup(basket({ ...CHANGES, sameRoute: false }))();
    await tools.look({ screenshot: false });
    const text = textOf(await tools.press({ target: { ref: "e3" } }));
    expect(text).toContain('e1 text "Basket"');
    expect(text).toContain("Route: basket");
  });

  it("says when nothing visible changed", async () => {
    const { tools } = await setup(basket({ sameRoute: true, added: [], removed: [], changed: [], moved: [] }))();
    await tools.look({ screenshot: false });
    expect(textOf(await tools.press({ target: { ref: "e3" } }))).toContain("No visible change");
  });
});

describe("back", () => {
  it("asks the app to go back and returns the fresh element list", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "back" ? { ok: true, result: { route: ["(tabs)", "detail"] } } : defaultHandler(req),
    )();
    const result = await tools.back({});
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Went back from (tabs) › detail.");
    expect(textOf(result)).toContain("e3 button");
    expect(app.requests.map((r) => r.method)).toEqual(["back", "tree"]);
  });

  it("reports nothing to go back to as an error", async () => {
    const { tools } = await setup((req) =>
      req.method === "back"
        ? { ok: false, error: { code: "not_actionable", message: "Nothing to go back to from home." } }
        : defaultHandler(req),
    )();
    const result = await tools.back({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Nothing to go back to");
  });
});

describe("look", () => {
  it("returns text and an image when the app supports screenshots", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.look({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(textOf(result)).toContain("Screen 402x874 @3x (points) - 1 element");
    expect(result.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
  });

  it("returns text only with a note when screenshot is unsupported", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "screenshot"
        ? { ok: false, error: { code: "unsupported", message: "react-native-view-shot is not installed" } }
        : defaultHandler(req),
    )();
    const first = await tools.look({});
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(1);
    expect(textOf(first)).toContain("No screenshot");
    expect(textOf(first)).toContain("e3 button");
    // remembered for this session: no second screenshot attempt
    await tools.look({});
    expect(app.requests.filter((r) => r.method === "screenshot")).toHaveLength(1);
  });

  it("skips the screenshot when asked", async () => {
    const { app, tools } = await setup(defaultHandler)();
    const result = await tools.look({ screenshot: false });
    expect(result.content).toHaveLength(1);
    expect(app.requests.map((r) => r.method)).toEqual(["tree"]);
  });

  it("asks the app for a 600-pixel screenshot, or the width given", async () => {
    const { app, tools } = await setup(defaultHandler)();
    await tools.look({});
    await tools.look({ width: 300 });
    const shots = app.requests.filter((r) => r.method === "screenshot").map((r) => r.params);
    expect(shots).toEqual([
      { format: "jpg", quality: 0.7, maxWidth: 600 },
      { format: "jpg", quality: 0.7, maxWidth: 300 },
    ]);
  });

  it("saves the screenshot to a file and returns only its path in file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-shots-"));
    try {
      const { host, port } = await startHost();
      hosts.push(host);
      const { app } = await FakeApp.connect(port, {}, defaultHandler);
      apps.push(app);
      const tools = new TaplineTools(host, {
        connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
        settleMs: 0,
        screenshots: "file",
        screenshotDir: dir,
      });
      const result = await tools.look({});
      expect(result.content.every((block) => block.type === "text")).toBe(true);
      const match = /Screenshot: (.+\.jpg) \(600x1305\)/.exec(textOf(result));
      expect(match).not.toBeNull();
      const file = match?.[1] ?? "";
      expect(file.startsWith(dir)).toBe(true);
      expect(readFileSync(file).toString()).toBe("ABC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest screenshot files in file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-shots-"));
    try {
      const { host, port } = await startHost();
      hosts.push(host);
      const { app } = await FakeApp.connect(port, {}, defaultHandler);
      apps.push(app);
      const tools = new TaplineTools(host, {
        connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
        settleMs: 0,
        screenshots: "file",
        screenshotDir: dir,
        screenshotKeep: 2,
      });
      const paths: string[] = [];
      for (let i = 0; i < 3; i++) {
        const match = /Screenshot: (.+\.jpg)/.exec(textOf(await tools.look({})));
        paths.push(match?.[1] ?? "");
      }
      expect(new Set(paths).size).toBe(3);
      expect(paths.map((p) => existsSync(p))).toEqual([false, true, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still returns the text when the screenshot fails another way", async () => {
    const { tools } = await setup((req) =>
      req.method === "screenshot" ? { ok: false, error: { code: "internal", message: "capture failed" } } : defaultHandler(req),
    )();
    const result = await tools.look({});
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Screenshot failed: capture failed");
  });
});

describe("no app connected", () => {
  it("tells the agent to pair a phone", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://100.101.102.103:${port}/`, name: "Dev PC" },
      settleMs: 0,
    });
    for (const result of [await tools.look({}), await tools.press({ target: { ref: "e1" } })]) {
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("No app is connected");
      expect(text).toContain(`ws://100.101.102.103:${port}/`);
      expect(text).toContain("`pair`");
      expect(text).toContain("Tailscale");
    }
    const apps = tools.apps();
    expect(apps.isError).toBeUndefined();
    expect(textOf(apps)).toContain("No app is connected");
  });
});

describe("pair", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function pairTools() {
    const { host, port } = await startHost();
    hosts.push(host);
    const dir = mkdtempSync(join(tmpdir(), "tapline-pair-"));
    dirs.push(dir);
    const imagePath = join(dir, `pair-${port}.png`);
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      settleMs: 0,
      pairImagePath: imagePath,
    });
    return { port, tools, imagePath };
  }

  it("returns a pairing link with a one-time code, its QR code and the forget link", async () => {
    const { port, tools, imagePath } = await pairTools();
    const result = await tools.pair({ scheme: "myapp" });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    const link = /myapp:\/\/tapline\/pair\?\S+/.exec(text)?.[0] ?? "";
    expect(link).toContain(`url=${encodeURIComponent(`ws://127.0.0.1:${port}/`)}`);
    expect(link).toContain("name=Dev%20PC");
    expect(text).toContain("myapp://tapline/forget");
    expect(text).toContain("10 minutes");
    expect(text).toContain(imagePath);
    expect(existsSync(imagePath)).toBe(true);
    expect(result.content.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);

    // The code in the link is accepted by the host, once.
    const code = new URLSearchParams(link.split("?")[1] ?? "").get("code") ?? "";
    const { app, welcome } = await FakeApp.connect(port, { token: undefined, pairCode: code });
    apps.push(app);
    expect(welcome["token"]).toBe(TOKEN);
  });

  it("deletes the saved QR code once its code has expired", async () => {
    const { host, port } = await startHost();
    hosts.push(host);
    const dir = mkdtempSync(join(tmpdir(), "tapline-pair-"));
    dirs.push(dir);
    const imagePath = join(dir, "pair.png");
    const tools = new TaplineTools(host, {
      connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" },
      pairImagePath: imagePath,
      pairImageLifetimeMs: 50,
    });
    await tools.pair({ scheme: "myapp" });
    expect(existsSync(imagePath)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(imagePath)).toBe(false);
  });

  it("each call makes a new code", async () => {
    const { tools } = await pairTools();
    const codeOf = async (): Promise<string> => /code=([^&\s]+)/.exec(textOf(await tools.pair({ scheme: "myapp" })))?.[1] ?? "";
    const first = await codeOf();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await codeOf()).not.toBe(first);
  });

  it("rejects something that is not a URL scheme", async () => {
    const { tools } = await pairTools();
    const result = await tools.pair({ scheme: "https" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("scheme");
  });
});

describe("apps and select_app", () => {
  it("lists connected apps and marks the selected one", async () => {
    const { host, app, tools } = await setup(defaultHandler)();
    void app;
    const text = textOf(tools.apps());
    expect(text).toContain("Demo 1.0.0 (1) [com.example.demo]");
    expect(text).toContain("Test iPhone");
    expect(text.split("\n")[1]?.startsWith("*")).toBe(true);
    const id = host.sessions()[0]?.id ?? "";
    expect(textOf(tools.selectApp({ session: id }))).toContain(`Selected Demo (${id})`);
    const bad = tools.selectApp({ session: "s-ffff" });
    expect(bad.isError).toBe(true);
  });

  it("shows the install id of a phone that sends no name, so two iPhones can be told apart", async () => {
    const { host, tools } = await setup(defaultHandler)();
    const { app } = await FakeApp.connect(host.boundPort() ?? 0, { device: { platform: "ios", osVersion: "26.1", id: "3fa2c9d1e5b7" } });
    apps.push(app);
    expect(textOf(tools.apps())).toContain("ios 26.1, install 3fa2c9");
  });
});

describe("other tools", () => {
  it("type_text sends the documented params", async () => {
    const { app, tools } = await setup((req) =>
      req.method === "type" ? { ok: true, result: { element: { ref: "e2", type: "TextInput" }, value: "hi" } } : defaultHandler(req),
    )();
    const result = await tools.typeText({ text: "hi", target: { testID: "email" }, submit: true, look: false });
    expect(app.requests[0]?.params).toEqual({ text: "hi", replace: true, submit: true, target: { testID: "email" } });
    expect(textOf(result)).toBe('Typed into e2 TextInput and submitted. Value is now "hi".');
  });

  it("scroll rejects `to` combined with direction", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.scroll({ to: "end", direction: "up" });
    expect(result.isError).toBe(true);
  });

  it("logs come from the host buffer", async () => {
    const { host, app, tools } = await setup(defaultHandler)();
    app.send({ type: "event", event: "log", data: { level: "warn", message: "careful", ts: 5000 } });
    const id = host.sessions()[0]?.id ?? "";
    for (let i = 0; i < 100 && host.logs(id).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const text = textOf(await tools.logs({}));
    expect(text).toContain("warn careful");
    expect(text).toContain("since=5000");
  });

  it("wait returns a fresh look", async () => {
    const { tools } = await setup(defaultHandler)();
    const result = await tools.wait({ seconds: 0.1 });
    expect(textOf(result)).toContain("Waited 0.1s.");
    expect(textOf(result)).toContain("e3 button");
  });
});

describe("mcp server", () => {
  it("registers every tool and validates input over an in-memory transport", async () => {
    const { tools } = await setup(defaultHandler)();
    const server = createMcpServer(tools);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(
        ["apps", "select_app", "pair", "look", "press", "long_press", "type_text", "scroll", "toggle", "open_url", "back", "check_layout", "logs", "reload", "wait"].sort(),
      );
      const ok = await client.callTool({ name: "press", arguments: { target: { testID: "login-button" } } });
      expect(JSON.stringify(ok.content)).toContain("Pressed e3");
      const bad = await client.callTool({ name: "press", arguments: { target: { ref: "e1", testID: "x" } } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
