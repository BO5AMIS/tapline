import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import { AuditLog } from "../src/auditlog.js";
import type { BugFinding } from "../src/bug.js";
import { runBug, type BugCliDeps } from "../src/bugcmd.js";
import { exportBug } from "../src/bugexport.js";
import { makeBug, readRunFinding, type BugContext, type MakeArgs } from "../src/bugreport.js";
import { BugGateError, BugStore } from "../src/bugstore.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { RunResult, Runner } from "../src/journeyexport.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { EXPLORE_CAPS, flushExploreMaps, input, setupExplore, type ExploreSetup } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { repairRig, textOf as repairText } from "./repair-helpers.js";

// PR 14, CodeRabbit round 2 (R2): what is still open after the Codex round. Every value is made up.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const crash = (extra: Partial<BugFinding> = {}): BugFinding => ({
  id: "f3",
  kind: "crash",
  app: "com.example.wayfare",
  app_version: "1.5.0",
  build: "220",
  tool: "tapline",
  tool_version: "1.8.5",
  when: "2026-11-14T09:21:07.512Z",
  device: { model: "iPhone16,1", os: "iOS 19.1" },
  place: "trips_id",
  path_from: "home",
  path: [{ tool: "tap", target: { id: "trips-tab" } }],
  expected: "the screen opens",
  got: "the app crashed: TypeError: undefined is not an object",
  picture: null,
  logs: [],
  crash: { reason: "TypeError: undefined is not an object", frames: ["*TripDetail.tsx:48 renderDays"] },
  repro: null,
  count: 1,
  ...extra,
});
const context = (store: BugStore, over: Partial<BugContext> = {}): BugContext => ({ store, redact: (t) => t, placeKey: () => ({ route: ["trips", "[id]"] }), roads: () => [], needsPerson: () => false, ...over });
const args = (finding: BugFinding, over: Partial<MakeArgs> = {}): MakeArgs => ({ finding, how: "explore", sourceKey: `r/${finding.id}`, run: "r", notChecked: "no check was asked for", ...over });

// -- the ZIP staging file is never a file that was already there

describe("R2-zip: the staging file of a zip", () => {
  it("never writes through a file or link that sits at <zip>.part", async () => {
    const store = new BugStore(tmp("tapline-r2-store-"));
    const made = makeBug(context(store), args(crash()));
    const dir = tmp("tapline-r2-zip-");
    const out = join(dir, "x.zip");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    try {
      symlinkSync(victim, `${out}.part`, "file");
    } catch {
      // a link needs a privilege on Windows: a plain file already at that name stands in for it
      writeFileSync(`${out}.part`, "keep me");
      writeFileSync(victim, "keep me");
    }
    const done = await exportBug({ store, redact: (t) => t, audit: new AuditLog(tmp("tapline-r2-audit-")), run: undefined, anyPath: true }, "com.example.wayfare", made.meta.id, { to: "zip", path: out });
    expect(done.ok).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readFileSync(`${out}.part`, "utf8")).toBe("keep me");
    expect(existsSync(out)).toBe(true);
    // nothing else of ours is left next to it
    expect(readdirSync(dir).sort()).toEqual(["victim.txt", "x.zip", "x.zip.part"]);
  });
});

// -- a retry of an issue export whose files are already on the branch

interface Call {
  command: string;
  args: string[];
}

function retryGh(): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (command, a, options): Promise<RunResult> => {
    calls.push({ command, args: a });
    if (command === "gh" && a[0] === "repo" && a[1] === "clone") mkdirSync(a[3] ?? "", { recursive: true });
    if (command === "gh" && a[0] === "repo" && a[1] === "view") return { code: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }), stderr: "" };
    if (command === "gh" && a[0] === "api") return { code: 0, stdout: "", stderr: "" };
    if (command === "gh" && a[0] === "issue") return { code: 0, stdout: "https://github.com/example-org/wayfare-qa/issues/13\n", stderr: "" };
    // the files are on the branch already: the index holds no change, and git refuses an empty commit
    if (command === "git" && a[0] === "diff") return { code: 0, stdout: "", stderr: "" };
    if (command === "git" && a[0] === "commit") return { code: 1, stdout: "nothing to commit, working tree clean", stderr: "" };
    void options;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("R2-retry: files already committed", () => {
  it("goes on to the issue without a commit or a push", async () => {
    const store = new BugStore(tmp("tapline-r2-store-"));
    const made = makeBug(context(store), args(crash()));
    const gh = retryGh();
    const done = await exportBug({ store, redact: (t) => t, audit: new AuditLog(tmp("tapline-r2-audit-")), run: gh.run, makeTemp: () => tmp("tapline-r2-tmp-") }, "com.example.wayfare", made.meta.id, { to: "issue", repo: "example-org/wayfare-qa", confirm: true });
    expect(done.ok).toBe(true);
    const words = gh.calls.map((c) => `${c.command} ${c.args[0]}`);
    expect(words).toContain("gh issue");
    // the commit was refused and the index holds nothing: no push
    expect(words).toContain("git diff");
    expect(words).not.toContain("git push");
  });
});

// -- a report folder's picture and script stay inside the folder, by their real place

describe("R2-links: readRunFinding resolves paths before it reads", () => {
  it("a findings folder that links outside gives no picture, a repro folder that links outside gives no script", () => {
    const root = tmp("tapline-r2-run-");
    const outside = tmp("tapline-r2-outside-");
    writeFileSync(join(outside, "f3.jpg"), "outside picture bytes");
    writeFileSync(join(outside, "f3.json"), JSON.stringify({ outside: true }));
    const run = join(root, "run");
    mkdirSync(run);
    const finding = { id: "f3", kind: "crash", app: "a", picture: { file: "findings/f3.jpg", private: false }, repro: "repro/f3.json" };
    writeFileSync(join(run, "report.json"), JSON.stringify({ findings: [finding] }));
    symlinkSync(outside, join(run, "findings"), "junction");
    symlinkSync(outside, join(run, "repro"), "junction");
    const read = readRunFinding(run, "f3");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.picture).toBeNull();
      expect(read.script).toBeNull();
    }
  });

  it("a real folder inside the run still reads", () => {
    const run = tmp("tapline-r2-run-");
    mkdirSync(join(run, "findings"));
    mkdirSync(join(run, "repro"));
    writeFileSync(join(run, "findings", "f3.jpg"), JPEG);
    writeFileSync(join(run, "repro", "f3.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(run, "report.json"), JSON.stringify({ findings: [{ id: "f3", kind: "crash", app: "a", picture: { file: "findings/f3.jpg", private: false }, repro: "repro/f3.json" }] }));
    const read = readRunFinding(run, "f3");
    expect(read.ok && read.picture !== null && read.script !== null).toBe(true);
  });
});

// -- the same bug id in two apps

describe("R2-ambiguous: one id, two apps", () => {
  const two = (): { store: BugStore; id: string } => {
    const store = new BugStore(tmp("tapline-r2-store-"));
    const a = makeBug(context(store), args(crash()));
    const b = makeBug(context(store), args(crash({ app: "com.example.other" })));
    expect(b.meta.id).toBe(a.meta.id);
    return { store, id: a.meta.id };
  };

  it("locate never picks the first app; with the app it finds the one", () => {
    const { store, id } = two();
    expect(store.locate(id)).toBeNull();
    expect(store.holders(id).sort()).toEqual(["com.example.other", "com.example.wayfare"]);
    expect(store.locate(id, "com.example.other")?.app).toBe("com.example.other");
    expect(store.locate(id, "com.example.wayfare")?.app).toBe("com.example.wayfare");
  });

  it("the command line says which apps hold it and asks for --app, and with --app it goes on", async () => {
    const { store, id } = two();
    const out: string[] = [];
    const err: string[] = [];
    const deps: BugCliDeps = { bugsDir: store.base, redact: (t) => t, map: () => undefined, policy: DEFAULT_POLICY, out: (t) => out.push(t), err: (t) => err.push(t) };
    expect(await runBug([id], {}, deps)).toBe(2);
    expect(err.join("\n")).toMatch(/com\.example\.other/);
    expect(err.join("\n")).toMatch(/com\.example\.wayfare/);
    expect(err.join("\n")).toMatch(/--app/);
    expect(out).toEqual([]);
    expect(await runBug([id], { app: "com.example.other" }, deps)).toBe(0);
    expect(out.join("\n")).toContain("com.example.other");
  });
});

// -- the retained script passes the gate on every update

describe("R2-gate: the retained repro.json is checked before a later write", () => {
  it("a label that became a vault value after the report was made refuses the update and writes nothing", () => {
    const store = new BugStore(tmp("tapline-r2-store-"));
    const LABEL = "Zanzibar-Quartz-Label-9047";
    const first = makeBug(context(store), args(crash(), { script: { version: 2, name: "x", steps: [{ tool: "tap", target: { label: LABEL } }] } }));
    const before = readdirSync(first.dir).map((n) => `${n}:${readFileSync(join(first.dir, n), "utf8")}`);
    const later = context(store, { gateValues: [LABEL] });
    expect(() => makeBug(later, args(crash({ id: "f9" }), { sourceKey: "r2/f9" }))).toThrow(BugGateError);
    expect(() => store.recordCheck("com.example.wayfare", first.meta.id, { n: 1, of: 3 } as never, (t) => t, [LABEL])).toThrow(BugGateError);
    expect(readdirSync(first.dir).map((n) => `${n}:${readFileSync(join(first.dir, n), "utf8")}`)).toEqual(before);
  });
});

// -- a fixture is never typed as a secure value

describe("R2-fixture: the kind of a fixture whose field is named password", () => {
  it("is plain, never secure", async () => {
    const file = join(tmp("tapline-r2-vault-"), "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { test_data: { kind: "fixture", password: "pale-green-lantern-77", explore: true } } }));
    const outside: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
    const loaded = await loadAccounts(file, outside);
    if (loaded.store === null) throw new Error("vault not loaded");
    const s: ExploreSetup = await setupExplore(hosts, apps, dirs, {
      capabilities: [...EXPLORE_CAPS, "typeKind"],
      hostOptions: { redact: loaded.store.redact },
      world: (w) => void w.screens[w.screen]?.elements.push(input("name-test-safe", "Name")),
      tools: { accounts: loaded },
    });
    await s.tools.typeText({ target: { id: "name-test-safe" }, text: "${vault.test_data.password}", look: false });
    expect(s.world.typeParams.find((t) => t.id === "name-test-safe")?.kind).toBe("plain");
  });
});

// -- a recorded failure says where its path starts

describe("R2-origin: path_from of an expect_failed finding", () => {
  it("is the place of the first step of the path, not the place of the step that failed", async () => {
    const r = await repairRig(hosts, apps, dirs);
    r.script("two", [
      { tool: "tap", target: { id: "open-settings" }, place: "home" },
      { tool: "back", expect: { id: "no-such-element" }, place: "settings" },
    ]);
    const said = repairText(await r.s.tools.replay({ name: "two", repair: "suggest" }));
    const json = said.split("\n").find((line) => line.startsWith("Finding: {")) as string;
    const finding = JSON.parse(json.slice("Finding: ".length)) as { place: string; path_from: string | null; path: unknown[] };
    expect(finding.path).toHaveLength(2);
    expect(finding.place).toBe("settings");
    expect(finding.path_from).toBe("home");
  });
});

