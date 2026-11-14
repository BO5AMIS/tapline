import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditSink } from "../src/auditlog.js";
import { GrantBook, type GrantDecision, type GrantTouch, type GrantUseRef } from "../src/grants.js";

// PR 12 Codex cycle 6, finding 1: a reduced quota counts the WHOLE bucket (higher slots too), not only the claim's own slot number.

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
  write(): boolean {
    return true;
  }
}

function rig(first: Record<string, unknown>): { path: string; put(g: Record<string, unknown>): void; make(extra?: Partial<ConstructorParameters<typeof GrantBook>[0]>): GrantBook } {
  const dir = mkdtempSync(join(tmpdir(), "tapline-grants-r13-"));
  dirs.push(dir);
  const path = join(dir, "policy.json");
  const put = (g: Record<string, unknown>): void => writeFileSync(path, JSON.stringify({ version: 2, confirm: ["Post"], block: [], grants: [g] }));
  put(first);
  const audit = new MemoryAudit();
  return { path, put, make: (extra = {}) => new GrantBook({ policyPath: path, audit, now: () => NOW, ...extra }) };
}

const folder = (r: { path: string }, sub: string): string[] => {
  try {
    return readdirSync(join(`${r.path}.uses`, "instagram_posting", sub)).sort();
  } catch {
    return [];
  }
};

const covered = (d: GrantDecision): d is Extract<GrantDecision, { kind: "covered" }> => d.kind === "covered";
const refOf = (d: GrantDecision): GrantUseRef => {
  if (!covered(d)) throw new Error(`not covered: ${d.kind}`);
  return { name: d.name, owner: d.owner, slots: [...d.slots] };
};

describe("the refreshed limit counts the whole bucket (finding 1)", () => {
  it("perDay 2: A at slot 1, B at slot 2 completes, perDay cut to 1: A no longer covers and gives its slot back", async () => {
    const r = rig(grant({ perDay: 2 }));
    const a = refOf(await r.make().decide(touch(), "use", "a"));
    refOf(await r.make().decide(touch(), "use", "b"));
    expect(await r.make().stillCovers(touch(), a)).toBe(true);
    r.put(grant({ perDay: 1 }));
    expect(await r.make().stillCovers(touch(), a)).toBe(false);
    expect(folder(r, "2026-11-14")).toEqual(["2"]);
  });

  it("perHour 2 (perDay 5): the same sequence with perHour cut to 1", async () => {
    const r = rig(grant({ perDay: 5, perHour: 2 }));
    const a = refOf(await r.make().decide(touch(), "use", "a"));
    refOf(await r.make().decide(touch(), "use", "b"));
    expect(await r.make().stillCovers(touch(), a)).toBe(true);
    r.put(grant({ perDay: 5, perHour: 1 }));
    expect(await r.make().stillCovers(touch(), a)).toBe(false);
    expect(folder(r, "2026-11-14T09")).toEqual(["h2"]);
  });

  it("the reduction during decide's policy re-read: slot 1 fits by number, the bucket holds 2 under perDay 1: asks and gives back", async () => {
    const r = rig(grant({ perDay: 3 }));
    let changed = false;
    const book = r.make({
      afterClaim: async () => {
        if (changed) return;
        changed = true;
        // another touch takes slot 2 meanwhile, then the quota is cut
        await r.make().decide(touch(), "use", "other");
        r.put(grant({ perDay: 1 }));
      },
    });
    const out = await book.decide(touch(), "use", "mine");
    expect(out.kind).toBe("ask");
    expect(folder(r, "2026-11-14")).toEqual(["2"]);
  });

  it("the same during decide with perHour", async () => {
    const r = rig(grant({ perDay: 5, perHour: 3 }));
    let changed = false;
    const book = r.make({
      afterClaim: async () => {
        if (changed) return;
        changed = true;
        await r.make().decide(touch(), "use", "other");
        r.put(grant({ perDay: 5, perHour: 1 }));
      },
    });
    expect((await book.decide(touch(), "use", "mine")).kind).toBe("ask");
    expect(folder(r, "2026-11-14T09")).toEqual(["h2"]);
  });

  it("an unchanged limit still covers normally, and so does a limit cut to exactly the occupancy", async () => {
    const r = rig(grant({ perDay: 2 }));
    const a = refOf(await r.make().decide(touch(), "use", "a"));
    refOf(await r.make().decide(touch(), "use", "b"));
    expect(await r.make().stillCovers(touch(), a)).toBe(true);
    // a limit cut to exactly the occupancy still covers
    r.put(grant({ perDay: 3 }));
    expect(await r.make().stillCovers(touch(), a)).toBe(true);
    expect(folder(r, "2026-11-14")).toEqual(["1", "2"]);
  });
});
