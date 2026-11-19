import { describe, expect, it } from "vitest";
import { instructionsFor, INSTRUCTIONS } from "../src/tool-text.js";
import { TOKEN_RULES } from "../src/token-rules.js";
import { parseCli, runtimeOptionsOf } from "../src/cli.js";

// AGENT-TOOLS 1.17 §30.1 (the token rules at the top of the instructions) and §30.4 (`--no-hints`).

describe("the token rules (§30.1)", () => {
  it("are the shared block word for word, with Tapline's replay filled in", () => {
    expect(TOKEN_RULES).toBe(
      [
        "Working well with this tool (fewer calls, fewer tokens):",
        "- Read each answer: it says what changed. Don't look again just to check.",
        "- When you know the next steps, send them as one `run`, with an `expect` on the steps that matter.",
        "- Target by id when there is one.",
        "- Ask for a screenshot only to judge how something looks (`screenshot: false` on a `look` that only reads); the text",
        "  answer is enough to act.",
        "- `Known:` lists screens reachable in one call (`drive {\"to\": ...}`). Use it instead of tapping your way there.",
        "- On a long or unknown task, hand the driving to one small, fast agent and check its result; never two drivers.",
        "- A bug report is `bug_report`, not a file you write.",
      ].join("\n"),
    );
  });

  it("begin the instructions, before the rest of 1.8's text", () => {
    const text = instructionsFor({ hints: true });
    expect(text.startsWith(`${TOKEN_RULES}\n\n`)).toBe(true);
    expect(text.endsWith(INSTRUCTIONS)).toBe(true);
  });

  it("are left out with --no-hints: the instructions are 1.8's", () => {
    expect(instructionsFor({ hints: false })).toBe(INSTRUCTIONS);
  });
});

describe("--no-hints (§30.4)", () => {
  it("is a flag of mcp and host, and reaches the runtime's options", () => {
    const { values } = parseCli(["mcp", "--no-hints"]);
    expect(runtimeOptionsOf(values, {})).toMatchObject({ noHints: true });
    const plain = parseCli(["mcp"]);
    expect(runtimeOptionsOf(plain.values, {})).not.toHaveProperty("noHints");
  });
});
