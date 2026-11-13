#!/usr/bin/env node
// The `tapline` command. A thin call must start in about 50 ms, so this file loads nothing at the top: `call` goes
// to thincall.ts (node: modules only) and every other command loads cli.ts (the host, MCP, qrcode, zod) lazily.
const argv = process.argv.slice(2);

async function start(): Promise<void> {
  if (argv[0] === "call") {
    const { runThinCall } = await import("./thincall.js");
    process.exitCode = await runThinCall(argv.slice(1));
    return;
  }
  const { runMain } = await import("./cli.js");
  runMain(argv);
}

start().catch((error: unknown) => {
  process.stderr.write(`tapline: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
