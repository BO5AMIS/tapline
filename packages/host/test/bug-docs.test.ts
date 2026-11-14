import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The bug report is in the docs an agent and a user read (1.8.5): the tool and `tapline bug`, each once and in its own place.

const repo = join(__dirname, "..", "..", "..");
const doc = (path: string): string => readFileSync(join(repo, path), "utf8");

describe("the bug report in the docs", () => {
  it.each([
    ["README.md", ["`bug_report`", "tapline bug list", "(1.8.5)"]],
    ["AGENTS.md", ["`bug_report`", "tapline bug list", "with_picture"]],
    ["skills/tapline/SKILL.md", ["`bug_report`", "tapline bug list", "with_picture"]],
    ["docs/setup.md", ["tapline bug", "tapline call bug_report", "--with-picture"]],
  ])("%s names it", (path, words) => {
    const text = doc(path);
    for (const word of words) expect(text, `${path} lacks ${word}`).toContain(word);
  });

  it("the CLI help lists it", () => {
    expect(doc("packages/host/src/cli.ts")).toContain("  bug      Make a one-page bug report");
  });
});
