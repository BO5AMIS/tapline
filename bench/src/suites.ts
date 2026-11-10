import type { BenchConfig } from "./config.js";
import { DEFAULT_LAB_URL } from "./lab.js";
import type { ToolSession } from "./mcp.js";
import type { ResultRow } from "./scorecard.js";
import { runReliability } from "./reliability/suite.js";
import { runSpeed } from "./speed.js";
import { runViewer } from "./viewer/suite.js";

export interface SuiteContext {
  tool: ToolSession;
  config: BenchConfig;
  samples: number;
  /** Runs of the reliability suite (default 3). */
  runs: number;
  labUrl: string;
}

export interface Suite {
  name: string;
  run(ctx: SuiteContext): Promise<ResultRow[]>;
}

/**
 * The suite registry: speed (part 1), viewer (V1-V8, part 2), reliability (R1-R8, part 3).
 * The CLI runs them in order, selected with --only name[,name].
 */
export const suites: Suite[] = [
  {
    name: "speed",
    run: (ctx) => runSpeed(ctx.tool, { samples: ctx.samples, link: ctx.config.link }),
  },
  {
    name: "viewer",
    run: (ctx) => runViewer(ctx.tool, { samples: ctx.samples, link: ctx.config.link }),
  },
  {
    name: "reliability",
    run: (ctx) => runReliability(ctx.tool, { runs: ctx.runs, link: ctx.config.link }),
  },
];

export function labUrlOf(config: BenchConfig): string {
  return config.labUrl ?? DEFAULT_LAB_URL;
}

export function selectSuites(only: string | undefined): Suite[] {
  if (!only) return suites;
  const names = only
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !suites.some((s) => s.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown suite: ${unknown.join(", ")}. Known: ${suites.map((s) => s.name).join(", ")}`,
    );
  }
  return suites.filter((s) => names.includes(s.name));
}
