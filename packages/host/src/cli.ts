#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toString as qrText } from "qrcode";
import {
  configDir,
  connectSnippet,
  hostUrl,
  markPaired,
  nativeIntentSnippet,
  reachableHost,
  resolveConfig,
  type HostConfig,
} from "./config.js";
import { setUpDevServe } from "./dev.js";
import { formatDoctor, needsAPerson, runDoctor } from "./doctor.js";
import { formatLogs } from "./format.js";
import { runInit } from "./init.js";
import { runReport } from "./report.js";
import { runMcp } from "./mcp.js";
import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.js";
import { createPairCode, forgetLink, pairingLink } from "./pairing.js";
import { failureWithDiff, junitXml } from "./script.js";
import { TaplineHost } from "./server.js";
import { formatInstalled, installSkill, skillSource } from "./skill.js";
import { TaplineTools } from "./tools.js";

const HELP = `tapline - let agents see and drive your own app on a test phone, over the same Wi-Fi

Usage: tapline <command> [options]

Commands:
  mcp      Run the host plus an MCP server on stdio (for Claude Code and other agents)
  host     Run a standalone host in the foreground: apps connect to it, and it serves the live view and
           "tapline call" (it takes the options of mcp)
  call     Send one tool call to a running "tapline host": tapline call <tool> '<json>' [--client NAME] [--json]
           (exit 0: an answer, 2: a refusal, 3: no host reachable)
  pair     Print a pairing link and QR code for a phone (needs --scheme)
  info     Show this computer's address and how to add Tapline to an app
  doctor   Check the setup (Node, the Wi-Fi address, Tailscale if used, token, ports, firewall);
           --app also checks the app side in --project (or here), as tapline init would
  init     Set up Tapline in your app in one go: packages, entry file, Metro helper, .env.local
           (run it in the app's folder; --dry-run shows the plan, --no-install skips the install)
  dev      Serve Metro over https in your tailnet (iOS needs it); \`tapline dev -- <command>\`
           also runs your Metro command with EXPO_PACKAGER_PROXY_URL set
  replay   Replay scripts without an agent: tapline replay <file.json | name>… [--junit out.xml] [--update-references]
           (exit 0: all held, 1: one stopped, 2: one couldn't start)
  report   Where an agent's calls went and the waste in them, from the action log:
           tapline report [--since <90m | 2h | 1d | date | epoch ms>] (default: the last 24 hours)
  token    Print the token (only for connecting without pairing, e.g. a simulator)
  skill    \`tapline skill install\` gives agents the skill for testing with Tapline:
           Claude Code (~/.claude/skills), Codex and other agents (~/.agents/skills);
           \`tapline skill path\` prints where the skill ships

Options:
  --scheme <s>   The app's URL scheme, e.g. myapp, or in Expo Go the address Expo prints,
                 e.g. exp://192.168.1.20:8081 (for pair; host also prints the QR code)
  --port <n>     Port (default 7210, or TAPLINE_PORT; without either, a taken port moves up to 7219)
  --host <addr>  Bind address(es), comma separated (default: Wi-Fi/LAN IP, Tailscale IP if any, 127.0.0.1)
  --screenshots <inline|file>
                 For mcp: put screenshots in the tool result (default), or save them in
                 ~/.tapline/shots and return the path (or TAPLINE_SCREENSHOTS)
  --client <name>  For call: the agent's name, so its report and journey stay its own (default: the parent process id)
  --json         For call: print {"text", "image_path"} instead of the text
  --no-log       For mcp: don't write the action log (~/.tapline/log/actions-YYYY-MM-DD.jsonl)
  --policy <file>  For mcp: the safety policy (JSON: words that need a person's OK, words that are blocked)
  --no-policy    For mcp: no confirmation and nothing blocked (a test device with test data)
  --no-dialog    For mcp: don't ask a person's OK in the host's dialog, only in the live view (for a host that
                 passes dialogs to the model instead of showing them to a person)
  --brief        For mcp and host: actions answer briefly (a call's brief: false overrides it); look is never brief
  --ux-rules <file>  For mcp: the user's UX house rules for ux_check and journeys (JSON: text rules to judge,
                 {"max_taps_to_goal": N}, {"way_back": true})
  --accounts <file>  For mcp and host: test accounts (JSON; the tool types an account's username and password so the
                 agent never sees them). The file must sit outside any git repo, or be ignored by it.
                 A password stays out of pictures only while its field is secure (a "show password" toggle shows it).
                 Keep the file outside the folders the agent may read
  --viewer-link  For mcp: the viewer tool gives the agent the live view's link (benchmarks, scripts); by
                 default it opens the live view in a browser here and keeps the link (its key) from the agent
                 (or TAPLINE_VIEWER_LINK=1)
  --viewer <local|remote|off>
                 For mcp: the live viewer on this computer only (default), also on your
                 own Tailscale devices, or off (or TAPLINE_VIEWER)
  --metro-port <n>   For dev: Metro's port (default 8081)
  --https-port <n>   For dev: the https port Tailscale serves Metro on (default 8443)
  --stop             For dev: stop serving Metro
  --wait <s>         For replay: how long to wait for the app to connect (default 60)
  --update-references  For replay: compare_screen steps and matches checks save the screen into the
                     script's .references folder instead of comparing (exit 0 when every step ran)
  --project <dir>    For skill install: install into that project's .claude/skills and
                     .agents/skills instead of your home folder. For init: the app's folder
                     (default: this folder)
  --dry-run          For init: print what it would do and change nothing
  --no-install       For init: don't install packages; print the command instead
  -h, --help     Show this help

Claude Code:  claude mcp add tapline -- tapline mcp
Codex:        in ~/.codex/config.toml:  [mcp_servers.tapline]  command = "tapline"  args = ["mcp"]
`;

function printInfo(config: HostConfig): void {
  const out = process.stdout;
  const last = config.port + config.portFallback;
  out.write(`Computer    ${config.name}\n`);
  out.write(`Address     ${hostUrl(config, config.port)}${config.advertisedHost === config.tailscaleIp ? " (Tailscale)" : config.lanIps.includes(config.advertisedHost) ? " (Wi-Fi/LAN)" : ""}\n`);
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

/**
 * The standalone host: apps connect to it, it serves the live viewer (a person's OK is given there) and the thin
 * call, `POST /api/<tool>` (AGENT-TOOLS 1.13 §18.10). It takes the options `mcp` takes.
 */
async function runHost(options: RuntimeOptions, scheme: string | undefined): Promise<boolean> {
  const stamp = (): string => new Date().toISOString().slice(11, 19);
  let runtime: Runtime;
  try {
    runtime = await createRuntime({ ...options, api: true, log: (message) => console.log(`${stamp()} ${message}`) });
  } catch (error) {
    for (const line of (error instanceof Error ? error.message : String(error)).split("\n")) console.error(line);
    return false;
  }
  const { host, config } = runtime;
  host.on("log", (s, entry) => console.log(`${stamp()} [${s.app.name}] ${formatLogs([entry])}`));
  console.log("\nTapline host running.\n");
  console.log(`  Apps connect to ${runtime.url}`);
  console.log(`  Agents without an MCP connection: tapline call <tool> '<json>' (port ${runtime.port})`);
  if (scheme !== undefined) await printPairing(config, runtime.url, scheme);
  else console.log(`\n  Pair a phone: tapline pair --scheme <your app's scheme> --port ${runtime.port}`);
  console.log("\nWaiting for apps. Ctrl+C to stop.\n");

  const stop = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return true;
}

function portOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a port number, not "${raw}"`);
  return port;
}

async function runDev(
  values: { "metro-port"?: string; "https-port"?: string; stop?: boolean },
  command: string[],
): Promise<number> {
  const metroPort = portOption(values["metro-port"], "--metro-port");
  const httpsPort = portOption(values["https-port"], "--https-port");
  const result = await setUpDevServe({
    ...(metroPort !== undefined ? { metroPort } : {}),
    ...(httpsPort !== undefined ? { httpsPort } : {}),
    ...(values.stop === true ? { stop: true } : {}),
  });
  process.stdout.write(`${result.lines.join("\n")}\n`);
  if (!result.ok) return 1;
  const [program, ...args] = command;
  if (program === undefined || result.url === undefined) return 0;
  process.stdout.write(`\nRunning ${command.join(" ")} with EXPO_PACKAGER_PROXY_URL=${result.url}\n\n`);
  return new Promise<number>((resolve) => {
    const child = spawn(program, args, {
      stdio: "inherit",
      env: { ...process.env, EXPO_PACKAGER_PROXY_URL: result.url },
      shell: process.platform === "win32", // npx and friends are .cmd files there
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      process.stderr.write(`Couldn't run ${program}: ${error.message}\n`);
      resolve(1);
    });
  });
}

/**
 * Replays scripts with its own host, no agent (AGENT-TOOLS 1.8 §9.4): each argument is a script file or a saved
 * script's name. Exit 0 when every script held, 1 when one stopped, 2 when one couldn't start (no app, a bad
 * file). `--junit out.xml` writes one test case per script.
 */
async function runReplay(
  config: HostConfig,
  scripts: string[],
  waitRaw: string | undefined,
  junitPath: string | undefined,
  updateReferences = false,
): Promise<number> {
  const waitSeconds = waitRaw === undefined ? 60 : Number(waitRaw);
  if (!(waitSeconds > 0)) {
    process.stderr.write("--wait is in seconds, above 0\n");
    return 2;
  }
  const host = new TaplineHost({ token: config.token, port: config.port, portFallback: config.portFallback, hosts: config.hosts });
  host.on("connect", () => markPaired());
  const result = await host.listen();
  const port = host.boundPort() ?? config.port;
  const url = hostUrl({ advertisedHost: reachableHost(config, result.listening) }, port);
  const tools = new TaplineTools(host, {
    connect: { url, name: config.name },
    scriptsDir: join(configDir(), "scripts"),
    baselinesDir: join(configDir(), "baselines"),
  });
  try {
    process.stdout.write(`Waiting up to ${waitSeconds} s for the app to connect on port ${port} (open it on the phone)…\n`);
    if (port !== config.port) {
      process.stdout.write(
        `Port ${config.port} is taken (an agent's host?). A phone reconnects to the port it paired with, so stop that agent or use its replay tool.\n`,
      );
    }
    const deadline = Date.now() + waitSeconds * 1000;
    while (host.current() === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (host.current() === undefined) {
      process.stderr.write("The app didn't connect. Is it open, on the same Wi-Fi as this computer?\n");
      return 2;
    }
    let code = 0;
    const results: Array<{ name: string; seconds: number; failure: string | null }> = [];
    for (const script of scripts) {
      const isFile = /[\\/]|\.json$/i.test(script);
      const started = Date.now();
      const outcome = await tools.replay(isFile ? { path: script } : { name: script }, { updateReferences });
      const textOut = outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      process.stdout.write(`${script}\n${textOut}\n\n`);
      const couldntStart = outcome.isError === true && /^Error (not_found|bad_params|not_connected|internal):/.test(textOut) && !/^Error \w+: Ran \d+ of/.test(textOut);
      if (couldntStart) code = 2;
      else if (outcome.isError === true && code === 0) code = 1;
      results.push({ name: script, seconds: (Date.now() - started) / 1000, failure: outcome.isError === true ? failureWithDiff(textOut) : null });
    }
    if (junitPath !== undefined) writeFileSync(junitPath, junitXml(results));
    return code;
  } finally {
    await host.close();
  }
}

/** The command line's words and options, in one place so a test can read them without starting a host. */
export function parseCli(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      scheme: { type: "string" },
      screenshots: { type: "string" },
      viewer: { type: "string" },
      "metro-port": { type: "string" },
      "https-port": { type: "string" },
      stop: { type: "boolean" },
      wait: { type: "string" },
      since: { type: "string" },
      junit: { type: "string" },
      "update-references": { type: "boolean" },
      "no-log": { type: "boolean" },
      policy: { type: "string" },
      "no-policy": { type: "boolean" },
      "no-dialog": { type: "boolean" },
      brief: { type: "boolean" },
      "ux-rules": { type: "string" },
      accounts: { type: "string" },
      "viewer-link": { type: "boolean" },
      project: { type: "string" },
      "dry-run": { type: "boolean" },
      app: { type: "boolean" },
      "no-install": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** What `mcp` and the standalone host both take, from the parsed options (`--brief` and the rest). */
export function runtimeOptionsOf(values: ReturnType<typeof parseCli>["values"], options: { port?: string; host?: string }): RuntimeOptions {
  return {
    ...options,
    ...(values.screenshots !== undefined ? { screenshots: values.screenshots } : {}),
    ...(values.viewer !== undefined ? { viewer: values.viewer } : {}),
    ...(values["no-log"] === true ? { noLog: true } : {}),
    ...(values.policy !== undefined ? { policy: values.policy } : {}),
    ...(values["no-policy"] === true ? { noPolicy: true } : {}),
    ...(values["no-dialog"] === true ? { noDialog: true } : {}),
    ...(values.brief === true ? { brief: true } : {}),
    ...(values["ux-rules"] !== undefined ? { uxRules: values["ux-rules"] } : {}),
    ...(values.accounts !== undefined ? { accounts: values.accounts } : {}),
    ...(values["viewer-link"] === true ? { viewerLink: true } : {}),
  };
}

export async function main(argv: string[]): Promise<number> {
  // The thin call has its own light entry (bin.ts); this keeps "node dist/cli.js call" working too.
  if (argv[0] === "call") {
    const { runThinCall } = await import("./thincall.js");
    return runThinCall(argv.slice(1));
  }
  const { values, positionals } = parseCli(argv);
  const command = positionals[0];
  if (values.help === true || command === undefined || command === "help") {
    process.stdout.write(HELP);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  const options = {
    ...(values.port !== undefined ? { port: values.port } : {}),
    ...(values.host !== undefined ? { host: values.host } : {}),
  };

  const runtimeOptions = runtimeOptionsOf(values, options);

  switch (command) {
    case "mcp":
      return (await runMcp(runtimeOptions)) ? -1 /* keep running */ : 1;
    case "host":
      return (await runHost(runtimeOptions, values.scheme)) ? -1 : 1;
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
    case "doctor": {
      const results = await runDoctor(values.accounts !== undefined ? { accountsFile: values.accounts } : {});
      process.stdout.write(`${formatDoctor(results, needsAPerson(results))}\n`);
      let failed = results.some((r) => r.status === "fail");
      if (values.app === true) {
        // The app side, as `tapline init` sees it; nothing is changed.
        process.stdout.write("\nApp side (what tapline init would do):\n");
        const app = runInit(
          { ...(values.project !== undefined ? { project: values.project } : {}), dryRun: true, install: false },
          { print: (line) => (line.startsWith("Dry run:") ? undefined : process.stdout.write(`${line}\n`)) },
        );
        if (app.exitCode !== 0 || app.changed) failed = true;
      }
      return failed ? 1 : 0;
    }
    case "dev":
      return runDev(values, positionals.slice(1));
    case "replay": {
      const scripts = positionals.slice(1);
      if (scripts.length === 0) {
        process.stderr.write("replay needs scripts: tapline replay <file.json | name>… [--junit out.xml]\n");
        return 2;
      }
      return runReplay(await resolveConfig(options), scripts, values.wait, values.junit, values["update-references"] === true);
    }
    case "report": {
      // Reads the action log; needs no host and no app.
      const outcome = runReport({ dir: join(configDir(), "log"), ...(values.since !== undefined ? { since: values.since } : {}) });
      (outcome.code === 0 ? process.stdout : process.stderr).write(`${outcome.text}\n`);
      return outcome.code;
    }
    case "token":
      process.stdout.write(`${(await resolveConfig(options)).token}\n`);
      return 0;
    case "skill": {
      if (positionals[1] === "path") {
        process.stdout.write(`${skillSource()}\n`);
        return 0;
      }
      if (positionals[1] !== "install") {
        process.stderr.write("Usage: tapline skill install [--project <dir>]\n       tapline skill path\n");
        return 1;
      }
      const { written } = installSkill(values.project !== undefined ? { project: values.project } : {});
      process.stdout.write(`${formatInstalled(written)}\n`);
      return 0;
    }
    case "init": {
      const result = runInit(
        {
          ...(values.project !== undefined ? { project: values.project } : {}),
          ...(values["dry-run"] === true ? { dryRun: true } : {}),
          ...(values["no-install"] === true ? { install: false } : {}),
        },
        { print: (line) => process.stdout.write(`${line}\n`) },
      );
      return result.exitCode;
    }
    case "info":
      printInfo(await resolveConfig(options));
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

/** Runs the command line and exits with its code (a negative code means a host keeps running). */
export function runMain(argv: string[]): void {
  main(argv).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`tapline: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

// "node dist/cli.js ..." still works; the tapline bin is bin.js, which loads this file only for commands other than call.
const entry = process.argv[1];
if (entry !== undefined) {
  try {
    if (realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) runMain(process.argv.slice(2));
  } catch {
    // not run as a script
  }
}
