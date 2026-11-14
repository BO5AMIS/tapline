import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import type { BugMeta } from "../src/bug.js";
import { runBug, type BugCliDeps } from "../src/bugcmd.js";
import { forbiddenForms, type BugCheck } from "../src/bugstore.js";
import { callTool } from "../src/dispatch.js";
import type { ExploreReport } from "../src/explorereport.js";
import type { MapFile } from "../src/mapfile.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { EXPLORE_CAPS, btn, flushExploreMaps, input, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";

// AGENT-TOOLS 1.16 §29.3, §29.9: each way of making a bug report, on the fake app, and `tapline bug`.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const tmp = (prefix = "tapline-bugtools-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

interface Rig {
  s: ExploreSetup;
  bugsDir: string;
  logDir: string;
  journeysDir: string;
  bugs: () => string[];
  bugDir: (id: string) => string;
}

const BUG_ID = /bug_[0-9a-f]{16}(?:_\d+)?/;

async function rig(options: ExploreSetupOptions = {}): Promise<Rig> {
  const bugsDir = tmp("tapline-bugs-");
  const logDir = tmp("tapline-log-");
  const journeysDir = tmp("tapline-journeys-");
  const s = await setupExplore(hosts, apps, dirs, { ...options, tools: { bugsDir, logDir, journeysDir, ...options.tools } });
  const appDir = join(bugsDir, APP.id);
  return {
    s,
    bugsDir,
    logDir,
    journeysDir,
    bugs: () => (existsSync(appDir) ? readdirSync(appDir).filter((n) => /^bug_[0-9a-f]{16}(?:_\d+)?$/.test(n)).sort() : []),
    bugDir: (id) => join(appDir, id),
  };
}

const lastRun = (s: ExploreSetup): string => {
  const appDir = join(s.exploreDir, APP.id);
  return join(appDir, readdirSync(appDir).sort().at(-1) as string);
};
const reportOf = (s: ExploreSetup): ExploreReport => JSON.parse(readFileSync(join(lastRun(s), "report.json"), "utf8")) as ExploreReport;
const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
const idIn = (answer: string): string => BUG_ID.exec(answer)?.[0] ?? "";

/** A world with a JS error on the form and a crash button. */
function broken(w: Parameters<NonNullable<ExploreSetupOptions["world"]>>[0]): void {
  w.errorOn["open-form"] = "TypeError: form failed";
  w.known = [{ route: ["home"] }, { route: ["settings"] }, { route: ["trips"] }, { route: ["form"] }];
}

describe("from a finding of an explore report (§29.3)", () => {
  it("makes the bug from f<n> of the newest report, with its picture private and out of the folder", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const finding = reportOf(r.s).findings.find((f) => f.kind === "js_error");
    expect(finding?.picture).toEqual({ file: `findings/${finding?.id}.jpg`, private: true });
    const answer = textOf(await r.s.tools.bugReport({ finding: finding?.id as string }));
    expect(answer).toMatch(/^New bug: JS error on home: TypeError: form failed\nReproduced: 3 of 3 runs\.\nSeen: 1 time, 2026-11-14, build 1\.5\.0 \(220\)\.\nFolder: .*bug_[0-9a-f]{16}$/);
    const id = idIn(answer);
    expect(r.bugs()).toEqual([id]);
    const dir = r.bugDir(id);
    expect(readdirSync(dir).sort()).toEqual(["finding.json", "report.html", "report.md", "repro.json"]);
    const md = read(dir, "report.md");
    expect(md).toContain('Start on home.\n1. Tap "Form" (id open-form)');
    expect(md).toContain("A picture exists and is private. To include it:");
    expect(md).toContain("- Place: home (route home)");
    const stored = JSON.parse(read(dir, "finding.json")) as { bug: BugMeta; got: string };
    expect(stored.bug).toMatchObject({ source: { how: "explore", finding: finding?.id }, picture_included: false, place_key: { route: ["home"] } });
    // the same call again is the same bug and counts nothing
    const again = textOf(await r.s.tools.bugReport({ finding: finding?.id as string, run: "last" }));
    expect(again).toMatch(/^Known bug \(seen 1 time\): JS error on home/);
    expect(r.bugs()).toEqual([id]);
  });

  it("a person's with_picture puts the private picture in, in the call or later with bug", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    const id = idIn(textOf(await r.s.tools.bugReport({ finding: f })));
    expect(existsSync(join(r.bugDir(id), "picture.jpg"))).toBe(false);
    const shown = textOf(await r.s.tools.bugReport({ bug: id, with_picture: true }));
    expect(shown).toContain("The picture is in the folder now.");
    expect(shown).toContain("![The screen at the moment](picture.jpg)");
    expect(existsSync(join(r.bugDir(id), "picture.jpg"))).toBe(true);
    expect(textOf(await r.s.tools.bugReport({ bug: id, with_picture: true }))).toContain("The picture is in the folder already.");
    // in the first call, on a fresh bug
    const second = await rig({ world: broken });
    await second.s.tools.explore({});
    const g = reportOf(second.s).findings.find((x) => x.kind === "js_error")?.id as string;
    const id2 = idIn(textOf(await second.s.tools.bugReport({ finding: g, with_picture: true })));
    expect(existsSync(join(second.bugDir(id2), "picture.jpg"))).toBe(true);
  });

  it("a crash's page has the frames, the components and the source, and its signature is the spec's recipe", async () => {
    const r = await rig({
      world: (w) => {
        w.crashOn.add("boom");
        w.errorOn["open-form"] = "x";
      },
    });
    r.s.world.screens["home"]?.elements.unshift(btn("boom", "Boom"));
    await r.s.tools.explore({});
    const crash = reportOf(r.s).findings.find((f) => f.kind === "crash");
    expect(crash?.id).toBeDefined();
    // the crash took the app: the report is named by its folder
    const answer = textOf(await r.s.tools.bugReport({ finding: crash?.id as string, run: lastRun(r.s) }));
    const id = idIn(answer);
    const md = read(r.bugDir(id), "report.md");
    expect(md).toContain("- Frames: *TripDetail.tsx:48 TripDetail, x.js:1 renderWithHooks");
    expect(md).toContain("- Components: TripDetail, TripScreen, Stack");
    expect(md).toContain("- Source: TripDetail.tsx line 48");
    expect(md).toContain("There is no picture.");
    // the id is bug_ and the signature of §29.5, and it holds that exact place key
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(["crash", '{"route":["home"]}', "the app crashed: TypeError: undefined is not an object (evaluating 'trip.days.map')", "TypeError", "TripDetail"].join("\n"), "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(id).toBe(`bug_${expected}`);
  });

  it("the same planted bug found in two runs is one bug with count 2", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const first = lastRun(r.s);
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    // the same planted bug found by a later run, a day later, on the next build (explore doesn't try the same action twice, so its report is copied)
    const second = join(r.s.exploreDir, APP.id, "20261115T091500Z");
    cpSync(first, second, { recursive: true });
    const report = JSON.parse(readFileSync(join(second, "report.json"), "utf8")) as ExploreReport;
    for (const finding of report.findings) {
      finding.when = "2026-11-15T09:15:00.000Z";
      finding.build = "221";
    }
    writeFileSync(join(second, "report.json"), JSON.stringify(report));
    const a = textOf(await r.s.tools.bugReport({ finding: f, run: first }));
    const b = textOf(await r.s.tools.bugReport({ finding: f, run: second }));
    expect(a).toMatch(/^New bug/);
    expect(b).toMatch(/^Known bug \(seen 2 times\)/);
    expect(b).toContain("Seen: 2 times, 2026-11-15, builds 1.5.0 (220), 1.5.0 (221).");
    expect(idIn(b)).toBe(idIn(a));
    expect(r.bugs()).toHaveLength(1);
    const stored = JSON.parse(read(r.bugDir(idIn(a)), "finding.json")) as { bug: BugMeta };
    expect(stored.bug.seen.count).toBe(2);
    expect(stored.bug.seen.sources).toHaveLength(2);
  });

  it("refuses what it can't make: no report, a finding that isn't there, a path outside the reports, a journey's folder", async () => {
    const r = await rig({ world: broken });
    expect(textOf(await r.s.tools.bugReport({ finding: "f1" }))).toMatch(/^Error not_found: no explore report for this app yet/);
    await r.s.tools.explore({});
    expect(textOf(await r.s.tools.bugReport({ finding: "f99" }))).toMatch(/^Error not_found: no finding "f99"/);
    expect(textOf(await r.s.tools.bugReport({ finding: "f1", run: tmp() }))).toMatch(/^Error bad_params: run is an explore report folder of this server/);
    // a journey's report folder holds no findings.json in the shape of §27
    const journey = join(r.journeysDir, "2026-11-14-0900-log-breakfast");
    mkdirSync(journey, { recursive: true });
    writeFileSync(join(journey, "report.md"), "# Journey report\n");
    const refused = await r.s.tools.bugReport({ finding: "f1", run: journey });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error bad_params: .*holds no report\.json: only an explore report can be made into a bug/);
    expect(r.bugs()).toEqual([]);
  });
});

describe("from the last failed check (§29.3)", () => {
  const failing = { steps: [{ tool: "tap", target: { id: "open-settings" } }, { tool: "tap", target: { id: "open-language" }, expect: { id: "does-not-exist" } }], look: false } as const;

  it("makes an expect_failed bug from the steps that ran, up to and including the failed one", async () => {
    const r = await rig({ world: broken });
    const run = await r.s.tools.run(failing as never);
    expect(textOf(run)).toMatch(/^Error expect_failed:/);
    const answer = textOf(await r.s.tools.bugReport({ from: "failure" }));
    expect(answer).toMatch(/^New bug: Check failed on an unnamed screen: /);
    const id = idIn(answer);
    const md = read(r.bugDir(id), "report.md");
    expect(md).toMatch(/\n1\. Tap .*open-settings.*\n2\. Tap .*open-language.*\n/);
    expect(md.split("\n").filter((line) => /^\d+\. /.test(line))).toHaveLength(2);
    expect(md).toContain("3 of 3 runs. Script: repro.json");
    const stored = JSON.parse(read(r.bugDir(id), "finding.json")) as { kind: string; bug: BugMeta };
    expect(stored.kind).toBe("expect_failed");
    expect(stored.bug.source.how).toBe("failure");
    // the same failure again counts nothing
    expect(textOf(await r.s.tools.bugReport({ from: "failure" }))).toMatch(/^Known bug \(seen 1 time\)/);
  });

  it("is not_found when nothing failed, or when a later run held", async () => {
    const r = await rig({ world: broken });
    expect(textOf(await r.s.tools.bugReport({ from: "failure" }))).toMatch(/^Error not_found: there is no failed replay or run/);
    await r.s.tools.run(failing as never);
    await r.s.tools.run({ steps: [{ tool: "back" }], look: false });
    expect(textOf(await r.s.tools.bugReport({ from: "failure" }))).toMatch(/^Error not_found/);
  });
});

describe("from now (§29.3)", () => {
  /** Twelve touches: tap Settings, go back, six times. */
  async function drive(r: Rig, rounds = 6): Promise<void> {
    for (let n = 0; n < rounds; n++) {
      await r.s.tools.tap({ target: { id: "open-settings" }, look: false });
      await r.s.tools.back({ look: false });
    }
  }

  it("takes at most the last 10 touches, redacted, and says Reproduced: not checked", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.look({ screenshot: false });
    await drive(r);
    const answer = textOf(await r.s.tools.bugReport({ from: "now", note: "the language row is missing", expected: "a language row" }));
    expect(answer).toMatch(/^New bug: Observed on home: the language row is missing\nReproduced: not checked\.\nSeen: 1 time, 2026-11-14, build 1\.5\.0 \(220\)\.\nFolder: /);
    const id = idIn(answer);
    const md = read(r.bugDir(id), "report.md");
    const steps = md.split("\n").filter((line) => /^\d+\. /.test(line));
    expect(steps).toHaveLength(10);
    expect(steps[0]).toBe('1. Tap "Settings" (id open-settings)');
    expect(steps[1]).toBe("2. Go back");
    expect(md).toContain("Expected: a language row. Got: the language row is missing");
    expect(md).toContain("Start on home.");
    expect(md).toMatch(/## Reproduced\nnot checked \(no check was asked for\)/);
    const stored = JSON.parse(read(r.bugDir(id), "finding.json")) as { kind: string; picture: { private: boolean }; path: unknown[]; bug: BugMeta };
    expect(stored).toMatchObject({ kind: "observed", picture: { private: true } });
    expect(stored.path).toHaveLength(10);
    expect(stored.bug).toMatchObject({ source: { how: "now" }, reproduced: { checked: false } });
    // the private screenshot isn't in the folder
    expect(existsSync(join(r.bugDir(id), "picture.jpg"))).toBe(false);
  });

  it("with fewer touches takes them all; a typed step is ${typed} and its value is in no file", async () => {
    const r = await rig({ world: broken });
    const secret = "Zebra-secret-9931";
    await r.s.tools.tap({ target: { id: "open-form" }, look: false });
    await r.s.tools.typeText({ target: { id: "name-test-safe" }, text: secret, look: false });
    const answer = textOf(await r.s.tools.bugReport({ from: "now", note: `the name field kept ${secret}` }));
    const id = idIn(answer);
    const md = read(r.bugDir(id), "report.md");
    expect(md.split("\n").filter((line) => /^\d+\. /.test(line))).toEqual([expect.stringMatching(/^1\. Tap .*open-form/), "2. Type something in id name-test-safe"]);
    expect(md).toContain("Got: the name field kept ");
    // the note went through the redactor: this host's typed list holds only what a run typed, so the note stays as the agent wrote it,
    // but the typed step never has a value
    const script = JSON.parse(read(r.bugDir(id), "repro.json")) as { variables: string[]; steps: Array<{ tool: string; text?: string }> };
    expect(script.variables).toEqual(["typed"]);
    expect(script.steps[1]).toMatchObject({ tool: "type_text", text: "${typed}" });
    expect(read(r.bugDir(id), "finding.json")).not.toMatch(/"text": "Zebra/);
  });

  it("a touch by ref can't be written down: the path starts after it, and the page says so", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.look({ screenshot: false });
    await r.s.tools.tap({ target: { ref: "e1" }, look: false });
    await r.s.tools.tap({ target: { id: "open-language" }, look: false });
    const id = idIn(textOf(await r.s.tools.bugReport({ from: "now", note: "no English row" })));
    const md = read(r.bugDir(id), "report.md");
    expect(md).toContain("Earlier steps couldn't be written down.");
    expect(md.split("\n").filter((line) => /^\d+\. /.test(line))).toEqual(['1. Tap "Language" (id open-language)']);
  });

  it("scrolls, swipes and links are written with their direction", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.tap({ target: { id: "open-trips" }, look: false });
    await r.s.tools.scroll({ direction: "down", look: false });
    await r.s.tools.scroll({ to: "end", look: false });
    await r.s.tools.openUrl({ url: "wayfare://trips/42?token=abc", look: false }).catch(() => undefined);
    const id = idIn(textOf(await r.s.tools.bugReport({ from: "now", note: "list ends early" })));
    const lines = read(r.bugDir(id), "report.md").split("\n").filter((line) => /^\d+\. /.test(line));
    expect(lines.slice(0, 3)).toEqual([expect.stringMatching(/^1\. Tap .*open-trips/), "2. Scroll down", "3. Scroll to the end"]);
    expect(read(r.bugDir(id), "report.md")).not.toContain("token=abc");
  });

  it("is not_found with no touch in the log, unsupported with the log off, bad_params without a note", async () => {
    const r = await rig({ world: broken });
    expect(textOf(await r.s.tools.bugReport({ from: "now", note: "x" }))).toMatch(/^Error not_found: there is no touch in the action log/);
    expect(textOf(await r.s.tools.bugReport({ from: "now" }))).toMatch(/^Error bad_params: from: "now" needs a note/);
    expect(textOf(await r.s.tools.bugReport({ from: "now", note: "x".repeat(301) }))).toMatch(/^Error bad_params: note is at most 300 characters/);
    expect(textOf(await r.s.tools.bugReport({ from: "now", note: "a\nb" }))).toMatch(/^Error bad_params: note is one line/);
    const off = await setupExplore(hosts, apps, dirs, { world: broken, tools: { bugsDir: tmp(), journeysDir: tmp() } });
    expect(textOf(await off.tools.bugReport({ from: "now", note: "x" }))).toMatch(/^Error unsupported: the action log is off \(--no-log\)/);
  });
});

describe("the call itself (§29.3)", () => {
  it("exactly one of finding, from and bug; note, expected and run go with their source", async () => {
    const r = await rig({ world: broken });
    const t = r.s.tools;
    expect(textOf(await t.bugReport({}))).toMatch(/^Error bad_params: give exactly one of finding, from and bug\./);
    expect(textOf(await t.bugReport({ finding: "f1", from: "failure" }))).toMatch(/^Error bad_params: give exactly one/);
    expect(textOf(await t.bugReport({ from: "failure", run: "last" }))).toMatch(/^Error bad_params: run goes with finding/);
    expect(textOf(await t.bugReport({ finding: "f1", note: "x" }))).toMatch(/^Error bad_params: note and expected go with from: "now"/);
    expect(textOf(await t.bugReport({ bug: "nope" }))).toMatch(/^Error bad_params: "nope" is not a bug id/);
    expect(textOf(await t.bugReport({ bug: "bug_0123456789abcdef" }))).toMatch(/^Error not_found: no bug bug_0123456789abcdef/);
    expect(textOf(await t.bugReport({ finding: "f1", verify: 11 }))).toMatch(/^Error bad_params: verify is true, false or a whole number from 0 to 10/);
  });

  it("verify takes true, false or 1 to 10; false and 0 mean no check", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    expect(textOf(await r.s.tools.bugReport({ finding: f, verify: false }))).toMatch(/^New bug.*\nReproduced: not checked \(no check was asked for\)\./s);
    expect(textOf(await r.s.tools.bugReport({ finding: f, verify: 0 }))).toMatch(/^Known bug/);
    expect(textOf(await r.s.tools.bugReport({ finding: f, verify: 2 }))).toMatch(/\nReproduced: 2 of 2 runs\./);
    // export goes with bug, alone
    expect(textOf(await r.s.tools.bugReport({ finding: f, export: { to: "zip" } }))).toMatch(/^Error bad_params: export goes with bug/);
  });

  it("a check given through the hook runs, and the page and the answer say the result", async () => {
    let called = 0;
    const bugCheck: BugCheck = async (bug, n) => {
      called += 1;
      expect(bug.finding.kind).toBe("js_error");
      return { n: 2, of: n, build: "1.5.0 (220)", when: "2026-11-14T11:20:02.014Z", reset: "reload only, data kept" };
    };
    const r = await rig({ world: broken, tools: { bugCheck } });
    await r.s.tools.explore({});
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    const answer = textOf(await r.s.tools.bugReport({ finding: f }));
    expect(called).toBe(1);
    expect(answer).toContain("Reproduced: 2 of 3 runs (flaky).");
    const md = read(r.bugDir(idIn(answer)), "report.md");
    expect(md).toContain("2 of 3 runs (flaky). Script: repro.json");
    expect(md).toContain("- Reset before each run: reload only, data kept");
    // from "now" is not checked unless asked
    await r.s.tools.tap({ target: { id: "open-settings" }, look: false });
    expect(textOf(await r.s.tools.bugReport({ from: "now", note: "seen" }))).toContain("Reproduced: not checked.");
    expect(called).toBe(1);
  });

  it("shows a kept bug: its page and its folder", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    const id = idIn(textOf(await r.s.tools.bugReport({ finding: f })));
    const shown = textOf(await r.s.tools.bugReport({ bug: id }));
    expect(shown).toContain("## How to see it");
    expect(shown).toMatch(/Folder: .*bug_[0-9a-f]{16}$/);
    expect(shown.split("\n").length).toBeLessThanOrEqual(85);
  });

  it("is a tool of the MCP list and the thin call, and its description names what it makes", async () => {
    const r = await rig({ world: broken });
    const answer = await callTool(r.s.tools, "bug_report", { from: "failure" });
    expect(textOf(answer)).toMatch(/^Error not_found: there is no failed replay/);
    const bad = await callTool(r.s.tools, "bug_report", { nope: 1 });
    expect(textOf(bad)).toMatch(/^Error bad_params: bug_report doesn't take nope/);
    const { toolDescription } = await import("../src/tool-text.js");
    expect(toolDescription("bug_report")).toMatch(/^One page for whoever fixes a bug/);
    const { INSTRUCTIONS } = await import("../src/tool-text.js");
    expect(INSTRUCTIONS).toContain("`bug_report`");
    const { TOOL_META } = await import("../src/dispatch.js");
    expect(TOOL_META.bug_report).toMatchObject({ readOnly: false });
  });
});

describe("redaction and the gate on the whole path (§29.6, §29.9)", () => {
  const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
  const DESTINATION = "Lisbon-Alfama-Tram-28-Route";
  const NOTE = "bring-the-blue-umbrella-please";

  it("a vault value planted in a note, a log line, a name and a frame is in no file of any bug, in any form or 12-character piece", async () => {
    const file = join(tmp(), "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { trip_data: { kind: "fixture", destination: DESTINATION, memo: NOTE, explore: true } } }));
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    const r = await rig({
      world: (w) => {
        broken(w);
        // a log line and a label that carry the value
        w.errorOn["open-form"] = `TypeError: could not open ${DESTINATION}`;
        w.screens["home"]?.elements.push(btn("planted", `Trip to ${DESTINATION}`), input("planted-input", `Notes ${NOTE}`));
      },
      capabilities: [...EXPLORE_CAPS, "typeKind"],
      hostOptions: { redact: loaded.store.redact },
      tools: { accounts: loaded },
    });
    await r.s.tools.explore({});
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    const a = textOf(await r.s.tools.bugReport({ finding: f }));
    await r.s.tools.tap({ target: { id: "planted" }, look: false }).catch(() => undefined);
    await r.s.tools.tap({ target: { id: "open-settings" }, look: false });
    const b = textOf(await r.s.tools.bugReport({ from: "now", note: `the trip to ${DESTINATION} says ${NOTE}`, expected: `a page about ${DESTINATION}` }));
    for (const answer of [a, b]) {
      expect(answer).not.toContain(DESTINATION);
      expect(answer).not.toContain(NOTE);
    }
    expect(b).toContain("<trip_data's destination>");
    expect(r.bugs()).toHaveLength(2);
    const forms = forbiddenForms([DESTINATION, NOTE]);
    forms.push(encodeURIComponent(DESTINATION), Buffer.from(DESTINATION).toString("base64"), JSON.stringify(DESTINATION).slice(1, -1));
    let seen = 0;
    for (const id of r.bugs()) {
      for (const name of readdirSync(r.bugDir(id))) {
        if (name.endsWith(".jpg")) continue;
        const text = read(r.bugDir(id), name);
        seen += 1;
        for (const form of forms) expect(text, `${id}/${name} holds ${form}`).not.toContain(form);
      }
    }
    expect(seen).toBe(8);
    // the placeholder is there instead
    expect(read(r.bugDir(r.bugs()[0] as string), "finding.json") + read(r.bugDir(r.bugs()[1] as string), "finding.json")).toContain("<trip_data's destination>");
  });

  it("no file shows a user's folder or machine name, and every file stays small", async () => {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const f = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    const id = idIn(textOf(await r.s.tools.bugReport({ finding: f })));
    for (const name of readdirSync(r.bugDir(id))) {
      const path = join(r.bugDir(id), name);
      expect(statSync(path).size).toBeLessThan(20_000);
      expect(readFileSync(path, "utf8")).not.toMatch(/[A-Za-z]:\\Users|\/Users\/|\/home\//);
    }
  });
});

describe("tapline bug (§29.3, the CLI)", () => {
  function cli(bugsDir: string, extra: Partial<BugCliDeps> = {}): { deps: BugCliDeps; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { bugsDir, redact: (t) => t, map: () => undefined, policy: DEFAULT_POLICY, out: (t) => out.push(t), err: (t) => err.push(t), ...extra } };
  }

  async function made(): Promise<{ run: string; finding: string; bugsDir: string; map: MapFile }> {
    const r = await rig({ world: broken });
    await r.s.tools.explore({});
    const finding = reportOf(r.s).findings.find((x) => x.kind === "js_error")?.id as string;
    await r.s.registry.flushAll();
    return { run: lastRun(r.s), finding, bugsDir: tmp("tapline-clibugs-"), map: r.s.file() };
  }

  it("exit 0 for a bug made or updated and not checked; the answer is the tool's", async () => {
    const m = await made();
    const { deps, out, err } = cli(m.bugsDir, { map: () => m.map });
    expect(await runBug([m.run, m.finding], {}, deps)).toBe(0);
    expect(out[0]).toMatch(/^New bug: JS error on home: TypeError: form failed\nReproduced: not checked \(no check was asked for\)\.\nSeen: 1 time/);
    expect(await runBug([m.run, m.finding], {}, deps)).toBe(0);
    expect(out[1]).toMatch(/^Known bug \(seen 1 time\)/);
    expect(err).toEqual([]);
  });

  it("exit 2 when it can't be made: no arguments, no folder, no such finding, a folder that isn't a report, a bad --verify", async () => {
    const m = await made();
    const { deps, err } = cli(m.bugsDir);
    expect(await runBug([], {}, deps)).toBe(2);
    expect(err.at(-1)).toContain("Usage: tapline bug");
    expect(await runBug([join(m.run, "nope"), "f1"], {}, deps)).toBe(2);
    expect(err.at(-1)).toMatch(/^not_found: no report folder/);
    expect(await runBug([m.run, "f99"], {}, deps)).toBe(2);
    expect(err.at(-1)).toMatch(/^not_found: no finding "f99"/);
    expect(await runBug([tmp()], {}, deps)).toBe(2);
    const plain = tmp();
    expect(await runBug([plain, "f1"], {}, deps)).toBe(2);
    expect(err.at(-1)).toMatch(/holds no report\.json/);
    expect(await runBug([m.run, m.finding], { verify: "11" }, deps)).toBe(2);
    expect(err.at(-1)).toMatch(/--verify is a whole number from 0 to 10/);
    expect(await runBug([m.run, m.finding], { verify: "abc" }, deps)).toBe(2);
  });

  it("exit 2 for verify with no way to reach the phone, and for an export of a bug that isn't kept", async () => {
    const m = await made();
    const { deps, err } = cli(m.bugsDir);
    expect(await runBug([m.run, m.finding], { verify: "3" }, deps)).toBe(2);
    expect(err.at(-1)).toMatch(/verify \(the reproduction check\) needs the phone/);
    expect(await runBug(["verify", "bug_0123456789abcdef"], {}, deps)).toBe(2);
    expect(await runBug(["export", "bug_0123456789abcdef"], { zip: "x.zip" }, deps)).toBe(2);
    expect(err.at(-1)).toMatch(/^no bug bug_0123456789abcdef/);
    expect(existsSync(join(m.bugsDir, APP.id))).toBe(false);
  });

  it("exit 1 when it was made and didn't reproduce, 0 when it did or was flaky (with a check hook)", async () => {
    const m = await made();
    const never: BugCheck = async (_bug, n) => ({ n: 0, of: n, build: "1.5.0 (220)", when: "2026-11-14T11:20:02.014Z", reset: "reload only, data kept" });
    const sometimes: BugCheck = async (_bug, n) => ({ n: 1, of: n, build: "1.5.0 (220)", when: "2026-11-14T11:21:02.014Z", reset: "reload only, data kept" });
    const always: BugCheck = async (_bug, n) => ({ n, of: n, build: "1.5.0 (220)", when: "2026-11-14T11:22:02.014Z", reset: "reload only, data kept" });
    const a = cli(m.bugsDir, { check: never, map: () => m.map });
    expect(await runBug([m.run, m.finding], { verify: "3" }, a.deps)).toBe(1);
    expect(a.out[0]).toContain("Reproduced: 0 of 3 runs: not reproduced.");
    // a bug that doesn't reproduce is kept, and listed
    const id = BUG_ID.exec(a.out[0] as string)?.[0] as string;
    expect(await runBug(["list"], {}, a.deps)).toBe(0);
    expect(a.out.at(-1)).toContain(`${id}  JS error on home: TypeError: form failed   seen 1, last 2026-11-14, 0 of 3`);
    const md = readFileSync(join(m.bugsDir, APP.id, id, "report.md"), "utf8");
    expect(md).toContain("0 of 3 runs: not reproduced");
    // a later check replaces the result
    const b = cli(m.bugsDir, { check: sometimes });
    expect(await runBug(["verify", id], { verify: "3" }, b.deps)).toBe(0);
    expect(b.out[0]).toBe("Reproduced: 1 of 3 runs (flaky).");
    const c = cli(m.bugsDir, { check: always });
    expect(await runBug(["verify", id], {}, c.deps)).toBe(0);
    expect(c.out[0]).toBe("Reproduced: 3 of 3 runs.");
    expect(readFileSync(join(m.bugsDir, APP.id, id, "report.md"), "utf8")).toContain("3 of 3 runs. Script: repro.json");
    const stored = JSON.parse(readFileSync(join(m.bugsDir, APP.id, id, "finding.json"), "utf8")) as { got: string; bug: BugMeta };
    expect(stored.bug.reproduced).toMatchObject({ n: 3, of: 3 });
    expect(stored.got).toBe("TypeError: form failed");
  });

  it("list: per app, newest first, with counts and the check; show: the page", async () => {
    const m = await made();
    const { deps, out } = cli(m.bugsDir, { map: () => m.map });
    expect(await runBug(["list"], {}, deps)).toBe(0);
    expect(out[0]).toBe("No bugs kept.");
    await runBug([m.run, m.finding], {}, deps);
    expect(await runBug(["list"], {}, deps)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`^${APP.id.replace(/\./g, "\\.")}\\n  bug_[0-9a-f]{16}  JS error on home: TypeError: form failed   seen 1, last 2026-11-14, not checked$`));
    expect(await runBug(["list"], { app: APP.id }, deps)).toBe(0);
    expect(out.at(-1)).toContain("seen 1");
    expect(await runBug(["list"], { app: "com.example.none" }, deps)).toBe(0);
    expect(out.at(-1)).toBe("No bugs kept.");
    const id = BUG_ID.exec(out.find((line) => line.startsWith("New bug")) as string)?.[0] as string;
    expect(await runBug([id], {}, deps)).toBe(0);
    expect(out.at(-1)).toContain("## How to see it");
    expect(await runBug(["bug_0123456789abcdef"], {}, deps)).toBe(2);
  });

  it("the CLI redacts its answers and refuses, writing nothing, when the gate finds a value", async () => {
    const m = await made();
    const secret = "TypeError: form failed";
    const leaky = cli(m.bugsDir, { redact: (t) => t.split(secret).join("<redacted>"), map: () => m.map });
    expect(await runBug([m.run, m.finding], {}, leaky.deps)).toBe(0);
    expect(leaky.out[0]).toContain("JS error on home: <redacted>");
    const store = join(m.bugsDir, APP.id);
    for (const id of readdirSync(store)) for (const name of readdirSync(join(store, id))) expect(readFileSync(join(store, id, name), "utf8")).not.toContain(secret);
    // a redactor that never settles: the gate refuses and the folder is not made
    const fresh = tmp("tapline-clibugs2-");
    const stuck = cli(fresh, { redact: (t) => `${t} ` });
    expect(await runBug([m.run, m.finding], {}, stuck.deps)).toBe(2);
    expect(stuck.err[0]).toMatch(/^bug report refused: a vault value was found in .*\. Nothing was written\.\s*$/);
    expect(existsSync(join(fresh, APP.id))).toBe(false);
  });
});
