import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TaplineTools, toolShapes, unknownArgumentError, type ToolArgs } from "./tools.js";

/**
 * One table from a tool's name to its handler (AGENT-TOOLS 1.13 §18.10). The MCP server registers its tools from
 * it and `POST /api/<tool>` runs them through it, so both ways in answer the same text and apply the same checks.
 */
export type ToolName = keyof typeof toolShapes;
export const TOOL_NAMES = Object.keys(toolShapes) as readonly ToolName[];

type ToolAnswer = CallToolResult | Promise<CallToolResult>;
type Handlers = { [K in ToolName]: (tools: TaplineTools, args: ToolArgs<K>) => ToolAnswer };

/** A new tool shape without a handler here is a type error. */
const HANDLERS: Handlers = {
  apps: (tools) => tools.apps(),
  open_app: (tools, args) => tools.openApp(args),
  pair: (tools, args) => tools.pair(args),
  look: (tools, args) => tools.look(args),
  check_layout: (tools, args) => tools.checkLayout(args),
  run: (tools, args) => tools.run(args),
  audit: (tools, args) => tools.audit(args),
  ux_check: (tools, args) => tools.uxCheck(args),
  media: (tools, args) => tools.media(args),
  inspect: (tools, args) => tools.inspect(args),
  tap: (tools, args) => tools.tap(args),
  swipe: (tools, args) => tools.swipe(args),
  long_press: (tools, args) => tools.longPress(args),
  type_text: (tools, args) => tools.typeText(args),
  scroll: (tools, args) => tools.scroll(args),
  toggle: (tools, args) => tools.toggle(args),
  open_url: (tools, args) => tools.openUrl(args),
  back: (tools, args) => tools.back(args),
  app_command: (tools, args) => tools.appCommand(args),
  compare_screen: (tools, args) => tools.compareScreen(args),
  filmstrip: (tools, args) => tools.filmstrip(args),
  viewer: (tools, args) => tools.viewer(args),
  record: (tools, args) => tools.record(args),
  replay: (tools, args) => tools.replay(args),
  wait_for: (tools, args) => tools.waitFor(args),
  logs: (tools, args) => tools.logs(args),
  crash: (tools, args) => tools.crash(args),
  reload: (tools, args) => tools.reload(args),
  performance: (tools, args) => tools.performance(args),
  wait: (tools, args) => tools.wait(args),
  journey: (tools, args) => tools.journey(args),
  session_report: (tools, args) => tools.sessionReport(args),
};

export interface ToolMeta {
  title: string;
  readOnly: boolean;
}

/** Titles and read-only hints for the MCP list, in the order the list has always had. */
export const TOOL_META: Record<ToolName, ToolMeta> = {
  apps: { title: "Connected apps", readOnly: true },
  open_app: { title: "Open app", readOnly: false },
  pair: { title: "Pair a phone", readOnly: false },
  look: { title: "Look at the screen", readOnly: true },
  check_layout: { title: "Check the layout", readOnly: true },
  run: { title: "Run several steps", readOnly: false },
  audit: { title: "Audit the screen's accessibility", readOnly: true },
  ux_check: { title: "Check the screen's usability", readOnly: true },
  media: { title: "Add test pictures", readOnly: false },
  inspect: { title: "Find the code behind an element", readOnly: true },
  tap: { title: "Tap", readOnly: false },
  swipe: { title: "Swipe", readOnly: false },
  long_press: { title: "Long press", readOnly: false },
  type_text: { title: "Type text", readOnly: false },
  scroll: { title: "Scroll", readOnly: false },
  toggle: { title: "Toggle", readOnly: false },
  open_url: { title: "Open URL", readOnly: false },
  back: { title: "Back", readOnly: false },
  app_command: { title: "App command", readOnly: false },
  compare_screen: { title: "Compare with a reference", readOnly: true },
  filmstrip: { title: "Filmstrip", readOnly: false },
  viewer: { title: "Live viewer", readOnly: true },
  record: { title: "Record a script", readOnly: false },
  replay: { title: "Replay a script", readOnly: false },
  wait_for: { title: "Wait for", readOnly: true },
  logs: { title: "App logs", readOnly: true },
  crash: { title: "App crash", readOnly: true },
  reload: { title: "Reload app", readOnly: false },
  performance: { title: "Performance", readOnly: false },
  wait: { title: "Wait", readOnly: true },
  journey: { title: "Journey", readOnly: false },
  session_report: { title: "Session report", readOnly: true },
};

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolShapes, name);
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Runs a tool's handler for arguments a schema has already parsed (the MCP SDK does that). An argument the tool
 * doesn't have is refused, and the refusal is numbered and logged like any call so the session report counts it.
 */
export function runTool(tools: TaplineTools, name: ToolName, args: Record<string, unknown>): ToolAnswer {
  const refused = unknownArgumentError(name, args);
  if (refused !== null) return tools.rejectedCall(name, args, refused);
  const handler = HANDLERS[name] as (tools: TaplineTools, args: Record<string, unknown>) => ToolAnswer;
  return handler(tools, args);
}

/**
 * Runs one tool by name from raw JSON (the thin call). An unknown tool, an unknown argument or an argument of the
 * wrong kind answers `Error bad_params:` the way the MCP server does.
 */
export async function callTool(tools: TaplineTools, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!isToolName(name)) return refusal(`Error bad_params: unknown tool "${name}"; the tools are ${TOOL_NAMES.join(", ")}.`);
  const refused = unknownArgumentError(name, args);
  if (refused !== null) return tools.rejectedCall(name, args, refused);
  const parsed = z.object(toolShapes[name]).safeParse(args);
  if (!parsed.success) {
    const why = parsed.error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join("; ");
    return tools.rejectedCall(name, args, refusal(`Error bad_params: ${name}: ${why}.`));
  }
  return runTool(tools, name, parsed.data as Record<string, unknown>);
}
