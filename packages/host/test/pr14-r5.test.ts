import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { looseScrubber } from "../src/accounts.js";
import { BugStore, gateFiles } from "../src/bugstore.js";
import { exportBug } from "../src/bugexport.js";
import { makeBug } from "../src/bugreport.js";
import { stripPaths } from "../src/bug.js";
import { AuditLog } from "../src/auditlog.js";
import { APP } from "./drive-helpers.js";
import { flushExploreMaps, setupExplore, input } from "./explore-helpers.js";
import type { TaplineHost } from "../src/server.js";
import type { FakeApp } from "./helpers.js";
import type { BugFinding } from "../src/bug.js";

// PR 14, Codex cycle 4 (R5): the findings of the independent reproductions, as regression tests.

const dirs: string[] = [];
const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pr14-r5-"));
  dirs.push(dir);
  return dir;
};
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const finding: BugFinding = {
  id: "f1", kind: "observed", app: APP.id, app_version: "1.0.0", build: "1", tool: "tapline", tool_version: "1.8.5",
  when: "2026-11-14T09:00:00.000Z", device: { model: "fake", os: "fake" }, place: "home", path_from: "home",
  path: [{ tool: "tap", target: { id: "open-form" } }], expected: "works", got: "broken", picture: null, logs: [], repro: null, count: 1,
};

describe("R5 finding 1: the gate reads decoded views of values and files", () => {
  const value = "prefix-ABCDEFGHIJKL-suffix";
  const redact = looseScrubber([value], "<typed>");

  it("gateFiles refuses a fragment written with a JSON escape", () => {
    expect(gateFiles({ "report.md": "BCDEFG\\u0048IJKL-" }, redact, [value])).toBe("report.md");
  });

  it("refuses mixed and partial escapes (percent, entity, upper-case JSON, a form plus)", () => {
    for (const fragment of ["BCDEFG%48IJKL-", "BCDEFG&#72;IJKL-", "BCDEFG\\u0048IJKL-", "BCDEFG&#x48;IJKL-", "BCD\\u0045FG%48IJ&#75;L-", "BCDEFG\\u004" + "8IJKL-"]) {
      expect(gateFiles({ "report.md": fragment }, redact, [value]), fragment).toBe("report.md");
    }
  });

  it("refuses a value that itself holds an escape when a file holds its decoded reading", () => {
    const encoded = "token-\\u0041BCDEFGHIJK-end";
    expect(gateFiles({ "report.md": "xx ABCDEFGHIJK-end yy" }, (t) => t, [encoded])).toBe("report.md");
  });

  it("still passes an unrelated file", () => {
    expect(gateFiles({ "report.md": "nothing here \\u0048 at all, 100% sure" }, redact, [value])).toBeNull();
  });

  it("makeBug and a zip export keep the fragment out", async () => {
    const store = new BugStore(tmp());
    const fragment = "BCDEFG\\u0048IJKL-";
    let made: ReturnType<typeof makeBug> | null = null;
    let thrown: unknown = null;
    try {
      made = makeBug({ store, redact, gateValues: [value], placeKey: () => ({ route: ["home"] }), roads: () => [], needsPerson: () => false },
        { finding: { ...finding, got: fragment }, how: "now", sourceKey: "now/1", notChecked: "no check" });
    } catch (error) {
      thrown = error;
    }
    if (made !== null) {
      const text = readFileSync(join(made.dir, "report.md"), "utf8");
      expect(text.includes(fragment)).toBe(false);
      const result = await exportBug({ store, redact, gateValues: [value], audit: new AuditLog(tmp()), run: undefined, anyPath: true }, APP.id, made.meta.id, { to: "zip", path: join(tmp(), "bug.zip") });
      expect(result.ok).toBe(true);
    } else {
      expect(thrown).not.toBeNull();
    }
  });
});

describe("R5 finding 2: export checks again against values registered during the export", () => {
  const secret = "fresh-sensitive-script-label-4417";

  const setup = () => {
    let values: string[] = [];
    const redact = (t: string): string => looseScrubber(values, "<typed>")(t);
    const store = new BugStore(tmp());
    const made = makeBug({ store, redact, gateValues: () => values, placeKey: () => ({ route: ["home"] }), roads: () => [], needsPerson: () => false },
      { finding, how: "now", sourceKey: "now/1", notChecked: "no check", script: { version: 2, name: "repro", steps: [{ tool: "tap", target: { label: secret } }] } });
    return { store, redact, made, register: () => { values = [secret]; }, values: () => values };
  };

  it("an issue export refuses when the label is registered while gh runs, and pushes nothing", async () => {
    const { store, redact, made, register, values } = setup();
    const calls: string[] = [];
    let pushedSecret = false;
    let clone = "";
    const run = async (command: string, args: string[]) => {
      calls.push(`${command} ${args[0] ?? ""} ${args[1] ?? ""}`.trim());
      if (command === "gh" && args[0] === "auth") register();
      if (command === "gh" && args[0] === "repo" && args[1] === "view") return { code: 0, stdout: '{"visibility":"PRIVATE"}', stderr: "" };
      if (command === "gh" && args[0] === "repo" && args[1] === "clone") { clone = args[3] as string; mkdirSync(clone, { recursive: true }); }
      if (command === "git" && args[0] === "push") pushedSecret = readFileSync(join(clone, ".tapline", "bugs", made.meta.id, "repro.json"), "utf8").includes(secret);
      return { code: 0, stdout: command === "gh" && args[0] === "issue" ? "https://github.com/example/repo/issues/1" : "", stderr: "" };
    };
    const result = await exportBug({ store, redact, gateValues: values, audit: new AuditLog(tmp()), run }, APP.id, made.meta.id, { to: "issue", repo: "example/repo", confirm: true });
    expect(result.ok).toBe(false);
    expect(pushedSecret).toBe(false);
    expect(calls.some((c) => c.startsWith("git push"))).toBe(false);
    expect(calls.some((c) => c.startsWith("gh issue"))).toBe(false);
  });

  it("a zip export refuses when the label is registered after the first check, before the zip is written", async () => {
    const { store, redact, made, register, values } = setup();
    // The audit write is the last step before the zip is written: the label is registered there.
    const base = new AuditLog(tmp());
    const audit = { write: (entry: Parameters<AuditLog["write"]>[0]) => { register(); return base.write(entry); } };
    const out = join(tmp(), "late.zip");
    const result = await exportBug({ store, redact, gateValues: values, audit, run: undefined, anyPath: true }, APP.id, made.meta.id, { to: "zip", path: out });
    expect(result.ok).toBe(false);
    expect(() => readFileSync(out)).toThrow();
  });

  it("a value registered while the push runs refuses before the issue is created", async () => {
    const late = "late-registered-got-text-7731";
    let values: string[] = [];
    const redact = (t: string): string => looseScrubber(values, "<typed>")(t);
    const store = new BugStore(tmp());
    const made = makeBug({ store, redact, gateValues: () => values, placeKey: () => ({ route: ["home"] }), roads: () => [], needsPerson: () => false },
      { finding: { ...finding, got: late }, how: "now", sourceKey: "now/1", notChecked: "no check" });
    const calls: string[] = [];
    let clone = "";
    const run = async (command: string, args: string[]) => {
      calls.push(command + " " + (args[0] ?? "") + " " + (args[1] ?? ""));
      if (command === "gh" && args[0] === "repo" && args[1] === "view") return { code: 0, stdout: '{"visibility":"PRIVATE"}', stderr: "" };
      if (command === "gh" && args[0] === "repo" && args[1] === "clone") { clone = args[3] as string; mkdirSync(clone, { recursive: true }); }
      if (command === "git" && args[0] === "push") values = [late];
      return { code: 0, stdout: command === "gh" && args[0] === "issue" ? "https://github.com/example/repo/issues/1" : "", stderr: "" };
    };
    const result = await exportBug({ store, redact, gateValues: () => values, audit: new AuditLog(tmp()), run }, APP.id, made.meta.id, { to: "issue", repo: "example/repo", confirm: true });
    expect(clone).not.toBe("");
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("gh issue"))).toBe(false);
  });
});

describe("R5 finding 3: verification evaluates a typing step's expect", () => {
  it("a type_text step whose expect never holds is not reproduced as a pass", async () => {
    const bugsDir = tmp();
    const s = await setupExplore(hosts, apps, dirs, {
      world: (w) => { w.screens[w.screen]?.elements.push(input("email-field", "Email")); },
      tools: { bugsDir, logDir: tmp(), journeysDir: tmp() },
    });
    const failed = await s.tools.run({ steps: [{ tool: "type_text", target: { id: "email-field" }, text: "test@example.com", expect: { id: "never-present" } }], look: false });
    expect(failed.isError).toBe(true);
    const answer = textOf(await s.tools.bugReport({ from: "failure", verify: false }));
    const id = /bug_[0-9a-f]{16}(?:_\d+)?/.exec(answer)?.[0] as string;
    const stored = new BugStore(bugsDir).read(APP.id, id);
    expect(stored).not.toBeNull();
    const requestsAt = s.current().requests.length;
    const out = await s.tools.runBugCheck({ app: APP.id, id, ...(stored as NonNullable<typeof stored>) }, 1, { reset: "own", typed: async () => "test@example.com" });
    expect(out).toMatchObject({ n: 1, of: 1 });
    // The expectation was evaluated: a wait for the missing element ran after the typing.
    expect(s.current().requests.slice(requestsAt).length).toBeGreaterThan(0);
  });
});

describe("R5 finding 4: paths with spaces keep no personal name", () => {
  const cases: Array<[string, string]> = [
    [String.raw`C:\Users\Jane Doe\private-project\Crash.tsx:48 renderDays`, "Crash.tsx:48 renderDays"],
    ["C:/Users/Jane Doe/private-project/Crash.tsx:48 renderDays", "Crash.tsx:48 renderDays"],
    [String.raw`C:\Users\Jane Doe/private-project\Crash.tsx:48 renderDays`, "Crash.tsx:48 renderDays"],
    ["/Users/Jane Doe/private-project/Crash.tsx:48 renderDays", "Crash.tsx:48 renderDays"],
    ["/home/Jane Doe/private project/Crash.tsx:48 renderDays", "Crash.tsx:48 renderDays"],
    [String.raw`"C:\Users\Jane Doe\private-project\My Crash.tsx":48 renderDays`, `"My Crash.tsx":48 renderDays`],
    [`at renderDays ('/Users/Jane Doe/private-project/Crash.tsx':48)`, `at renderDays ('Crash.tsx':48)`],
  ];
  for (const [path, want] of cases) {
    it(`strips ${path}`, () => {
      const out = stripPaths(`at ${path}`);
      expect(out).not.toContain("Jane");
      expect(out).not.toContain("private");
      expect(out).toContain(want);
    });
  }

  it("a report keeps no name from a frame or a log line with spaces", () => {
    const path = String.raw`C:\Users\Jane Doe\private-project\Crash.tsx:48 renderDays`;
    const store = new BugStore(tmp());
    const made = makeBug({ store, redact: (t) => t, placeKey: () => ({ route: ["home"] }), roads: () => [], needsPerson: () => false },
      { finding: { ...finding, kind: "crash", got: "boom", crash: { reason: "boom", frames: ["*" + path] }, logs: ["at " + path] }, how: "now", sourceKey: "now/2", notChecked: "no check" });
    const text = readFileSync(join(made.dir, "report.md"), "utf8");
    expect(text).not.toContain("Jane Doe");
    expect(text).not.toContain("private-project");
    expect(text).toContain("Crash.tsx:48");
  });
});
