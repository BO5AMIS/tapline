import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { startHost } from "./helpers.js";

// The live view's link carries the key that approves held-back touches: by default the agent never sees it.

const hosts: TaplineHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const LINKS = ["http://127.0.0.1:7210/viewer?token=secret-key", "http://100.101.102.103:7210/viewer?token=secret-key"];

describe("the viewer tool", () => {
  it("opens the live view in a browser here and keeps the link from the agent", async () => {
    const { host } = await startHost();
    hosts.push(host);
    const opened: string[] = [];
    const tools = new TaplineTools(host, {
      connect: { url: "", name: "Dev PC" },
      viewerLinks: () => LINKS,
      openViewer: (link) => {
        opened.push(link);
        return true;
      },
    });
    const answer = textOf(await tools.viewer({}));
    expect(opened).toEqual([LINKS[0]]);
    expect(answer).not.toContain("secret-key");
    expect(answer).toContain("Opened the live view in a browser on this computer");
    expect(answer).toContain("this server's log");
  });

  it("gives the link with --viewer-link (benchmarks, scripts)", async () => {
    const { host } = await startHost();
    hosts.push(host);
    const tools = new TaplineTools(host, {
      connect: { url: "", name: "Dev PC" },
      viewerLinks: () => LINKS,
      openViewer: () => true,
      viewerLinkToAgent: true,
    });
    expect(textOf(await tools.viewer({}))).toContain(LINKS[0]);
  });
});
