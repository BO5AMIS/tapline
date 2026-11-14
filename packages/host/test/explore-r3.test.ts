import { describe, expect, it } from "vitest";
import { TYPED, redactFinding } from "../src/findings.js";

// PR 13 CodeRabbit round (R3): findings.

describe("R3: a finding's placeholder-shaped text is still content", () => {
  const scrub = (text: string): string => text.replace(/SECRET/g, "<hidden>");
  it("redacts a vault value inside a ${…} span, and keeps the typed placeholder", () => {
    const out = redactFinding({ got: "${SECRET}", expected: `${TYPED} and ${"${SECRET}"}`, logs: ["error ${a SECRET b}"] }, scrub);
    expect(out.got).toBe("${<hidden>}");
    expect(out.expected).toBe(`${TYPED} and \${<hidden>}`);
    expect(out.logs[0]).toBe("error ${a <hidden> b}");
  });
});

import type { LogEntry } from "../src/protocol.js";
import { errorLine } from "../src/explore.js";

describe("R3: an error line is redacted before it is cut", () => {
  it("a value that straddles the 300th character is hidden whole", () => {
    const value = "hunter2-hunter2";
    const message = `${"e".repeat(290)}${value} and more`;
    const redact = (text: string): string => text.split(value).join("<hidden>");
    const line = errorLine({ message } as LogEntry, redact);
    expect(line).not.toContain("hunter");
    expect(line).toContain("<hidden>");
  });
});

import { rmSync } from "node:fs";
import { afterEach } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaplineHost } from "../src/server.js";
import { flushExploreMaps, setupExplore } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("R3: a saved back road leads the next run to the parent's frontier", () => {
  it("a run started on the child, whose back was tried before, still explores the parent", async () => {
    const s = await setupExplore(hosts, apps, dirs, {});
    s.world.screen = "settings";
    // Run 1 is cut at depth 1: settings is explored (its back road to home is saved), home is not.
    await s.tools.explore({ depth: 1 });
    expect(s.world.pressed).not.toContain("open-trips");
    s.world.screen = "settings";
    s.world.pressed.length = 0;
    const second = await s.tools.explore({});
    expect(textOf(second)).toMatch(/Stopped: the frontier is empty\./);
    expect(s.world.pressed).toContain("open-trips");
  });
});

describe("R3: a toggle is restored after an alert recovery", () => {
  it("the alert that opens on a flip is cleared by a reload that keeps data; the toggle is flipped back", async () => {
    const s = await setupExplore(hosts, apps, dirs, {});
    s.world.onPress = (id) => {
      if (id === "notify-switch" && s.world.toggles["notify-switch"] === false) s.world.alertOpen = true;
    };
    await s.tools.explore({});
    expect(s.world.reloads).toBeGreaterThanOrEqual(1);
    expect(s.world.toggles["notify-switch"]).toBe(false);
  });

  it("when it can't be flipped back after the recovery, the run stops with toggle_not_restored", async () => {
    const s = await setupExplore(hosts, apps, dirs, {});
    s.world.stuckToggles.add("notify-switch");
    s.world.onPress = (id) => {
      if (id === "notify-switch" && s.world.toggles["notify-switch"] === false) s.world.alertOpen = true;
    };
    const out = textOf(await s.tools.explore({}));
    expect(out).toMatch(/Stopped: .*toggle/i);
  });
});

describe("R3: explore and a recording, a replay or a journey exclude each other from both sides", () => {
  it("record, a route recording, replay and a journey are refused while an explore runs", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const scriptsDir = mkdtempSync(join(tmpdir(), "tapline-r3-scripts-"));
    dirs.push(scriptsDir);
    const s = await setupExplore(hosts, apps, dirs, { tools: { scriptsDir } });
    const answers: Promise<CallToolResult>[] = [];
    s.world.onPress = (id) => {
      if (id !== "open-settings" || answers.length > 0) return;
      answers.push(s.tools.record({ start: true, name: "x" }));
      answers.push(s.tools.record({ start: true, route: "sign_in" }));
      answers.push(s.tools.replay({ name: "x" }));
      answers.push(s.tools.journey({ start: true, goal: "find settings" }));
    };
    await s.tools.explore({});
    const texts = (await Promise.all(answers)).map(textOf);
    expect(texts).toHaveLength(4);
    for (const t of texts) expect(t).toMatch(/can't start while an explore is running/);
    // Nothing was left recording, and a recording can start once the explore is over.
    expect(textOf(await s.tools.record({ start: true, name: "after" }))).toMatch(/Recording "after"/);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { APP } from "./drive-helpers.js";

describe("R3: a move's log window survives a full buffer", () => {
  it("an error logged when the host's buffer is already full is still the move's finding", async () => {
    const s = await setupExplore(hosts, apps, dirs, {
      hostOptions: { logBufferSize: 3 },
      world: (world) => {
        world.errorOn["open-settings"] = ["settings a", "settings b", "settings c", "settings d"];
        world.errorOn["open-trips"] = "trips boom";
      },
    });
    await s.tools.explore({});
    const appDir = joinPath(s.exploreDir, APP.id);
    const names = readdirSync(appDir).sort();
    const report = JSON.parse(readFileSync(joinPath(appDir, names[names.length - 1] as string, "report.json"), "utf8")) as { findings: Array<{ got: string; place: string | null }> };
    const got = report.findings.map((f) => f.got);
    expect(got).toContain("trips boom");
    expect(got).toContain("settings b");
    // The sequence number is the host's bookkeeping: no finding keeps it.
    expect(JSON.stringify(report)).not.toContain('"seq"');
  });
});

import { btn, row } from "./explore-helpers.js";
import type { ExEl } from "./explore-helpers.js";

describe("R3: rows are numbered in their own list", () => {
  it("the first two rows of a second list are tried too", async () => {
    const at = (y: number): NonNullable<ExEl["frame"]> => ({ x: 20, y, width: 300, height: 44 });
    const s = await setupExplore(hosts, apps, dirs, {
      world: (w) => {
        w.screens["home"]!.elements = [
          { id: "list-a", role: "scroll", type: "ScrollView", actions: ["scroll"], frame: { x: 0, y: 0, width: 430, height: 400 } },
          row("a-1", "Alpha one", { frame: at(10) }),
          row("a-2", "Alpha two", { frame: at(70) }),
          { id: "list-b", role: "scroll", type: "ScrollView", actions: ["scroll"], frame: { x: 0, y: 420, width: 430, height: 400 } },
          row("b-1", "Beta one", { frame: at(430) }),
          row("b-2", "Beta two", { frame: at(490) }),
        ];
        w.screens["home"]!.hidden = [];
      },
    });
    await s.tools.explore({});
    expect(s.world.pressed).toEqual(expect.arrayContaining(["a-1", "a-2", "b-1", "b-2"]));
  });
});

describe("R3: a path through a submitted form keeps the typing", () => {
  it("a finding on the place a submit leads to carries the typed steps of the form", async () => {
    const s = await setupExplore(hosts, apps, dirs, {
      world: (w) => {
        w.screens["done"] = { route: ["done"], parent: "form", elements: [btn("done-ok", "OK")] };
        w.goes["form|save-profile"] = "done";
        w.audit["done"] = [{ type: "contrast", problem: "done is faint", fix: "darken" }];
      },
      policy: { version: 2, confirm: [], block: [], explore: { submit: ["save-profile"] } },
    });
    await s.tools.explore({ fill: "test-data" });
    const appDir = joinPath(s.exploreDir, APP.id);
    const names = readdirSync(appDir).sort();
    const report = JSON.parse(readFileSync(joinPath(appDir, names[names.length - 1] as string, "report.json"), "utf8")) as { findings: Array<{ got: string; path: Array<Record<string, unknown>> }> };
    const found = report.findings.find((f) => f.got.includes("done is faint"));
    expect(found?.path.map((step) => step["tool"])).toEqual(["tap", "type_text", "type_text", "tap"]);
    expect(found?.path.filter((step) => step["tool"] === "type_text").map((step) => step["text"])).toEqual(["${typed}", "${typed}"]);
  });
});
