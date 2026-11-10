import { describe, expect, it } from "vitest";
import { TaplineError } from "../src/server.js";
import { ambiguousBlock, describeError } from "../src/tools.js";

function input(ref: string, y: number) {
  return { ref, type: "TextInput", role: "input", testID: null, label: null, text: "", value: null, frame: { x: 20, y, width: 300, height: 40 }, actions: ["tap", "type"] };
}

describe("ambiguous: several inputs, no target (AGENT-TOOLS §4)", () => {
  it("ends with 'Retry with one of the refs as the target.'", () => {
    const error = new TaplineError("ambiguous", "2 inputs on screen; pass a target to pick one:", {
      candidates: [input("e4", 100), input("e7", 200)],
    });
    expect(describeError(error)).toBe(
      [
        "Error ambiguous: 2 inputs on screen; pass a target to pick one:",
        "Candidates:",
        "  e4 input @20,100 300x40 [tap, type]",
        "  e7 input @20,200 300x40 [tap, type]",
        "Retry with one of the refs as the target.",
      ].join("\n"),
    );
  });

  it("words the (+N more) line without index", () => {
    const error = new TaplineError("ambiguous", "7 inputs on screen; pass a target to pick one:", {
      candidates: [1, 2, 3, 4, 5, 6, 7].map((n) => input(`e${n}`, n * 50)),
    });
    const lines = describeError(error).split("\n");
    expect(lines.at(-2)).toBe("  (+2 more; use a ref)");
    expect(lines.at(-1)).toBe("Retry with one of the refs as the target.");
  });

  it("keeps the other ambiguous cases as they were", () => {
    expect(ambiguousBlock('8 elements match text "x".', ["a", "b", "c", "d", "e", "f"], 8).split("\n").slice(-2)).toEqual([
      '  (+3 more; use a ref or "index")',
      'Retry with one of the refs, or add "index" (0-based).',
    ]);
    expect(ambiguousBlock("2 connected apps match \"demo\".", ["a", "b"], undefined, "Retry with open_app and one of these session ids.").split("\n").at(-1)).toBe(
      "Retry with open_app and one of these session ids.",
    );
  });
});
