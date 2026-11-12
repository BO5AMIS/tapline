import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActionLogEntry } from "../src/actionlog.js";
import { analyze, buildCalls, formatReport, parseSince, readLogEntries, reportFor, runReport } from "../src/report.js";
import { TaplineHost } from "../src/server.js";
import { TaplineTools } from "../src/tools.js";
import { FakeApp, startHost, type IncomingRequest, type Reply } from "./helpers.js";

// AGENT-TOOLS 1.11 §16.1: the call log (reads too, with call numbers, client id and answer size) and session_report.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SAVE = { ref: "e3", type: "Pressable", role: "button", testID: "save", text: "Save", frame: { x: 24, y: 610, width: 354, height: 48 }, actions: ["press"] };
const LIST = { ref: "e1", type: "ScrollView", role: "scroll", frame: { x: 0, y: 0, width: 400, height: 800 }, actions: ["scroll"] };
const TREE = { screen: { width: 400, height: 800 }, elements: [LIST, SAVE] };

function lines(dir: string): Array<Record<string, unknown>> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}

function handler(req: IncomingRequest): Reply {
  if (req.method === "press") return { ok: true, result: { element: SAVE, settledMs: 100 } };
  if (req.method === "scroll") return { ok: true, result: { element: LIST, offset: { x: 0, y: 300 }, settledMs: 100 } };
  if (req.method === "tree") return { ok: true, result: TREE };
  if (req.method === "logs") return { ok: true, result: { entries: [{ ts: 1, level: "log", message: "secret log text" }] } };
  return { ok: true, result: {} };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tapline-calls-"));
  dirs.push(dir);
  const { host, port } = await startHost();
  hosts.push(host);
  const { app } = await FakeApp.connect(port, {}, handler);
  apps.push(app);
  return { dir, tools: new TaplineTools(host, { connect: { url: "", name: "Dev PC" }, logDir: dir }) };
}

// ---- synthetic logs ------------------------------------------------------------

let clock = Date.parse("2026-11-12T10:00:00.000Z");
function entry(call: number, tool: string, extra: Partial<ActionLogEntry> = {}, session = "s1"): ActionLogEntry {
  clock += 5000;
  return { t: new Date(clock).toISOString(), source: "tapline", by: "agent", tool, ok: true, session, call, ...extra };
}
const TAP_SAVE = { target: { id: "save" }, element: 'button "Save" id=save' };

describe("the call log", () => {
  it("logs reads with kind read, the client id, the answer's size and call numbers; never log text", async () => {
    const { dir, tools } = await setup();
    tools.setClientId(() => "claude-code");
    const looked = await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "save" }, look: false });
    const logs = await tools.logs({});
    await tools.checkLayout({});
    const log = lines(dir);
    expect(log.map((l) => [l["tool"], l["call"]])).toEqual([["look", 1], ["tap", 2], ["logs", 3], ["check_layout", 4]]);
    expect(log[0]).toMatchObject({ kind: "read", ok: true, client: "claude-code", by: "agent", source: "tapline", app: "com.example.demo" });
    const lookText = looked.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(log[0]?.["size"]).toBe(lookText.length);
    expect(log[1]).toMatchObject({ tool: "tap", client: "claude-code", size: expect.any(Number) as number });
    expect(log[1]?.["kind"]).toBeUndefined();
    expect(log.every((l) => l["session"] === log[0]?.["session"])).toBe(true);
    const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
    expect(raw).not.toContain("secret log text");
    expect(raw).not.toContain("base64");
    expect(JSON.stringify(logs.content)).toContain("secret log text");
  });

  it("logs a read that failed, with its code", async () => {
    const { dir, tools } = await setup();
    const opened = tools.openApp({ app: "no such app" });
    expect(opened.isError).toBe(true);
    const log = lines(dir);
    expect(log[0]).toMatchObject({ tool: "open_app", kind: "read", ok: false });
    expect(typeof log[0]?.["code"]).toBe("string");
  });

  it("a run's steps share the run's call number and name it; listed marks an answer with the changes", async () => {
    const { dir, tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.run({ steps: [{ tool: "back" }, { tool: "tap", target: { id: "save" } }] });
    await tools.tap({ target: { id: "save" }, look: false });
    const log = lines(dir);
    const steps = log.filter((l) => l["batch"] !== undefined);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s["call"])).toEqual([2, 2]);
    expect(steps.map((s) => s["of"])).toEqual(["run", "run"]);
    expect(steps.every((s) => s["listed"] === true)).toBe(true);
    expect(log[3]?.["listed"]).toBeUndefined();
    const calls = buildCalls(log as unknown as ActionLogEntry[]);
    expect(calls.map((c) => c.tool)).toEqual(["look", "run", "tap"]);
  });

  it("a touch after scrolls records whether its target was in the list before the first scroll", async () => {
    const { dir, tools } = await setup();
    await tools.look({ screenshot: false });
    for (let i = 0; i < 3; i++) await tools.scroll({ direction: "down", look: false });
    await tools.tap({ target: { id: "save" }, look: false });
    await tools.scroll({ direction: "down", look: false });
    await tools.tap({ target: { id: "elsewhere" }, look: false });
    const taps = lines(dir).filter((l) => l["tool"] === "tap");
    expect(taps[0]?.["in_list"]).toBe(true);
    // the actions before the second hunt gave the agent no list: it can't be known any more
    expect(taps[1]?.["in_list"]).toBeUndefined();
    const report = tools.sessionReport();
    expect(JSON.stringify(report.content)).toContain("1 scroll hunt of 3 or more scrolls for an element already in the list (calls 2–5)");
    expect(JSON.stringify(report.content)).not.toContain("(maybe)");
  });

  it("an action that gave no list or changes (look: false) makes the list unknown, so the hunt after it is a maybe", async () => {
    const { dir, tools } = await setup();
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "save" }, look: false }); // could have navigated
    for (let i = 0; i < 3; i++) await tools.scroll({ direction: "down", look: false });
    await tools.tap({ target: { id: "save" }, look: false });
    const taps = lines(dir).filter((l) => l["tool"] === "tap");
    expect(taps[1]?.["in_list"]).toBeUndefined();
    expect(JSON.stringify(tools.sessionReport().content)).toContain("1 scroll hunt (maybe) of 3 or more scrolls");
    // a list seen again makes it known
    await tools.look({ screenshot: false });
    for (let i = 0; i < 3; i++) await tools.scroll({ direction: "down", look: false });
    await tools.tap({ target: { id: "save" }, look: false });
    expect(lines(dir).filter((l) => l["tool"] === "tap")[2]?.["in_list"]).toBe(true);
  });

  it("without a list before the scrolls the hunt is a maybe", async () => {
    const { tools } = await setup();
    for (let i = 0; i < 3; i++) await tools.scroll({ direction: "down", look: false });
    await tools.tap({ target: { id: "save" }, look: false });
    const answer = JSON.stringify(tools.sessionReport().content);
    expect(answer).toContain("1 scroll hunt (maybe) of 3 or more scrolls");
  });

  it("session_report reads this session only, and says so when the log is off", async () => {
    const { dir, tools } = await setup();
    writeFileSync(join(dir, "actions-2999-01-01.jsonl"), `${JSON.stringify(entry(1, "look", { kind: "read" }, "other"))}\n`);
    await tools.look({ screenshot: false });
    await tools.tap({ target: { id: "save" }, look: false });
    const text = JSON.stringify(tools.sessionReport().content);
    expect(text).toContain("Session: 2 calls in 1 min (look 1, tap 1). Failed: 0.");
    expect(text).toContain("Waste: none.");
    const { host, port } = await startHost();
    hosts.push(host);
    const { app } = await FakeApp.connect(port, {}, handler);
    apps.push(app);
    const off = new TaplineTools(host, { connect: { url: "", name: "Dev PC" } });
    const refused = off.sessionReport();
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("unsupported");
  });
});

describe("session_report waste flags", () => {
  const flagsOf = (entries: ActionLogEntry[]): string[] => analyze(buildCalls(entries)).flags.map((f) => f.text);

  it("does not flag a look that asked for what the action's answer could not give: a screenshot, a width or labels", () => {
    const tap = entry(1, "tap", { ...TAP_SAVE, listed: true });
    expect(flagsOf([tap, entry(2, "look", { kind: "read", look_args: { screenshot: true } })])).toEqual([]);
    expect(flagsOf([tap, entry(2, "look", { kind: "read", look_args: { width: 300 } })])).toEqual([]);
    expect(flagsOf([tap, entry(2, "look", { kind: "read", look_args: { labels: true } })])).toEqual([]);
    // a look that asked for no picture is still the waste it was
    expect(flagsOf([tap, entry(2, "look", { kind: "read", look_args: { screenshot: false } })])).toHaveLength(1);
  });

  it("logs a look's screenshot, width and labels arguments (booleans and numbers only) on its read entry", async () => {
    const { dir, tools } = await setup();
    await tools.look({ screenshot: true, width: 300, labels: true });
    await tools.look({ screenshot: false });
    await tools.look({});
    const looks = lines(dir).filter((l) => l["tool"] === "look");
    expect(looks[0]?.["look_args"]).toEqual({ screenshot: true, width: 300, labels: true });
    expect(looks[1]?.["look_args"]).toEqual({ screenshot: false });
    expect(looks[2]?.["look_args"]).toBeUndefined();
  });

  it("flags a look right after an action whose answer had the changes; not after look:false, a read or a failure", () => {
    const flagged = flagsOf([entry(1, "tap", { ...TAP_SAVE, listed: true }), entry(2, "look", { kind: "read" })]);
    expect(flagged).toEqual(["1 look right after an action whose answer already had the changes (calls 2)"]);
    expect(flagsOf([entry(1, "tap", TAP_SAVE), entry(2, "look", { kind: "read" })])).toEqual([]);
    expect(flagsOf([entry(1, "logs", { kind: "read" }), entry(2, "look", { kind: "read" })])).toEqual([]);
    expect(flagsOf([entry(1, "tap", { ...TAP_SAVE, listed: true, ok: false, code: "not_found" }), entry(2, "look", { kind: "read" })])).toEqual([]);
    expect(flagsOf([entry(1, "tap", { ...TAP_SAVE, listed: true }), entry(2, "wait_for", { kind: "read" }), entry(3, "look", { kind: "read" })])).toEqual([]);
  });

  it("flags a retry after not_found that found the same element by another target", () => {
    const failed = entry(1, "tap", { target: { id: "save" }, ok: false, code: "not_found" });
    const flagged = flagsOf([failed, entry(2, "tap", { target: { text: "Save" }, element: 'button "Save" id=save' })]);
    expect(flagged).toEqual(["1 retry after not_found that found the same element by another target (calls 2): use its id first"]);
    // a different element, the same target again, another tool: not a match
    expect(flagsOf([failed, entry(2, "tap", { target: { text: "Cancel" }, element: 'button "Cancel" id=cancel' })])).toEqual([]);
    expect(flagsOf([failed, entry(2, "tap", { target: { id: "save" }, element: 'button "Save" id=save' })])).toEqual([]);
    expect(flagsOf([failed, entry(2, "long_press", { target: { text: "Save" }, element: 'button "Save" id=save' })])).toEqual([]);
    expect(flagsOf([entry(1, "tap", { target: { id: "save" }, ok: false, code: "covered" }), entry(2, "tap", { target: { text: "Save" }, element: 'button "Save" id=save' })])).toEqual([]);
  });

  it("flags 3 or more scrolls then a touch on an element that was in the list; maybe when that is unknown; not when it wasn't", () => {
    const scrolls = (from: number, n: number): ActionLogEntry[] => Array.from({ length: n }, (_, i) => entry(from + i, "scroll"));
    const exact = flagsOf([...scrolls(1, 3), entry(4, "tap", { ...TAP_SAVE, in_list: true })]);
    expect(exact).toEqual(["1 scroll hunt of 3 or more scrolls for an element already in the list (calls 1–4): let the action scroll"]);
    const maybe = flagsOf([...scrolls(1, 3), entry(4, "tap", TAP_SAVE)]);
    expect(maybe).toEqual(["1 scroll hunt (maybe) of 3 or more scrolls for an element already in the list (calls 1–4): let the action scroll"]);
    expect(flagsOf([...scrolls(1, 3), entry(4, "tap", { ...TAP_SAVE, in_list: false })])).toEqual([]);
    expect(flagsOf([...scrolls(1, 2), entry(3, "tap", { ...TAP_SAVE, in_list: true })])).toEqual([]);
    expect(flagsOf([...scrolls(1, 3), entry(4, "look", { kind: "read" })])).toEqual([]);
    const mixed = flagsOf([...scrolls(1, 3), entry(4, "tap", { ...TAP_SAVE, in_list: true }), ...scrolls(5, 4), entry(9, "tap", TAP_SAVE)]);
    expect(mixed[0]).toContain("2 scroll hunts (1 maybe)");
    expect(mixed[0]).toContain("(calls 1–4, 5–9)");
  });

  it("flags 3 or more actions back to back with no read between; not inside a run, and a read or a failure ends the chain", () => {
    const taps = (from: number, n: number): ActionLogEntry[] => Array.from({ length: n }, (_, i) => entry(from + i, "tap", TAP_SAVE));
    expect(flagsOf(taps(1, 3))).toEqual(["1 run of 3 or more actions with no answer read in between (calls 1–3): one run each"]);
    expect(flagsOf(taps(1, 2))).toEqual([]);
    expect(flagsOf([...taps(1, 2), entry(3, "look", { kind: "read" }), ...taps(4, 2)])).toEqual([]);
    expect(flagsOf([...taps(1, 2), entry(3, "tap", { ...TAP_SAVE, ok: false, code: "not_actionable" }), entry(4, "tap", TAP_SAVE)])).toEqual([]);
    const batch = (step: number): ActionLogEntry => entry(1, "tap", { ...TAP_SAVE, batch: { id: "b1", step }, of: "run" });
    expect(flagsOf([batch(1), batch(2), batch(3), batch(4)])).toEqual([]);
  });

  it("names at most 5 calls per flag, then an ellipsis", () => {
    const entries: ActionLogEntry[] = [];
    for (let i = 0; i < 7; i++) entries.push(entry(i * 2 + 1, "tap", { ...TAP_SAVE, listed: true }), entry(i * 2 + 2, "look", { kind: "read" }));
    expect(flagsOf(entries)[0]).toBe("7 looks right after an action whose answer already had the changes (calls 2, 4, 6, 8, 10, …)");
  });

  it("numbers calls by position when several sessions are in the period", () => {
    const entries = [
      entry(1, "tap", { ...TAP_SAVE, listed: true }, "a"),
      entry(2, "look", { kind: "read" }, "a"),
      entry(1, "tap", { ...TAP_SAVE, listed: true }, "b"),
      entry(2, "look", { kind: "read" }, "b"),
    ];
    const text = flagsOf(entries)[0];
    expect(text).toContain("2 looks");
    expect(text).toContain("(calls 2, 4)");
  });
});

describe("the report text", () => {
  it("has the session line, failures by code, and the waste lines", () => {
    const entries: ActionLogEntry[] = [
      entry(1, "look", { kind: "read" }),
      entry(2, "tap", { target: { id: "nope" }, ok: false, code: "not_found" }),
      entry(3, "tap", { target: { text: "Nope" }, ok: false, code: "ambiguous" }),
      entry(4, "tap", { ...TAP_SAVE, listed: true }),
      entry(5, "look", { kind: "read" }),
    ];
    const text = formatReport(analyze(buildCalls(entries)));
    expect(text.split("\n")).toEqual([
      "Session: 5 calls in 1 min (tap 3, look 2). Failed: 2 (ambiguous 1, not_found 1).",
      "Waste:",
      "- 1 look right after an action whose answer already had the changes (calls 5)",
    ]);
  });

  it("says Waste: none. with no waste, and handles an empty log", () => {
    expect(formatReport(analyze(buildCalls([entry(1, "look", { kind: "read" })])))).toBe("Session: 1 call in 1 min (look 1). Failed: 0.\nWaste: none.");
    expect(formatReport(analyze([]))).toBe("Session: 0 calls.\nWaste: none.");
  });

  it("counts a run as one call named run, failing with its failed step's code", () => {
    const steps = [
      entry(1, "tap", { ...TAP_SAVE, batch: { id: "b", step: 1 }, of: "run", listed: true }),
      entry(1, "tap", { ...TAP_SAVE, batch: { id: "b", step: 2 }, of: "run", ok: false, code: "expect_failed" }),
    ];
    expect(formatReport(analyze(buildCalls(steps)))).toBe("Session: 1 call in 1 min (run 1). Failed: 1 (expect_failed 1).\nWaste: none.");
  });
});

describe("tapline report", () => {
  it("reads a log folder, last 24 hours by default; --since narrows; people's actions and old days don't count", () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-report-"));
    dirs.push(dir);
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const at = (hoursAgo: number): string => new Date(now - hoursAgo * 3600 * 1000).toISOString();
    const rows: ActionLogEntry[] = [
      { t: at(30), source: "tapline", by: "agent", tool: "look", kind: "read", ok: true, session: "old", call: 1 },
      { t: at(3), source: "tapline", by: "agent", tool: "tap", ok: true, session: "s", call: 1, listed: true, ...TAP_SAVE },
      { t: at(3), source: "tapline", by: "person", tool: "tap", ok: true },
      { t: at(2), source: "tapline", by: "agent", tool: "look", kind: "read", ok: true, session: "s", call: 2 },
    ];
    writeFileSync(join(dir, "actions-2026-11-11.jsonl"), `${JSON.stringify(rows[0])}\n`);
    writeFileSync(join(dir, "actions-2026-11-12.jsonl"), `${rows.slice(1).map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`);
    const all = runReport({ dir, now });
    expect(all.code).toBe(0);
    expect(all.text).toBe(
      "Session: 2 calls in 60 min (look 1, tap 1). Failed: 0.\nWaste:\n- 1 look right after an action whose answer already had the changes (calls 2)",
    );
    expect(runReport({ dir, now, since: "48h" }).text).toContain("Session: 3 calls");
    expect(runReport({ dir, now, since: "30m" }).text).toBe("Session: 0 calls.\nWaste: none.");
    const bad = runReport({ dir, now, since: "yesterday-ish" });
    expect(bad.code).toBe(1);
    expect(bad.text).toContain("--since");
    expect(runReport({ dir: join(dir, "missing"), now }).text).toBe("Session: 0 calls.\nWaste: none.");
    expect(readLogEntries(dir, now - 24 * 3600 * 1000)).toHaveLength(3);
    expect(reportFor(dir, now - 24 * 3600 * 1000, "nobody")).toBe("Session: 0 calls.\nWaste: none.");
  });

  it("reads --since as epoch ms, ISO time or how long ago", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    expect(parseSince("90m", now)).toBe(now - 90 * 60000);
    expect(parseSince("1d", now)).toBe(now - 86400000);
    expect(parseSince(String(now - 5), now)).toBe(now - 5);
    expect(parseSince("2026-11-12T11:00:00Z", now)).toBe(now - 3600000);
    expect(parseSince("soon", now)).toBeNull();
  });
});
