import { describe, expect, it } from "vitest";
import { answerRows, sizeAnswers, textTokens } from "../src/answers.js";
import { imageSize, parseToolResult } from "../src/mcp.js";

// A 1x1 PNG's header with width 600 and height 1300 written in.
function png(w: number, h: number): string {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf.toString("base64");
}

describe("J6 answer size", () => {
  it("reads an image's size and costs it width x height / 750", () => {
    expect(imageSize(png(600, 1300))).toEqual({ w: 600, h: 1300 });
    const parsed = parseToolResult({ content: [{ type: "text", text: "x".repeat(36) }, { type: "image", data: png(600, 1300), mimeType: "image/png" }] });
    expect(parsed.imageTokens).toBe(1040);
    expect(textTokens("x".repeat(36))).toBe(10);
  });

  it("gives median and p95 for looks and actions, and skips errors", async () => {
    const answers: Record<string, string> = { look: "y".repeat(360), tap: "z".repeat(72) };
    const { session, rows } = sizeAnswers({
      call: async (name) => ({ text: answers[name] ?? "", images: 0, isError: name === "bad", ms: 1 }),
    });
    await session.call("look", {});
    await session.call("tap", {});
    await session.call("bad", {});
    const byId = Object.fromEntries(rows().map((r) => [r.id, r.value]));
    expect(byId["J6 look text"]).toBe(100);
    expect(byId["J6 action answer"]).toBe(20);
    expect(byId["J6 look screenshot"]).toBeNull();
    expect(answerRows([])).toHaveLength(5);
  });
});
