import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditSink } from "../src/auditlog.js";
import { GrantBook, grantKey, parseGrants, type GrantSpec, type GrantTouch, type GrantUseRef } from "../src/grants.js";

// PR 12 round 7 (Codex cycle 3), findings 1 to 3: the policy file's edit lock, case aliases of grant names, and midnight in a claim.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-grants-r7-"));
  dirs.push(dir);
  return dir;
};

const NOW = new Date(2026, 10, 14, 9, 0, 0);
const GRANT = { name: "instagram_posting", app: "com.instagram.ios", words: ["Post"], perDay: 1, until: "2026-11-21", draftsOnly: false };
const touch = (): GrantTouch => ({ app: { id: "com.instagram.ios", name: "Instagram" }, element: { text: "Post" }, routes: [] });

class MemoryAudit implements AuditSink {
  lines: Array<Record<string, unknown>> = [];
  write(entry: Record<string, unknown>): boolean {
    this.lines.push(entry);
    return true;
  }
}

const latch = (): { wait: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

interface Rig {
  dir: string;
  path: string;
  audit: MemoryAudit;
  clock: { now: Date };
  make(extra?: Partial<ConstructorParameters<typeof GrantBook>[0]>): GrantBook;
  put(grants: unknown[]): void;
  read(): { version: number; grants: Array<Record<string, unknown>> };
}

function rig(grants: unknown[] = [GRANT]): Rig {
  const dir = tmp();
  const path = join(dir, "policy.json");
  const audit = new MemoryAudit();
  const clock = { now: NOW };
  const put = (list: unknown[]): void => writeFileSync(path, JSON.stringify({ version: 2, confirm: ["Post"], block: [], grants: list }));
  put(grants);
  return {
    dir,
    path,
    audit,
    clock,
    put,
    make: (extra = {}) => new GrantBook({ policyPath: path, audit, now: () => clock.now, editLockWaitMs: 3000, editLockPollMs: 5, ...extra }),
    read: () => JSON.parse(readFileSync(path, "utf8")) as { version: number; grants: Array<Record<string, unknown>> },
  };
}

const spec = (over: Partial<GrantSpec> = {}): GrantSpec => ({ nameBase: "second_grant", app: "com.instagram.ios", words: ["Remove"], perDay: 2, days: 7, ...over });

describe("finding 1: every policy-file mutation runs under an edit lock, on fresh content", () => {
  it("a creator paused after its check cannot undo a revoke-all: the revoke waits for the lock, then revokes the creator's grant too", async () => {
    const r = rig();
    const reached = latch();
    const gate = latch();
    const creator = r.make({
      beforePolicyWrite: async () => {
        reached.open();
        await gate.wait;
      },
    });
    const revoker = r.make();
    const created = creator.create(spec());
    await reached.wait;
    // revoke-all starts while the creator holds its stale-able copy: it cannot complete before the creator is done
    const revoked = revoker.revokeAll();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.read().grants.some((g) => typeof g["revoked"] === "string")).toBe(false);
    gate.open();
    expect(await created).toMatchObject({ grant: { name: "second_grant" } });
    const done = await revoked;
    expect(done).toEqual({ revoked: ["instagram_posting", "second_grant"], already: [] });
    // the revocation stands: every grant, the new one included, is revoked in the file
    expect(r.read().grants.map((g) => g["revoked"])).toEqual(["2026-11-14", "2026-11-14"]);
    expect(existsSync(`${r.path}.edit.lock`)).toBe(false);
  });

  it("a revoke-all that completed first is never undone by a creator that started before it: the creator applies its change to the revoked file", async () => {
    const r = rig();
    const reached = latch();
    const gate = latch();
    const revoker = r.make({
      beforePolicyWrite: async () => {
        reached.open();
        await gate.wait;
      },
    });
    const creator = r.make();
    const revoked = revoker.revokeAll();
    await reached.wait;
    const created = creator.create(spec());
    await new Promise((resolve) => setTimeout(resolve, 80));
    gate.open();
    await revoked;
    expect(await created).toMatchObject({ grant: { name: "second_grant" } });
    const grants = r.read().grants;
    expect(grants.map((g) => g["name"])).toEqual(["instagram_posting", "second_grant"]);
    // the first grant's revocation is still in the file
    expect(grants[0]?.["revoked"]).toBe("2026-11-14");
  });

  it("a holder that can't get the lock in time fails closed: no grant, nothing written, and the file is as it was", async () => {
    const r = rig();
    const before = readFileSync(r.path, "utf8");
    // a live process holds the lock for good
    writeFileSync(`${r.path}.edit.lock`, `${JSON.stringify({ owner: "x-1", pid: 4242, started: null })}\n`);
    const book = r.make({ editLockWaitMs: 120, editLock: { pid: 1111, alive: () => true } });
    const created = await book.create(spec());
    expect(created).toMatchObject({ error: expect.stringMatching(/edit lock/) });
    const revoked = await book.revokeAll();
    expect(revoked).toMatchObject({ error: expect.stringMatching(/edit lock/) });
    expect(readFileSync(r.path, "utf8")).toBe(before);
    expect(r.audit.lines).toEqual([]);
    // the other holder's lock is untouched
    expect(JSON.parse(readFileSync(`${r.path}.edit.lock`, "utf8"))).toMatchObject({ owner: "x-1", pid: 4242 });
  });

  it("a lock left by a holder that died doesn't block: it is taken over, used, and released", async () => {
    const r = rig();
    writeFileSync(`${r.path}.edit.lock`, `${JSON.stringify({ owner: "dead-999", pid: 999, started: null })}\n`);
    const book = r.make({ editLock: { pid: 1111, alive: (pid) => pid !== 999 } });
    expect(await book.create(spec())).toMatchObject({ grant: { name: "second_grant" } });
    expect(r.read().grants).toHaveLength(2);
    expect(existsSync(`${r.path}.edit.lock`)).toBe(false);
    expect(readdirSync(r.dir).filter((f) => f.includes(".edit.lock"))).toEqual([]);
  });

  it("an empty edit lock is never taken for a leftover", async () => {
    const r = rig();
    writeFileSync(`${r.path}.edit.lock`, "");
    const book = r.make({ editLockWaitMs: 100, editLock: { pid: 1111, alive: () => false } });
    expect(await book.create(spec())).toMatchObject({ error: expect.stringMatching(/edit lock/) });
    expect(r.read().grants).toHaveLength(1);
  });

  it("the lock is released when the edit fails, and two creators in a row both land (neither loses the other's grant)", async () => {
    const r = rig();
    const a = r.make();
    const b = r.make();
    const [one, two] = await Promise.all([a.create(spec({ nameBase: "alpha" })), b.create(spec({ nameBase: "beta" }))]);
    expect(one).toHaveProperty("grant");
    expect(two).toHaveProperty("grant");
    expect(r.read().grants.map((g) => g["name"]).sort()).toEqual(["alpha", "beta", "instagram_posting"]);
    expect(existsSync(`${r.path}.edit.lock`)).toBe(false);
  });
});

describe("finding 2: grant names that differ only by case (or by Unicode form) are one name", () => {
  const base = { app: "x", words: ["Remove"], until: "2026-11-20" };

  it("grantKey folds case and Unicode compatibility forms", () => {
    expect(grantKey("G")).toBe(grantKey("g"));
    expect(grantKey("Instagram_Post")).toBe(grantKey("instagram_post"));
    expect(grantKey("ｇ")).toBe(grantKey("g")); // a full-width g
    expect(grantKey("a")).not.toBe(grantKey("b"));
  });

  it("an active g and a revoked G: the later one is refused alone, with a reason", () => {
    const { grants, refused } = parseGrants([{ name: "g", ...base }, { name: "G", ...base, revoked: "2026-11-13" }], "2026-11-14", () => []);
    expect(grants.map((g) => g.name)).toEqual(["g"]);
    expect(refused).toEqual([{ name: "G", reason: expect.stringMatching(/same name as an earlier grant|only in case/) }]);
  });

  it("a revoked G listed first and an active g after: the later (active) one is refused, never both loaded", () => {
    const { grants, refused } = parseGrants([{ name: "G", ...base, revoked: "2026-11-13" }, { name: "g", ...base }], "2026-11-14", () => []);
    expect(grants.map((g) => g.name)).toEqual(["G"]);
    expect(refused.map((x) => x.name)).toEqual(["g"]);
  });

  it("pruning a revoked alias can't delete the active grant's uses, so no touch beyond perDay is possible", async () => {
    // the file holds an active g and a revoked G; they share one folder on a case-insensitive file system
    const r = rig([{ ...GRANT, name: "g" }, { ...GRANT, name: "G", revoked: "2026-11-13" }]);
    const book = r.make();
    expect((await book.decide(touch(), "use", "x")).kind).toBe("covered");
    expect(await book.prune()).toEqual([]);
    expect((await book.decide(touch(), "use", "x")).kind).toBe("ask"); // perDay 1 is used; the prune reset nothing
    const uses = readdirSync(`${r.path}.uses`);
    expect(uses).toEqual(["g"]);
    expect(readdirSync(join(`${r.path}.uses`, "g", "2026-11-14"))).toEqual(["1"]);
  });

  it("the slot folder is the lower-cased name (names are ASCII only), so a name's case never picks another folder", async () => {
    const r = rig([{ ...GRANT, name: "Mixed_Case" }]);
    const book = r.make();
    const used = await book.decide(touch(), "use", "x");
    if (used.kind !== "covered") throw new Error("not covered");
    expect(used.slots).toEqual(["mixed_case/2026-11-14/1"]);
    expect(readdirSync(`${r.path}.uses`)).toEqual(["mixed_case"]);
    await book.release(used);
    expect(readdirSync(join(`${r.path}.uses`, "mixed_case", "2026-11-14"))).toEqual([]);
  });

  it("a new grant's name never collides with an existing one by case", async () => {
    const r = rig([{ ...GRANT, name: "Second_Grant" }]);
    const made = await r.make().create(spec({ nameBase: "second_grant" }));
    expect(made).toMatchObject({ grant: { name: "second_grant_2" } });
  });
});

describe("finding 3: midnight in a claim", () => {
  const slots = (r: Rig, folder: string, name = "instagram_posting"): string[] => {
    const dir = join(`${r.path}.uses`, name, folder);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };
  const pausingBook = (r: Rig): { book: GrantBook; reached: Promise<void>; go: () => void } => {
    const reached = latch();
    const gate = latch();
    let first = true;
    const book = r.make({
      beforeCreate: async () => {
        if (!first) return;
        first = false;
        reached.open();
        await gate.wait;
      },
    });
    return { book, reached: reached.wait, go: gate.open };
  };

  it("a claimer paused before its create, the clock passes midnight, today's quota is used: it must not return covered from yesterday's folder", async () => {
    const r = rig([{ ...GRANT, perDay: 1, until: "2026-11-21" }]);
    r.clock.now = new Date(2026, 10, 14, 23, 59, 59);
    const a = pausingBook(r);
    const pa = a.book.decide(touch(), "use", "a");
    await a.reached;
    r.clock.now = new Date(2026, 10, 15, 0, 0, 1);
    expect((await r.make().decide(touch(), "use", "b")).kind).toBe("covered"); // the 15th's only use
    a.go();
    expect((await pa).kind).toBe("ask");
    expect(slots(r, "2026-11-14")).toEqual([]); // its own late slot was deleted
    expect(slots(r, "2026-11-15")).toEqual(["1"]);
    expect(r.audit.lines.filter((l) => l["kind"] === "grant")).toHaveLength(1);
  });

  it("the same for the hour bucket: a claim from 09:59 is not counted against 09 once it is 10:00 and the 10 o'clock use is taken", async () => {
    const r = rig([{ ...GRANT, perDay: 5, perHour: 1 }]);
    r.clock.now = new Date(2026, 10, 14, 9, 59, 59);
    const a = pausingBook(r);
    const pa = a.book.decide(touch(), "use", "a");
    await a.reached;
    r.clock.now = new Date(2026, 10, 14, 10, 0, 1);
    expect((await r.make().decide(touch(), "use", "b")).kind).toBe("covered");
    a.go();
    expect((await pa).kind).toBe("ask");
    expect(slots(r, "2026-11-14T09")).toEqual([]);
    expect(slots(r, "2026-11-14T10")).toEqual(["h1"]);
    expect(slots(r, "2026-11-14")).toEqual(["1"]);
  });

  it("when the new day has room the paused claimer claims again there, and its slots are in the current bucket only", async () => {
    const r = rig([{ ...GRANT, perDay: 3, until: "2026-11-21" }]);
    r.clock.now = new Date(2026, 10, 14, 23, 59, 59);
    const a = pausingBook(r);
    const pa = a.book.decide(touch(), "use", "a");
    await a.reached;
    r.clock.now = new Date(2026, 10, 15, 0, 0, 1);
    a.go();
    const done = await pa;
    expect(done).toMatchObject({ kind: "covered", slots: ["instagram_posting/2026-11-15/1"] });
    expect(slots(r, "2026-11-14")).toEqual([]);
    expect(slots(r, "2026-11-15")).toEqual(["1"]);
  });

  it("stillCovers: a use taken yesterday whose touch comes after midnight is released and, when today is full, not covered", async () => {
    const r = rig([{ ...GRANT, perDay: 1, until: "2026-11-21" }]);
    r.clock.now = new Date(2026, 10, 14, 23, 59, 50);
    const book = r.make();
    const used = await book.decide(touch(), "use", "x");
    if (used.kind !== "covered") throw new Error("not covered");
    r.clock.now = new Date(2026, 10, 15, 0, 0, 5);
    expect((await r.make().decide(touch(), "use", "other")).kind).toBe("covered"); // the 15th's only use
    expect(await book.stillCovers(touch(), used)).toBe(false);
    expect(slots(r, "2026-11-14")).toEqual([]); // released
    expect(slots(r, "2026-11-15")).toEqual(["1"]); // the other one's, untouched
  });

  it("stillCovers: with room today the use is reclaimed in the current bucket, and the reference now names those slots", async () => {
    const r = rig([{ ...GRANT, perDay: 2, until: "2026-11-21" }]);
    r.clock.now = new Date(2026, 10, 14, 23, 59, 50);
    const book = r.make();
    const used = await book.decide(touch(), "use", "x");
    if (used.kind !== "covered") throw new Error("not covered");
    const ref: GrantUseRef = { name: used.name, owner: used.owner, slots: used.slots };
    r.clock.now = new Date(2026, 10, 15, 0, 0, 5);
    expect(await book.stillCovers(touch(), ref)).toBe(true);
    expect(ref.slots).toEqual(["instagram_posting/2026-11-15/1"]);
    expect(slots(r, "2026-11-14")).toEqual([]);
    expect(slots(r, "2026-11-15")).toEqual(["1"]);
    // and the reference it holds now gives those back
    await book.release(ref);
    expect(slots(r, "2026-11-15")).toEqual([]);
  });

  it("stillCovers in the same day and hour changes nothing", async () => {
    const r = rig([{ ...GRANT, perDay: 2, perHour: 1 }]);
    const book = r.make();
    const used = await book.decide(touch(), "use", "x");
    if (used.kind !== "covered") throw new Error("not covered");
    const ref: GrantUseRef = { name: used.name, owner: used.owner, slots: [...used.slots] };
    expect(await book.stillCovers(touch(), ref)).toBe(true);
    expect(ref.slots).toEqual(used.slots);
  });
});

