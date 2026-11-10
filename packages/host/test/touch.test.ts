import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ControlQueue } from "../src/control.js";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, delay, startHost, type IncomingRequest, type Reply } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

const NOTE = "Note: a person used the app since your last look.";
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

const handler = (req: IncomingRequest): Reply => {
  switch (req.method) {
    case "tree":
      return { ok: true, result: TREE };
    case "press":
      return { ok: true, result: { element: TREE.elements[0] } };
    default:
      return { ok: true, result: {} };
  }
};

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

async function setup() {
  const { host, port } = await startHost();
  hosts.push(host);
  const { app, session } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  const control = new ControlQueue({ idleMs: 400, giveUpMs: 2000 });
  const tools = new TaplineTools(host, { connect: { url: `ws://127.0.0.1:${port}/`, name: "Dev PC" }, control });
  return { host, port, app, session, tools, control };
}

/** Sends a `touch` event from the app and waits until the host has handled it. */
async function touch(host: TaplineHost, app: FakeApp): Promise<void> {
  const seen = new Promise<void>((resolve) => host.once("touch", () => resolve()));
  app.send({ type: "event", event: "touch", data: { at: Date.now() } });
  await seen;
}

describe("a finger on the phone (real touch)", () => {
  it("the next answer ends with the person note, once", async () => {
    const { host, app, tools } = await setup();
    await tools.look({ screenshot: false });
    await touch(host, app);
    const first = textOf(await tools.tap({ target: { id: "login-button" } }));
    expect(first.trimEnd().split("\n").at(-1)).toBe(NOTE);
    const second = textOf(await tools.tap({ target: { id: "login-button" } }));
    expect(second).not.toContain("a person used the app");
  });

  it("makes {ref} targets stale until the next look, while id targets keep working", async () => {
    const { host, app, tools } = await setup();
    await tools.look({ screenshot: false });
    await touch(host, app);
    const stale = await tools.tap({ target: { ref: "e3" } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/^Error stale: a person used the app since your last look/);
    const byId = await tools.tap({ target: { id: "login-button" } });
    expect(byId.isError).toBeFalsy();
  });

  it("a look says it once and makes refs work again", async () => {
    const { host, app, tools } = await setup();
    await tools.look({ screenshot: false });
    await touch(host, app);
    const look = textOf(await tools.look({ screenshot: false }));
    expect(look.trimEnd().split("\n").at(-1)).toBe(NOTE);
    const ref = await tools.tap({ target: { ref: "e3" } });
    expect(ref.isError).toBeFalsy();
    expect(textOf(ref)).not.toContain("a person used the app");
  });

  it("does not make the agent wait or get `busy`: it is not the viewer's queue", async () => {
    const { host, app, tools, control } = await setup();
    await tools.look({ screenshot: false });
    await touch(host, app);
    expect(control.driver()).toBeNull();
    const started = Date.now();
    const result = await tools.tap({ target: { id: "login-button" }, look: false });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toMatch(/busy/i);
    expect(Date.now() - started).toBeLessThan(350); // the viewer's idle wait here would be 400 ms
    expect(control.driver()).toBeNull();
  });

  it("a touch event from a session that is not the current one changes nothing", async () => {
    const { host, port, app, session, tools } = await setup();
    const { app: other } = await FakeApp.connect(
      port,
      { app: { name: "Other", id: "com.example.other", version: "1", build: "1" }, device: { platform: "ios", name: "Other phone" } },
      handler,
    );
    apps.push(other);
    host.select(session);
    await tools.look({ screenshot: false });
    await touch(host, other);
    await delay(20);
    const result = await tools.tap({ target: { ref: "e3" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain("a person used the app");
    // ...while the same event from the current session still counts.
    await touch(host, app);
    expect(textOf(await tools.tap({ target: { ref: "e3" } }))).toMatch(/^Error stale/);
  });

  it("a touch event with no data still counts, also before any look", async () => {
    const { host, app, tools } = await setup();
    const seen = new Promise<void>((resolve) => host.once("touch", () => resolve()));
    app.send({ type: "event", event: "touch" });
    await seen;
    const answer = textOf(await tools.tap({ target: { id: "login-button" }, look: false }));
    expect(answer).toContain(NOTE);
  });
});
