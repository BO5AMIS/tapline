import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ingressRedactor, loadAccounts, type GitProbe } from "../src/accounts.js";
import { AuditLog } from "../src/auditlog.js";
import type { BugFinding } from "../src/bug.js";
import { exportBug } from "../src/bugexport.js";
import { runCheck, type CheckHost } from "../src/bugcheck.js";
import { makeBug, type BugContext, type MakeArgs } from "../src/bugreport.js";
import { BugStore, gateFiles } from "../src/bugstore.js";
import { OtpCodes } from "../src/otpclient.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { flushExploreMaps, input, setupExplore, type ExWorld, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import { FakeApp } from "./helpers.js";

// PR 14 security review, Codex cycle 1 (R1): six release blockers of the bug report (AGENT-TOOLS 1.16.1 §29). Every value is made up.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const BUG_ID = /bug_[0-9a-f]{16}(?:_\d+)?/;

type Loaded = Awaited<ReturnType<typeof loadAccounts>>;

async function vaultOf(entries: Record<string, Record<string, string>>): Promise<Loaded> {
  const dir = tmp("tapline-r1-vault-");
  const file = join(dir, "vault.json");
  writeFileSync(file, JSON.stringify({ version: 2, vault: entries }));
  const loaded = await loadAccounts(file, OUTSIDE);
  if (loaded.store === null) throw new Error("vault not loaded");
  return loaded;
}

interface Rig {
  s: ExploreSetup;
  bugsDir: string;
  auditDir: string;
  bugDir: (id: string) => string;
}

function broken(w: ExWorld): void {
  w.errorOn["open-form"] = "TypeError: form failed";
  w.known = [{ route: ["home"] }, { route: ["settings"] }, { route: ["trips"] }, { route: ["form"] }];
  w.screens[w.screen]?.elements.push(input("email-field", "Email"));
}

async function rig(options: ExploreSetupOptions & { loaded?: Loaded } = {}): Promise<Rig> {
  const bugsDir = tmp("tapline-r1-bugs-");
  const auditDir = tmp("tapline-r1-audit-");
  const { loaded, ...rest } = options;
  const s = await setupExplore(hosts, apps, dirs, {
    ...rest,
    world: (w) => {
      broken(w);
      rest.world?.(w);
    },
    ...(loaded !== undefined && loaded.store !== null ? { hostOptions: { ...rest.hostOptions, redact: ingressRedactor(() => loaded.store, new OtpCodes()) } } : {}),
    tools: { bugsDir, audit: new AuditLog(auditDir), logDir: tmp("tapline-r1-log-"), journeysDir: tmp("tapline-r1-j-"), ...(loaded !== undefined ? { accounts: loaded } : {}), ...rest.tools },
  });
  return { s, bugsDir, auditDir, bugDir: (id) => join(bugsDir, APP.id, id) };
}

async function makeJsBug(r: Rig): Promise<string> {
  await r.s.tools.explore({});
  const appDir = join(r.s.exploreDir, APP.id);
  const run = join(appDir, readdirSync(appDir).sort().at(-1) as string);
  const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8")) as { findings: Array<{ id: string; kind: string }> };
  const f = report.findings.find((x) => x.kind === "js_error")?.id as string;
  const answer = textOf(await r.s.tools.bugReport({ finding: f, verify: false }));
  return BUG_ID.exec(answer)?.[0] as string;
}

const filesOf = (dir: string): string[] => readdirSync(dir).filter((n) => !n.endsWith(".jpg"));
const allText = (dir: string): string => filesOf(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("\n");

// -- 1. a reset is never a repro step

describe("R1-1: a reset runs only in the fresh start, and only with reset: app", () => {
  const BAD: Array<[string, unknown[]]> = [
    ["the exact reproduction", [{ tool: "app_command", name: "reset", expect: { id: "home" } }]],
    ["without an expect", [{ tool: "app_command", name: "reset" }]],
    ["after a tap", [{ tool: "tap", target: { id: "open-form" } }, { tool: "app_command", name: "reset", expect: { id: "home" } }]],
    ["nested in a step's own list", [{ tool: "tap", target: { id: "open-form" }, steps: [{ tool: "app_command", name: "reset" }] }]],
    ["a run step inside a step", [{ tool: "run", steps: [{ tool: "app_command", name: "reset" }] }]],
    ["a drive with then", [{ tool: "drive", to: "home", then: [{ tool: "app_command", name: "reset" }] }]],
  ];

  for (const [label, steps] of BAD) {
    it(`${label}: refused before anything runs, the app's data is kept`, async () => {
      const r = await rig({ world: (w) => void (w.commands = ["reset"]) });
      const id = await makeJsBug(r);
      writeFileSync(join(r.bugDir(id), "repro.json"), JSON.stringify({ start: "home", steps }));
      const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 1 }));
      expect(r.s.world.resets).toBe(0);
      expect(answer).toMatch(/Reproduced: not checked \(step \d/);
      expect(answer).not.toMatch(/data kept/);
    });
  }

  it("reset: app still resets once per run, as the fresh start", async () => {
    const r = await rig({ world: (w) => void (w.commands = ["reset"]) });
    const id = await makeJsBug(r);
    await r.s.tools.bugReport({ bug: id, verify: 2, reset: "app" });
    expect(r.s.world.resets).toBe(2);
  });

  it("the engine refuses a step outside the allowlist before the first reset", async () => {
    const calls: string[] = [];
    const host = { build: () => "1.0 (1)", reset: async () => (calls.push("reset"), { ok: true as const, words: "x" }), clock: () => 0 } as unknown as CheckHost;
    const finding = { kind: "js_error", app: "a", expected: "", got: "x" } as unknown as BugFinding;
    const out = await runCheck(host, { finding, meta: { place_key: null, signature: "s" } as never, script: { start: null, steps: [{ tool: "app_command", name: "reset" }] } }, 1, { reset: "own" });
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ checked: false });
  });
});

// -- 2. every typed value is registered

describe("R1-2: an ordinary typed value never reaches a bug file", () => {
  const VALUE = "synthetic-typed-value-4417";

  async function typedThenReport(how: "plain" | "run"): Promise<{ text: string; r: Rig }> {
    const r = await rig();
    await r.s.tools.explore({});
    if (how === "plain") await r.s.tools.typeText({ target: { id: "email-field" }, text: VALUE, look: false });
    else await r.s.tools.run({ steps: [{ tool: "type_text", target: { id: "email-field" }, text: VALUE }], look: false });
    const answer = textOf(await r.s.tools.bugReport({ from: "now", note: `the form echoed ${VALUE} back`, expected: `no ${VALUE}` }));
    const id = BUG_ID.exec(answer)?.[0] as string;
    return { text: `${answer}\n${allText(r.bugDir(id))}`, r };
  }

  it("ordinary type_text, then a bug: report.md, finding.json and the answer hold no value", async () => {
    const { text } = await typedThenReport("plain");
    expect(text).not.toContain(VALUE);
    expect(text).toContain("${typed}");
  });

  it("a type_text step of run is registered the same", async () => {
    const { text } = await typedThenReport("run");
    expect(text).not.toContain(VALUE);
  });

  it("a public fake and a text under the minimum are not registered", async () => {
    const r = await rig();
    await r.s.tools.typeText({ target: { id: "email-field" }, text: "ab", look: false });
    await r.s.tools.typeText({ target: { id: "email-field" }, text: "test@example.com", look: false });
    const answer = textOf(await r.s.tools.bugReport({ from: "now", note: "ab and test@example.com stay readable" }));
    const md = readFileSync(join(r.bugDir(BUG_ID.exec(answer)?.[0] as string), "report.md"), "utf8");
    expect(md).toContain("ab and test@example.com stay readable");
  });
});

// -- 3. overlapping values in one pass

describe("R1-3: a typed value that holds a vault value leaves no fragment", () => {
  const SECRET = "Vault-Secret-Pw-9981-zq";
  const TYPED = `LEFT-PRIVATE-${SECRET}-RIGHT-TYPED-FRAGMENT`;

  it("every bug path shows the placeholder of the longest match and none of its pieces", async () => {
    const loaded = await vaultOf({ tester: { kind: "account", username: "jane.quill@example.test", password: SECRET } });
    const r = await rig({ loaded });
    await r.s.tools.explore({});
    await r.s.tools.typeText({ target: { id: "email-field" }, text: TYPED, look: false });
    const answer = textOf(await r.s.tools.bugReport({ from: "now", note: `the form echoed ${TYPED} back`, expected: `kept ${TYPED}` }));
    const id = BUG_ID.exec(answer)?.[0] as string;
    const all = `${answer}\n${allText(r.bugDir(id))}\n${textOf(await r.s.tools.bugReport({ bug: id }))}`;
    for (const piece of [SECRET, "RIGHT-TYPED-FRAGMENT", "LEFT-PRIVATE", "-RIGHT", "Vault-Secret"]) expect(all, piece).not.toContain(piece);
  });
});

// -- 4. production export grep

describe("R1-4: the production export gate checks every 12-character piece of the live values", () => {
  const SECRET = "Zq9-vault-secret-ABCDEFGH-XYZ";

  it("a non-prefix slice of a vault secret in report.md refuses the zip", async () => {
    const loaded = await vaultOf({ tester: { kind: "account", username: "jane.quill@example.test", password: SECRET } });
    const r = await rig({ loaded });
    const id = await makeJsBug(r);
    const slice = SECRET.slice(7, 19);
    expect(slice).toHaveLength(12);
    const page = join(r.bugDir(id), "report.md");
    writeFileSync(page, `${readFileSync(page, "utf8")}\nnote: ${slice}\n`);
    const answer = textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip" } }));
    expect(answer).toMatch(/^Error not_allowed: export refused: a vault value was found in report\.md/);
    expect(existsSync(join(r.bugsDir, APP.id, `${id}.zip`))).toBe(false);
  });

  it("a slice of a typed value in finding.json refuses it too, and an unrelated page goes", async () => {
    const r = await rig();
    const id = await makeJsBug(r);
    const ok = textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip" } }));
    expect(ok).toMatch(/^Exported/);
    await r.s.tools.typeText({ target: { id: "email-field" }, text: "synthetic-typed-value-4417", look: false });
    const file = join(r.bugDir(id), "finding.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...stored, got: "saw ic-typed-val in it" }));
    expect(textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip" } }))).toMatch(/^Error not_allowed: export refused: a vault value was found in finding\.json/);
  });

  it("gateFiles finds any 12-character window of any form, not only prefixes of the raw value", () => {
    const value = "Some-Secret-Value-With-Space é";
    const encoded = encodeURIComponent(value);
    expect(gateFiles({ "a.md": `x ${encoded.slice(6, 18)} y` }, (t) => t, [value])).toBe("a.md");
    expect(gateFiles({ "a.md": `x ${value.slice(9, 21)} y` }, (t) => t, [value])).toBe("a.md");
    expect(gateFiles({ "a.md": "nothing here at all, just words" }, (t) => t, [value])).toBeNull();
    expect(gateFiles({ "a.md": `x ${value.slice(9, 20)} y` }, (t) => t, [value])).toBeNull();
    // values come lazily too (the live stores)
    expect(gateFiles({ "a.md": `x ${value.slice(9, 21)} y` }, (t) => t, () => [value])).toBe("a.md");
  });
});

// -- 5. a picture's privacy belongs to its bytes

/** Whether the zip holds a picture entry (entry names are stored plain). */
const hasPicture = (zip: string): boolean => readFileSync(zip).includes(Buffer.from("/picture.jpg"));

describe("R1-5: a later sighting never admits bytes of another privacy", () => {
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
    picture: { file: "findings/f3.jpg", private: true },
    logs: [],
    crash: { reason: "TypeError: undefined is not an object", frames: ["*TripDetail.tsx:48 renderDays"] },
    repro: null,
    count: 1,
    ...extra,
  });
  const context = (store: BugStore): BugContext => ({ store, redact: (t) => t, placeKey: () => ({ route: ["trips", "[id]"] }), roads: () => [], needsPerson: () => false });
  const args = (finding: BugFinding, over: Partial<MakeArgs> = {}): MakeArgs => ({ finding, how: "explore", sourceKey: `r/${finding.id}`, run: "r", notChecked: "no check was asked for", ...over });

  it("first sighting public with no bytes, a later private picture is not stored (and not exported)", async () => {
    const store = new BugStore(tmp("tapline-r1-store-"));
    const first = makeBug(context(store), args(crash({ picture: { file: "findings/f3.jpg", private: false } }), { picture: null }));
    const later = makeBug(context(store), args(crash({ id: "f9", picture: { file: "findings/f9.jpg", private: true } }), { sourceKey: "r2/f9", picture: JPEG }));
    expect(later.meta.id).toBe(first.meta.id);
    expect(existsSync(join(first.dir, "picture.jpg"))).toBe(false);
    expect(later.meta.picture_included).toBe(false);
    const out = join(tmp("tapline-r1-zip-"), "x.zip");
    const done = await exportBug({ store, redact: (t) => t, audit: new AuditLog(tmp("tapline-r1-audit-")), run: undefined, anyPath: true }, "com.example.wayfare", first.meta.id, { to: "zip", path: out });
    expect(done.ok).toBe(true);
    expect(hasPicture(out)).toBe(false);
  });

  it("the export decides from the record of the exact bytes, not from the finding's flag", async () => {
    const store = new BugStore(tmp("tapline-r1-store-"));
    const made = makeBug(context(store), args(crash(), { picture: JPEG, withPicture: true }));
    expect(existsSync(join(made.dir, "picture.jpg"))).toBe(true);
    const file = join(made.dir, "finding.json");
    const edited = JSON.parse(readFileSync(file, "utf8")) as { picture: { private: boolean } };
    edited.picture.private = false;
    writeFileSync(file, JSON.stringify(edited));
    const out = join(tmp("tapline-r1-zip-"), "y.zip");
    const deps = { store, redact: (t: string) => t, audit: new AuditLog(tmp("tapline-r1-audit-")), run: undefined, anyPath: true };
    await exportBug(deps, "com.example.wayfare", made.meta.id, { to: "zip", path: out });
    expect(hasPicture(out)).toBe(false);
    const asked = join(tmp("tapline-r1-zip-"), "z.zip");
    await exportBug(deps, "com.example.wayfare", made.meta.id, { to: "zip", path: asked, with_picture: true });
    expect(hasPicture(asked)).toBe(true);
    // swapped bytes no longer match the record: still private
    writeFileSync(join(made.dir, "picture.jpg"), new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]));
    const swapped = join(tmp("tapline-r1-zip-"), "w.zip");
    await exportBug(deps, "com.example.wayfare", made.meta.id, { to: "zip", path: swapped });
    expect(hasPicture(swapped)).toBe(false);
  });
});

// -- 6. the check goes to the app the bug is for

describe("R1-6: the check runs only on a connected session of the bug's own app", () => {
  it("with another app in front it makes no move and says why", async () => {
    const r = await rig({ world: (w) => void (w.commands = ["reset"]) });
    const id = await makeJsBug(r);
    const other = await FakeApp.connect(r.s.port, { app: { name: "Other", id: "com.example.other", version: "2.0.0", build: "9" }, capabilities: ["tree", "press", "logs", "dryRun", "place", "places"] }, () => ({ ok: true, result: {} }));
    apps.push(other.app);
    const before = r.s.world.asked.length;
    const answer = textOf(await r.s.tools.bugReport({ bug: id, verify: 2, reset: "app" }));
    expect(answer).toMatch(/Reproduced: not checked \(.*com\.example\.wayfare/);
    expect(other.app.requests.filter((q) => !["tree", "logs", "place", "places"].includes(q.method))).toEqual([]);
    expect(r.s.world.asked.length).toBe(before);
    expect(r.s.world.resets).toBe(0);
  });

  it("the engine stops before the next action when the session is gone, and says why", async () => {
    const moves: string[] = [];
    let gone: string | null = null;
    const host = {
      clock: () => 0,
      wall: () => new Date(0),
      build: () => "1.0 (1)",
      away: () => gone,
      reset: async () => ({ ok: true as const, words: "reload only, data kept" }),
      start: async () => true,
      step: async (step: { tool: string }) => (moves.push(step.tool), (gone = "stopped (com.example.other is in front now, not a)"), { kind: "ok" as const }),
      mark: () => 0,
      since: async () => ({ crash: null, disconnected: false, errors: [] }),
      placeKey: async () => null,
      issues: async () => null,
      inFront: () => true,
      redact: (t: string) => t,
    } as unknown as CheckHost;
    const finding = { kind: "js_error", app: "a", expected: "", got: "x" } as unknown as BugFinding;
    const steps = [{ tool: "tap", target: { id: "a" } }, { tool: "back" }, { tool: "back" }];
    const out = await runCheck(host, { finding, meta: { place_key: null, signature: "s" } as never, script: { start: null, steps } }, 1, { reset: "own" });
    expect(moves).toEqual(["tap"]);
    expect(out).toEqual({ checked: false, why: "stopped (com.example.other is in front now, not a)" });
  });
});

// -- P2. one deadline

describe("R1-P2: one absolute deadline covers the reset, the way to the start and each step", () => {
  it("a step that never answers ends the run as not checked (timed out)", async () => {
    let now = 0;
    const aborted: boolean[] = [];
    const host: CheckHost = {
      clock: () => now,
      wall: () => new Date(0),
      build: () => "1.0 (1)",
      reset: async () => ({ ok: true, words: "reload only, data kept" }),
      start: async () => true,
      step: (_step, _typed, signal) =>
        new Promise((resolve) => {
          now += 1000;
          signal?.addEventListener("abort", () => (aborted.push(true), resolve({ kind: "ok" })));
        }),
      mark: () => 0,
      since: async () => ({ crash: null, disconnected: false, errors: [] }),
      placeKey: async () => null,
      issues: async () => null,
      inFront: () => true,
      redact: (t) => t,
      deadlineMs: 20,
    } as CheckHost;
    const finding = { kind: "js_error", app: "a", expected: "", got: "x" } as unknown as BugFinding;
    const out = await runCheck(host, { finding, meta: { place_key: null, signature: "s" } as never, script: { start: null, steps: [{ tool: "tap", target: { id: "x" } }] } }, 1, { reset: "own" });
    expect(out).toEqual({ checked: false, why: "timed out" });
    expect(aborted).toEqual([true]);
  });
});

void mkdirSync;
