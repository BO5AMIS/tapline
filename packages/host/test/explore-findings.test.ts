import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import { FINDING_KINDS, FindingBook, cutText, reproScript, type Finding } from "../src/findings.js";
import { RUNS_KEPT, openRunFolder, reportMarkdown, type ExploreReport } from "../src/explorereport.js";
import { crashFacts } from "../src/explore.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { btn, flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
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

const setup = (options: ExploreSetupOptions = {}): Promise<ExploreSetup> => setupExplore(hosts, apps, dirs, options);
const lastRun = (s: ExploreSetup): string => {
  const appDir = join(s.exploreDir, APP.id);
  return join(appDir, readdirSync(appDir).sort().at(-1) as string);
};
const reportOf = (s: ExploreSetup): ExploreReport => JSON.parse(readFileSync(join(lastRun(s), "report.json"), "utf8")) as ExploreReport;
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, `${prefix}${name}/`) : [`${prefix}${name}`];
  });
}

/** A world with something wrong on most screens. */
function broken(w: Parameters<NonNullable<ExploreSetupOptions["world"]>>[0]): void {
  w.screens["home"]?.elements.push(btn("open-slow", "Slow"), btn("open-covered", "Covered"));
  w.slowOn["open-slow"] = 3500;
  w.refuse["open-covered"] = { code: "not_actionable", message: "covered: a sheet covers it" };
  w.errorOn["open-form"] = "TypeError: form failed";
  w.audit["settings"] = [
    { type: "contrast", problem: "text is too pale", fix: "darken it" },
    { type: "hit_region", problem: "tap area is 20x20", fix: "make it 44x44" },
  ];
  w.ux["trips"] = [{ kind: "icon_only", problem: "an icon button has no label" }];
  w.known = [{ route: ["home"] }, { route: ["settings"] }, { route: ["trips"] }, { route: ["form"] }, { route: ["secret", "vault"] }];
}

describe("findings (§27.1): one shape for every kind", () => {
  it("every kind explore finds parses and holds the keys of §27.1", async () => {
    const s = await setup({ world: broken });
    await s.tools.explore({});
    const report = reportOf(s);
    const kinds = new Set(report.findings.map((f) => f.kind));
    for (const kind of ["js_error", "refused", "slow", "a11y", "ux", "unreachable"] as const) expect(kinds.has(kind)).toBe(true);
    for (const f of report.findings) {
      expect(FINDING_KINDS).toContain(f.kind);
      expect(Object.keys(f).sort()).toEqual(expect.arrayContaining(["id", "kind", "app", "app_version", "build", "tool", "tool_version", "when", "device", "place", "path_from", "path", "expected", "got", "picture", "logs", "repro", "count"]));
      expect(f).toMatchObject({ app: APP.id, app_version: "1.5.0", build: "220", tool: "tapline", tool_version: "1.8.0", device: { model: "iPhone18,2", os: "iOS 26.1" }, count: 1 });
      expect(f.when).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(f.id).toMatch(/^f\d+$/);
      expect(f.expected.includes("\n")).toBe(false);
      expect(f.logs.length).toBeLessThanOrEqual(20);
    }
    // Pictures are small and private (this tool can't know a test app): the report shows no picture by itself.
    const withPicture = report.findings.filter((f) => f.picture !== null);
    expect(withPicture.length).toBeGreaterThan(0);
    for (const f of withPicture) {
      expect(f.picture).toEqual({ file: `findings/${f.id}.jpg`, private: true });
      expect(statSync(join(lastRun(s), f.picture?.file as string)).size).toBeLessThan(200_000);
    }
    expect(readFileSync(join(lastRun(s), "report.md"), "utf8")).not.toContain("![");
  });

  it("says where it happened and the path from a known place, by id (never by ref), and writes a repro script", async () => {
    const s = await setup({ world: broken });
    await s.tools.explore({});
    const error = reportOf(s).findings.find((f) => f.kind === "js_error");
    expect(error).toMatchObject({ place: "home", path_from: "home", path: [{ tool: "tap", target: { id: "open-form" } }], expected: "no error in the app's log", got: "TypeError: form failed" });
    const slow = reportOf(s).findings.find((f) => f.kind === "slow");
    expect(slow?.got).toBe("3.5 s to settle");
    const refused = reportOf(s).findings.find((f) => f.kind === "refused");
    expect(refused?.got).toBe("not_actionable: covered: a sheet covers it");
    const repro = JSON.parse(readFileSync(join(lastRun(s), error?.repro as string), "utf8")) as { format: string; version: number; start: string; steps: unknown[]; name: string };
    expect(repro).toMatchObject({ format: "agent-tools-script", version: 2, start: "home", steps: [{ tool: "tap", target: { id: "open-form" } }] });
    expect(existsSync(join(lastRun(s), "repro", `${error?.id}.json`))).toBe(true);
    expect(JSON.stringify(reportOf(s))).not.toMatch(/"ref"/);
  });

  it("puts the issues of audit and ux_check on a new place into one finding each, at most 10 lines", async () => {
    const s = await setup({
      world: (w) => {
        broken(w);
        w.audit["settings"] = Array.from({ length: 14 }, (_, n) => ({ type: "contrast", problem: `issue ${n + 1}`, fix: "fix it" }));
      },
    });
    await s.tools.explore({});
    const report = reportOf(s);
    const a11y = report.findings.filter((f) => f.kind === "a11y");
    expect(a11y).toHaveLength(1);
    expect(a11y[0]?.place).toBe("settings");
    expect(a11y[0]?.got.split("\n")).toHaveLength(10);
    expect(a11y[0]?.got.split("\n")[0]).toMatch(/^contrast: .*: issue 1\. Fix: fix it\.$/);
    const ux = report.findings.filter((f) => f.kind === "ux");
    expect(ux).toHaveLength(1);
    expect(ux[0]?.place).toBe("trips");
  });

  it("reports the same finding once, with a count, and a row with no id as {row: true, index}", async () => {
    const s = await setup({
      world: (w) => {
        const trips = w.screens["trips"];
        if (trips !== undefined) {
          trips.elements = [
            trips.elements[0] as (typeof trips.elements)[number],
            { text: "Trip A", label: "Trip A", role: "button", type: "Pressable", actions: ["press"], row: true },
            { text: "Trip B", label: "Trip B", role: "button", type: "Pressable", actions: ["press"], row: true },
          ];
          trips.hidden = [];
        }
        w.errorOn["Trip A"] = "TypeError: trip failed";
        w.errorOn["Trip B"] = "TypeError: trip failed";
        w.goes["trips|Trip A"] = "trip";
        w.goes["trips|Trip B"] = "trip";
      },
    });
    await s.tools.explore({});
    const errors = reportOf(s).findings.filter((f) => f.kind === "js_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ count: 2, place: "trips", path_from: "home" });
    expect(errors[0]?.path).toEqual([
      { tool: "tap", target: { id: "open-trips" } },
      { tool: "tap", target: { row: true, index: 1 } },
    ]);
    // A row's text is private: no file of the run holds it.
    for (const file of filesUnder(lastRun(s))) expect(readFileSync(join(lastRun(s), file), "utf8")).not.toContain("Trip A");
  });

  it("holds at most 20 log lines, each cut at 300 characters, and a crash with its stack and components (§27.1)", async () => {
    const lines = Array.from({ length: 25 }, (_, n) => `error line ${n + 1} ${"x".repeat(n === 24 ? 400 : 5)}`);
    const s = await setup({
      world: (w) => {
        w.errorOn["open-form"] = lines;
      },
    });
    await s.tools.explore({});
    const error = reportOf(s).findings.find((f) => f.kind === "js_error");
    expect(error?.logs).toHaveLength(20);
    expect(error?.logs.every((line) => line.length <= 330)).toBe(true);
    expect(error?.logs.at(-1)).toMatch(/…\(\+\d+\)$/);
    expect(error?.logs[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} error /);
  });

  it("has the crash's reason, its top frames with the app's own marked *, the component stack, and no picture", async () => {
    const s = await setup({
      world: (w) => {
        w.screens["home"]?.elements.unshift(btn("boom", "Boom"));
        w.crashOn.add("boom");
      },
    });
    const answer = await s.tools.explore({});
    expect(answer.content[0]).toMatchObject({ type: "text" });
    const crash = reportOf(s).findings.find((f) => f.kind === "crash");
    expect(crash).toMatchObject({
      kind: "crash",
      place: "home",
      picture: null,
      expected: "the screen opens and the app stays open",
      path: [{ tool: "tap", target: { id: "boom" } }],
      crash: { reason: "TypeError: undefined is not an object", frames: ["*TripDetail.tsx:48 TripDetail", "x.js:1 renderWithHooks"] },
      component_stack: ["TripDetail", "TripScreen", "Stack"],
    });
    expect(crash?.got).toBe("the app crashed: TypeError: undefined is not an object (evaluating 'trip.days.map')");
  });

  it("takes crash facts from a record: frames capped at 8, a marker for the app's own", () => {
    const stack = ["TypeError: boom", ...Array.from({ length: 12 }, (_, n) => `    at fn${n} (/app/src/File${n}.tsx:${n + 1}:3)`)].join("\n");
    const facts = crashFacts({ ts: 1, name: "TypeError", message: "boom", stack, source: "live" });
    expect(facts.crash.frames).toHaveLength(8);
    expect(facts.crash.frames[0]).toBe("*File0.tsx:1 fn0");
    expect(facts.line).toBe("TypeError: boom");
  });
});

describe("findings: the book, the cut and the repro script", () => {
  const draft = (got: string, kind: Finding["kind"] = "js_error", place: string | null = "home") => ({
    kind,
    app: "a",
    app_version: "1",
    build: "2",
    tool: "tapline" as const,
    tool_version: "1.8.0",
    when: "2026-11-14T09:21:07.512Z",
    device: { model: "m", os: "o" },
    place,
    path_from: "home",
    path: [],
    expected: "e",
    got,
    logs: [],
  });

  it("merges the same kind, place and first line of got, and counts them", () => {
    const book = new FindingBook();
    expect(book.add(draft("boom\nmore")).isNew).toBe(true);
    expect(book.add(draft("boom\nother")).isNew).toBe(false);
    expect(book.add(draft("boom", "js_error", "settings")).isNew).toBe(true);
    expect(book.add(draft("boom", "slow")).isNew).toBe(true);
    expect(book.all().map((f) => [f.id, f.count])).toEqual([["f1", 2], ["f2", 1], ["f3", 1]]);
    expect(book.summary()).toBe("2 js_error, 1 slow");
  });

  it("cuts with what is missing said, and writes a typed step as ${typed} with the variable listed", () => {
    expect(cutText("x".repeat(305), 300)).toBe(`${"x".repeat(300)}…(+5)`);
    expect(cutText("short", 300)).toBe("short");
    const script = reproScript({ id: "f4", app: "a", path_from: "home", path: [{ tool: "type_text", target: { id: "name" }, text: "${typed}" }, { tool: "tap", target: { id: "save" } }] });
    expect(script).toMatchObject({ format: "agent-tools-script", version: 2, start: "home", variables: ["typed"] });
    expect(reproScript({ id: "f5", app: "a", path_from: null, path: [] })).not.toHaveProperty("start");
  });
});

describe("the report folder (§25.10)", () => {
  it("writes report.json, report.md first with the findings, the pictures and the repro scripts", async () => {
    const s = await setup({ world: broken });
    const answer = await s.tools.explore({});
    const dir = lastRun(s);
    expect(dir).toMatch(/com\.example\.wayfare[\\/]20261114T0915\d\dZ$/);
    const files = filesUnder(dir);
    expect(files).toEqual(expect.arrayContaining(["report.json", "report.md"]));
    expect(files.some((f) => /^findings\/f\d+\.jpg$/.test(f))).toBe(true);
    expect(files.some((f) => /^repro\/f\d+\.json$/.test(f))).toBe(true);
    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md.indexOf("## Findings")).toBeGreaterThan(-1);
    expect(md.indexOf("## Findings")).toBeLessThan(md.indexOf("## Coverage"));
    expect(md).toContain("Skipped");
    const report = reportOf(s);
    expect(Object.keys(report)).toEqual(["format", "version", "app", "build", "tool", "tool_version", "started", "ended", "stopped", "start_place", "budget", "used", "coverage", "findings", "skipped", "notes", "resets"]);
    expect(report.coverage).toMatchObject({ places: expect.any(Number), known_up_front: 5, reached: 4, not_reached: ["vault"], frontier_left: 0 });
    expect(report.started).toMatch(/^2026-11-14T09:15:\d\dZ$/);
    expect(report.used).toEqual({ minutes: 0, steps: expect.any(Number) });
    expect(JSON.stringify(answer.content)).toContain("Report: ");
  });

  it("keeps the newest 20 run folders of an app and removes the older ones at start", () => {
    const base = mkdtempSync(join(tmpdir(), "tapline-explore-keep-"));
    dirs.push(base);
    const appDir = join(base, "com.example.app");
    mkdirSync(appDir, { recursive: true });
    const names = Array.from({ length: 24 }, (_, n) => `202611${String(n + 1).padStart(2, "0")}T090000Z`);
    for (const name of names) mkdirSync(join(appDir, name));
    mkdirSync(join(appDir, "notes"));
    const folder = openRunFolder(base, "com.example.app", new Date(Date.UTC(2026, 11, 30, 9, 0, 0)));
    const left = readdirSync(appDir).filter((n) => /^\d{8}T/.test(n)).sort();
    expect(left).toHaveLength(RUNS_KEPT);
    expect(left.at(-1)).toBe("20261230T090000Z");
    expect(left).not.toContain(names[0]);
    expect(left).toContain(names[names.length - 1]);
    expect(existsSync(join(appDir, "notes"))).toBe(true);
    expect(folder.dir).toBe(join(appDir, "20261230T090000Z"));
    // A second run in the same second gets its own folder.
    expect(openRunFolder(base, "com.example.app", new Date(Date.UTC(2026, 11, 30, 9, 0, 0))).dir).toBe(join(appDir, "20261230T090000Z-2"));
  });

  it("names an app id that is not a plain folder name safely", () => {
    const base = mkdtempSync(join(tmpdir(), "tapline-explore-name-"));
    dirs.push(base);
    const folder = openRunFolder(base, "../evil/app", new Date(Date.UTC(2026, 10, 14, 9, 0, 0)));
    expect(folder.dir.startsWith(base)).toBe(true);
    expect(readdirSync(base)).toEqual(["__evil_app"]);
    writeFileSync(join(folder.dir, "x"), "");
  });

  it("has a markdown report that lists the findings before the rest and shows no picture itself", () => {
    const report: ExploreReport = {
      format: "agent-tools-explore-report",
      version: 1,
      app: "a",
      build: "1 (2)",
      tool: "tapline",
      tool_version: "1.8.0",
      started: "s",
      ended: "e",
      stopped: "budget_steps",
      start_place: "home",
      budget: { minutes: 1, steps: 2, depth: 3 },
      used: { minutes: 0, steps: 2 },
      coverage: { places: 1, frontier_left: 4 },
      findings: [{ ...draftFinding(), picture: { file: "findings/f1.jpg", private: true } }],
      skipped: [{ place: "home", sig: "text:Sign out", why: "floor", word: "Sign out" }],
      notes: ["rows: first 2 of the list tried (trips)"],
      resets: [{ how: "reload", data_kept: true, at_step: 3 }],
    };
    const md = reportMarkdown(report);
    expect(md.indexOf("### f1")).toBeLessThan(md.indexOf("## Coverage"));
    expect(md).toContain("findings/f1.jpg (private: may show personal data)");
    expect(md).toContain("reload only, data kept");
    expect(md).toContain("Stopped: the budget (steps) is used up.");
    expect(md).not.toContain("![");
  });
});

function draftFinding(): Finding {
  return { id: "f1", kind: "js_error", app: "a", app_version: "1", build: "2", tool: "tapline", tool_version: "1.8.0", when: "w", device: { model: "m", os: "o" }, place: "home", path_from: "home", path: [{ tool: "tap", target: { id: "x" } }], expected: "e", got: "g", picture: null, logs: [], repro: "repro/f1.json", count: 1 };
}

describe("redaction (§27.2, §20.3): nothing the vault holds is in any file of the run", () => {
  it("scrubs every form of every vault value and every 12-character piece of it, in every file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-explore-vault-"));
    dirs.push(dir);
    const file = join(dir, "vault.json");
    const values = { street: "12 Test Lane Ave", username: "explorer-4821-x", password: "hunter-2-horse-battery", note: "private-note-text-9" };
    writeFileSync(file, JSON.stringify({ version: 2, vault: { home: { kind: "address", street: values.street, city: "Testville" }, tester: { kind: "account", username: values.username, password: values.password }, memo: { kind: "note", text: values.note } } }));
    const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    const s = await setup({
      hostOptions: { redact: loaded.store.redact },
      tools: { accounts: loaded },
      world: (w) => {
        w.errorOn["open-form"] = [`failed for ${values.username} at ${values.street}`, `token ${encodeURIComponent(values.street)} and ${values.password}`, `memo ${values.note}`];
        w.audit["settings"] = [{ type: "description", problem: `label says ${values.username}`, fix: "rename" }];
        w.screens["home"]?.elements.push(btn("open-secret", `Hello ${values.username}`));
        w.goes["home|open-secret"] = "trips";
      },
    });
    await s.tools.explore({});
    const folder = lastRun(s);
    const all = filesUnder(folder).filter((f) => !f.endsWith(".jpg"));
    expect(all.length).toBeGreaterThan(3);
    const forms = (value: string): string[] => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64")];
    const pieces = (value: string): string[] => (value.length < 12 ? [] : Array.from({ length: value.length - 11 }, (_, n) => value.slice(n, n + 12)));
    const secrets = Object.values(values);
    for (const name of all) {
      const text = readFileSync(join(folder, name), "utf8");
      for (const secret of secrets) for (const form of [...forms(secret), ...pieces(secret)]) expect(text, `${name} holds ${form}`).not.toContain(form);
    }
    // What is kept says it with the placeholder, and the map holds none of it either.
    expect(readFileSync(join(folder, "report.json"), "utf8")).toContain("<tester's username>");
    await s.registry.flushAll();
    const map = readFileSync(join(s.folder, "map.json"), "utf8");
    for (const secret of secrets) for (const form of [...forms(secret), ...pieces(secret)]) expect(map).not.toContain(form);
  });
});
