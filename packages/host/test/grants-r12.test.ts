import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditSink } from "../src/auditlog.js";
import { GrantBook, type GrantDecision, type GrantTouch, type GrantUseRef } from "../src/grants.js";

// PR 12 Codex cycle 5, finding 3: a claim is checked against the REFRESHED grant after every policy re-read: a slot number above the
// new perDay, or an hour slot above (or missing for) the new perHour, doesn't cover; the book reclaims under the new limits once.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const NOW = new Date(2026, 10, 14, 9, 0, 0);
const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "instagram_posting",
  app: "com.instagram.ios",
  words: ["Post"],
  perDay: 2,
  until: "2026-11-21",
  draftsOnly: false,
  ...over,
});
const touch = (): GrantTouch => ({ app: { id: "com.instagram.ios", name: "Instagram" }, element: { text: "Post" }, routes: [] });

class MemoryAudit implements AuditSink {
  lines: Array<Record<string, unknown>> = [];
  write(entry: Record<string, unknown>): boolean {
    this.lines.push(entry);
    return true;
  }
}

function rig(first: Record<string, unknown>): { path: string; dir: string; put(g: Record<string, unknown>): void; make(extra?: Partial<ConstructorParameters<typeof GrantBook>[0]>): GrantBook } {
  const dir = mkdtempSync(join(tmpdir(), "tapline-grants-r12-"));
  dirs.push(dir);
  const path = join(dir, "policy.json");
  const put = (g: Record<string, unknown>): void => writeFileSync(path, JSON.stringify({ version: 2, confirm: ["Post"], block: [], grants: [g] }));
  put(first);
  const audit = new MemoryAudit();
  return { path, dir, put, make: (extra = {}) => new GrantBook({ policyPath: path, audit, now: () => NOW, ...extra }) };
}

const folder = (r: { path: string }, sub: string): string[] => {
  try {
    return readdirSync(join(`${r.path}.uses`, "instagram_posting", sub)).sort();
  } catch {
    return [];
  }
};

const covered = (d: GrantDecision): d is Extract<GrantDecision, { kind: "covered" }> => d.kind === "covered";

describe("a claim is validated against the refreshed grant (finding 3)", () => {
  it("perDay 2, a second claim, the policy drops to perDay 1 before the re-read: the touch asks and the slot is given back", async () => {
    const r = rig(grant({ perDay: 2 }));
    expect((await r.make().decide(touch(), "use", "one")).kind).toBe("covered");
    let changed = false;
    const book = r.make({
      afterClaim: async () => {
        if (changed) return;
        changed = true;
        r.put(grant({ perDay: 1 }));
      },
    });
    const out = await book.decide(touch(), "use", "two");
    expect(out.kind).toBe("ask");
    expect(folder(r, "2026-11-14")).toEqual(["1"]);
  });

  it("stillCovers: a use at slot 2 no longer covers once perDay is 1", async () => {
    const r = rig(grant({ perDay: 2 }));
    expect((await r.make().decide(touch(), "use", "one")).kind).toBe("covered");
    const second = await r.make().decide(touch(), "use", "two");
    if (!covered(second)) throw new Error("not covered");
    const use: GrantUseRef = { name: second.name, owner: second.owner, slots: [...second.slots] };
    expect(await r.make().stillCovers(touch(), use)).toBe(true);
    r.put(grant({ perDay: 1 }));
    expect(await r.make().stillCovers(touch(), use)).toBe(false);
    // slot 2 was released and nothing took its place: only the first use stays counted
    expect(folder(r, "2026-11-14")).toEqual(["1"]);
  });

  it("perHour added mid-flight: the claim (no hour slot) is reclaimed under the new limits, and covers with an hour slot", async () => {
    const r = rig(grant({ perDay: 3 }));
    let changed = false;
    const book = r.make({
      afterClaim: async () => {
        if (changed) return;
        changed = true;
        r.put(grant({ perDay: 3, perHour: 1 }));
      },
    });
    const out = await book.decide(touch(), "use", "one");
    if (!covered(out)) throw new Error(`not covered: ${out.kind}`);
    expect(out.slots.some((s) => /\/h\d+$/.test(s))).toBe(true);
    expect(folder(r, "2026-11-14T09")).toEqual(["h1"]);
    expect(folder(r, "2026-11-14")).toEqual(["1"]);
  });

  it("perHour added mid-flight and the hour already used up: asks", async () => {
    const r = rig(grant({ perDay: 3, perHour: 1 }));
    expect((await r.make().decide(touch(), "use", "one")).kind).toBe("covered");
    r.put(grant({ perDay: 3 }));
    let changed = false;
    const book = r.make({
      afterClaim: async () => {
        if (changed) return;
        changed = true;
        r.put(grant({ perDay: 3, perHour: 1 }));
      },
    });
    expect((await book.decide(touch(), "use", "two")).kind).toBe("ask");
    expect(folder(r, "2026-11-14")).toEqual(["1"]);
  });

  it("perHour reduced mid-flight below the claimed hour slot: asks", async () => {
    const r = rig(grant({ perDay: 5, perHour: 2 }));
    expect((await r.make().decide(touch(), "use", "one")).kind).toBe("covered");
    let changed = false;
    const book = r.make({
      afterClaim: async () => {
        if (changed) return;
        changed = true;
        r.put(grant({ perDay: 5, perHour: 1 }));
      },
    });
    expect((await book.decide(touch(), "use", "two")).kind).toBe("ask");
    expect(folder(r, "2026-11-14T09")).toEqual(["h1"]);
  });

  it("stillCovers: perHour added after the use was taken reclaims an hour slot", async () => {
    const r = rig(grant({ perDay: 3 }));
    const out = await r.make().decide(touch(), "use", "one");
    if (!covered(out)) throw new Error("not covered");
    const use: GrantUseRef = { name: out.name, owner: out.owner, slots: [...out.slots] };
    r.put(grant({ perDay: 3, perHour: 1 }));
    expect(await r.make().stillCovers(touch(), use)).toBe(true);
    expect(use.slots.some((s) => /\/h\d+$/.test(s))).toBe(true);
    expect(folder(r, "2026-11-14")).toEqual(["1"]);
  });
});
