import { describe, expect, it } from "vitest";
import { bugSignature, type BugFinding } from "../src/bug.js";
import { runCheck, type CheckHost } from "../src/bugcheck.js";

// PR 14, Codex cycle 2 (R3), P2 items 4 and 5: the check engine on a fake host. Every value is made up.

const CRASH = { reason: "boom", frames: ["*A.tsx:1 f"] };
const crashFinding = { kind: "crash", app: "a", expected: "", got: "the app crashed: boom", crash: CRASH } as unknown as BugFinding;
const crashSig = bugSignature({ kind: "crash", placeKey: null, got: "the app crashed: boom", crash: CRASH });

function engineHost(over: Partial<CheckHost>): CheckHost {
  return {
    clock: () => 0,
    wall: () => new Date(0),
    build: () => "1.0 (1)",
    reset: async () => ({ ok: true, words: "reload only, data kept" }),
    start: async () => true,
    step: async () => ({ kind: "ok" }),
    mark: () => 0,
    since: async () => ({ crash: null, disconnected: false, errors: [] }),
    placeKey: async () => null,
    issues: async () => null,
    inFront: () => true,
    redact: (t) => t,
    ...over,
  };
}

const crashBug = { finding: crashFinding, meta: { place_key: null, signature: crashSig } as never, script: { start: null, steps: [{ tool: "tap", target: { id: "x" } }] } };

describe("R3-crash: a crash on the final step, then a disconnect", () => {
  it("counts the matching crash instead of stopping as not checked", async () => {
    let gone = false;
    const host = engineHost({
      away: () => (gone ? "stopped (the app disconnected)" : null),
      step: async () => ((gone = true), { kind: "ok" }),
      since: async () => ({ crash: { line: "boom", crash: CRASH }, disconnected: true, errors: [] }),
    });
    expect(await runCheck(host, crashBug, 1, { reset: "own" })).toMatchObject({ n: 1, of: 1 });
  });

  it("still stops when the app is gone and nothing matching was seen", async () => {
    let gone = false;
    const host = engineHost({
      away: () => (gone ? "stopped (the app disconnected)" : null),
      step: async () => ((gone = true), { kind: "ok" }),
    });
    expect(await runCheck(host, crashBug, 1, { reset: "own" })).toEqual({ checked: false, why: "stopped (the app disconnected)" });
  });
});

describe("R3-typed: the prompt for a typed value is inside the deadline", () => {
  const typedBug = {
    finding: { kind: "js_error", app: "a", expected: "", got: "x" } as unknown as BugFinding,
    meta: { place_key: null, signature: "s" } as never,
    script: { start: null, steps: [{ tool: "type_text", target: { id: "f" }, text: "${typed}" }] },
  };

  it("a prompt that never answers ends the run as timed out", async () => {
    const stepped: string[] = [];
    const host = engineHost({ step: async (s) => (stepped.push(s.tool), { kind: "ok" }), deadlineMs: 20 });
    const out = await runCheck(host, typedBug, 1, { reset: "own", typed: () => new Promise<string | null>(() => undefined) });
    expect(out).toEqual({ checked: false, why: "timed out" });
    expect(stepped).toEqual([]);
  });

  it("a value that comes after the deadline is never typed", async () => {
    const stepped: string[] = [];
    const host = engineHost({ step: async (s) => (stepped.push(s.tool), { kind: "ok" }), deadlineMs: 20 });
    const out = await runCheck(host, typedBug, 1, { reset: "own", typed: () => new Promise<string | null>((resolve) => setTimeout(() => resolve("late"), 60)) });
    expect(out).toEqual({ checked: false, why: "timed out" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stepped).toEqual([]);
  });
});
