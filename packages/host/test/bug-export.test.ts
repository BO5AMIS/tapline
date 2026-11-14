import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts, type GitProbe } from "../src/accounts.js";
import { AuditLog, readAuditLines, type AuditSink } from "../src/auditlog.js";
import { exportBug, zipOf } from "../src/bugexport.js";
import { runBug, type BugCliDeps } from "../src/bugcmd.js";
import { BugStore } from "../src/bugstore.js";
import { callTool } from "../src/dispatch.js";
import type { RunResult, Runner } from "../src/journeyexport.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { EXPLORE_CAPS, flushExploreMaps, setupExplore, type ExploreSetup, type ExploreSetupOptions } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import type { ToolArgs } from "../src/tools.js";

// AGENT-TOOLS 1.16 §29.7, §29.9: the export of a bug to a GitHub issue and to a zip, through an injected gh and git. Nothing here runs a real one.

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
const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

interface Call {
  command: string;
  args: string[];
  cwd: string | undefined;
  /** For `git add`: the files in the clone then. For a body-file: its text. */
  files?: string[];
  body?: string;
}

function walk(root: string, rel = ""): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(root, rel === "" ? d.name : `${rel}/${d.name}`) : [rel === "" ? d.name : `${rel}/${d.name}`]));
}

/** A gh and git that only write down what they were asked. `visibility` is what `gh repo view` says; the branch `qa-reports` is missing. */
function fakeGh(visibility: string = "PRIVATE", answer: (call: Call) => Partial<RunResult> | undefined = () => undefined): { run: Runner; calls: Call[]; words: () => string[] } {
  const calls: Call[] = [];
  const run: Runner = async (command, args, options) => {
    const call: Call = { command, args, cwd: options?.cwd };
    calls.push(call);
    const bodyFile = args[args.indexOf("--body-file") + 1];
    if (args.includes("--body-file") && bodyFile !== undefined) call.body = readFileSync(bodyFile, "utf8");
    if (command === "git" && args[0] === "add" && options?.cwd !== undefined) call.files = walk(options.cwd).filter((f) => !f.startsWith(".git/"));
    if (command === "gh" && args[0] === "repo" && args[1] === "clone") mkdirSync(args[3] ?? "", { recursive: true });
    const custom = answer(call);
    if (custom !== undefined) return { code: 0, stdout: "", stderr: "", ...custom };
    if (command === "gh" && args[0] === "repo" && args[1] === "view") return { code: 0, stdout: visibility === "" ? "not json" : JSON.stringify({ visibility }), stderr: "" };
    if (command === "gh" && args[0] === "api") return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    if (command === "gh" && args[0] === "issue") return { code: 0, stdout: "https://github.com/example-org/wayfare-qa/issues/12\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const words = (): string[] => {
    const clone = calls.find((c) => c.args[0] === "repo" && c.args[1] === "clone")?.args[3] ?? "\u0000";
    const root = clone.replace(/[\\/]repo$/, "");
    return calls.map((c) => [c.command, ...c.args].join(" ").split(clone).join("<clone>").split(root).join("<tmp>").replace(/\\/g, "/"));
  };
  return { run, calls, words };
}

interface Rig {
  s: ExploreSetup;
  bugsDir: string;
  auditDir: string;
  audit: AuditLog;
  bugDir: (id: string) => string;
  /** The js_error bug of the form, made without a check. */
  make: (withPicture?: boolean) => Promise<string>;
  lines: () => Array<Record<string, unknown>>;
}

async function rig(options: ExploreSetupOptions & { audit?: AuditSink } = {}): Promise<Rig> {
  const bugsDir = tmp("tapline-export-bugs-");
  const auditDir = tmp("tapline-export-audit-");
  const audit = new AuditLog(auditDir);
  const s = await setupExplore(hosts, apps, dirs, {
    ...options,
    world: (w) => {
      w.errorOn["open-form"] = "TypeError: form failed";
      w.known = [{ route: ["home"] }, { route: ["settings"] }, { route: ["trips"] }, { route: ["form"] }];
      options.world?.(w);
    },
    tools: { bugsDir, audit: options.audit ?? audit, logDir: tmp("tapline-export-log-"), journeysDir: tmp("tapline-export-j-"), ...options.tools },
  });
  const make = async (withPicture = false): Promise<string> => {
    await s.tools.explore({});
    const appDir = join(s.exploreDir, APP.id);
    const run = join(appDir, readdirSync(appDir).sort().at(-1) as string);
    const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8")) as { findings: Array<{ id: string; kind: string }> };
    const f = report.findings.find((x) => x.kind === "js_error")?.id as string;
    const answer = textOf(await s.tools.bugReport({ finding: f, verify: false, ...(withPicture ? { with_picture: true } : {}) }));
    return /bug_[0-9a-f]{16}/.exec(answer)?.[0] as string;
  };
  return {
    s,
    bugsDir,
    auditDir,
    audit,
    bugDir: (id) => join(bugsDir, APP.id, id),
    make,
    lines: () => readAuditLines(auditDir).flatMap((l) => (l.entry === null ? [] : [l.entry as unknown as Record<string, unknown>])),
  };
}

/** The entries of a zip, read by hand: name, DOS time and date, flags, extra length, and the bytes. */
function readZip(bytes: Buffer): Array<{ name: string; time: number; date: number; flags: number; extra: number; data: Buffer; crc: number }> {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  expect(end).toBeGreaterThanOrEqual(0);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const flags = bytes.readUInt16LE(at + 8);
    const time = bytes.readUInt16LE(at + 12);
    const date = bytes.readUInt16LE(at + 14);
    const crc = bytes.readUInt32LE(at + 16);
    const csize = bytes.readUInt32LE(at + 20);
    const nameLen = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    out.push({ name, time, date, flags, extra, crc, data: inflateRawSync(bytes.subarray(start, start + csize)) });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

const REPO = "example-org/wayfare-qa";
const ISSUE = (id: string, extra: Partial<NonNullable<ToolArgs<"bug_report">["export"]>> = {}): ToolArgs<"bug_report"> => ({ bug: id, export: { to: "issue", repo: REPO, confirm: true, ...extra } });

describe("export to an issue (§29.7)", () => {
  it("needs confirm: true: without it nothing is asked of gh, and the refusal is logged", async () => {
    const gh = fakeGh();
    const r = await rig({ tools: { exportRunner: gh.run } });
    const id = await r.make();
    const refused = await r.s.tools.bugReport({ bug: id, export: { to: "issue", repo: REPO } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error not_allowed: needs_confirmation: /);
    expect(gh.calls).toEqual([]);
    expect(r.lines().map((l) => l["detail"])).toEqual([`issue ${REPO}: ${id}, refused (needs confirmation)`]);
  });

  it("opens the issue through the user's own gh: exactly these commands, the page as the body, the script on the qa-reports branch", async () => {
    const gh = fakeGh();
    const r = await rig({ tools: { exportRunner: gh.run } });
    const id = await r.make();
    const answer = textOf(await r.s.tools.bugReport(ISSUE(id)));
    const title = /^# (.*)$/m.exec(readFileSync(join(r.bugDir(id), "report.md"), "utf8"))?.[1] as string;
    expect(gh.words()).toEqual([
      "gh auth status",
      `gh repo view ${REPO} --json visibility`,
      `gh api repos/${REPO}/branches/qa-reports --silent`,
      `gh repo clone ${REPO} <clone> -- --depth 1 --no-checkout`,
      "git checkout --orphan qa-reports",
      "git rm -rf -q --ignore-unmatch .",
      `git add -f -- .tapline/bugs/${id}`,
      `git commit -m QA bug report: ${id}`,
      "git push origin HEAD:refs/heads/qa-reports",
      `gh issue create --repo ${REPO} --title ${title} --body-file <tmp>/issue.md`,
    ]);
    // never the user's working tree
    const clone = gh.calls.find((c) => c.args[1] === "clone")?.args[3] ?? "";
    for (const git of gh.calls.filter((c) => c.command === "git")) expect(git.cwd).toBe(clone);
    expect(existsSync(clone)).toBe(false);
    // only the script goes to the branch (no picture was asked for); the page is the body
    expect(gh.calls.find((c) => c.args[0] === "add")?.files).toEqual([`.tapline/bugs/${id}/repro.json`]);
    const body = gh.calls.at(-1)?.body ?? "";
    expect(body.startsWith(readFileSync(join(r.bugDir(id), "report.md"), "utf8").trimEnd())).toBe(true);
    expect(body).toContain(`https://github.com/${REPO}/raw/qa-reports/.tapline/bugs/${id}/repro.json`);
    expect(body).not.toContain("picture.jpg");
    expect(answer).toBe(`Exported: wrote repro.json to .tapline/bugs/${id}/ on branch qa-reports of ${REPO} (made it), and opened an issue: https://github.com/${REPO}/issues/12`);
  });

  it("a public repository is refused unless public: true; one whose visibility can't be told counts as public", async () => {
    const pub = fakeGh("PUBLIC");
    const r = await rig({ tools: { exportRunner: pub.run } });
    const id = await r.make();
    const refused = textOf(await r.s.tools.bugReport(ISSUE(id)));
    expect(refused).toMatch(/^Error not_allowed: export refused: example-org\/wayfare-qa is a public repository, so the report would be visible to everyone; export again with public: true/);
    expect(pub.words()).toEqual(["gh auth status", `gh repo view ${REPO} --json visibility`]);
    expect(r.lines().map((l) => l["detail"])).toEqual([`issue ${REPO}: ${id}, refused (public repository)`]);
    // unknown counts as public
    const unknown = fakeGh("");
    const u = await rig({ tools: { exportRunner: unknown.run } });
    const uid = await u.make();
    expect(textOf(await u.s.tools.bugReport(ISSUE(uid)))).toMatch(/^Error not_allowed: export refused: Tapline couldn't tell whether example-org\/wayfare-qa is public, so it counts as public/);
    // with public: true it goes, and the audit line ends (public)
    const again = await r.s.tools.bugReport(ISSUE(id, { public: true }));
    expect(textOf(again)).toContain("opened an issue: https://github.com/example-org/wayfare-qa/issues/12 (public)");
    expect(r.lines().map((l) => l["detail"]).at(-1)).toBe(`issue ${REPO}: ${id}, picture not sent (public)`);
  });

  it("a private picture goes only when the bug was made with with_picture and the export says it too", async () => {
    // never made into the folder: with_picture at export finds nothing to send
    const a = fakeGh();
    const r1 = await rig({ tools: { exportRunner: a.run } });
    const id1 = await r1.make(false);
    expect(existsSync(join(r1.bugDir(id1), "picture.jpg"))).toBe(false);
    expect(textOf(await r1.s.tools.bugReport(ISSUE(id1, { with_picture: true })))).not.toContain("picture");
    expect(a.calls.find((c) => c.args[0] === "add")?.files).toEqual([`.tapline/bugs/${id1}/repro.json`]);
    // in the folder (the bug said so) but the export doesn't: left out
    const b = fakeGh();
    const r2 = await rig({ tools: { exportRunner: b.run } });
    const id2 = await r2.make(true);
    expect(existsSync(join(r2.bugDir(id2), "picture.jpg"))).toBe(true);
    const left = textOf(await r2.s.tools.bugReport(ISSUE(id2)));
    expect(left).toContain("The private picture was left out.");
    expect(b.calls.find((c) => c.args[0] === "add")?.files).toEqual([`.tapline/bugs/${id2}/repro.json`]);
    expect(b.calls.at(-1)?.body).not.toContain("picture.jpg");
    expect(r2.lines().map((l) => l["detail"])).toEqual([`issue ${REPO}: ${id2}, picture not sent`]);
    // both asked: it goes, and the body links it
    const c = fakeGh();
    const r3 = await rig({ tools: { exportRunner: c.run } });
    const id3 = await r3.make(true);
    expect(textOf(await r3.s.tools.bugReport(ISSUE(id3, { with_picture: true })))).toContain("wrote repro.json and picture.jpg to");
    expect([...(c.calls.find((x) => x.args[0] === "add")?.files ?? [])].sort()).toEqual([`.tapline/bugs/${id3}/picture.jpg`, `.tapline/bugs/${id3}/repro.json`]);
    expect(c.calls.at(-1)?.body).toContain(`/raw/qa-reports/.tapline/bugs/${id3}/picture.jpg`);
    expect(r3.lines().map((l) => l["detail"])).toEqual([`issue ${REPO}: ${id3}, picture sent`]);
  });

  it("a picture that isn't private goes always", async () => {
    const gh = fakeGh();
    const r = await rig({ tools: { exportRunner: gh.run } });
    const id = await r.make(true);
    const path = join(r.bugDir(id), "finding.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { picture: { file: string; private: boolean } };
    stored.picture.private = false;
    writeFileSync(path, JSON.stringify(stored));
    await r.s.tools.bugReport(ISSUE(id));
    expect([...(gh.calls.find((x) => x.args[0] === "add")?.files ?? [])].sort()).toEqual([`.tapline/bugs/${id}/picture.jpg`, `.tapline/bugs/${id}/repro.json`]);
  });

  it("an @name in the page can't ping anyone; the bad repo, a missing gh and an unknown bug are said, not sent", async () => {
    const gh = fakeGh();
    const r = await rig({ tools: { exportRunner: gh.run } });
    const id = await r.make();
    const md = join(r.bugDir(id), "report.md");
    writeFileSync(md, `${readFileSync(md, "utf8")}\nask @someone-else about it\n`);
    await r.s.tools.bugReport(ISSUE(id));
    expect(gh.calls.at(-1)?.body).toContain("@​someone-else");
    expect(textOf(await r.s.tools.bugReport(ISSUE(id, { repo: "not a repo" })))).toMatch(/^Error bad_params: export to an issue needs repo as owner\/name/);
    expect(textOf(await r.s.tools.bugReport({ bug: "bug_0123456789abcdef", export: { to: "zip" } }))).toMatch(/^Error not_found: no bug/);
    expect(textOf(await r.s.tools.bugReport({ bug: id, export: { to: "issue", repo: "a/b", confirm: true }, with_picture: true }))).toMatch(/^Error bad_params: export is a call of its own/);
    const none = await rig();
    const nid = await none.make();
    expect(textOf(await none.s.tools.bugReport(ISSUE(nid)))).toMatch(/^Error unsupported: export isn't available here: this server has no GitHub runner/);
  });

  it("a gh that isn't signed in stops it before anything is written; a push that fails says so", async () => {
    const out = fakeGh("PRIVATE", (call) => (call.args[0] === "auth" ? { code: 1, stderr: "You are not logged in to any GitHub hosts. Run gh auth login" } : undefined));
    const r = await rig({ tools: { exportRunner: out.run } });
    const id = await r.make();
    expect(textOf(await r.s.tools.bugReport(ISSUE(id)))).toMatch(/^Error not_allowed: export refused: gh isn't signed in/);
    expect(r.lines()).toEqual([]);
    const bad = fakeGh("PRIVATE", (call) => (call.command === "git" && call.args[0] === "push" ? { code: 1, stderr: "remote: Permission to x denied 403" } : undefined));
    const r2 = await rig({ tools: { exportRunner: bad.run } });
    const id2 = await r2.make();
    expect(textOf(await r2.s.tools.bugReport(ISSUE(id2)))).toMatch(/^Error internal: git push was refused: you may have no write access/);
    expect(bad.calls.some((c) => c.args[0] === "issue")).toBe(false);
  });
});

describe("export to a zip (§29.7)", () => {
  it("writes <bug id>.zip next to the bug's folder, with the folder in it as it is, a fixed time, and no network", async () => {
    const gh = fakeGh();
    const r = await rig({ tools: { exportRunner: gh.run } });
    const id = await r.make();
    const answer = textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip" } }));
    const zip = join(r.bugsDir, APP.id, `${id}.zip`);
    expect(existsSync(zip)).toBe(true);
    expect(answer).toContain(`Exported: wrote 4 files of ${id} to `);
    expect(answer).toContain("No network was used.");
    expect(gh.calls).toEqual([]);
    const entries = readZip(readFileSync(zip));
    expect(entries.map((e) => e.name)).toEqual([`${id}/finding.json`, `${id}/report.html`, `${id}/report.md`, `${id}/repro.json`]);
    for (const e of entries) {
      // a fixed time (1980-01-01 00:00), UTF-8 names, no extra field: no user name, no machine path
      expect([e.time, e.date, e.flags, e.extra]).toEqual([0, 0x0021, 0x0800, 0]);
      expect(e.data.toString("utf8")).toBe(readFileSync(join(r.bugDir(id), e.name.slice(id.length + 1)), "utf8"));
      expect(e.name).not.toMatch(/Users|home|[A-Za-z]:/);
    }
    // the same files give the same bytes
    const first = readFileSync(zip);
    await r.s.tools.bugReport({ bug: id, export: { to: "zip" } });
    expect(readFileSync(zip).equals(first)).toBe(true);
    expect(zipOf([{ name: "a", data: Buffer.from("x") }]).equals(zipOf([{ name: "a", data: Buffer.from("x") }]))).toBe(true);
  });

  it("leaves a private picture out unless the export itself has with_picture", async () => {
    const r = await rig();
    const id = await r.make(true);
    await r.s.tools.bugReport({ bug: id, export: { to: "zip" } });
    const zip = join(r.bugsDir, APP.id, `${id}.zip`);
    expect(readZip(readFileSync(zip)).map((e) => e.name)).not.toContain(`${id}/picture.jpg`);
    const said = textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip", with_picture: true } }));
    expect(readZip(readFileSync(zip)).map((e) => e.name)).toContain(`${id}/picture.jpg`);
    expect(said).toContain("the picture is in it");
    expect(r.lines().map((l) => l["detail"])).toEqual([expect.stringMatching(new RegExp(`^zip .*${id}\\.zip: ${id}, picture not sent$`)), expect.stringMatching(new RegExp(`^zip .*${id}\\.zip: ${id}, picture sent$`))]);
  });

  it("a call's path must stay in the bugs folder; the command line's may go anywhere", async () => {
    const r = await rig();
    const id = await r.make();
    const away = join(tmp("tapline-away-"), "mine.zip");
    expect(textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip", path: away } }))).toMatch(/^Error bad_params: a zip goes next to the bug's folder/);
    expect(existsSync(away)).toBe(false);
    expect(textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip", path: join(r.bugsDir, APP.id, "again.zip") } }))).toContain("Exported");
  });
});

describe("every export checks every file again (E1, §29.6, §29.7)", () => {
  const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };
  const DESTINATION = "Lisbon-Alfama-Tram-28-Route";

  async function vaultRig(gh: ReturnType<typeof fakeGh>): Promise<{ r: Rig; id: string }> {
    const file = join(tmp("tapline-vault-"), "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, vault: { trip_data: { kind: "fixture", destination: DESTINATION, explore: true } } }));
    const loaded = await loadAccounts(file, OUTSIDE);
    if (loaded.store === null) throw new Error("vault not loaded");
    const r = await rig({ capabilities: [...EXPLORE_CAPS], hostOptions: { redact: loaded.store.redact }, tools: { accounts: loaded, exportRunner: gh.run } });
    return { r, id: await r.make() };
  }

  it("a vault value planted into a file after the bug was made: the export refuses, names the file and not the value, sends nothing, and logs it", async () => {
    const gh = fakeGh();
    const { r, id } = await vaultRig(gh);
    for (const [name, to] of [["report.md", { to: "zip" }], ["repro.json", { to: "zip" }], ["finding.json", { to: "zip" }], ["report.html", { to: "zip" }], ["report.md", { to: "issue", repo: REPO, confirm: true }]] as const) {
      const path = join(r.bugDir(id), name);
      const clean = readFileSync(path, "utf8");
      // a JSON file stays JSON (the bug is read from it)
      writeFileSync(path, name.endsWith(".json") ? clean.replace(/^\{/, `{"note": "${DESTINATION}",`) : `${clean}\nnote: ${DESTINATION}\n`);
      const answer = textOf(await r.s.tools.bugReport({ bug: id, export: { ...to } }));
      expect(answer).toBe(to.to === "zip" && name === "report.html" ? answer : `Error not_allowed: export refused: a vault value was found in ${name}.`);
      expect(answer).not.toContain(DESTINATION);
      writeFileSync(path, clean);
    }
    expect(existsSync(join(r.bugsDir, APP.id, `${id}.zip`))).toBe(false);
    // issue: nothing past the refusal (not even gh auth), and every refusal has its line
    expect(gh.calls).toEqual([]);
    const details = r.lines().map((l) => String(l["detail"]));
    expect(details).toHaveLength(5);
    for (const d of details) expect(d).toMatch(/refused \(redaction check\)$/);
    expect(details.join("\n")).not.toContain(DESTINATION);
    // and once clean, the same export goes
    expect(textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip" } }))).toContain("Exported");
  });

  it("every form and every 12-character piece of a value is found, in every file, for a zip and an issue body", async () => {
    const r = await rig();
    const id = await r.make();
    const value = "Zq secret value 9 and more";
    // the forms of a value (as it is, percent and form encoded) and its 12-character pieces are refused; an 11-character piece isn't a form
    const refusedForms = [value, encodeURIComponent(value), value.replace(/ /g, "+"), value.slice(5, 17), value.slice(-12)];
    const forms = [...refusedForms, value.slice(5, 16)];
    const store = new BugStore(r.bugsDir);
    const found = store.locate(id);
    const dir = found?.stored.dir as string;
    const base = readFileSync(join(dir, "report.md"), "utf8");
    for (const form of forms.filter((f) => f.length >= 3)) {
      writeFileSync(join(dir, "report.md"), `${base}\nsee ${form}\n`);
      const zipped = await exportBug({ store, redact: (t) => t, gateValues: [value], audit: r.audit, run: undefined }, APP.id, id, { to: "zip" });
      const expected = refusedForms.includes(form) ? "refused" : "sent";
      expect(zipped.ok ? "sent" : "refused", `${form}`).toBe(expected);
    }
    writeFileSync(join(dir, "report.md"), base);
  });

  it("with the audit log unwritable nothing is sent", async () => {
    const gh = fakeGh();
    const r = await rig({ audit: { write: () => false }, tools: { exportRunner: gh.run } });
    const id = await r.make();
    expect(textOf(await r.s.tools.bugReport(ISSUE(id)))).toBe("Error not_allowed: export refused: the audit log can't be written. Nothing was sent.");
    // gh was only asked who it is and what the repository is: no clone, no push, no issue
    expect(gh.calls.map((c) => c.args[0])).toEqual(["auth", "repo"]);
    expect(textOf(await r.s.tools.bugReport({ bug: id, export: { to: "zip" } }))).toMatch(/^Error not_allowed: export refused: the audit log can't be written/);
    expect(existsSync(join(r.bugsDir, APP.id, `${id}.zip`))).toBe(false);
    // and a server with no audit log at all sends nothing either
    const bare = await rig({ tools: { audit: undefined as never } });
    const bid = await bare.make();
    expect(textOf(await bare.s.tools.bugReport({ bug: bid, export: { to: "zip" } }))).toMatch(/audit log can't be written/);
  });
});

describe("the audit lines (§23, kind export)", () => {
  it("one line for each export, a refused one too: tool, kind, app, name bug_report, detail the target and the bug id, never content", async () => {
    const gh = fakeGh("PUBLIC");
    const r = await rig({ tools: { exportRunner: gh.run } });
    const id = await r.make();
    await r.s.tools.bugReport(ISSUE(id));
    await r.s.tools.bugReport(ISSUE(id, { public: true }));
    await r.s.tools.bugReport({ bug: id, export: { to: "zip" } });
    const lines = r.lines();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(["app", "detail", "kind", "name", "t", "tool"]);
      expect(line).toMatchObject({ tool: "tapline", kind: "export", app: APP.id, name: "bug_report" });
      expect(String(line["t"])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(lines.map((l) => l["detail"])).toEqual([
      `issue ${REPO}: ${id}, refused (public repository)`,
      `issue ${REPO}: ${id}, picture not sent (public)`,
      expect.stringMatching(new RegExp(`^zip .*${id}\\.zip: ${id}, picture not sent$`)),
    ]);
    const all = lines.map((l) => String(l["detail"])).join("\n");
    expect(all).not.toContain("TypeError");
  });
});

describe("tapline bug export (the command line)", () => {
  async function cliRig(gh: ReturnType<typeof fakeGh>, extra: Partial<BugCliDeps> = {}): Promise<{ r: Rig; id: string; deps: BugCliDeps; out: string[]; err: string[] }> {
    const r = await rig();
    const id = await r.make();
    const out: string[] = [];
    const err: string[] = [];
    return { r, id, out, err, deps: { bugsDir: r.bugsDir, redact: (t) => t, map: () => undefined, policy: DEFAULT_POLICY, out: (t) => out.push(t), err: (t) => err.push(t), audit: r.audit, runner: gh.run, ...extra } };
  }

  it("--issue asks `Send to GitHub? [y/N]`; --yes answers it when there is no terminal; exit 0 when done", async () => {
    const gh = fakeGh();
    const asked: string[] = [];
    const c = await cliRig(gh, { askYes: async (q) => (asked.push(q), true) });
    expect(await runBug(["export", c.id], { issue: REPO }, c.deps)).toBe(0);
    expect(asked).toEqual(["Send to GitHub? [y/N]"]);
    expect(c.out[0]).toContain(`opened an issue: https://github.com/${REPO}/issues/12`);
    // no terminal: refused unless --yes
    const none = await cliRig(fakeGh(), { askYes: async () => null });
    expect(await runBug(["export", none.id], { issue: REPO }, none.deps)).toBe(2);
    expect(none.err[0]).toMatch(/^export refused: needs_confirmation: there is no terminal to ask `Send to GitHub\? \[y\/N\]`; give --yes/);
    const yes = await cliRig(fakeGh(), { askYes: async () => null });
    expect(await runBug(["export", yes.id], { issue: REPO, yes: true }, yes.deps)).toBe(0);
    // the answer no
    const no = await cliRig(fakeGh(), { askYes: async () => false });
    expect(await runBug(["export", no.id], { issue: REPO }, no.deps)).toBe(2);
    expect(no.err[0]).toContain("not sent");
  });

  it("--public and --with-picture are passed on; a public repository is exit 2 without --public", async () => {
    const gh = fakeGh("PUBLIC");
    const c = await cliRig(gh);
    expect(await runBug(["export", c.id], { issue: REPO, yes: true }, c.deps)).toBe(2);
    expect(c.err[0]).toMatch(/^not_allowed: export refused: example-org\/wayfare-qa is a public repository/);
    expect(await runBug(["export", c.id], { issue: REPO, yes: true, public: true }, c.deps)).toBe(0);
    expect(c.r.lines().map((l) => String(l["detail"]))).toEqual([`issue ${REPO}: ${c.id}, refused (public repository)`, `issue ${REPO}: ${c.id}, picture not sent (public)`]);
  });

  it("--zip <path> writes there and needs no confirmation or network; exit 2 for a refusal, a bad choice or an unknown bug", async () => {
    const gh = fakeGh();
    const c = await cliRig(gh);
    const path = join(tmp("tapline-zipout-"), "out.zip");
    expect(await runBug(["export", c.id], { zip: path }, c.deps)).toBe(0);
    expect(readZip(readFileSync(path)).map((e) => e.name)).toContain(`${c.id}/report.md`);
    expect(gh.calls).toEqual([]);
    expect(c.out[0]).toContain("No network was used.");
    expect(await runBug(["export", c.id], {}, c.deps)).toBe(2);
    expect(await runBug(["export", c.id], { zip: path, issue: REPO }, c.deps)).toBe(2);
    expect(await runBug(["export"], { zip: path }, c.deps)).toBe(2);
    expect(await runBug(["export", "bug_0123456789abcdef"], { zip: path }, c.deps)).toBe(2);
    expect(c.err.at(-1)).toMatch(/^no bug bug_0123456789abcdef/);
    // the gate: a planted value the CLI's redactor knows refuses with exit 2 and writes no zip
    const found = new BugStore(c.deps.bugsDir).locate(c.id);
    writeFileSync(join(found?.stored.dir as string, "report.md"), `${readFileSync(join(found?.stored.dir as string, "report.md"), "utf8")}\nthe secret-word is here\n`);
    const leaky: BugCliDeps = { ...c.deps, redact: (t) => t.split("secret-word").join("<redacted>") };
    const next = join(tmp("tapline-zipout2-"), "no.zip");
    expect(await runBug(["export", c.id], { zip: next }, leaky)).toBe(2);
    expect(c.err.at(-1)).toBe("not_allowed: export refused: a vault value was found in report.md.");
    expect(existsSync(next)).toBe(false);
  });
});
