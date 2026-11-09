#!/usr/bin/env node
import { parseArgs } from "node:util";
import { toString as qrText } from "qrcode";
import { connectSnippet, hostUrl, nativeIntentSnippet, reachableHost, resolveConfig, type HostConfig } from "./config.js";
import { formatLogs } from "./format.js";
import { runMcp } from "./mcp.js";
import { createPairCode, forgetLink, pairingLink } from "./pairing.js";
import { TaplineHost } from "./server.js";

const HELP = `tapline - let agents see and drive your own app on your phone, over Tailscale

Usage: tapline <command> [options]

Commands:
  mcp      Run the host plus an MCP server on stdio (for Claude Code and other agents)
  host     Run the host in the foreground and log connections and app logs
  pair     Print a pairing link and QR code for a phone (needs --scheme)
  info     Show this computer's address and how to add Tapline to an app
  token    Print the token (only for connecting without pairing, e.g. a simulator)

Options:
  --scheme <s>   The app's URL scheme, e.g. myapp (for pair; host also prints the QR code)
  --port <n>     Port (default 7210, or TAPLINE_PORT; without either, a taken port moves up to 7219)
  --host <addr>  Bind address(es), comma separated (default: Tailscale IP + 127.0.0.1)
  --screenshots <inline|file>
                 For mcp: put screenshots in the tool result (default), or save them in
                 ~/.tapline/shots and return the path (or TAPLINE_SCREENSHOTS)
  -h, --help     Show this help

Claude Code:  claude mcp add tapline -- tapline mcp
`;

function printInfo(config: HostConfig): void {
  const out = process.stdout;
  const last = config.port + config.portFallback;
  out.write(`Computer    ${config.name}\n`);
  out.write(`Address     ${hostUrl(config, config.port)}${config.tailscaleIp === null ? "" : " (Tailscale)"}\n`);
  if (config.portFallback > 0) {
    out.write(`Ports       ${config.port}, or up to ${last} when several hosts run (one per agent)\n`);
  }
  out.write(`Token file  ${config.tokenPath}\n`);
  for (const note of config.notes) out.write(`\nNote: ${note}\n`);
  out.write(`\nIn the app's entry file (the build carries no address or token):\n\n${connectSnippet()}\n`);
  out.write(`\nExpo Router apps also need app/+native-intent.ts, so pairing links don't open a "not found" screen:\n\n${nativeIntentSnippet()}\n`);
  out.write(`\nSet EXPO_PUBLIC_TAPLINE_ENABLED=1 in development and test builds only, never in the store build.\n`);
  out.write(`\nPair a phone: ask your agent to use its pair tool, or run: tapline pair --scheme <your app's scheme>\n`);
  out.write(`Steps: docs/setup.md in the Tapline repository.\n`);
}

async function printPairing(config: HostConfig, url: string, scheme: string): Promise<void> {
  const link = pairingLink({ scheme, url, code: createPairCode(config.token), name: config.name });
  const qr = await qrText(link, { type: "terminal", small: true, errorCorrectionLevel: "M" });
  const out = process.stdout;
  out.write(`\nScan with the phone's camera, then tap Connect in the app (valid 10 minutes, works once):\n\n${qr}\n`);
  out.write(`${link}\n\nTo unpair the phone, open ${forgetLink(scheme)} on it.\n`);
}

async function runHost(config: HostConfig, scheme: string | undefined): Promise<void> {
  const host = new TaplineHost({
    token: config.token,
    port: config.port,
    portFallback: config.portFallback,
    hosts: config.hosts,
  });
  const stamp = (): string => new Date().toISOString().slice(11, 19);
  host.on("connect", (s) =>
    console.log(`${stamp()} connected    ${s.id} ${s.app.name} ${s.app.version ?? ""} on ${s.device.name ?? s.device.platform}`),
  );
  host.on("disconnect", (s, reason) => console.log(`${stamp()} disconnected ${s.id} ${s.app.name}: ${reason}`));
  host.on("log", (s, entry) => console.log(`${stamp()} [${s.app.name}] ${formatLogs([entry])}`));
  host.on("warning", (message) => console.warn(`${stamp()} warning: ${message}`));

  const result = await host.listen();
  const port = host.boundPort() ?? config.port;
  const url = hostUrl({ advertisedHost: reachableHost(config, result.listening) }, port);
  console.log("Tapline host running.\n");
  console.log(`  Apps connect to ${url}`);
  for (const note of config.notes) console.log(`\n  Note: ${note}`);
  for (const { host: h, port: p } of result.listening) console.log(`  listening on ws://${h}:${p}/`);
  for (const { host: h, error } of result.failed) console.warn(`  could not listen on ${h}: ${error}`);
  if (scheme !== undefined) await printPairing(config, url, scheme);
  else console.log(`\n  Pair a phone: tapline pair --scheme <your app's scheme> --port ${port}`);
  console.log("\nWaiting for apps. Ctrl+C to stop.\n");

  const stop = (): void => {
    void host.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      scheme: { type: "string" },
      screenshots: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help === true || command === undefined || command === "help") {
    process.stdout.write(HELP);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  const options = {
    ...(values.port !== undefined ? { port: values.port } : {}),
    ...(values.host !== undefined ? { host: values.host } : {}),
  };

  switch (command) {
    case "mcp":
      return (await runMcp({ ...options, ...(values.screenshots !== undefined ? { screenshots: values.screenshots } : {}) }))
        ? -1 // keep running
        : 1;
    case "host":
      await runHost(await resolveConfig(options), values.scheme);
      return -1;
    case "pair": {
      if (values.scheme === undefined) {
        process.stderr.write(`pair needs the app's URL scheme: tapline pair --scheme myapp\n`);
        return 1;
      }
      const config = await resolveConfig(options);
      await printPairing(config, hostUrl(config, config.port), values.scheme);
      if (values.port === undefined) {
        process.stdout.write(
          `\nThis is for the host on port ${config.port}. An agent's own host may be on another port ` +
            `(up to ${config.port + config.portFallback}); its pair tool always uses the right one.\n`,
        );
      }
      return 0;
    }
    case "token":
      process.stdout.write(`${(await resolveConfig(options)).token}\n`);
      return 0;
    case "info":
      printInfo(await resolveConfig(options));
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`tapline: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
