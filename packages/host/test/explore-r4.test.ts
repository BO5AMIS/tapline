import { describe, expect, it } from "vitest";
import { TYPED, redactFinding } from "../src/findings.js";

// PR 13 security review, Codex cycle 2 (R4) and the two open CodeRabbit items.

describe("R4 item 6: a finding's text is redacted whole", () => {
  const vault = "abc${x}def";
  const scrub = (text: string): string => text.split(vault).join("<hidden>");
  it("a vault value that crosses a placeholder-shaped span is hidden", () => {
    const out = redactFinding({ got: `saw ${vault} here`, expected: vault, logs: [`error ${vault}`] }, scrub);
    expect(out.got).toBe("saw <hidden> here");
    expect(out.expected).toBe("<hidden>");
    expect(out.logs[0]).toBe("error <hidden>");
  });
  it("keeps the placeholder the tool generated, even when a vault value is a piece of it", () => {
    const out = redactFinding({ path: [{ tool: "type_text", text: TYPED }] }, (text) => text.split("typed").join("<hidden>"));
    expect(out.path[0]?.text).toBe(TYPED);
  });
});
