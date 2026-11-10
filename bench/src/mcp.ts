import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

/** What one tool call gave back, as an agent sees it. */
export interface CallResult {
  /** Text content items joined with a newline. */
  text: string;
  /** Number of image content items. */
  images: number;
  isError: boolean;
  /** Wall time of the call in milliseconds (one clock: performance.now()). */
  ms: number;
  /** Set by the app guard when the answer itself named iOS's own UI: the sample isn't a clean one. */
  interrupted?: string;
}

/** The only thing the suites need from a tool; fakes implement it in tests. */
export interface ToolSession {
  call(name: string, args: Record<string, unknown>): Promise<CallResult>;
  /** Names of the tools the server lists (MCP listTools). Fakes may leave it out. */
  listTools?(): Promise<string[]>;
}

export interface ToolHandle extends ToolSession {
  /** performance.now() just before the server process was spawned. */
  readonly spawnedAt: number;
  close(): Promise<void>;
}

export interface SpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

const contentSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
  isError: z.boolean().optional(),
});

/** Turns a raw MCP tool result (unknown shape) into a CallResult without `ms`. */
export function parseToolResult(raw: unknown): Omit<CallResult, "ms"> {
  const parsed = contentSchema.safeParse(raw);
  if (!parsed.success) {
    return { text: "", images: 0, isError: true };
  }
  const items = parsed.data.content;
  const text = items
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("\n");
  const images = items.filter((c) => c.type === "image").length;
  return { text, images, isError: parsed.data.isError === true };
}

/** Spawns the tool's MCP server over stdio, exactly as an agent would. */
export async function startTool(config: SpawnConfig): Promise<ToolHandle> {
  const spawnedAt = performance.now();
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    ...(config.env ? { env: config.env } : {}),
  });
  const client = new Client({ name: "tapline-bench", version: "0.1.0" });
  await client.connect(transport);
  return {
    spawnedAt,
    async call(name, args) {
      const t0 = performance.now();
      const raw: unknown = await client.callTool({ name, arguments: args });
      const ms = performance.now() - t0;
      return { ...parseToolResult(raw), ms };
    },
    async listTools() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        names.push(...page.tools.map((t) => t.name));
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    },
    async close() {
      await client.close();
    },
  };
}
