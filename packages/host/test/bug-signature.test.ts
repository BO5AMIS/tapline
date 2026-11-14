import { describe, expect, it } from "vitest";
import { bugSignature, exceptionType, frameSymbol, normalizeGot, placeKeyJson, topAppSymbol } from "../src/bug.js";

// AGENT-TOOLS 1.16 §29.5 and §29.9: the signature, with the two worked vectors and the normalizing vectors, exactly.

const CRASH_GOT = "the app crashed: TypeError: undefined is not an object (evaluating 'trip.days.map')";

describe("the signature (§29.5)", () => {
  it("the crash of §27.1 is 7bc2e91c152d416e", () => {
    const signature = bugSignature({
      kind: "crash",
      placeKey: { route: ["trips", "[id]"], tab: "trips" },
      got: CRASH_GOT,
      crash: { reason: "TypeError: undefined is not an object", frames: ["*TripDetail.tsx:48 renderDays", "…"] },
    });
    expect(signature).toBe("7bc2e91c152d416e");
  });

  it("the observed note on a signature place is 29146f71e709878d", () => {
    const signature = bugSignature({
      kind: "observed",
      placeKey: { signature: "c41f9a07d2", parts: { anything: 1 } },
      got: "Total shows $12.50 after 2 coupons at 09:21:07",
    });
    expect(normalizeGot("Total shows $12.50 after 2 coupons at 09:21:07")).toBe("Total shows $# after # coupons at #");
    expect(signature).toBe("29146f71e709878d");
  });

  it("the place key is JSON with sorted keys and no spaces, a signature key by its signature only, unknown as null", () => {
    expect(placeKeyJson({ route: ["trips", "[id]"], tab: "trips" })).toBe('{"route":["trips","[id]"],"tab":"trips"}');
    expect(placeKeyJson({ tab: "trips", route: ["trips"], layer: "sheet" })).toBe('{"layer":"sheet","route":["trips"],"tab":"trips"}');
    expect(placeKeyJson({ signature: "c41f9a07d2", parts: { x: 1 } })).toBe('{"signature":"c41f9a07d2"}');
    expect(placeKeyJson(null)).toBe("null");
  });

  it("the vectors of §29.9: normalized text", () => {
    expect(normalizeGot("Total shows $12.50 after 2 coupons")).toBe("Total shows $# after # coupons");
    expect(normalizeGot("Order 7b9e3c1a-0d52-4f10-9a77-1c2b3d4e5f60 failed at 2026-11-14T09:21:07Z")).toBe("Order # failed at #");
    expect(normalizeGot("trip-42 not found (0x7ffee3a1c8d0)")).toBe("trip-# not found (#)");
    expect(normalizeGot("  many   spaces\nsecond line 9  ")).toBe("many spaces");
    // 8 or more hex digits that include a digit; a word of letters only is kept
    expect(normalizeGot("id deadbeef and facade12 and 5f3a9c01b2")).toBe("id deadbeef and # and #");
  });

  it("the vectors of §29.9: frame symbols", () => {
    expect(frameSymbol("*TripDetail.tsx:48 renderDays")).toBe("renderDays");
    expect(frameSymbol("3 Wayfare 0x0000000102a4b3c8 -[TripViewController renderDays] + 148")).toBe("-[TripViewController renderDays]");
    expect(frameSymbol("*TripDetail.tsx:48")).toBe("unsymbolicated");
    expect(frameSymbol("*bundle.js:1:2 <anonymous>")).toBe("unsymbolicated");
    expect(frameSymbol("4 Wayfare 0x0000000102a4b3c8 + 148")).toBe("unsymbolicated");
    expect(topAppSymbol(["RN.js:1 f", "*TripDetail.tsx:48 renderDays"])).toBe("renderDays");
    expect(topAppSymbol(["RN.js:1 f"])).toBe("unsymbolicated");
    expect(topAppSymbol([])).toBe("unsymbolicated");
  });

  it("the exception type is the text before the first colon, else the first word", () => {
    expect(exceptionType("TypeError: undefined is not an object")).toBe("TypeError");
    expect(exceptionType("EXC_BAD_ACCESS (SIGSEGV)")).toBe("EXC_BAD_ACCESS");
  });

  it("a changed number, address or place name keeps it; a changed type or symbol makes another", () => {
    const base = { kind: "crash" as const, placeKey: { route: ["trips", "[id]"], tab: "trips" }, got: CRASH_GOT, crash: { reason: "TypeError: x", frames: ["*TripDetail.tsx:48 renderDays"] } };
    const sig = bugSignature(base);
    expect(bugSignature({ ...base, crash: { reason: "TypeError: y", frames: ["*TripDetail.tsx:51 renderDays"] } })).toBe(sig);
    expect(bugSignature({ ...base, crash: { reason: "RangeError: x", frames: base.crash.frames } })).not.toBe(sig);
    expect(bugSignature({ ...base, crash: { reason: "TypeError: x", frames: ["*TripDetail.tsx:48 renderOther"] } })).not.toBe(sig);
    const slow = { kind: "slow" as const, placeKey: { route: ["a"] }, got: "3.5 s to settle" };
    expect(bugSignature({ ...slow, got: "4.1 s to settle" })).toBe(bugSignature(slow));
  });
});
