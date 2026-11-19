import { CORE_INSTRUCTIONS, CORE_TOOL_TEXT, EXTRA_TOOL_TEXT, TAPLINE_ADDS } from "./tool-text-data.js";
import { TOKEN_RULES } from "./token-rules.js";

/** Joins a core tool's shared paragraph and its `Tapline:` line. The one place the format lives. */
export function joinToolText(shared: string, tapline?: string): string {
  return tapline === undefined ? shared : `${shared}\n${tapline}`;
}

/** The MCP `instructions`: the shared core block, a blank line, then what Tapline adds. */
export const INSTRUCTIONS = `${CORE_INSTRUCTIONS}\n\n${TAPLINE_ADDS}`;

/** The MCP instructions: the token rules first (AGENT-TOOLS 1.17 §30.1), unless `--no-hints` (§30.4) gives 1.8's text. */
export function instructionsFor(options: { hints: boolean }): string {
  return options.hints ? `${TOKEN_RULES}\n\n${INSTRUCTIONS}` : INSTRUCTIONS;
}

type CoreName = keyof typeof CORE_TOOL_TEXT;
type ExtraName = keyof typeof EXTRA_TOOL_TEXT;

/** The description of a tool that TOOL-TEXT covers, as an agent should read it. */
export function toolDescription(name: CoreName | ExtraName): string {
  if (name in CORE_TOOL_TEXT) {
    const entry: { readonly shared: string; readonly tapline?: string } = CORE_TOOL_TEXT[name as CoreName];
    return joinToolText(entry.shared, entry.tapline);
  }
  return EXTRA_TOOL_TEXT[name as ExtraName];
}

export type ToolTextName = CoreName | ExtraName;
