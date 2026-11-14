import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BugFinding } from "../src/bug.js";
import { makeBug, type BugContext, type MakeArgs } from "../src/bugreport.js";
import { BugGateError, BugStore } from "../src/bugstore.js";

// PR 14, Codex cycle 2 and CodeRabbit (R3). Every value is made up.

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

describe("R3-gate: the middle of a long value", () => {
  it("is looked for as much as its ends", () => {
    const typed = `${"LEFT-".repeat(500)}MIDDLESECRET0123456789abcdef${"-RIGHT".repeat(500)}`;
    const store = new BugStore(tmp("tapline-r3-store-"));
    const finding = crash({ got: "the app crashed: it held MIDDLESECRET0123456789abcdef here" });
    expect(() => makeBug(context(store, { gateValues: [typed] }), args(finding))).toThrow(BugGateError);
  });

  it("still lets a text with none of the value's pieces through", () => {
    const typed = `${"LEFT-".repeat(500)}MIDDLESECRET0123456789abcdef${"-RIGHT".repeat(500)}`;
    const store = new BugStore(tmp("tapline-r3-store-"));
    expect(() => makeBug(context(store, { gateValues: [typed] }), args(crash()))).not.toThrow();
  });
});

describe("R3-retained: a script that can't be read", () => {
  it("refuses an update instead of taking it for an empty one", () => {
    const store = new BugStore(tmp("tapline-r3-store-"));
    const made = makeBug(context(store), args(crash()));
    const repro = join(made.dir, "repro.json");
    rmSync(repro);
    mkdirSync(repro); // a folder where the script was: reading it fails with an error other than "absent"
    expect(() => store.recordCheck("com.example.wayfare", made.meta.id, { n: 1, of: 1, build: "1.5.0 (220)", when: "2026-11-14T10:00:00.000Z", reset: "own" }, (t) => t)).toThrow(BugGateError);
  });

  it("still updates a bug whose script file is simply absent", () => {
    const store = new BugStore(tmp("tapline-r3-store-"));
    const made = makeBug(context(store), args(crash()));
    rmSync(join(made.dir, "repro.json"));
    const meta = store.recordCheck("com.example.wayfare", made.meta.id, { n: 1, of: 1, build: "1.5.0 (220)", when: "2026-11-14T10:00:00.000Z", reset: "own" }, (t) => t);
    expect(meta).not.toBeNull();
    expect(readFileSync(join(made.dir, "finding.json"), "utf8")).toContain('"n": 1');
    void writeFileSync;
  });
});
