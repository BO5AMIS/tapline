import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { DEFAULT_PORT, DEFAULT_PORT_FALLBACK, tokenFilePath } from "./config.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  /** Runs a program directly (never through a shell). A missing binary or a timeout gives code -1. */
  run: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  platform: NodeJS.Platform;
  nodeVersion: string;
  fileExists: (path: string) => boolean;
  portFree: (host: string, port: number) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
}

const MIN_NODE_MAJOR = 20;
const RUN_TIMEOUT_MS = 10_000;
const METRO_PORT = "8081";
const WINDOWS_TAILSCALE = "C:\\Program Files\\Tailscale\\tailscale.exe";
const MAC_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const FIREWALL_COMMAND =
  'New-NetFirewallRule -DisplayName "Tapline" -Direction Inbound -Protocol TCP -LocalPort 7210-7219 -RemoteAddress 100.64.0.0/10 -Action Allow';
const SERVE_COMMAND = `tailscale serve --bg --https=8443 http://127.0.0.1:${METRO_PORT}`;

function defaultRun(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr: stderr.length > 0 ? stderr : error.message });
      },
    );
  });
}

function defaultPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function defaultDeps(): DoctorDeps {
  return {
    run: defaultRun,
    platform: process.platform,
    nodeVersion: process.versions.node,
    fileExists: existsSync,
    portFree: defaultPortFree,
    env: process.env,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** Runs one check; whatever it throws becomes a result with the error text instead. */
async function guard(name: string, onError: CheckStatus, check: () => Promise<CheckResult> | CheckResult): Promise<CheckResult> {
  try {
    return await check();
  } catch (error) {
    return { name, status: onError, detail: `check failed: ${errorText(error)}` };
  }
}

interface TailscaleLookup {
  binary: string | null;
  version: string;
  error: string;
}

async function findTailscale(deps: DoctorDeps): Promise<TailscaleLookup> {
  const candidates = ["tailscale"];
  if (deps.platform === "win32") candidates.push(WINDOWS_TAILSCALE);
  else if (deps.platform === "darwin") candidates.push(MAC_TAILSCALE);
  let error = "";
  for (const candidate of candidates) {
    try {
      const result = await deps.run(candidate, ["version"]);
      if (result.code === 0) return { binary: candidate, version: firstLine(result.stdout), error: "" };
      error = firstLine(result.stderr);
    } catch (caught) {
      error = errorText(caught);
    }
  }
  return { binary: null, version: "", error };
}

function checkNode(deps: DoctorDeps): CheckResult {
  const major = Number(/^v?(\d+)/.exec(deps.nodeVersion)?.[1]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    return { name: "Node.js", status: "pass", detail: `version ${deps.nodeVersion}` };
  }
  return {
    name: "Node.js",
    status: "fail",
    detail: `version ${deps.nodeVersion}, Tapline needs Node.js ${MIN_NODE_MAJOR} or later`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or later from https://nodejs.org, then open a new terminal.`,
  };
}

function checkCli(lookup: TailscaleLookup): CheckResult {
  if (lookup.binary !== null) {
    return {
      name: "Tailscale CLI",
      status: "pass",
      detail: lookup.version.length > 0 ? `found, version ${lookup.version}` : "found",
    };
  }
  return {
    name: "Tailscale CLI",
    status: "fail",
    detail: lookup.error.length > 0 ? `the tailscale command didn't run: ${lookup.error}` : "the tailscale command wasn't found",
    fix: "Install Tailscale from https://tailscale.com/download on this computer, then open a new terminal.",
  };
}

async function checkRunning(deps: DoctorDeps, binary: string | null): Promise<{ result: CheckResult }> {
  const name = "Tailscale running";
  if (binary === null) {
    return {
      result: {
        name,
        status: "fail",
        detail: "can't check, the Tailscale CLI isn't available",
        fix: "Install Tailscale first (see the check above), then open it and sign in.",
      },
    };
  }
  const result = await deps.run(binary, ["ip", "-4"]);
  const ip = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(line));
  if (result.code === 0 && ip !== undefined) {
    return { result: { name, status: "pass", detail: `this computer is ${ip}` } };
  }
  const why = firstLine(result.stderr);
  return {
    result: {
      name,
      status: "fail",
      detail: `no Tailscale address (100.x.y.z)${why.length > 0 ? `: ${why}` : ""}`,
      fix: "Open Tailscale on this computer and sign in, and check that it is connected.",
    },
  };
}

async function checkMagicDns(deps: DoctorDeps, binary: string | null): Promise<{ result: CheckResult; dnsName: string | null }> {
  const name = "MagicDNS name";
  const fix =
    "Turn on MagicDNS and HTTPS certificates in the Tailscale admin console (DNS page). You only need this to load a development build over https away from your Wi-Fi.";
  if (binary === null) {
    return { result: { name, status: "warn", detail: "can't check, the Tailscale CLI isn't available", fix }, dnsName: null };
  }
  const run = await deps.run(binary, ["status", "--json"]);
  let dns: string | null = null;
  if (run.code === 0) {
    try {
      const parsed: unknown = JSON.parse(run.stdout);
      const self = isRecord(parsed) ? parsed["Self"] : undefined;
      const raw = isRecord(self) ? self["DNSName"] : undefined;
      if (typeof raw === "string" && raw.replace(/\.$/, "").length > 0) dns = raw.replace(/\.$/, "");
    } catch {
      dns = null;
    }
  }
  if (dns !== null) return { result: { name, status: "pass", detail: dns }, dnsName: dns };
  return { result: { name, status: "warn", detail: "this computer has no MagicDNS name", fix }, dnsName: null };
}

function checkToken(deps: DoctorDeps): CheckResult {
  const path = tokenFilePath(deps.env);
  if (deps.fileExists(path)) return { name: "Token", status: "pass", detail: `found at ${path}` };
  return {
    name: "Token",
    status: "warn",
    detail: `no token file yet at ${path}, it is created on first run`,
    fix: "Nothing to do: run `tapline info` (or start the host) once and it creates the token.",
  };
}

async function checkPorts(deps: DoctorDeps): Promise<CheckResult> {
  const first = DEFAULT_PORT;
  const last = DEFAULT_PORT + DEFAULT_PORT_FALLBACK;
  const name = `Ports ${first}-${last}`;
  let free = 0;
  const total = DEFAULT_PORT_FALLBACK + 1;
  for (let port = first; port <= last; port += 1) {
    if (await deps.portFree("127.0.0.1", port)) free += 1;
  }
  if (free === 0) {
    return {
      name,
      status: "warn",
      detail: `all ${total} ports are taken, other Tapline hosts are running`,
      fix: "Close an agent session you aren't using (each one runs a host), or find the process with `netstat -ano`.",
    };
  }
  return { name, status: "pass", detail: `${free} of ${total} ports are free on 127.0.0.1` };
}

async function checkFirewall(deps: DoctorDeps): Promise<CheckResult> {
  const name = "Windows firewall";
  const result = await deps.run("powershell", [
    "-NoProfile",
    "-Command",
    "Get-NetFirewallRule -DisplayName Tapline -ErrorAction Stop | Out-Null",
  ]);
  if (result.code === 0) return { name, status: "pass", detail: 'the "Tapline" inbound rule exists' };
  return {
    name,
    status: "warn",
    detail: 'no "Tapline" firewall rule, the phone may not be able to connect (ignore this if Windows already asked and you allowed Node.js on private networks)',
    fix: `In PowerShell as administrator: ${FIREWALL_COMMAND}`,
  };
}

/** The https URL that serves Metro, null when none does, undefined when the JSON isn't understood. */
function findMetroUrl(stdout: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const web = parsed["Web"];
  if (web === undefined || web === null) return null;
  if (!isRecord(web)) return undefined;
  const tcp = isRecord(parsed["TCP"]) ? parsed["TCP"] : {};
  for (const [hostPort, entry] of Object.entries(web)) {
    if (!isRecord(entry) || !isRecord(entry["Handlers"])) continue;
    const split = hostPort.lastIndexOf(":");
    const host = split === -1 ? hostPort : hostPort.slice(0, split);
    const port = split === -1 ? "443" : hostPort.slice(split + 1);
    const tcpEntry = tcp[port];
    if (isRecord(tcpEntry) && tcpEntry["HTTP"] === true && tcpEntry["HTTPS"] !== true) continue; // plain http
    for (const handler of Object.values(entry["Handlers"])) {
      const proxy = isRecord(handler) ? handler["Proxy"] : undefined;
      if (typeof proxy !== "string") continue;
      const match = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)(?:[/?#]|$)/.exec(proxy.trim());
      if (match !== null && match[1] === METRO_PORT) {
        return port === "443" ? `https://${host}` : `https://${host}:${port}`;
      }
    }
  }
  return null;
}

async function checkMetro(deps: DoctorDeps, binary: string | null): Promise<CheckResult> {
  const name = "Metro over https";
  const fix = `Run \`tapline dev\`, or by hand: ${SERVE_COMMAND}`;
  if (binary === null) {
    return { name, status: "warn", detail: "can't check, the Tailscale CLI isn't available", fix };
  }
  const run = await deps.run(binary, ["serve", "status", "--json"]);
  if (run.code !== 0) {
    const why = firstLine(run.stderr);
    return { name, status: "warn", detail: `couldn't read tailscale serve status${why.length > 0 ? `: ${why}` : ""}`, fix };
  }
  const url = findMetroUrl(run.stdout);
  if (url === undefined) return { name, status: "warn", detail: "couldn't read tailscale serve status", fix };
  if (url === null) {
    return {
      name,
      status: "warn",
      detail: `nothing serves Metro (port ${METRO_PORT}) over https; only needed for a development build away from your Wi-Fi`,
      fix,
    };
  }
  return { name, status: "pass", detail: `Metro is served at ${url}` };
}

/** Checks the setup in order. Never throws: a check that breaks becomes a warning or failure. */
export async function runDoctor(overrides: Partial<DoctorDeps> = {}): Promise<CheckResult[]> {
  const deps: DoctorDeps = { ...defaultDeps(), ...overrides };
  const results: CheckResult[] = [];

  results.push(await guard("Node.js", "fail", () => checkNode(deps)));

  let lookup: TailscaleLookup = { binary: null, version: "", error: "" };
  try {
    lookup = await findTailscale(deps);
  } catch (error) {
    lookup = { binary: null, version: "", error: errorText(error) };
  }
  results.push(await guard("Tailscale CLI", "fail", () => checkCli(lookup)));
  results.push(await guard("Tailscale running", "fail", async () => (await checkRunning(deps, lookup.binary)).result));
  results.push(await guard("MagicDNS name", "warn", async () => (await checkMagicDns(deps, lookup.binary)).result));
  results.push(await guard("Token", "warn", () => checkToken(deps)));
  results.push(await guard(`Ports ${DEFAULT_PORT}-${DEFAULT_PORT + DEFAULT_PORT_FALLBACK}`, "warn", () => checkPorts(deps)));
  if (deps.platform === "win32") {
    results.push(await guard("Windows firewall", "warn", () => checkFirewall(deps)));
  }
  results.push(await guard("Metro over https", "warn", () => checkMetro(deps, lookup.binary)));
  return results;
}

const ICONS: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };
const FIX_PREFIX = "  fix: ";

/** One line per check, indented fix lines, then a summary. */
export function formatDoctor(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${ICONS[result.status]} ${result.name}: ${result.detail}`);
    if (result.fix !== undefined && result.fix.length > 0) {
      const [head = "", ...rest] = result.fix.split(/\r?\n/);
      lines.push(`${FIX_PREFIX}${head}`);
      for (const line of rest) lines.push(`${" ".repeat(FIX_PREFIX.length)}${line}`);
    }
  }
  const problems = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  if (problems === 0 && warnings === 0) {
    lines.push("All good.");
  } else {
    lines.push(`${problems} ${problems === 1 ? "problem" : "problems"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`);
  }
  return lines.join("\n");
}
