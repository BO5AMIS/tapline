import { execFile } from "node:child_process";

/**
 * `tapline dev`: serves Metro over https inside the user's tailnet (Tailscale Serve), because
 * iOS refuses plain http to a Tailscale address. Never touches what else Tailscale serves.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DevDeps {
  run: (command: string, args: string[]) => Promise<RunResult>;
  platform: NodeJS.Platform;
}

export interface DevOptions {
  /** Metro's port. Default 8081. */
  metroPort?: number;
  /** The https port Tailscale serves Metro on. Default 8443 (443 is often taken). */
  httpsPort?: number;
  /** Turn the entry off instead. */
  stop?: boolean;
}

export interface DevResult {
  ok: boolean;
  url?: string;
  lines: string[];
}

const WINDOWS_TAILSCALE = "C:\\Program Files\\Tailscale\\tailscale.exe";

/** Runs a program without a shell; a missing program gives code -1. */
export function runCommand(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
    });
  });
}

const defaultDeps: DevDeps = { run: runCommand, platform: process.platform };

async function findTailscale(deps: DevDeps): Promise<string | null> {
  const candidates = deps.platform === "win32" ? ["tailscale", WINDOWS_TAILSCALE] : ["tailscale"];
  for (const candidate of candidates) {
    const result = await deps.run(candidate, ["version"]);
    if (result.code === 0) return candidate;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What Tailscale already serves at the root of https port `port`, if anything. */
function servedAt(status: unknown, port: number): string | null {
  if (!isRecord(status) || !isRecord(status["Web"])) return null;
  for (const [hostPort, site] of Object.entries(status["Web"])) {
    if (!hostPort.endsWith(`:${port}`) || !isRecord(site) || !isRecord(site["Handlers"])) continue;
    const root = site["Handlers"]["/"];
    if (isRecord(root) && typeof root["Proxy"] === "string") return root["Proxy"];
    return "something";
  }
  return null;
}

export async function setUpDevServe(options: DevOptions = {}, deps: DevDeps = defaultDeps): Promise<DevResult> {
  const metroPort = options.metroPort ?? 8081;
  const httpsPort = options.httpsPort ?? 8443;
  const tailscale = await findTailscale(deps);
  if (tailscale === null) {
    return { ok: false, lines: ["Tailscale isn't installed or its command isn't found. Install Tailscale, sign in, and try again."] };
  }
  if (options.stop === true) {
    const off = await deps.run(tailscale, ["serve", `--https=${httpsPort}`, "off"]);
    return off.code === 0
      ? { ok: true, lines: [`Stopped serving https port ${httpsPort}.`] }
      : { ok: false, lines: [`Couldn't stop it: ${off.stderr.trim() || off.stdout.trim()}`] };
  }

  const status = await deps.run(tailscale, ["status", "--json"]);
  const self = parseJson(status.stdout);
  const rawName = isRecord(self) && isRecord(self["Self"]) ? self["Self"]["DNSName"] : undefined;
  const dnsName = typeof rawName === "string" ? rawName.replace(/\.$/, "") : "";
  if (status.code !== 0 || dnsName === "") {
    return {
      ok: false,
      lines: ["Couldn't read this computer's Tailscale name. Is Tailscale running and signed in, with MagicDNS on?"],
    };
  }
  const url = `https://${dnsName}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  const metro = `http://127.0.0.1:${metroPort}`;

  const serveStatus = await deps.run(tailscale, ["serve", "status", "--json"]);
  const current = servedAt(parseJson(serveStatus.stdout), httpsPort);
  const lines: string[] = [];
  if (current !== null) {
    const sameTarget = current === metro || current === `http://localhost:${metroPort}`;
    if (!sameTarget) {
      return {
        ok: false,
        lines: [
          `https port ${httpsPort} already serves ${current}; Tapline won't replace it. Pick another port with --https-port.`,
        ],
      };
    }
    lines.push(`Tailscale already serves Metro (${metro}) at ${url}.`);
  } else {
    const serve = await deps.run(tailscale, ["serve", "--bg", `--https=${httpsPort}`, metro]);
    if (serve.code !== 0) {
      return {
        ok: false,
        lines: [
          `Tailscale couldn't serve it: ${serve.stderr.trim() || serve.stdout.trim()}`,
          "HTTPS certificates must be on for your tailnet (Tailscale admin console, DNS).",
        ],
      };
    }
    lines.push(`Tailscale now serves Metro (${metro}) at ${url}, inside your tailnet only.`);
  }
  lines.push(
    `Start Metro with: EXPO_PACKAGER_PROXY_URL=${url} npx expo start --dev-client --port ${metroPort}`,
    `   (or run: tapline dev -- npx expo start --dev-client --port ${metroPort})`,
    `In the development build: Enter URL manually, ${url}`,
    `Stop serving it: tapline dev --stop${httpsPort === 8443 ? "" : ` --https-port ${httpsPort}`}`,
  );
  return { ok: true, url, lines };
}
