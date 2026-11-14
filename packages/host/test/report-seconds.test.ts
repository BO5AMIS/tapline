import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActionLogEntry } from "../src/actionlog.js";
import type { AccountStore } from "../src/accounts.js";
import { analyze, buildCalls, formatReport, reportFor } from "../src/report.js";
import { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.13 §16.1 (seconds): the Time line, the accounts line and the new-process waste flag.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const START = Date.parse("2026-11-12T10:00:00.000Z");

/** An entry that begins `at` ms after START and takes `ms`. */
function at(call: number, tool: string, atMs: number, ms: number | undefined, extra: Partial<ActionLogEntry> = {}, session = "s1"): ActionLogEntry {
  return {
    t: new Date(START + atMs).toISOString(),
    source: "tapline",
    by: "agent",
    tool,
    ok: true,
    session,
    call,
    v: 2,
    ...(ms !== undefined ? { ms } : {}),
    ...extra,
  };
}

const report = (entries: ActionLogEntry[], accounts?: readonly string[]): string => formatReport(analyze(buildCalls(entries)), accounts);
const timeLine = (text: string): string | undefined => text.split("\n").find((l) => l.startsWith("Time:"));

describe("the report's seconds", () => {
  it("the Time line has the exact shape with medians", () => {
    // tool: tap 500, tap 700, look 200 (all in ms); gaps: 3000, 4000 between the calls
    const entries = [at(1, "tap", 0, 500), at(2, "tap", 3500, 700), at(3, "look", 8200, 200, { kind: "read" })];
    const line = timeLine(report(entries));
    // gaps: 3500-500 = 3000, 8200-4200 = 4000: thinking 7 s (median 3.5 s); tool 1.4 s (median 0.5 s)
    expect(line).toBe("Time: 8 s: thinking between calls 7 s (median 3.5 s), in the tool 1 s (median 0.5 s; tap 0.6 s, look 0.2 s).");
  });

  it("the Time line sits right after the Session line, in minutes when long", () => {
    // 30 calls of 18 s, each after 44 s of thinking: 22 min thinking, 9 min in the tool
    const entries: ActionLogEntry[] = [];
    for (let i = 0; i < 30; i++) entries.push(at(i + 1, "tap", i * 62_000, 18_000));
    const lines = report(entries).split("\n");
    expect(lines[0]).toMatch(/^Session: 30 calls/);
    expect(lines[1]).toMatch(/^Time: 30 min: thinking between calls 21 min \(median 44\.0 s\), in the tool 9 min \(median 18\.0 s; tap 18\.0 s\)\.$/);
  });

  it("a 3-minute gap is left out of thinking", () => {
    const entries = [at(1, "tap", 0, 1000), at(2, "tap", 181_000, 1000), at(3, "tap", 184_000, 1000)];
    // gaps: 180 s (idle, left out), 2 s
    const line = timeLine(report(entries)) ?? "";
    expect(line).toContain("thinking between calls 2 s (median 2.0 s)");
  });

  it("a gap of exactly 2 minutes still counts; over 2 minutes does not", () => {
    const exact = timeLine(report([at(1, "tap", 0, 1000), at(2, "tap", 121_000, 1000)])) ?? "";
    expect(exact).toContain("thinking between calls 2 min");
    const over = timeLine(report([at(1, "tap", 0, 1000), at(2, "tap", 121_001, 1000)])) ?? "";
    expect(over).toContain("thinking between calls 0 s");
  });

  it("per-tool part lists the top three by time, then … when there are more", () => {
    const entries = [
      at(1, "tap", 0, 5000),
      at(2, "look", 10_000, 4000, { kind: "read" }),
      at(3, "scroll", 20_000, 3000),
      at(4, "logs", 30_000, 100, { kind: "read" }),
    ];
    const line = timeLine(report(entries)) ?? "";
    expect(line).toContain("(median 3.5 s; tap 5.0 s, look 4.0 s, scroll 3.0 s, …)");
    expect(line).not.toContain("logs");
  });

  it("a run is one call: its time is the steps and the gap is counted after it", () => {
    const entries = [
      at(1, "tap", 0, 1000, { batch: { id: "b", step: 1 }, of: "run" }),
      at(1, "tap", 1000, 2000, { batch: { id: "b", step: 2 }, of: "run" }),
      at(2, "look", 8000, 500, { kind: "read" }),
    ];
    const line = timeLine(report(entries)) ?? "";
    // run took 3 s (0 to 3000); the look began 5 s later
    expect(line).toContain("thinking between calls 5 s (median 5.0 s)");
    expect(line).toContain("run 3.0 s");
  });

  it("old log lines without ms are skipped without error", () => {
    const entries = [at(1, "tap", 0, undefined), at(2, "tap", 3000, undefined)];
    expect(timeLine(report(entries))).toBeUndefined();
    const mixed = [at(1, "tap", 0, undefined), at(2, "tap", 3000, 1000), at(3, "tap", 9000, 1000)];
    const line = timeLine(report(mixed)) ?? "";
    // only the gap between the two calls that have times
    expect(line).toContain("thinking between calls 5 s (median 5.0 s)");
    expect(line).toContain("in the tool 2 s (median 1.0 s; tap 1.0 s)");
  });

  it("gaps are per client", () => {
    const entries = [
      at(1, "tap", 0, 1000, { client: "a" }),
      at(2, "tap", 500, 1000, { client: "b" }),
      at(3, "tap", 11_000, 1000, { client: "a" }),
      at(4, "tap", 12_500, 1000, { client: "b" }),
    ];
    // a: gap 11000 - 1000 = 10 s; b: gap 12500 - 1500 = 11 s. Mixed in one stream they would be 0.5, 9, 0.5 s.
    const line = timeLine(report(entries)) ?? "";
    expect(line).toContain("thinking between calls 21 s (median 10.5 s)");
  });

  it("calls that overlap in time add no negative thinking", () => {
    const entries = [at(1, "tap", 0, 5000), at(2, "look", 1000, 100, { kind: "read" })];
    expect(timeLine(report(entries)) ?? "").toContain("thinking between calls 0 s");
  });

  it("two sessions under one client name are not mixed", () => {
    const entries = [
      at(1, "tap", 0, 1000, { client: "x" }, "s1"),
      at(1, "tap", 2000, 1000, { client: "x" }, "s2"),
      at(2, "tap", 11_000, 1000, { client: "x" }, "s1"),
      at(2, "tap", 13_000, 1000, { client: "x" }, "s2"),
    ];
    // s1: 11000 - 1000 = 10 s; s2: 13000 - 3000 = 10 s. Mixed in one list the gaps would be 1 s, 8 s, 1 s.
    expect(timeLine(report(entries)) ?? "").toContain("thinking between calls 20 s (median 10.0 s)");
  });

  it("a log spanning the upgrade: only v 2 entries make the Time line", () => {
    const old = (call: number, atMs: number): ActionLogEntry => {
      const e = at(call, "tap", atMs, 1000);
      delete e.v;
      return e;
    };
    // old entries stamped the end of the action: left out, like entries without ms
    const entries = [old(1, 0), old(2, 5000), at(3, "tap", 20_000, 1000), at(4, "tap", 25_000, 1000)];
    const line = timeLine(report(entries)) ?? "";
    expect(line).toContain("thinking between calls 4 s (median 4.0 s)");
    expect(line).toContain("in the tool 2 s (median 1.0 s; tap 1.0 s)");
    expect(timeLine(report([old(1, 0), old(2, 5000)]))).toBeUndefined();
  });

  it("entries carry ms through a real call, reads too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-seconds-"));
    dirs.push(dir);
    const { host, port } = await startHost();
    hosts.push(host);
    const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
    const handler = (req: IncomingRequest): Reply =>
      req.method === "press"
        ? { ok: true, result: { element: SAVE, settledMs: 100 } }
        : req.method === "tree"
          ? { ok: true, result: { screen: { width: 400, height: 800 }, elements: [SAVE] } }
          : { ok: true, result: {} };
    const { app } = await FakeApp.connect(port, {}, handler);
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir: dir });
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "save" } });
    const log = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));
    expect(log.length).toBeGreaterThanOrEqual(2);
    for (const l of log) {
      expect(typeof l["ms"]).toBe("number");
      expect(l["v"]).toBe(2);
    }
    expect(log.some((l) => l["via"] !== undefined)).toBe(false);
  });

  it("a thin call writes via call, an MCP call does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-seconds-"));
    dirs.push(dir);
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: true, result: { screen: { width: 400, height: 800 }, elements: [] } }));
    apps.push(app);
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir: dir });
    const { callTool } = await import("../src/dispatch.js");
    await tools.asThinCall(() => callTool(tools, "look", { screenshot: false }));
    await tools.look({ screenshot: false });
    const log = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));
    expect(log.map((l) => l["via"])).toEqual(["call", undefined]);
  });
});

describe("the new-process flag", () => {
  const flags = (entries: ActionLogEntry[]): string[] => analyze(buildCalls(entries)).flags.map((f) => f.text);
  const thin = (n: number, extra: Partial<ActionLogEntry> = {}): ActionLogEntry[] =>
    Array.from({ length: n }, (_, i) => at(i + 1, "look", i * 3000, 200, { kind: "read", via: "call", ...extra }));

  it("5 thin-call entries raise the flag with the range of call numbers", () => {
    expect(flags(thin(14))).toEqual(["14 calls each from a new process (calls 1–14): load the MCP server once; each call paid about 2 s"]);
    expect(flags(thin(5))).toEqual(["5 calls each from a new process (calls 1–5): load the MCP server once; each call paid about 2 s"]);
  });

  it("4 thin calls raise nothing", () => {
    expect(flags(thin(4))).toEqual([]);
  });

  it("no thin calls, no flag", () => {
    const entries = Array.from({ length: 8 }, (_, i) => at(i + 1, "look", i * 3000, 200, { kind: "read" }));
    expect(flags(entries)).toEqual([]);
  });

  it("at most 5 groups of call numbers, then …", () => {
    // thin calls with an MCP call between each: 7 separate calls, the flag names 5 and …
    const entries: ActionLogEntry[] = [];
    let n = 0;
    for (let i = 0; i < 7; i++) {
      entries.push(at(++n, "look", n * 3000, 200, { kind: "read", via: "call" }));
      entries.push(at(++n, "logs", n * 3000, 200, { kind: "read" }));
    }
    expect(flags(entries)).toEqual(["7 calls each from a new process (calls 1, 3, 5, 7, 9, …): load the MCP server once; each call paid about 2 s"]);
  });

  it("Waste: none. still shows when nothing is flagged, after the Time line", () => {
    const text = report([at(1, "look", 0, 100, { kind: "read" })]);
    expect(text.split("\n")).toEqual([
      "Session: 1 call in 1 min (look 1). Failed: 0.",
      "Time: 0 s: thinking between calls 0 s (median 0.0 s), in the tool 0 s (median 0.1 s; look 0.1 s).",
      "Waste: none.",
    ]);
  });

  it("the flag follows the other waste lines in the list", () => {
    const text = report(thin(6));
    expect(text).toContain("Waste:\n- 6 calls each from a new process");
  });
});

describe("the accounts line", () => {
  it("names only, after the Time line", () => {
    const text = report([at(1, "look", 0, 100, { kind: "read" })], ["tester1", "tester2"]);
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^Time:/);
    expect(lines[2]).toBe("Accounts: tester1, tester2.");
  });

  it("no accounts loaded, no line", () => {
    expect(report([at(1, "look", 0, 100, { kind: "read" })], [])).not.toContain("Accounts:");
    expect(report([at(1, "look", 0, 100, { kind: "read" })])).not.toContain("Accounts:");
  });

  it("comes right after Session when old logs give no Time line", () => {
    const lines = report([at(1, "look", 0, undefined, { kind: "read" })], ["tester1"]).split("\n");
    expect(lines[1]).toBe("Accounts: tester1.");
  });

  it("session_report shows the loaded names and never a username or password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-seconds-"));
    dirs.push(dir);
    writeFileSync(join(dir, "actions-2026-11-12.jsonl"), "");
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, () => ({ ok: true, result: { screen: { width: 400, height: 800 }, elements: [] } }));
    apps.push(app);
    const store: AccountStore = {
      names: () => ["tester1", "tester2"],
      kindOf: () => "account",
      resolve: () => ({ ok: false, code: "not_found", message: "none" }),
      resolveEntry: () => ({ ok: false, code: "not_found", message: "none" }),
      redact: (value) => value,
    };
    const tools = new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir: dir, accounts: { store } });
    await tools.look({ screenshot: false });
    const answer = tools.sessionReport({});
    const first = answer.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(text).toContain("Accounts: tester1, tester2.");
  });

  it("reportFor takes the names", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-seconds-"));
    dirs.push(dir);
    expect(reportFor(dir, 0, undefined, ["tester1"])).toBe("Session: 0 calls.\nAccounts: tester1.\nWaste: none.");
  });
});
