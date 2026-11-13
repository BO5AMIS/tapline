import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOL_META, runTool, type ToolName } from "./dispatch.js";
import { DIALOG_TTL_MS, Dialogs, type ElicitClient } from "./elicit.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.js";
import { INSTRUCTIONS, toolDescription } from "./tool-text.js";
import { TaplineTools, toolShapes } from "./tools.js";

/**
 * A tool's input for the MCP server: its own keys, with unknown ones let through (the SDK would strip them
 * silently) so `runTool` can refuse them. The published JSON schema is cleaned of the resulting
 * `additionalProperties` in `createMcpServer`.
 */
function looseInput(name: ToolName): z.ZodObject<z.ZodRawShape, z.core.$loose> {
  return z.object<z.ZodRawShape>(toolShapes[name]).passthrough();
}

/**
 * Drops `additionalProperties` from the tool list: it only came from letting unknown keys through to `runTool`.
 * Reaches the SDK's own list handler by its method name; when the SDK changes that, the schema simply keeps it.
 */
function publishPlainSchemas(server: McpServer): void {
  const handlers: unknown = Reflect.get(server.server, "_requestHandlers");
  const original: unknown = handlers instanceof Map ? handlers.get("tools/list") : undefined;
  if (!(handlers instanceof Map) || typeof original !== "function") {
    process.stderr.write("tapline: the MCP SDK changed; tool schemas keep additionalProperties (harmless, but strict clients may refuse it)\n");
    return;
  }
  const list = original as (request: unknown, extra: unknown) => Promise<{ tools: Array<{ inputSchema: Record<string, unknown> }> }>;
  handlers.set("tools/list", async (request: unknown, extra: unknown) => {
    const answer = await list(request, extra);
    for (const tool of answer.tools) delete tool.inputSchema["additionalProperties"];
    return answer;
  });
}

/**
 * The host's dialog (AGENT-TOOLS 1.13 §11.3): MCP elicitation, form mode, to the client that started this server.
 * The request goes out by hand, not through the SDK's elicitInput: that refuses a client whose capability is an empty
 * `elicitation: {}` (older clients mean form mode by it), and its 60 s default would cut a 120 s wait short.
 */
export function elicitClientFor(server: McpServer): ElicitClient {
  return {
    canShowForm: () => {
      const elicitation = server.server.getClientCapabilities()?.elicitation;
      // A client that lists only `url` can't show a form; an empty object is form mode.
      return elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined);
    },
    elicit: async (message, schema, signal) => {
      const result = await server.server.request(
        { method: "elicitation/create", params: { mode: "form", message, requestedSchema: schema } },
        ElicitResultSchema,
        { signal, timeout: DIALOG_TTL_MS + 5000 },
      );
      return { action: result.action, ...(result.content !== undefined ? { content: result.content } : {}) };
    },
  };
}

/** Registers every Tapline tool on an MCP server, from the one table in dispatch.ts. `noDialog` is `--no-dialog`. */
export function createMcpServer(tools: TaplineTools, options: { noDialog?: boolean } = {}): McpServer {
  const server = new McpServer({ name: "tapline", version: "1.6.0" }, { instructions: INSTRUCTIONS });

  for (const name of Object.keys(TOOL_META) as ToolName[]) {
    const meta = TOOL_META[name];
    server.registerTool(
      name,
      {
        title: meta.title,
        description: toolDescription(name),
        inputSchema: looseInput(name),
        ...(meta.readOnly ? { annotations: { readOnlyHint: true } } : {}),
      },
      // The request's abort signal closes a dialog the call is waiting on when the client cancels or times out.
      (args: Record<string, unknown>, extra: { signal: AbortSignal }) => tools.withCall(extra.signal, () => runTool(tools, name, args)),
    );
  }

  // The call log names the agent by the MCP client's name, known once the client has said hello.
  tools.setClientId(() => server.server.getClientVersion()?.name);
  // A person's OK is asked in the host's dialog when the client can show one; the live view answers either way.
  tools.setDialogs(new Dialogs(elicitClientFor(server), { disabled: options.noDialog === true }));

  publishPlainSchemas(server);
  return server;
}

function log(message: string): void {
  process.stderr.write(`[tapline] ${message}\n`);
}

/** Runs the host and serves MCP over stdio. stdout is reserved for the protocol; everything else goes to stderr. */
export async function runMcp(options: Omit<RuntimeOptions, "api" | "log"> = {}): Promise<boolean> {
  let runtime: Runtime;
  try {
    // A host inside an agent's MCP server never serves the thin call (AGENT-TOOLS 1.13 §18.10).
    runtime = await createRuntime({ ...options, api: false });
  } catch (error) {
    for (const line of (error instanceof Error ? error.message : String(error)).split("\n")) log(line);
    return false;
  }
  const server = createMcpServer(runtime.toolsFor(undefined), { noDialog: options.noDialog === true });
  // `runtime.close` writes the maps before it closes the host.
  const shutdown = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("close", shutdown);
  await server.connect(new StdioServerTransport());
  return true;
}
