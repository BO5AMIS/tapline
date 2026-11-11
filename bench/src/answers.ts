import type { CallResult, ToolSession } from "./mcp.js";
import type { ValueRow } from "./scorecard.js";
import { summarize } from "./stats.js";

/**
 * J6 (answer size): how many tokens each answer costs the agent, over every call a run makes. The same
 * estimate for every tool, so tools and versions compare: text ≈ characters / 3.6, an image ≈
 * width × height / 750 (the API's own rule for images). Report only; the target is a relative one (−30%).
 */

export const CHARS_PER_TOKEN = 3.6;
const ACTIONS = new Set(["tap", "long_press", "type_text", "scroll", "toggle", "back", "swipe", "open_url"]);

export function textTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

interface Sample {
  name: string;
  text: number;
  image: number;
}

/** Wraps a session and records each answer's size. */
export function sizeAnswers(session: ToolSession): { session: ToolSession; rows: () => ValueRow[] } {
  const samples: Sample[] = [];
  const wrapped: ToolSession = {
    async call(name, args): Promise<CallResult> {
      const result = await session.call(name, args);
      if (!result.isError) samples.push({ name, text: textTokens(result.text), image: result.imageTokens ?? 0 });
      return result;
    },
    ...(session.listTools ? { listTools: () => (session.listTools as () => Promise<string[]>)() } : {}),
  };
  return { session: wrapped, rows: () => answerRows(samples) };
}

function row(id: string, values: number[], which: "median" | "p95", notes: string): ValueRow {
  const s = summarize(values);
  return { id, value: s.n === 0 ? null : s[which], unit: "tokens", target: null, pass: null, notes: `n=${s.n}; ${notes}` };
}

export function answerRows(samples: Sample[]): ValueRow[] {
  const looks = samples.filter((s) => s.name === "look");
  const acts = samples.filter((s) => ACTIONS.has(s.name));
  const lookText = looks.map((s) => s.text);
  const actText = acts.map((s) => s.text);
  const shots = looks.filter((s) => s.image > 0).map((s) => s.image);
  return [
    row("J6 look text", lookText, "median", "text only, screenshot not counted"),
    row("J6 look text p95", lookText, "p95", "text only"),
    row("J6 action answer", actText, "median", "tap, type_text, scroll, toggle, back, swipe, open_url"),
    row("J6 action answer p95", actText, "p95", "actions"),
    row("J6 look screenshot", shots, "median", "image tokens when a look sent one inline"),
  ];
}
