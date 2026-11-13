import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionLogEntry } from "../src/actionlog.js";
import { AuditLog, type AuditSink } from "../src/auditlog.js";
import { runDoctor } from "../src/doctor.js";
import { DRAFTS_SCHEMA, GRANT_SCHEMA } from "../src/elicit.js";
import { GrantBook, grantCaption, grantNameBase, type GrantTouch } from "../src/grants.js";
import { runAuditLog, runGrants } from "../src/grantscmd.js";
import { grantsLine } from "../src/report.js";

// AGENT-TOOLS 1.14 §19.5 to §19.7 and §23: revoking, the dialog's text, `tapline grants`, `tapline audit-log`, doctor, the report line.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-grants-control-"));
  dirs.push(dir);
  return dir;
};

const NOW = new Date(2026, 10, 14, 9, 0, 0);
const GRANT = { name: "instagram_posting", app: "com.instagram.ios", words: ["Post"], perDay: 3, until: "2026-11-21", draftsOnly: false };
const touch = (over: Partial<GrantTouch> = {}): GrantTouch => ({ app: { id: "com.instagram.ios", name: "Instagram" }, element: { text: "Post" }, routes: [], ...over });

class MemoryAudit implements AuditSink {
  lines: Array<Record<string, unknown>> = [];
  write(entry: Record<string, unknown>): boolean {
    this.lines.push(entry);
    return true;
  }
}

function rig(grants: unknown[], version = 2): { path: string; dir: string; audit: MemoryAudit; book: GrantBook; read(): { version: number; grants: Array<Record<string, unknown>> } } {
  const dir = tmp();
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify({ version, confirm: ["Post", "Send"], block: [], grants }));
  const audit = new MemoryAudit();
  const book = new GrantBook({ policyPath: path, audit, now: () => NOW });
  return { path, dir, audit, book, read: () => JSON.parse(readFileSync(path, "utf8")) as { version: number; grants: Array<Record<string, unknown>> } };
}

describe("the dialog's question says everything the grant allows (§19.6)", () => {
  it("is the spec's example, word for word", () => {
    const caption = grantCaption({ words: ["Post"], perDay: 3, until: "2026-11-21", route: "post_update", draftsOnly: true }, "Instagram");
    expect(caption).toBe('Allow tapping "Post" in Instagram up to 3 times a day, only in route post_update, until 21 Nov (drafts shown to you first)?');
  });

  it("says several words, an hourly limit and quiet hours as the spec words them", () => {
    const caption = grantCaption({ words: ["Post", "Send"], perDay: 3, perHour: 1, until: "2026-11-21", quiet: { from: "22:00", to: "07:00" }, draftsOnly: false }, "Instagram");
    expect(caption).toBe('Allow tapping "Post" or "Send" in Instagram up to 3 times a day and 1 an hour, not between 22:00 and 07:00, until 21 Nov?');
  });

  it("cuts and cleans text from the app", () => {
    const caption = grantCaption({ words: ["Post"], perDay: 1, until: "2026-11-21", draftsOnly: false }, "Insta\u0000gram".repeat(1));
    expect(caption).toContain("up to 1 time a day");
    expect(grantCaption({ words: ['Po"st'], perDay: 1, until: "2026-11-21", draftsOnly: false }, "X")).toContain(`"Po'st"`);
  });

  it("the first question has no default, the second defaults to No", () => {
    expect(GRANT_SCHEMA.properties["answer"]?.default).toBeUndefined();
    expect(GRANT_SCHEMA.properties["answer"]?.enum).toEqual(["Don't allow", "Allow"]);
    expect(DRAFTS_SCHEMA.properties["answer"]?.default).toBe("No");
  });

  it("names a grant from the app and the word", () => {
    expect(grantNameBase("Instagram", "Post")).toBe("instagram_post");
    expect(grantNameBase("***", "!!!")).toBe("grant");
  });
});

describe("revoke-all (§19.5)", () => {
  it("marks every grant in the file, keeps it listed, and writes one revoke line each", async () => {
    const r = rig([GRANT, { ...GRANT, name: "second", words: ["Send"] }]);
    const done = await r.book.revokeAll();
    expect(done).toEqual({ revoked: ["instagram_posting", "second"], already: [] });
    expect(r.read().grants.map((g) => g["revoked"])).toEqual(["2026-11-14", "2026-11-14"]);
    expect(r.read().grants).toHaveLength(2);
    expect(r.audit.lines).toEqual([
      { kind: "revoke", app: "com.instagram.ios", name: "instagram_posting", detail: "grants --revoke-all" },
      { kind: "revoke", app: "com.instagram.ios", name: "second", detail: "grants --revoke-all" },
    ]);
  });

  it("keeps an earlier revocation's date and writes no line for it", async () => {
    const r = rig([{ ...GRANT, revoked: "2026-11-01" }, { ...GRANT, name: "b" }]);
    expect(await r.book.revokeAll()).toEqual({ revoked: ["b"], already: ["instagram_posting"] });
    expect(r.read().grants.map((g) => g["revoked"])).toEqual(["2026-11-01", "2026-11-14"]);
  });

  it("a version 1 file with no grants is left as it is", async () => {
    const r = rig([], 1);
    const before = readFileSync(r.path, "utf8");
    expect(await r.book.revokeAll()).toEqual({ revoked: [], already: [] });
    expect(readFileSync(r.path, "utf8")).toBe(before);
  });

  it("a second host instance on the same file sees it at its very next touch", async () => {
    const r = rig([GRANT]);
    const other = new GrantBook({ policyPath: r.path, audit: new MemoryAudit(), now: () => NOW });
    expect((await other.decide(touch(), "use", "tap")).kind).toBe("covered");
    await r.book.revokeAll();
    const next = await other.decide(touch(), "use", "tap");
    expect(next).toMatchObject({ kind: "ask", asked: ["revoked"] });
    expect(next.kind === "ask" ? next.notes : []).toEqual(['Note: grant "instagram_posting" doesn\'t cover this (it was revoked on 2026-11-14); asking a person.']);
  });

  it("a revoked grant stays revoked after the use counts are read again, and nothing is counted", async () => {
    const r = rig([GRANT]);
    await r.book.revokeAll();
    await r.book.decide(touch(), "use", "tap");
    expect(r.audit.lines.filter((l) => l["kind"] === "grant")).toEqual([]);
  });
});

describe("creating a grant (§19.6)", () => {
  const spec = { nameBase: "instagram_post", app: "com.instagram.ios", words: ["Post"], perDay: 3, days: 7 };

  it("writes it into the file with a name not used yet, and logs the creation", async () => {
    const r = rig([{ ...GRANT, name: "instagram_post" }]);
    const made = await r.book.create(spec);
    expect(made).toMatchObject({ grant: { name: "instagram_post_2", until: "2026-11-21", perDay: 3, draftsOnly: true } });
    const file = r.read();
    expect(file.grants).toHaveLength(2);
    expect(file.grants[1]).toEqual({ name: "instagram_post_2", app: "com.instagram.ios", words: ["Post"], perDay: 3, until: "2026-11-21" });
    expect(r.audit.lines).toEqual([{ kind: "approval", app: "com.instagram.ios", name: "Post", detail: "grant created" }]);
  });

  it("writes draftsOnly false only when asked to", async () => {
    const r = rig([]);
    await r.book.create({ ...spec, draftsOnly: false });
    expect(r.read().grants[0]?.["draftsOnly"]).toBe(false);
  });

  it("turns a version 1 file into version 2", async () => {
    const r = rig([], 1);
    await r.book.create(spec);
    expect(r.read().version).toBe(2);
    expect(r.read().grants).toHaveLength(1);
  });

  it("keeps until within 30 days", async () => {
    const r = rig([]);
    const made = await r.book.create({ ...spec, days: 90 });
    expect(made).toMatchObject({ grant: { until: "2026-12-14" } });
  });

  it("refuses what is never grantable, writes nothing and no line", async () => {
    const r = rig([]);
    const before = readFileSync(r.path, "utf8");
    const made = await r.book.create({ ...spec, words: ["Pay"] });
    expect("error" in made).toBe(true);
    expect(readFileSync(r.path, "utf8")).toBe(before);
    expect(r.audit.lines).toEqual([]);
  });
});

describe("tapline grants (§19.7)", () => {
  it("lists every grant with today's counts and the last uses from the audit log", async () => {
    const dir = tmp();
    const path = join(dir, "policy.json");
    const auditDir = join(dir, "audit");
    writeFileSync(path, JSON.stringify({ version: 2, confirm: ["Post"], block: [], grants: [{ ...GRANT, perHour: 2 }, { name: "shop", app: "x", words: ["Pay"], until: "2026-11-20" }] }));
    const audit = new AuditLog(auditDir, () => NOW);
    audit.open();
    const book = new GrantBook({ policyPath: path, audit, now: () => NOW });
    await book.decide(touch(), "use", 'tap "Post"');
    await book.decide(touch(), "use", 'tap "Post"');
    const out = await runGrants({ policy: path, auditDir, now: () => NOW });
    expect(out.code).toBe(0);
    expect(out.text).toContain("instagram_posting: active");
    expect(out.text).toContain("app com.instagram.ios; words \"Post\"; until 2026-11-21");
    expect(out.text).toContain("today 2 of 3, this hour 2 of 2");
    expect(out.text).toContain('last uses: ');
    expect(out.text).toContain('tap "Post" (2 of 3 today)');
    expect(out.text).toContain('Refused: grant "shop" is refused: payments and purchases are never grantable ("Pay").');
  });

  it("says when there are none, and needs the policy file", async () => {
    const r = rig([]);
    expect((await runGrants({ policy: r.path, auditDir: join(r.dir, "audit"), now: () => NOW })).text).toBe("No grants.");
    expect((await runGrants({ policy: undefined, auditDir: r.dir })).code).toBe(2);
  });

  it("--revoke-all revokes, writes the lines and lists them as revoked", async () => {
    const r = rig([GRANT]);
    const auditDir = join(r.dir, "audit");
    const out = await runGrants({ policy: r.path, auditDir, revokeAll: true, now: () => NOW });
    expect(out.text).toContain("Revoked 1 grant: instagram_posting.");
    expect(out.text).toContain("instagram_posting: revoked 2026-11-14");
    const lines = readdirSync(auditDir).flatMap((n) => readFileSync(join(auditDir, n), "utf8").split("\n").filter((l) => l !== ""));
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([expect.objectContaining({ kind: "revoke", name: "instagram_posting", detail: "grants --revoke-all" })]);
  });

  it("an ended grant is listed as ended", async () => {
    const r = rig([{ ...GRANT, until: "2026-11-10" }]);
    expect((await runGrants({ policy: r.path, auditDir: join(r.dir, "audit"), now: () => new Date(2026, 10, 14, 9) })).text).toContain("instagram_posting: ended 2026-11-10");
  });
});

describe("tapline audit-log (§23)", () => {
  const seed = (dir: string): void => {
    const lines = [
      { t: "2026-11-12T06:00:00.000Z", tool: "tapline", kind: "grant", name: "g", detail: "old" },
      { t: "2026-11-14T06:00:12.481Z", tool: "tapline", kind: "revoke", name: "g", detail: "grants --revoke-all" },
    ];
    writeFileSync(join(dir, "2026-11.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  };

  it("lists the lines as written, and only those since a date or ISO time", () => {
    const dir = tmp();
    seed(dir);
    const all = runAuditLog({ dir });
    expect(all.text.split("\n")).toHaveLength(2);
    expect(all.text.split("\n")[0]).toBe('{"t":"2026-11-12T06:00:00.000Z","tool":"tapline","kind":"grant","name":"g","detail":"old"}');
    const since = runAuditLog({ dir, since: "2026-11-14T00:00:00Z" });
    expect(since.text).toBe('{"t":"2026-11-14T06:00:12.481Z","tool":"tapline","kind":"revoke","name":"g","detail":"grants --revoke-all"}');
    expect(runAuditLog({ dir, since: "2026-11-15T12:00:00Z" }).text).toBe("The audit log has no lines since then.");
  });

  it("refuses a since it can't read", () => {
    expect(runAuditLog({ dir: tmp(), since: "yesterday-ish" }).code).toBe(2);
  });

  it("--delete deletes the log, and says how many lines went", () => {
    const dir = tmp();
    seed(dir);
    expect(runAuditLog({ dir, delete: true })).toEqual({ text: "Deleted the audit log (2 lines).", code: 0 });
    expect(readdirSync(dir)).toEqual([]);
    expect(runAuditLog({ dir }).text).toBe("The audit log has no lines.");
  });

  it("--delete with --since is refused and deletes nothing", () => {
    const dir = tmp();
    seed(dir);
    expect(runAuditLog({ dir, delete: true, since: "2026-11-14" }).code).toBe(2);
    expect(readdirSync(dir)).toEqual(["2026-11.jsonl"]);
  });
});

describe("the report's Grants line (§19.7)", () => {
  const entry = (over: Partial<ActionLogEntry>): ActionLogEntry => ({ t: "2026-11-14T06:00:00.000Z", source: "tapline", by: "agent", tool: "tap", ok: true, ...over });

  it("says the uses, the last count and the times a person was asked", () => {
    const line = grantsLine([
      entry({ grant: "instagram_posting", grant_use: "1 of 2 today" }),
      entry({ grant: "instagram_posting", grant_use: "2 of 2 today" }),
      entry({ ok: false, code: "not_allowed", grant_asked: "limit reached" }),
    ]);
    expect(line).toBe("Grants: instagram_posting 2 uses (2 of 2 today); asked a person 1 time (limit reached).");
  });

  it("is left out when no grant was involved, and a dry run counts nothing", () => {
    expect(grantsLine([entry({})])).toBeUndefined();
    expect(grantsLine([entry({ grant: "g", dry_run: true })])).toBeUndefined();
  });

  it("names several reasons with their counts", () => {
    expect(grantsLine([entry({ grant_asked: "limit reached" }), entry({ grant_asked: "limit reached" }), entry({ grant_asked: "quiet hours" })])).toBe("Grants: asked a person 3 times (limit reached 2, quiet hours 1).");
  });
});

describe("doctor reports refused grants and a broken state file (§19.1, §19.4)", () => {
  const run = async (policyFile: string): Promise<Awaited<ReturnType<typeof runDoctor>>[number] | undefined> => {
    const results = await runDoctor({
      policyFile,
      now: () => NOW,
      platform: "linux",
      run: async () => ({ code: -1, stdout: "", stderr: "" }),
      lanIps: () => ["192.168.1.2"],
      portFree: async () => true,
      gitStatus: async () => null,
    });
    return results.find((r) => r.name === "Grants");
  };

  it("passes with sound grants", async () => {
    const r = rig([GRANT]);
    expect(await run(r.path)).toMatchObject({ status: "pass", detail: "1 grant load" });
  });

  it("warns, naming the refused grant and why", async () => {
    const r = rig([GRANT, { name: "shop_pay", app: "x", words: ["Pay"], until: "2026-11-20" }]);
    const result = await run(r.path);
    expect(result?.status).toBe("warn");
    expect(result?.detail).toBe('grant "shop_pay" is refused: payments and purchases are never grantable ("Pay")');
  });

  it("warns about a state file that doesn't parse", async () => {
    const r = rig([GRANT]);
    writeFileSync(`${r.path}.state.json`, "{ nope");
    const result = await run(r.path);
    expect(result?.status).toBe("warn");
    expect(result?.detail).toContain("state file doesn't parse");
  });
});
