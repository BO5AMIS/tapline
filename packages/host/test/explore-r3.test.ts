import { describe, expect, it } from "vitest";
import { TYPED, redactFinding } from "../src/findings.js";

// PR 13 CodeRabbit round (R3): findings.

describe("R3: a finding's placeholder-shaped text is still content", () => {
  const scrub = (text: string): string => text.replace(/SECRET/g, "<hidden>");
  it("redacts a vault value inside a ${…} span, and keeps the typed placeholder", () => {
    const out = redactFinding({ got: "${SECRET}", expected: `${TYPED} and ${"${SECRET}"}`, logs: ["error ${a SECRET b}"] }, scrub);
    expect(out.got).toBe("${<hidden>}");
    expect(out.expected).toBe(`${TYPED} and \${<hidden>}`);
    expect(out.logs[0]).toBe("error ${a <hidden> b}");
  });
});

import type { LogEntry } from "../src/protocol.js";
import { errorLine } from "../src/explore.js";

describe("R3: an error line is redacted before it is cut", () => {
  it("a value that straddles the 300th character is hidden whole", () => {
    const value = "hunter2-hunter2";
    const message = `${"e".repeat(290)}${value} and more`;
    const redact = (text: string): string => text.split(value).join("<hidden>");
    const line = errorLine({ message } as LogEntry, redact);
    expect(line).not.toContain("hunter");
    expect(line).toContain("<hidden>");
  });
});
