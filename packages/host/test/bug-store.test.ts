import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bugPageHtml, bugPageMarkdown, bugTitle, stepLine, type BugFinding, type BugMeta } from "../src/bug.js";
import { makeBug, type BugContext, type MakeArgs } from "../src/bugreport.js";
import { BugGateError, BugStore, gateFiles } from "../src/bugstore.js";
import type { MapRoad, PlaceKey } from "../src/mapfile.js";

// AGENT-TOOLS 1.16 §29.1, §29.2, §29.5, §29.6, §29.9: the page, the folder, one bug for many sightings, and the gate.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-bug-"));
  dirs.push(dir);
  return dir;
};

const KEY: PlaceKey = { route: ["trips", "[id]"], tab: "trips" };
const CRASH_GOT = "the app crashed: TypeError: undefined is not an object (evaluating 'trip.days.map')";
/** The crash's got is over 80 characters: its first 45 and its last 30, with " … " between (§29.1). */
const CUT = `${Array.from(CRASH_GOT).slice(0, 45).join("")} \u2026 ${Array.from(CRASH_GOT).slice(-30).join("")}`;
const CRASH_TITLE = `Crash on trips_id: ${CUT}`;

/** The crash of §27.1. */
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
  path: [
    { tool: "tap", target: { id: "trips-tab" } },
    { tool: "tap", target: { id: "trip-row-1" } },
  ],
  expected: "the screen opens and the app stays open",
  got: CRASH_GOT,
  picture: { file: "findings/f3.jpg", private: true },
  logs: ["09:21:07.440 error TypeError: undefined is not an object (evaluating 'trip.days.map')"],
  crash: { reason: "TypeError: undefined is not an object", frames: ["*TripDetail.tsx:48 renderDays", "x.js:1 renderWithHooks"] },
  component_stack: ["TripDetail", "TripScreen", "Stack"],
  repro: "repro/f3.json",
  count: 1,
  ...extra,
});

function context(store: BugStore, extra: Partial<BugContext> = {}): BugContext {
  const roads: MapRoad[] = [{ from: "home", to: "trips", move: { tool: "tap", target: { id: "trips-tab" } }, names: { id: "trips-tab", label: "Trips", text: "Trips" }, by: "tapline", seen: 1, failed: 0, ms: 1, last: "x", build: "1.5.0 (220)" }];
  return { store, redact: (text) => text, placeKey: (_app, place) => (place === null ? null : KEY), roads: () => roads, needsPerson: () => false, ...extra };
}

const args = (finding: BugFinding, over: Partial<MakeArgs> = {}): MakeArgs => ({ finding, how: "explore", sourceKey: `20261114T091500Z/${finding.id}`, run: "20261114T091500Z", notChecked: "no check was asked for", ...over });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("the page (§29.1)", () => {
  it("has the nine sections in the spec's order, the title first, and the steps written for a person", () => {
    const store = new BugStore(tmp());
    const made = makeBug(context(store), args(crash(), { reproduced: { n: 3, of: 3, build: "1.5.0 (220)", when: "2026-11-14T11:20:02.014Z", reset: "reload only, data kept" } }));
    const md = readFileSync(join(made.dir, "report.md"), "utf8");
    const headings = md.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual([`# ${CRASH_TITLE}`, "## What happened", "## How to see it", "## Reproduced", "## Environment", "## Where", "## Logs", "## Picture", "## Seen before"]);
    expect(md).toContain("Expected: the screen opens and the app stays open. Got: the app crashed: TypeError: undefined is not an object (evaluating 'trip.days.map')");
    expect(md).toContain("Start on home.\n1. Tap \"Trips\" (id trips-tab)\n2. Tap id trip-row-1");
    expect(md).toContain("3 of 3 runs. Script: repro.json");
    expect(md).toContain("- App: com.example.wayfare 1.5.0 (220)");
    expect(md).toContain("- Device: iPhone16,1, iOS 19.1");
    expect(md).toContain("- Tool: tapline 1.8.5, found 2026-11-14 09:21:07 UTC (explore, finding f3)");
    expect(md).toContain("- Reset before each run: reload only, data kept");
    expect(md).toContain("- Place: trips_id (route trips › [id], tab trips)");
    expect(md).toContain("- Frames: *TripDetail.tsx:48 renderDays, x.js:1 renderWithHooks");
    expect(md).toContain("- Components: TripDetail, TripScreen, Stack");
    expect(md).toContain("- Source: TripDetail.tsx line 48");
    expect(md).toContain("```\n09:21:07.440 error TypeError");
    expect(md).toContain('A picture exists and is private. To include it: bug_report {"bug": "bug_7bc2e91c152d416e", "with_picture": true}');
    expect(md).toContain("1 time; first 2026-11-14, last 2026-11-14; build 1.5.0 (220).");
    expect(md.split("\n").length).toBeLessThanOrEqual(80);
  });

  it("the title: the kind words, an unnamed screen, and a long got cut to its first 45 and last 30 characters", () => {
    expect(bugTitle({ kind: "crash", place: null, got: "x" })).toBe("Crash on an unnamed screen: x");
    expect(bugTitle({ kind: "expect_failed", place: "home", got: "short" })).toBe("Check failed on home: short");
    expect(bugTitle({ kind: "observed", place: "place_4", got: "short" })).toBe("Observed on place_4: short");
    const long = `${"a".repeat(45)}${"m".repeat(20)}${"z".repeat(30)}`;
    const title = bugTitle({ kind: "slow", place: "home", got: long });
    expect(title).toBe(`Slow screen on home: ${"a".repeat(45)} … ${"z".repeat(30)}`);
    expect(bugTitle({ kind: "slow", place: "home", got: "x".repeat(80) })).toBe(`Slow screen on home: ${"x".repeat(80)}`);
  });

  it("writes each kind of step as a person would read it, never the typed value, and marks a step that needs a person", () => {
    const note = (name: string | null = null, others = false, needsPerson = false) => ({ name, others, needsPerson });
    expect(stepLine({ tool: "tap", target: { id: "trips-tab" } }, note("Trips"))).toBe('Tap "Trips" (id trips-tab)');
    expect(stepLine({ tool: "tap", target: { id: "trip-row-1" } }, note())).toBe("Tap id trip-row-1");
    expect(stepLine({ tool: "tap", target: { label: "Save" } }, note())).toBe('Tap "Save"');
    expect(stepLine({ tool: "long_press", target: { id: "row" } }, note("Trip"))).toBe('Press and hold "Trip" (id row)');
    expect(stepLine({ tool: "toggle", target: { id: "notify-switch" } }, note("Notifications"))).toBe('Switch "Notifications" (id notify-switch)');
    expect(stepLine({ tool: "tap", target: { row: true, index: 1 } }, note())).toBe("Tap the 1st row of the list.");
    expect(stepLine({ tool: "tap", target: { row: true, index: 12 } }, note())).toBe("Tap the 12th row of the list.");
    expect(stepLine({ tool: "tap", target: { row: true, index: 3 } }, note())).toBe("Tap the 3rd row of the list.");
    expect(stepLine({ tool: "type_text", target: { id: "email" }, text: "${typed}" }, note("Email"))).toBe('Type something in "Email" (id email)');
    expect(stepLine({ tool: "type_text", target: { id: "email" }, text: "${typed}" }, note("Email"))).not.toContain("typed");
    expect(stepLine({ tool: "scroll" }, note())).toBe("Scroll down");
    expect(stepLine({ tool: "scroll", direction: "up" }, note())).toBe("Scroll up");
    expect(stepLine({ tool: "scroll", to: "end" }, note())).toBe("Scroll to the end");
    expect(stepLine({ tool: "swipe", x0: 200, y0: 600, x1: 210, y1: 200 }, note())).toBe("Swipe up");
    expect(stepLine({ tool: "swipe", x0: 100, y0: 300, x1: 20, y1: 310 }, note())).toBe("Swipe left");
    expect(stepLine({ tool: "swipe", x0: 100, y0: 300, x1: 300, y1: 305 }, note())).toBe("Swipe right");
    expect(stepLine({ tool: "swipe", x0: 100, y0: 300, x1: 105, y1: 700 }, note())).toBe("Swipe down");
    expect(stepLine({ tool: "back" }, note())).toBe("Go back");
    expect(stepLine({ tool: "open_url", url: "wayfare://trips/42?token=abc123" }, note())).toBe("Open the link wayfare://trips/[value]");
    expect(stepLine({ tool: "tap", target: { id: "delete-all" } }, note("Delete all", false, true))).toBe('Tap "Delete all" (id delete-all) (needs a person)');
    expect(stepLine({ tool: "wait_for", text: "Thanks" }, note())).toBe("Run wait_for");
    // text from others is a quote marked as such, never part of a sentence the page speaks itself
    expect(stepLine({ tool: "tap", target: { text: "Great trip!" } }, note(null, true))).toBe('Tap "Great trip!" (from others)');
  });

  it("is at most about 80 lines, and 90 for the worst case: 15 steps, 8 frames, 20 logs", () => {
    const store = new BugStore(tmp());
    const worst = crash({
      path: Array.from({ length: 19 }, (_, n) => ({ tool: "tap", target: { id: `row-${n}` } })),
      crash: { reason: "TypeError: x", frames: Array.from({ length: 8 }, (_, n) => `*File${n}.tsx:${n + 1} fn${n}`) },
      logs: Array.from({ length: 25 }, (_, n) => `09:21:${String(n).padStart(2, "0")}.000 error line ${n}`),
    });
    const made = makeBug(context(store), args(worst));
    const md = readFileSync(join(made.dir, "report.md"), "utf8");
    expect(md.split("\n").length).toBeLessThanOrEqual(90);
    // only the last 15 steps are shown, and the page says where the first ones are
    expect(md).toContain("The first 4 steps are in repro.json.");
    expect(md).toContain("1. Tap id row-4\n");
    expect(md).toContain("15. Tap id row-18");
    expect(md).not.toContain("Tap id row-3\n");
    // the nearest 20 log lines, each cut
    expect(md).toContain("error line 24");
    expect(md).not.toContain("error line 4\n");
    expect(JSON.parse(readFileSync(join(made.dir, "repro.json"), "utf8")).steps).toHaveLength(19);
  });

  it("report.html is the same page: inline style, no script, no request, every text escaped", () => {
    const md = bugPageMarkdown({
      finding: crash({ got: "<script>alert(1)</script> & \"quotes\"" }),
      meta: { id: "bug_x", signature: "x", place_key: KEY, source: { how: "explore" }, seen: { first: "2026-11-14T09:21:07.512Z", last: "2026-11-14T09:21:07.512Z", count: 1, builds: ["1.5.0 (220)"], sources: [] }, reproduced: { checked: false, why: "no phone" }, picture_included: true } satisfies BugMeta,
      pictureFile: "picture.jpg",
    });
    const html = bugPageHtml(md);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script|<link|https?:\/\//);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
    expect(html).toContain('<img src="picture.jpg"');
    expect(html.match(/<h2>/g)).toHaveLength(8);
  });
});

describe("the folder (§29.2)", () => {
  it("holds report.md, report.html, repro.json and finding.json with the bug key, and no picture by itself when it is private", () => {
    const store = new BugStore(tmp());
    const made = makeBug(context(store), args(crash(), { picture: JPEG }));
    expect(made.dir).toBe(join(store.base, "com.example.wayfare", "bug_7bc2e91c152d416e"));
    expect(readdirSync(made.dir).sort()).toEqual(["finding.json", "report.html", "report.md", "repro.json"]);
    const stored = JSON.parse(readFileSync(join(made.dir, "finding.json"), "utf8")) as Record<string, unknown> & { bug: BugMeta };
    expect(stored["id"]).toBe("f3");
    expect(stored.bug).toMatchObject({
      id: "bug_7bc2e91c152d416e",
      signature: "7bc2e91c152d416e",
      place_key: KEY,
      source: { how: "explore", run: "20261114T091500Z", finding: "f3", file: "TripDetail.tsx", line: 48 },
      seen: { first: "2026-11-14T09:21:07.512Z", last: "2026-11-14T09:21:07.512Z", count: 1, builds: ["1.5.0 (220)"], sources: ["20261114T091500Z/f3"] },
      reproduced: { checked: false, why: "no check was asked for" },
      picture_included: false,
    });
    const repro = JSON.parse(readFileSync(join(made.dir, "repro.json"), "utf8")) as { version: number; start: string; steps: unknown[] };
    expect(repro).toMatchObject({ format: "agent-tools-script", version: 2, start: "home" });
    expect(repro.steps).toHaveLength(2);
  });

  it("a private picture goes in only with with_picture, and only while its bytes exist; a public one always", () => {
    const store = new BugStore(tmp());
    const without = makeBug(context(store), args(crash(), { picture: JPEG }));
    expect(existsSync(join(without.dir, "picture.jpg"))).toBe(false);
    expect(without.meta.picture_included).toBe(false);
    expect(readFileSync(join(without.dir, "report.md"), "utf8")).not.toContain("![");
    expect(readFileSync(join(without.dir, "report.html"), "utf8")).not.toContain("<img");

    const other = new BugStore(tmp());
    const gone = makeBug(context(other), args(crash(), { withPicture: true, picture: null }));
    expect(existsSync(join(gone.dir, "picture.jpg"))).toBe(false);
    expect(readFileSync(join(gone.dir, "report.md"), "utf8")).toContain("A picture exists and is private");

    const asked = new BugStore(tmp());
    const given = makeBug(context(asked), args(crash(), { withPicture: true, picture: JPEG }));
    expect(readFileSync(join(given.dir, "picture.jpg"))).toEqual(Buffer.from(JPEG));
    expect(given.meta.picture_included).toBe(true);
    expect(readFileSync(join(given.dir, "report.md"), "utf8")).toContain("![The screen at the moment](picture.jpg)");
    expect(readFileSync(join(given.dir, "report.html"), "utf8")).toContain('<img src="picture.jpg"');

    const open = new BugStore(tmp());
    const shown = makeBug(context(open), args(crash({ picture: { file: "findings/f3.jpg", private: false } }), { picture: JPEG }));
    expect(existsSync(join(shown.dir, "picture.jpg"))).toBe(true);
  });

  it("a person's later with_picture adds the picture to a kept bug (page rewritten), once", () => {
    const store = new BugStore(tmp());
    const made = makeBug(context(store), args(crash(), { picture: JPEG }));
    const redact = (text: string): string => text;
    expect(store.addPicture("com.example.wayfare", made.meta.id, null, redact)).toBe("gone");
    expect(store.addPicture("com.example.wayfare", made.meta.id, JPEG, redact)).toBe("added");
    expect(existsSync(join(made.dir, "picture.jpg"))).toBe(true);
    expect(readFileSync(join(made.dir, "report.md"), "utf8")).toContain("![The screen at the moment](picture.jpg)");
    expect(store.addPicture("com.example.wayfare", made.meta.id, JPEG, redact)).toBe("has");
    expect(store.addPicture("com.example.wayfare", "bug_0000000000000000", JPEG, redact)).toBe("none");
  });

  it("keeps the newest 100 bugs of an app by their last sighting, with their zips, never the one just made", () => {
    const store = new BugStore(tmp(), 3);
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const made = makeBug(context(store), args(crash({ got: `the app crashed: Error: kind ${n}x${"abc"[n % 3]}`, crash: { reason: `Error${n}: x`, frames: [`*A.tsx:1 f${n}`] }, when: `2026-11-1${n}T09:00:00.000Z` }), { sourceKey: `run${n}/f1` }));
      writeFileSync(join(store.appDir("com.example.wayfare"), `${made.meta.id}.zip`), "zip");
      ids.push(made.meta.id);
    }
    // the oldest two are gone, and the zips of removed bugs went with them
    const zips = readdirSync(store.appDir("com.example.wayfare")).filter((name) => name.endsWith(".zip")).sort();
    expect(zips).toEqual([ids[2], ids[3], ids[4]].map((id) => `${id}.zip`).sort());
    const kept = store.list("com.example.wayfare").map((row) => row.id);
    expect(kept).toHaveLength(3);
    expect(kept).toEqual([ids[4], ids[3], ids[2]]);
    // a bug that keeps coming isn't removed: it is kept by its last sighting
    const again = makeBug(context(store), args(crash({ got: "the app crashed: Error: kind 2xc", crash: { reason: "Error2: x", frames: ["*A.tsx:1 f2"] }, when: "2026-11-20T09:00:00.000Z" }), { sourceKey: "later/f1" }));
    expect(again.isNew).toBe(false);
    expect(store.list("com.example.wayfare")[0]?.id).toBe(ids[2]);
  });

  it("lists the bugs of every app, newest first, with counts and the check", () => {
    const store = new BugStore(tmp());
    makeBug(context(store), args(crash()));
    makeBug(context(store), args(crash({ kind: "slow", got: "3.5 s to settle", when: "2026-11-15T09:00:00.000Z" })));
    makeBug(context(store), args(crash({ app: "com.example.other", when: "2026-11-13T09:00:00.000Z" })));
    const rows = store.list();
    expect(rows.map((row) => [row.app, row.title])).toEqual([
      ["com.example.other", CRASH_TITLE],
      ["com.example.wayfare", "Slow screen on trips_id: 3.5 s to settle"],
      ["com.example.wayfare", CRASH_TITLE],
    ]);
    expect(rows[0]).toMatchObject({ count: 1, reproduced: "not checked" });
    expect(store.list("com.example.other")).toHaveLength(1);
  });
});

describe("later sightings (§29.5, §29.9 dedupe)", () => {
  it("the same planted bug found in two runs is one bug with count 2, and rewrites only Reproduced and Seen before", () => {
    const store = new BugStore(tmp());
    const first = makeBug(context(store), args(crash({ when: "2026-11-12T10:02:44.120Z", build: "219" }), { sourceKey: "20261112T095900Z/f3", picture: JPEG }));
    const md1 = readFileSync(join(first.dir, "report.md"), "utf8");
    const second = makeBug(context(store), args(crash({ id: "f1", when: "2026-11-14T09:21:07.512Z", build: "220", logs: ["a different log"], path: [] }), { sourceKey: "20261114T091500Z/f1" }));
    expect(second.isNew).toBe(false);
    expect(second.meta.id).toBe(first.meta.id);
    expect(second.meta.seen).toMatchObject({ first: "2026-11-12T10:02:44.120Z", last: "2026-11-14T09:21:07.512Z", count: 2, builds: ["1.5.0 (219)", "1.5.0 (220)"], sources: ["20261112T095900Z/f3", "20261114T091500Z/f1"] });
    expect(readdirSync(join(store.base, "com.example.wayfare"))).toEqual([first.meta.id]);
    const md2 = readFileSync(join(first.dir, "report.md"), "utf8");
    expect(md2).toContain("2 times; first 2026-11-12, last 2026-11-14; builds 1.5.0 (219), 1.5.0 (220).");
    // the first finding stays: its logs, its path and its title
    expect(md2).toContain("Tap \"Trips\" (id trips-tab)");
    expect(md2).not.toContain("a different log");
    expect(md2.replace(/## Seen before[\s\S]*$/, "")).toBe(md1.replace(/## Seen before[\s\S]*$/, ""));
    expect(JSON.parse(readFileSync(join(first.dir, "finding.json"), "utf8")).id).toBe("f3");
    expect(readFileSync(join(first.dir, "report.html"), "utf8")).toContain("2 times; first 2026-11-12");
  });

  it("making a bug again from the same source counts nothing; a finding's own count counts", () => {
    const store = new BugStore(tmp());
    makeBug(context(store), args(crash({ count: 3 })));
    const same = makeBug(context(store), args(crash({ count: 3 })));
    expect(same.meta.seen.count).toBe(3);
    const other = makeBug(context(store), args(crash({ count: 2 }), { sourceKey: "other/f9" }));
    expect(other.meta.seen.count).toBe(5);
  });

  it("a new build adds to builds and not to the bugs", () => {
    const store = new BugStore(tmp());
    makeBug(context(store), args(crash({ build: "219" })));
    const next = makeBug(context(store), args(crash({ build: "220" }), { sourceKey: "next/f3" }));
    expect(next.meta.seen.builds).toEqual(["1.5.0 (219)", "1.5.0 (220)"]);
    expect(store.list()).toHaveLength(1);
  });

  it("a renamed place keeps the signature; a changed number in got and a changed address in a frame keep it", () => {
    const store = new BugStore(tmp());
    const a = makeBug(context(store), args(crash({ place: "place_3", got: "the app crashed: TypeError: item 41 broke", crash: { reason: "TypeError: item 41 broke", frames: ["*TripDetail.tsx:48 renderDays"] } })));
    const b = makeBug(context(store), args(crash({ place: "trips_id", got: "the app crashed: TypeError: item 77 broke", crash: { reason: "TypeError: item 77 broke", frames: ["3 Wayfare 0x0000000102a4b3c8 -[X y] + 1", "*TripDetail.tsx:51 renderDays"] } }), { sourceKey: "b/f1" }));
    expect(b.meta.id).toBe(a.meta.id);
    expect(store.list()).toHaveLength(1);
  });

  it("a changed exception type or symbol makes another bug", () => {
    const store = new BugStore(tmp());
    const a = makeBug(context(store), args(crash()));
    const type = makeBug(context(store), args(crash({ crash: { reason: "RangeError: nope", frames: ["*TripDetail.tsx:48 renderDays"] } }), { sourceKey: "t/f1" }));
    const symbol = makeBug(context(store), args(crash({ crash: { reason: "TypeError: x", frames: ["*TripDetail.tsx:48 renderOther"] } }), { sourceKey: "s/f1" }));
    expect(new Set([a.meta.id, type.meta.id, symbol.meta.id]).size).toBe(3);
  });

  it("a finding with no place key is never merged: bug_<signature>_2 and on, and the same source is not a second bug", () => {
    const store = new BugStore(tmp());
    const noKey = context(store, { placeKey: () => null });
    const a = makeBug(noKey, args(crash(), { sourceKey: "r1/f3" }));
    const b = makeBug(noKey, args(crash(), { sourceKey: "r2/f3" }));
    const again = makeBug(noKey, args(crash(), { sourceKey: "r2/f3" }));
    expect(a.meta.id).toMatch(/^bug_[0-9a-f]{16}_2$/);
    expect(b.meta.id).toMatch(/^bug_[0-9a-f]{16}_3$/);
    expect(again.meta.id).toBe(b.meta.id);
    expect(again.meta.seen.count).toBe(1);
    expect(a.meta.place_key).toBeNull();
  });
});

describe("redaction and the gate (§29.6)", () => {
  const SECRET = "Lisbon-Alfama-Tram-28-Route";
  const CODE = "482913";
  const TYPED_VALUE = "typed-by-the-agent-7731";
  const redact = (text: string): string => text.split(SECRET).join("<trip's destination>").split(CODE).join("<code>").split(TYPED_VALUE).join("${typed}");
  const values = [SECRET, CODE, TYPED_VALUE];

  function files(dir: string): Record<string, string> {
    return Object.fromEntries(readdirSync(dir).filter((name) => !name.endsWith(".jpg")).map((name) => [name, readFileSync(join(dir, name), "utf8")]));
  }

  it("a value planted in the note, a log line, a typed step, a name and a frame path is in no file, in no form or 12-character piece", () => {
    const store = new BugStore(tmp());
    const planted = crash({
      kind: "observed",
      got: `Total is wrong for ${SECRET} (code ${CODE})`,
      expected: `shows ${SECRET}`,
      logs: [`09:21:07.440 error failed for ${SECRET}`, `/Users/someone/dev/app/src/${SECRET}.tsx:4 at ${TYPED_VALUE}`],
      path: [
        { tool: "tap", target: { label: `Trip to ${SECRET}` } },
        { tool: "type_text", target: { id: "dest" }, text: TYPED_VALUE },
      ],
      crash: { reason: `TypeError: ${SECRET}`, frames: [`*/Users/someone/dev/app/src/${SECRET}.tsx:48 render${CODE}`] },
      component_stack: [SECRET],
    });
    const made = makeBug(context(store, { redact, gateValues: values }), args(planted));
    for (const [name, text] of Object.entries(files(made.dir))) {
      for (const form of [SECRET, CODE, TYPED_VALUE, ...Array.from({ length: SECRET.length - 11 }, (_, n) => SECRET.slice(n, n + 12)), encodeURIComponent(SECRET), Buffer.from(SECRET).toString("base64")]) {
        expect(text, `${name} holds ${form}`).not.toContain(form);
      }
      expect(text, name).not.toContain("/Users/someone");
      expect(text, name).not.toContain("someone");
    }
    const md = readFileSync(join(made.dir, "report.md"), "utf8");
    expect(md).toContain("<trip's destination>");
    // a typed step is `${typed}` in the script, and its value is in no file
    const script = JSON.parse(readFileSync(join(made.dir, "repro.json"), "utf8")) as { variables: string[]; steps: Array<{ text?: string }> };
    expect(script.variables).toEqual(["typed"]);
    expect(script.steps[1]?.text).toBe("${typed}");
    expect(JSON.parse(readFileSync(join(made.dir, "finding.json"), "utf8")).path[1].text).toBe("${typed}");
  });

  it("redaction comes before the cut: a value on the edge of the 80-character title is never half there", () => {
    const store = new BugStore(tmp());
    const got = `${"x".repeat(40)}${SECRET}${"y".repeat(40)}`;
    const made = makeBug(context(store, { redact, gateValues: values }), args(crash({ kind: "slow", got })));
    const text = readFileSync(join(made.dir, "report.md"), "utf8");
    expect(text).not.toContain(SECRET.slice(0, 12));
    expect(text.split("\n")[0]).toContain("<trip");
    expect(text).toContain("Got: " + "x".repeat(40) + "<trip's destination>" + "y".repeat(40));
  });

  it("the signature is made from the redacted got: a vault value that changes between sightings doesn't split the bug", () => {
    const store = new BugStore(tmp());
    const a = makeBug(context(store, { redact }), args(crash({ kind: "slow", got: `Total for ${SECRET}` })));
    const b = makeBug(context(store, { redact }), args(crash({ kind: "slow", got: `Total for ${SECRET}` }), { sourceKey: "n/f1" }));
    expect(b.meta.id).toBe(a.meta.id);
  });

  it("the gate refuses and writes nothing when a file would still hold a value (the redactor changes it, or a form is found)", () => {
    const store = new BugStore(tmp());
    const leaky = (text: string): string => (text.includes(SECRET) ? text.replace(SECRET, "<x>") : text);
    // a redactor that keeps changing its own output: the page never passes
    const never = (text: string): string => `${text} `;
    expect(() => makeBug(context(store, { redact: never }), args(crash()))).toThrow(BugGateError);
    expect(existsSync(store.appDir("com.example.wayfare"))).toBe(false);
    // a value the redactor doesn't know, found by its forms
    expect(() => makeBug(context(store, { redact: (t) => t, gateValues: [SECRET] }), args(crash({ got: `x ${SECRET}` })))).toThrow(/a vault value was found in/);
    expect(leaky(SECRET)).toBe("<x>");
    expect(store.list()).toEqual([]);
  });

  it("gateFiles names the first file that fails and never the value", () => {
    const hit = gateFiles({ "report.md": "clean", "finding.json": `{"a": "${SECRET}"}` }, (t) => t, [SECRET]);
    expect(hit).toBe("finding.json");
    expect(gateFiles({ a: "x" }, (t) => t, ["a-value-here-long"])).toBeNull();
    // a piece of 12 characters of a long value is found
    expect(gateFiles({ a: `see ${SECRET.slice(5, 17)}` }, (t) => t, [SECRET])).toBe("a");
    // a value under 3 characters is never scrubbed, so it isn't looked for
    expect(gateFiles({ a: "to be or not" }, (t) => t, ["or"])).toBeNull();
  });

  it("finding.json is redacted again when a later sighting touches the bug", () => {
    const store = new BugStore(tmp());
    const first = makeBug(context(store), args(crash({ logs: [`seen ${SECRET}`] })));
    expect(readFileSync(join(first.dir, "finding.json"), "utf8")).toContain(SECRET);
    makeBug(context(store, { redact }), args(crash(), { sourceKey: "later/f9" }));
    expect(readFileSync(join(first.dir, "finding.json"), "utf8")).not.toContain(SECRET);
    expect(readFileSync(join(first.dir, "finding.json"), "utf8")).toContain("<trip's destination>");
  });

  it("an app id with odd characters is a plain folder name", () => {
    const store = new BugStore(tmp());
    const made = makeBug(context(store), args(crash({ app: "../../evil/app" })));
    expect(dirname(dirname(made.dir))).toBe(store.base);
    expect(readdirSync(store.base)).toHaveLength(1);
  });
});
