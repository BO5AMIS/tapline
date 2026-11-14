import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditSink } from "../src/auditlog.js";
import { AuditLog } from "../src/auditlog.js";
import { GrantBook, type GrantTouch } from "../src/grants.js";
import { runGrants } from "../src/grantscmd.js";

// PR 12, CodeRabbit round: grants (app scope, the lock, inherited names).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = new Date(2026, 10, 14, 9, 0, 0);
const GRANT = { name: "instagram_posting", app: "com.instagram.ios", words: ["Post"], route: "post_update", perDay: 3, until: "2026-11-21", draftsOnly: false };
const touch = (over: Partial<GrantTouch> = {}): GrantTouch => ({ app: { id: "com.instagram.ios", name: "Instagram" }, element: { text: "Post" }, routes: ["post_update"], ...over });

class MemoryAudit implements AuditSink {
  lines: Array<Record<string, unknown>> = [];
  write(entry: Record<string, unknown>): boolean {
    this.lines.push(entry);
    return true;
  }
}

function rig(grants: unknown[] = [GRANT]) {
  const dir = mkdtempSync(join(tmpdir(), "tapline-pr12cr-"));
  dirs.push(dir);
  const path = join(dir, "policy.json");
  const audit = new MemoryAudit();
  const clock = { now: NOW };
  const put = (list: unknown[]): void => writeFileSync(path, JSON.stringify({ version: 2, confirm: ["Send", "Post"], block: [], grants: list }));
  put(grants);
  const options = { policyPath: path, audit, now: () => clock.now, sleep: async (): Promise<void> => undefined };
  return { path, audit, clock, put, options, book: new GrantBook(options) };
}

describe("grants: the app, the lock and inherited names (PR 12 CodeRabbit)", () => {
  it("a grant scoped to an app's name doesn't cover another app that has an id of its own", async () => {
    const r = rig([{ ...GRANT, app: "com.instagram.ios" }]);
    const other = touch({ app: { id: "other", name: "com.instagram.ios" } });
    expect((await r.book.decide(other, "use", "x")).kind).toBe("ask");
    expect((await r.book.decide(other, "peek", "x")).kind).toBe("ask");
    expect(r.audit.lines).toEqual([]);
  });

  it("a grant scoped to a name covers an app that has no id", async () => {
    const r = rig([{ ...GRANT, app: "Instagram" }]);
    expect((await r.book.decide(touch({ app: { name: "Instagram" } }), "use", "x")).kind).toBe("covered");
  });

  it("a revocation that completes before the use writes its line stops the touch: no line, no count", async () => {
    const r = rig([GRANT]);
    const book = new GrantBook({
      ...r.options,
      beforeCommit: async () => {
        r.put([{ ...GRANT, revoked: "2026-11-14" }]);
      },
    });
    expect((await book.decide(touch(), "use", "x")).kind).toBe("ask");
    expect(r.audit.lines).toEqual([]);
    expect(existsSync(`${r.path}.state.json`)).toBe(false);
  });

  it("a grant that ended while the use waited for the lock doesn't cover (the clock is read again)", async () => {
    const r = rig([{ ...GRANT, until: "2026-11-14" }]);
    const book = new GrantBook({
      ...r.options,
      beforeCommit: async () => {
        r.clock.now = new Date(2026, 10, 15, 0, 1, 0);
      },
    });
    expect((await book.decide(touch(), "use", "x")).kind).toBe("ask");
    expect(r.audit.lines).toEqual([]);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a grant named %s keeps its count across a restart and touches no prototype", async (name) => {
    const r = rig([{ ...GRANT, name, perDay: 1 }]);
    expect((await r.book.decide(touch(), "use", "x")).kind).toBe("covered");
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(Object.keys({})).toEqual([]);
    expect(Object.keys(Object)).toEqual([]);
    expect(Object.keys(Object.prototype.toString)).toEqual([]);
    const state = JSON.parse(readFileSync(`${r.path}.state.json`, "utf8")) as { uses: Record<string, unknown> };
    expect(Object.keys(state.uses)).toEqual([name]);
    const again = new GrantBook(r.options);
    const second = await again.decide(touch(), "use", "x");
    expect(second.kind).toBe("ask");
  });
});

describe("tapline grants: last uses are scoped by app and name (PR 12 CodeRabbit)", () => {
  it("two policy files with a grant of one name keep their last uses apart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-pr12cr-"));
    dirs.push(dir);
    const auditDir = join(dir, "audit");
    const audit = new AuditLog(auditDir, () => NOW);
    audit.open();
    const fileA = join(dir, "a.json");
    const fileB = join(dir, "b.json");
    const policy = (app: string): string => JSON.stringify({ version: 2, confirm: ["Post"], block: [], grants: [{ ...GRANT, name: "posting", app, perDay: 5 }] });
    writeFileSync(fileA, policy("com.one"));
    writeFileSync(fileB, policy("com.two"));
    await new GrantBook({ policyPath: fileA, audit, now: () => NOW }).decide(touch({ app: { id: "com.one", name: "One" } }), "use", "tap ONE-ACTION");
    await new GrantBook({ policyPath: fileB, audit, now: () => NOW, sleep: async () => undefined }).decide(touch({ app: { id: "com.two", name: "Two" } }), "use", "tap TWO-ACTION");
    const a = await runGrants({ policy: fileA, auditDir, now: () => NOW });
    expect(a.text).toContain("ONE-ACTION");
    expect(a.text).not.toContain("TWO-ACTION");
    const b = await runGrants({ policy: fileB, auditDir, now: () => NOW });
    expect(b.text).toContain("TWO-ACTION");
    expect(b.text).not.toContain("ONE-ACTION");
  });
});
