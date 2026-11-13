import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, type AuditSink } from "../src/auditlog.js";
import { GrantBook, parseGrants, refusalLine, type GrantTouch } from "../src/grants.js";
import { loadPolicy } from "../src/policy.js";

// AGENT-TOOLS 1.14 §19.1 to §19.4 and §23: grants, their counts and the audit log.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-grants-"));
  dirs.push(dir);
  return dir;
};

const NOW = new Date(2026, 10, 14, 9, 0, 0);
const GRANT = { name: "instagram_posting", app: "com.instagram.ios", words: ["Post"], route: "post_update", perDay: 3, perHour: 1, until: "2026-11-21", draftsOnly: false };
const touch = (over: Partial<GrantTouch> = {}): GrantTouch => ({ app: { id: "com.instagram.ios", name: "Instagram" }, element: { text: "Post" }, routes: ["post_update"], ...over });

class MemoryAudit implements AuditSink {
  lines: Array<Record<string, unknown>> = [];
  fail = false;
  write(entry: Record<string, unknown>): boolean {
    if (this.fail) return false;
    this.lines.push(entry);
    return true;
  }
}

interface Rig {
  dir: string;
  path: string;
  audit: MemoryAudit;
  clock: { now: Date };
  book: GrantBook;
  put(grants: unknown[], extra?: Record<string, unknown>): void;
}

function rig(grants: unknown[] = [GRANT]): Rig {
  const dir = tmp();
  const path = join(dir, "policy.json");
  const audit = new MemoryAudit();
  const clock = { now: NOW };
  const put = (list: unknown[], extra: Record<string, unknown> = {}): void => writeFileSync(path, JSON.stringify({ version: 2, confirm: ["Send", "Post"], block: [], grants: list, ...extra }));
  put(grants);
  const book = new GrantBook({ policyPath: path, audit, now: () => clock.now, sleep: async () => undefined });
  return { dir, path, audit, clock, book, put };
}

describe("loading a policy with grants (§19.1)", () => {
  it("a version 1 file still loads, with no grants", () => {
    const dir = tmp();
    const path = join(dir, "p.json");
    writeFileSync(path, JSON.stringify({ version: 1, confirm: ["Send"], block: [] }));
    expect(loadPolicy(path).confirm).toEqual(["Send"]);
  });

  it("a version 2 file loads, and a version 3 doesn't", () => {
    const dir = tmp();
    const path = join(dir, "p.json");
    writeFileSync(path, JSON.stringify({ version: 2, grants: [GRANT] }));
    expect(loadPolicy(path).version).toBe(2);
    writeFileSync(path, JSON.stringify({ version: 3 }));
    expect(() => loadPolicy(path)).toThrow(/isn't a policy/);
  });

  it("a valid grant loads with its defaults", () => {
    const { grants, refused } = parseGrants([{ name: "a", app: "x", words: ["Delete"], until: "2026-11-20" }], "2026-11-14", () => []);
    expect(refused).toEqual([]);
    expect(grants).toEqual([{ name: "a", app: "x", words: ["Delete"], perDay: 1, until: "2026-11-20", draftsOnly: false }]);
  });

  it("draftsOnly defaults to true for a word that reaches other people, and an explicit false lifts it", () => {
    const { grants } = parseGrants(
      [
        { name: "a", app: "x", words: ["Post"], until: "2026-11-20" },
        { name: "b", app: "x", words: ["Reply"], until: "2026-11-20", draftsOnly: false },
        { name: "c", app: "x", words: ["Remove"], until: "2026-11-20" },
      ],
      "2026-11-14",
      () => [],
    );
    expect(grants.map((g) => [g.name, g.draftsOnly])).toEqual([["a", true], ["b", false], ["c", false]]);
  });

  const base = { app: "x", words: ["Remove"], until: "2026-11-20" };
  const refusals: Array<[string, unknown, RegExp]> = [
    ["no name", { ...base, name: undefined }, /name is missing/],
    ["no app", { name: "n", words: ["Remove"], until: "2026-11-20" }, /app is missing/],
    ["no words", { name: "n", app: "x", until: "2026-11-20" }, /words must be/],
    ["empty words", { name: "n", ...base, words: [] }, /words must be/],
    ["no until", { name: "n", app: "x", words: ["Remove"] }, /until must be a date/],
    ["an impossible date", { name: "n", ...base, until: "2026-02-31" }, /until must be a date/],
    ["more than 30 days", { name: "n", ...base, until: "2026-12-25" }, /until is 41 days away; the most is 30\./],
    ["perDay 0", { name: "n", ...base, perDay: 0 }, /perDay must be/],
    ["a fractional perHour", { name: "n", ...base, perHour: 1.5 }, /perHour must be/],
    ["a bad quiet", { name: "n", ...base, quiet: { from: "25:00", to: "07:00" } }, /quiet needs from and to/],
    ["a bad draftsOnly", { name: "n", ...base, draftsOnly: "no" }, /draftsOnly must be/],
    ["a bad route", { name: "n", ...base, route: 3 }, /route must be/],
    ["a bad revoked", { name: "n", ...base, revoked: "yesterday" }, /revoked must be a date/],
    ["a payment word", { name: "n", ...base, words: ["Pay now"] }, /payments and purchases are never grantable \("Pay"\)/],
    ["Buy", { name: "n", ...base, words: ["buy"] }, /never grantable/],
    ["Delete account", { name: "n", ...base, words: ["Delete account"] }, /deleting an account is never grantable/],
  ];
  for (const [label, grant, reason] of refusals) {
    it(`refuses a grant with ${label}, and the others still load`, () => {
      const { grants, refused } = parseGrants([{ name: "ok", ...base }, grant, { name: "ok2", ...base }], "2026-11-14", () => []);
      expect(grants.map((g) => g.name)).toEqual(["ok", "ok2"]);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toMatch(reason);
    });
  }

  it("refuses a grant that names a blocked word of its app, and a repeated name", () => {
    const { grants, refused } = parseGrants(
      [
        { name: "a", app: "x", words: ["Erase"], until: "2026-11-20" },
        { name: "b", app: "y", words: ["Erase"], until: "2026-11-20" },
        { name: "b", app: "y", words: ["Remove"], until: "2026-11-20" },
      ],
      "2026-11-14",
      (app) => (app === "x" ? ["Erase"] : []),
    );
    expect(grants.map((g) => g.name)).toEqual(["b"]);
    expect(refused.map((r) => r.reason)).toEqual(['a blocked word is never grantable ("Erase").', "name is already used by an earlier grant."]);
  });

  it("says why in the spec's words", () => {
    const { refused } = parseGrants([{ name: "shop_pay", app: "x", words: ["Pay"], until: "2026-11-20" }, { name: "insta", app: "x", words: ["Post"], until: "2026-12-25" }], "2026-11-14", () => []);
    expect(refused.map(refusalLine)).toEqual([
      'Note: grant "shop_pay" is refused: payments and purchases are never grantable ("Pay").',
      'Note: grant "insta" is refused: until is 41 days away; the most is 30.',
    ]);
  });

  it("a grant of exactly 30 days loads; unknown keys are ignored", () => {
    const { grants, refused } = parseGrants([{ name: "n", app: "x", words: ["Remove"], until: "2026-12-14", future: true }], "2026-11-14", () => []);
    expect(refused).toEqual([]);
    expect(grants).toHaveLength(1);
  });

  it("inspect keeps the refusals for doctor and the first answer", async () => {
    const r = rig([GRANT, { ...GRANT, name: "bad", words: ["Buy"] }]);
    const report = await r.book.inspect();
    expect(report.grants.map((g) => g.name)).toEqual(["instagram_posting"]);
    expect(GrantBook.noticeLines(report)).toEqual(['Note: grant "bad" is refused: payments and purchases are never grantable ("Buy").']);
  });
});

describe("what a grant covers (§19.3)", () => {
  it("covers a touch with the exact note and counts it, with an audit line", async () => {
    const r = rig();
    const first = await r.book.decide(touch(), "use", 'tap "Post"');
    expect(first).toMatchObject({ kind: "covered", name: "instagram_posting", line: 'Note: allowed by grant "instagram_posting" (1 of 3 today).' });
    expect(r.audit.lines).toEqual([{ kind: "grant", app: "com.instagram.ios", name: "instagram_posting", detail: 'tap "Post" (1 of 3 today)' }]);
    // perHour: 1 stops the second use in the same hour
    const second = await r.book.decide(touch(), "use", 'tap "Post"');
    expect(second).toMatchObject({ kind: "ask", notes: ['Note: grant "instagram_posting" doesn\'t cover this (1 of 1 this hour); asking a person.'] });
    expect(r.audit.lines).toHaveLength(1);
  });

  it("counts 2 of 3 once an hour has passed", async () => {
    const r = rig();
    await r.book.decide(touch(), "use", "x");
    r.clock.now = new Date(2026, 10, 14, 10, 30, 0);
    const second = await r.book.decide(touch(), "use", "x");
    expect(second).toMatchObject({ kind: "covered", line: 'Note: allowed by grant "instagram_posting" (2 of 3 today).' });
  });

  it("says 3 of 3 today when the day's limit is reached", async () => {
    const r = rig([{ ...GRANT, perHour: undefined }]);
    for (let i = 0; i < 3; i++) expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
    expect(await r.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", notes: ['Note: grant "instagram_posting" doesn\'t cover this (3 of 3 today); asking a person.'] });
  });

  it("a new local day starts from zero", async () => {
    const r = rig([{ ...GRANT, perDay: 1, perHour: undefined }]);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("ask");
    r.clock.now = new Date(2026, 10, 15, 9, 0, 0);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
  });

  it("peek counts nothing and writes no line", async () => {
    const r = rig([{ ...GRANT, perDay: 1, perHour: undefined }]);
    expect(await r.book.decide(touch(), "peek", "x")).toMatchObject({ kind: "covered", counts: "1 of 1" });
    expect(await r.book.decide(touch(), "peek", "x")).toMatchObject({ kind: "covered" });
    expect(r.audit.lines).toEqual([]);
    expect(existsSync(`${r.path}.state.json`)).toBe(false);
  });

  it("quiet hours, crossing midnight, don't cover", async () => {
    const r = rig([{ ...GRANT, quiet: { from: "22:00", to: "07:00" } }]);
    const note = 'Note: grant "instagram_posting" doesn\'t cover this (quiet hours 22:00 to 07:00); asking a person.';
    r.clock.now = new Date(2026, 10, 14, 23, 0, 0);
    expect(await r.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", notes: [note] });
    r.clock.now = new Date(2026, 10, 14, 6, 59, 0);
    expect(await r.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", notes: [note] });
    r.clock.now = new Date(2026, 10, 14, 7, 0, 0);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
  });

  it("covers up to the end of the until day, then says it ended", async () => {
    const r = rig();
    r.clock.now = new Date(2026, 10, 21, 23, 59, 0);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
    r.clock.now = new Date(2026, 10, 22, 0, 1, 0);
    expect(await r.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", notes: ['Note: grant "instagram_posting" doesn\'t cover this (it ended on 2026-11-21); asking a person.'] });
  });

  it("a revoked grant covers nothing and says when", async () => {
    const r = rig([{ ...GRANT, revoked: "2026-11-14" }]);
    expect(await r.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", notes: ['Note: grant "instagram_posting" doesn\'t cover this (it was revoked on 2026-11-14); asking a person.'] });
  });

  it("a mismatch of the app, the word or the route is not noted", async () => {
    const r = rig();
    expect(await r.book.decide(touch({ app: { id: "other", name: "Other" } }), "use", "x")).toMatchObject({ kind: "ask", notes: [] });
    expect(await r.book.decide(touch({ element: { text: "Send" } }), "use", "x")).toMatchObject({ kind: "ask", notes: [] });
    expect(await r.book.decide(touch({ element: { text: "Posted" } }), "use", "x")).toMatchObject({ kind: "ask", notes: [] });
    expect(await r.book.decide(touch({ routes: [] }), "use", "x")).toMatchObject({ kind: "ask", notes: [] });
    expect(await r.book.decide(touch({ routes: ["other"] }), "use", "x")).toMatchObject({ kind: "ask", notes: [] });
  });

  it("matches the word whole, ignoring case, on the label too", async () => {
    const r = rig([{ ...GRANT, route: undefined, perHour: undefined }]);
    expect((await r.book.decide(touch({ element: { label: "post update" }, routes: [] }), "use", "x")).kind).toBe("covered");
  });

  it("without a route in the grant, any run covers", async () => {
    const r = rig([{ ...GRANT, route: undefined, perHour: undefined }]);
    expect((await r.book.decide(touch({ routes: [] }), "use", "x")).kind).toBe("covered");
  });

  it("never-grantable words always ask, even when a hand-edited grant that loaded lists them", async () => {
    const r = rig([{ name: "pay", app: "x", words: ["Remove"], until: "2026-11-20" }]);
    const t = { app: { id: "x", name: "X" }, element: { text: "Pay now" }, routes: [] };
    expect(await r.book.decide(t, "use", "x")).toMatchObject({ kind: "ask", notes: [] });
    expect(await r.book.decide({ ...t, element: { text: "Delete account" } }, "use", "x")).toMatchObject({ kind: "ask", notes: [] });
    // and the grant that names such a word is refused at load, so it covers nothing at all
    const bad = rig([{ name: "pay", app: "x", words: ["Pay"], until: "2026-11-20" }]);
    expect(await bad.book.decide({ ...t, element: { text: "Pay" } }, "use", "x")).toMatchObject({ kind: "ask", notes: [] });
  });

  it("a draftsOnly grant stops at a draft and counts nothing (§19.3, §21.3)", async () => {
    const r = rig([{ ...GRANT, perDay: 1, draftsOnly: undefined }]);
    expect(await r.book.decide(touch(), "use", "x")).toEqual({ kind: "draft", name: "instagram_posting" });
    // nothing was used, so it stops at a draft again, and no audit line was written
    expect(await r.book.decide(touch(), "use", "x")).toEqual({ kind: "draft", name: "instagram_posting" });
    expect(r.audit.lines).toEqual([]);
  });

  it("a draftsOnly grant still has its other limits: ended, revoked, quiet hours and the counts ask a person", async () => {
    const ended = rig([{ ...GRANT, until: "2026-11-01", draftsOnly: true }]);
    expect(await ended.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", asked: ["ended"] });
    const revoked = rig([{ ...GRANT, revoked: "2026-11-10", draftsOnly: true }]);
    expect(await revoked.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", asked: ["revoked"] });
  });

  it("an edit of the policy file is seen at the very next touch", async () => {
    const r = rig([{ ...GRANT, perHour: undefined }]);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
    r.put([{ ...GRANT, perHour: undefined, revoked: "2026-11-14" }]);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("ask");
    r.put([{ ...GRANT, perHour: undefined }]);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
    writeFileSync(r.path, "{ not json");
    expect(await r.book.decide(touch(), "use", "x")).toMatchObject({ kind: "ask", notes: [] });
  });

  it("an unreadable file later is said as a note for doctor", async () => {
    const r = rig();
    writeFileSync(r.path, "nope");
    const report = await r.book.inspect();
    expect(report.fileOk).toBe(false);
    expect(GrantBook.noticeLines(report)[0]).toMatch(/policy file can't be read/);
  });

  it("without an audit log nothing is covered, and a failed line means not covered", async () => {
    const none = new GrantBook({ policyPath: rig().path, audit: null });
    expect((await none.decide(touch(), "use", "x")).kind).toBe("ask");
    const r = rig();
    r.audit.fail = true;
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("ask");
    // and no use was counted
    expect(existsSync(`${r.path}.state.json`)).toBe(false);
    r.audit.fail = false;
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
  });

  it("a use gives itself back when the touch wasn't made", async () => {
    const r = rig([{ ...GRANT, perDay: 1, perHour: undefined }]);
    const used = await r.book.decide(touch(), "use", "x");
    if (used.kind !== "covered") throw new Error("not covered");
    await r.book.release(used);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
  });
});

describe("counts and the state file (§19.4)", () => {
  it("the state file has the spec's format and counts hold across a new host instance", async () => {
    const r = rig([{ ...GRANT, perHour: undefined }]);
    await r.book.decide(touch(), "use", "x");
    await r.book.decide(touch(), "use", "x");
    const state: unknown = JSON.parse(readFileSync(`${r.path}.state.json`, "utf8"));
    expect(state).toEqual({ version: 1, uses: { instagram_posting: { "2026-11-14": [expect.stringMatching(/^2026-11-14T09:00:00[+-]\d\d:\d\d$/), expect.stringMatching(/^2026-11-14T09:00:00[+-]\d\d:\d\d$/)] } } });
    const again = new GrantBook({ policyPath: r.path, audit: r.audit, now: () => r.clock.now, sleep: async () => undefined });
    expect(await again.decide(touch(), "use", "x")).toMatchObject({ kind: "covered", line: 'Note: allowed by grant "instagram_posting" (3 of 3 today).' });
    expect((await again.decide(touch(), "use", "x")).kind).toBe("ask");
  });

  it("a lock older than 30 s is taken over; a fresh one is waited for", async () => {
    const r = rig();
    const lock = `${r.path}.state.lock`;
    writeFileSync(lock, "999 old");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    // the lock's age is read against the book's clock, so this one runs on the wall clock
    const real = new GrantBook({ policyPath: r.path, audit: r.audit, now: () => new Date(), sleep: async () => undefined });
    r.put([{ ...GRANT, until: localPlus(5), route: undefined, perHour: undefined }]);
    expect((await real.decide(touch({ routes: [] }), "use", "x")).kind).toBe("covered");
    expect(existsSync(lock)).toBe(false);
  });

  it("a fresh lock held by someone else means the use waits, then gives up (asks)", async () => {
    const r = rig();
    const lock = `${r.path}.state.lock`;
    writeFileSync(lock, "999 fresh");
    let slept = 0;
    const book = new GrantBook({ policyPath: r.path, audit: r.audit, now: () => NOW, sleep: async () => void slept++ });
    // A lock younger than 30 s of the wall clock is held.
    utimesSync(lock, new Date(), new Date());
    expect((await book.decide(touch(), "use", "x")).kind).toBe("ask");
    expect(slept).toBeGreaterThan(0);
    expect(existsSync(lock)).toBe(true);
  });

  it("a state file that doesn't parse is left alone, and every grant is used up", async () => {
    const r = rig();
    writeFileSync(`${r.path}.state.json`, "{ broken");
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("ask");
    expect(readFileSync(`${r.path}.state.json`, "utf8")).toBe("{ broken");
    expect(r.audit.lines).toEqual([]);
    const report = await r.book.inspect();
    expect(report.stateBroken).toBe(true);
    expect(GrantBook.noticeLines(report)[0]).toMatch(/state file doesn't parse/);
    // a state file of the wrong shape is broken too
    writeFileSync(`${r.path}.state.json`, JSON.stringify({ version: 2, uses: {} }));
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("ask");
  });

  it("two writers don't lose a count", async () => {
    const r = rig([{ ...GRANT, perDay: 10, perHour: undefined }]);
    const other = new GrantBook({ policyPath: r.path, audit: r.audit, now: () => r.clock.now });
    const mine = new GrantBook({ policyPath: r.path, audit: r.audit, now: () => r.clock.now });
    const all = await Promise.all([...Array.from({ length: 5 }, () => mine.decide(touch(), "use", "x")), ...Array.from({ length: 5 }, () => other.decide(touch(), "use", "x"))]);
    expect(all.every((d) => d.kind === "covered")).toBe(true);
    const state = JSON.parse(readFileSync(`${r.path}.state.json`, "utf8")) as { uses: { instagram_posting: Record<string, string[]> } };
    expect(state.uses.instagram_posting["2026-11-14"]).toHaveLength(10);
    // the eleventh is past the limit
    expect((await mine.decide(touch(), "use", "x")).kind).toBe("ask");
  });

  it("two writers can't both make the last use of perDay: 1", async () => {
    const r = rig([{ ...GRANT, perDay: 1, perHour: undefined }]);
    const other = new GrantBook({ policyPath: r.path, audit: r.audit, now: () => r.clock.now });
    const kinds = (await Promise.all([r.book.decide(touch(), "use", "x"), other.decide(touch(), "use", "x")])).map((d) => d.kind).sort();
    expect(kinds).toEqual(["ask", "covered"]);
  });

  it("entries are pruned after the grant's until", async () => {
    const r = rig([{ ...GRANT, perHour: undefined }, { ...GRANT, name: "old", words: ["Send"], until: "2026-11-15", perHour: undefined }]);
    await r.book.decide(touch({ element: { text: "Send" } }), "use", "x");
    r.clock.now = new Date(2026, 10, 16, 9, 0, 0);
    await r.book.decide(touch(), "use", "x");
    const state = JSON.parse(readFileSync(`${r.path}.state.json`, "utf8")) as { uses: Record<string, unknown> };
    expect(Object.keys(state.uses)).toEqual(["instagram_posting"]);
  });
});

/** A local date n days from today, for a grant that has to be valid against the wall clock. */
function localPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("the audit log (§23)", () => {
  it("appends the spec's lines to YYYY-MM.jsonl", () => {
    const dir = join(tmp(), "audit");
    const log = new AuditLog(dir, () => new Date("2026-11-14T06:00:12.481Z"));
    log.open();
    expect(log.write({ kind: "grant", app: "com.instagram.ios", name: "instagram_posting", detail: 'tap "Post" (2 of 3 today)' })).toBe(true);
    const text = readFileSync(join(dir, "2026-11.jsonl"), "utf8");
    expect(JSON.parse(text)).toEqual({ t: "2026-11-14T06:00:12.481Z", tool: "tapline", kind: "grant", app: "com.instagram.ios", name: "instagram_posting", detail: 'tap "Post" (2 of 3 today)' });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("prunes lines older than 90 days at open, keeping new ones and what it can't read", () => {
    const dir = join(tmp(), "audit");
    mkdirSync(dir, { recursive: true });
    const now = new Date("2026-11-14T00:00:00.000Z");
    const line = (t: string): string => JSON.stringify({ t, tool: "tapline", kind: "grant", name: "g" });
    writeFileSync(join(dir, "2026-07.jsonl"), `${line("2026-07-01T00:00:00.000Z")}\n`);
    writeFileSync(join(dir, "2026-08.jsonl"), `${line("2026-08-10T00:00:00.000Z")}\n${line("2026-08-20T00:00:00.000Z")}\nnot json\n`);
    writeFileSync(join(dir, "notes.txt"), "keep");
    new AuditLog(dir, () => now).open();
    expect(existsSync(join(dir, "2026-07.jsonl"))).toBe(false);
    const kept = readFileSync(join(dir, "2026-08.jsonl"), "utf8").trim().split("\n");
    expect(kept).toEqual([line("2026-08-20T00:00:00.000Z"), "not json"]);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("a write that fails answers false, so the grant doesn't cover the touch", async () => {
    const dir = tmp();
    // the audit folder can't be made: a file stands where it should be
    const blocked = join(dir, "audit");
    writeFileSync(blocked, "a file");
    const log = new AuditLog(blocked);
    log.open();
    expect(log.write({ kind: "grant", name: "g" })).toBe(false);
    const r = rig();
    const book = new GrantBook({ policyPath: r.path, audit: log, now: () => NOW, sleep: async () => undefined });
    expect((await book.decide(touch(), "use", "x")).kind).toBe("ask");
    expect(existsSync(`${r.path}.state.json`)).toBe(false);
  });

  it("a covered touch through the real log writes a grant line", async () => {
    const r = rig();
    const dir = join(tmp(), "audit");
    const log = new AuditLog(dir, () => NOW);
    log.open();
    const book = new GrantBook({ policyPath: r.path, audit: log, now: () => NOW, sleep: async () => undefined });
    expect((await book.decide(touch(), "use", 'tap "Post"')).kind).toBe("covered");
    const line = JSON.parse(readFileSync(join(dir, `${NOW.toISOString().slice(0, 7)}.jsonl`), "utf8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ tool: "tapline", kind: "grant", app: "com.instagram.ios", name: "instagram_posting" });
  });
});
