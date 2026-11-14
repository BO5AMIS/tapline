import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BugFinding } from "../src/bug.js";
import { makeBug, type BugContext, type MakeArgs } from "../src/bugreport.js";
import { BugGateError, BugStore, gateFiles } from "../src/bugstore.js";

// PR 14, Codex cycle 3 and CodeRabbit (R4): the gate. Every value is made up.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

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

const same = (text: string): string => text;

describe("R4-normalize: a value is normalized whole before its windows are taken", () => {
  it("a fragment that whitespace collapse joins across an old chunk boundary is refused (the reported case)", () => {
    const typed = `${"L".repeat(3983)}ABCDEF${" ".repeat(20)}GHIJK${"R".repeat(5000)}`;
    expect(gateFiles({ "report.md": "it held ABCDEF GHIJK here" }, same, [typed])).toBe("report.md");
    const store = new BugStore(tmp("tapline-r4-store-"));
    expect(() => makeBug(context(store, { gateValues: [typed] }), args(crash({ got: "the app crashed: it held ABCDEF GHIJK here" })))).toThrow(BugGateError);
  });

  it("a text whose own whitespace differs is normalized too", () => {
    const typed = `${"L".repeat(3983)}ABCDEF GHIJK${"R".repeat(5000)}`;
    expect(gateFiles({ "report.md": `it held ABCDEF${"\n ".repeat(9)}GHIJK here` }, same, [typed])).toBe("report.md");
  });

  it("a fragment across the old chunk boundary is found in each form", () => {
    const head = "L".repeat(3990);
    const typed = `${head}<AB&CD>"EF'GH IJ${"​"}KL;MN${"R".repeat(5000)}`;
    const raw = typed.slice(3990, 4010);
    const forms: Record<string, string> = {
      raw,
      html: raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
      percent: encodeURIComponent(raw),
      json: JSON.stringify(raw).slice(1, -1),
      stripped: raw.replace(/​/g, ""),
      collapsed: raw.replace(/​/g, "").replace(/\s+/g, " "),
    };
    for (const [form, text] of Object.entries(forms)) expect(gateFiles({ [form]: `x ${text} y` }, same, [typed]), form).toBe(form);
  });

  it("a text with none of the value's windows passes, and a long value is quick", () => {
    const typed = `${"LEFT-".repeat(8000)}MIDDLE-SECRET-VALUE${"-RIGHT".repeat(8000)}`;
    const started = Date.now();
    expect(gateFiles({ "report.md": "a perfectly ordinary report about a crash", "finding.json": "{}" }, same, [typed])).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("R4-link: a script link that can't be reached refuses the update", () => {
  const recorded = { n: 1, of: 1, build: "1.5.0 (220)", when: "2026-11-14T10:00:00.000Z", reset: "own" as const };

  it("an lstat that fails with EACCES refuses, never skips the gate", () => {
    const denied = (path: string): ReturnType<typeof lstatSync> => {
      if (path.endsWith("repro.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return lstatSync(path);
    };
    const store = new BugStore(tmp("tapline-r4-store-"), undefined, denied);
    const made = makeBug(context(store), args(crash()));
    expect(() => store.recordCheck("com.example.wayfare", made.meta.id, recorded, same)).toThrow(BugGateError);
  });

  it("a link whose target is gone refuses; an absent file still updates", () => {
    const store = new BugStore(tmp("tapline-r4-store-"));
    const made = makeBug(context(store), args(crash()));
    const repro = join(made.dir, "repro.json");
    rmSync(repro);
    expect(store.recordCheck("com.example.wayfare", made.meta.id, recorded, same)).not.toBeNull();
    const outside = tmp("tapline-r4-out-");
    try {
      symlinkSync(join(outside, "nowhere"), repro, "file");
    } catch {
      try {
        symlinkSync(join(outside, "nowhere"), repro, "junction");
      } catch {
        return; // a link needs a privilege on Windows
      }
    }
    expect(() => store.recordCheck("com.example.wayfare", made.meta.id, recorded, same)).toThrow(BugGateError);
    void mkdirSync;
  });
});
