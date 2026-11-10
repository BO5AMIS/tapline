#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { guardApp, learnLabApp } from "./guard.js";
import { openLab } from "./lab.js";
import { startTool } from "./mcp.js";
import {
  allPass,
  buildScorecard,
  formatTable,
  writeScorecard,
  type ResultRow,
} from "./scorecard.js";
import { measureStartToReady } from "./speed.js";
import { labUrlOf, selectSuites } from "./suites.js";

const USAGE = `Usage: node bench/dist/cli.js --config <file.json> [--only speed|viewer|reliability] [--samples 20] [--runs 3] [--out bench/results]

Spawns the tool's MCP server over stdio, scores it against docs/QUALITY-BAR.md,
writes a scorecard JSON and prints a table.

  --config   path to the config JSON (required)
  --only     comma-separated suites to run (default: all; known: speed, viewer, reliability)
  --samples  samples per speed metric (default 20)
  --runs     runs of the reliability suite (default 3)
  --out      scorecard directory (default bench/results)

Exit code: 0 all rows pass, 1 some row fails, 2 runner error.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      only: { type: "string" },
      samples: { type: "string", default: "20" },
      runs: { type: "string", default: "3" },
      out: { type: "string", default: "bench/results" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.config) {
    console.error(USAGE);
    return 2;
  }
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  const config = loadConfig(values.config);
  const selected = selectSuites(values.only);

  const tool = await startTool({ command: config.command, args: config.args, env: config.env });
  const results: ResultRow[] = [];
  try {
    const s5 = await measureStartToReady(tool, tool.spawnedAt, config.link);
    results.push(s5);
    if (s5.samples > 0) {
      const labUrl = labUrlOf(config);
      await openLab(tool, labUrl);
      // From here on every touch goes through the guard: the run stops if the phone leaves the lab's app.
      const guarded = guardApp(tool, await learnLabApp(tool));
      for (const suite of selected) {
        results.push(...(await suite.run({ tool: guarded, config, samples, runs, labUrl })));
      }
    }
  } finally {
    await tool.close();
  }

  const card = buildScorecard(
    {
      tool: config.tool,
      version: config.version,
      phone: config.phone,
      ios: config.ios,
      link: config.link,
    },
    results,
  );
  const path = writeScorecard(values.out ?? "bench/results", card);
  console.log(formatTable(card));
  console.log(`\nScorecard: ${path}`);
  return allPass(card) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Runner error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
