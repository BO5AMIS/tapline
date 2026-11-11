import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 7210;
/** Without an explicit port, a host whose port is taken (another agent's host) moves up to 7219. */
export const DEFAULT_PORT_FALLBACK = 9;

export interface HostConfig {
  /** Shared secret a paired app presents in `hello`. */
  token: string;
  /** Where the token lives on disk. */
  tokenPath: string;
  port: number;
  /** How many following ports to try when `port` is taken (0 for an explicit port). */
  portFallback: number;
  /** Addresses the WebSocket server binds to. */
  hosts: string[];
  /** This machine's Tailscale IPv4, if found. */
  tailscaleIp: string | null;
  /** This machine's addresses on its Wi-Fi or wired network (private IPv4), Wi-Fi first. */
  lanIps: string[];
  /** The address the app should connect to (the Wi-Fi/LAN address if there is one, else Tailscale, else loopback). */
  advertisedHost: string;
  /** This computer's name, shown on the phone before it connects. */
  name: string;
  /** Human-readable notes (e.g. "Tailscale not found, binding loopback only"). */
  notes: string[];
}

/** ws://<advertisedHost>:<port>/ for the port the host actually bound. */
export function hostUrl(config: Pick<HostConfig, "advertisedHost">, port: number): string {
  const host = config.advertisedHost.includes(":") ? `[${config.advertisedHost}]` : config.advertisedHost;
  return `ws://${host}:${port}/`;
}

/**
 * The address to give apps once the host is listening: the advertised one if it bound (or the
 * host listens on every interface), else one that did bind (e.g. Tailscale went down).
 */
export function reachableHost(config: Pick<HostConfig, "advertisedHost">, listening: Array<{ host: string }>): string {
  const hosts = listening.map((l) => l.host);
  if (hosts.includes(config.advertisedHost) || hosts.some((h) => h === "0.0.0.0" || h === "::")) {
    return config.advertisedHost;
  }
  return hosts[0] ?? config.advertisedHost;
}

export interface ResolveOptions {
  port?: number | string;
  /** Comma-separated bind addresses; overrides the defaults. */
  host?: string;
  env?: NodeJS.ProcessEnv;
  /** The network interfaces (tests); defaults to this machine's. */
  interfaces?: NetworkInterfaces;
}

export type NetworkInterfaces = ReturnType<typeof networkInterfaces>;

/** Adapters that aren't the network the phone is on: virtual machines, containers, VPNs. */
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|docker|loopback|tailscale|utun|zerotier|npcap|bluetooth|^br-|^tap|^tun/i;

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a = 0, b = 0] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * This machine's addresses on the network a phone next to it shares (Wi-Fi or a cable to the same
 * router): private IPv4 on a physical adapter, Wi-Fi first, then Ethernet.
 */
export function lanAddresses(interfaces: NetworkInterfaces = networkInterfaces()): string[] {
  const found: Array<{ name: string; address: string }> = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (list === undefined || VIRTUAL_ADAPTER.test(name)) continue;
    for (const entry of list) {
      const v4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (v4 && !entry.internal && isPrivateV4(entry.address)) found.push({ name, address: entry.address });
    }
  }
  const rank = (name: string): number => (/wi-?fi|wlan|wireless|^en0$/i.test(name) ? 0 : /ethernet|^eth|^en\d/i.test(name) ? 1 : 2);
  return found.sort((x, y) => rank(x.name) - rank(y.name)).map((entry) => entry.address);
}

export type ScreenshotMode = "inline" | "file";

/**
 * How `look` delivers screenshots: from `--screenshots`, else `TAPLINE_SCREENSHOTS`, else inline.
 * "file" saves them and returns paths, for lead agents that hand images to smaller models.
 */
export function screenshotMode(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): ScreenshotMode {
  const fromEnv = env["TAPLINE_SCREENSHOTS"];
  const raw = flag ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : "inline");
  if (raw === "inline" || raw === "file") return raw;
  throw new Error(`Unknown screenshot mode "${raw}": use inline or file (--screenshots or TAPLINE_SCREENSHOTS).`);
}

export type ViewerMode = "local" | "remote" | "off";

/**
 * Where the live viewer can be opened: from `--viewer`, else `TAPLINE_VIEWER`, else local
 * (this computer only). "remote" adds your own devices on Tailscale; "off" turns it off.
 */
export function viewerMode(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): ViewerMode {
  const fromEnv = env["TAPLINE_VIEWER"];
  const raw = flag ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : "local");
  if (raw === "local" || raw === "remote" || raw === "off") return raw;
  throw new Error(`Unknown viewer mode "${raw}": use local, remote or off (--viewer or TAPLINE_VIEWER).`);
}

/** `~/.tapline`, or `$TAPLINE_HOME` when set. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["TAPLINE_HOME"];
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".tapline");
}

export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "token");
}

const MIN_TOKEN_LENGTH = 16;

/** Reads the persisted token, generating a new 32-hex-char one on first use. */
export function loadOrCreateToken(env: NodeJS.ProcessEnv = process.env): string {
  const path = tokenFilePath(env);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= MIN_TOKEN_LENGTH) return existing;
  }
  const token = randomBytes(16).toString("hex");
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

function runTailscale(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["ip", "-4"], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve(null);
        return;
      }
      const ip = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line));
      resolve(ip ?? null);
    });
  });
}

/** Finds this machine's Tailscale IPv4 via the `tailscale` CLI. */
export async function detectTailscaleIp(): Promise<string | null> {
  const candidates = ["tailscale"];
  if (process.platform === "win32") {
    candidates.push("C:\\Program Files\\Tailscale\\tailscale.exe");
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  }
  for (const candidate of candidates) {
    const ip = await runTailscale(candidate);
    if (ip !== null) return ip;
  }
  return null;
}

function parsePort(value: number | string | undefined, source: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port from ${source}: ${String(value)}`);
  }
  return port;
}

/**
 * The address to give apps: one the host listens on. The Wi-Fi/LAN address comes first (v1: a test
 * phone on the same network as this computer), then Tailscale.
 */
function advertise(hosts: string[], tailscaleIp: string | null, lanIps: string[]): string {
  const lan = lanIps.find((ip) => hosts.includes(ip));
  if (lan !== undefined) return lan;
  if (tailscaleIp !== null && hosts.includes(tailscaleIp)) return tailscaleIp;
  const specific = hosts.find((h) => h !== "0.0.0.0" && h !== "::");
  if (specific !== undefined) return specific;
  return tailscaleIp ?? "127.0.0.1"; // listening on every interface
}

export async function resolveConfig(options: ResolveOptions = {}): Promise<HostConfig> {
  const env = options.env ?? process.env;
  const explicitPort = parsePort(options.port, "--port") ?? parsePort(env["TAPLINE_PORT"], "TAPLINE_PORT");
  const port = explicitPort ?? DEFAULT_PORT;
  const token = loadOrCreateToken(env);
  const notes: string[] = [];
  const tailscaleIp = await detectTailscaleIp();
  const lanIps = lanAddresses(options.interfaces);

  let hosts: string[];
  if (options.host !== undefined && options.host.trim().length > 0) {
    hosts = options.host
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  } else {
    // The phone's Wi-Fi (or the same router by cable), Tailscale when it runs, and this computer.
    hosts = [...lanIps, ...(tailscaleIp !== null ? [tailscaleIp] : []), "127.0.0.1"];
    if (lanIps.length === 0 && tailscaleIp === null) {
      notes.push(
        "This computer has no Wi-Fi or local network address and Tailscale wasn't found, so the host listens on 127.0.0.1 only. " +
          "Connect it to the same Wi-Fi as the phone (or a cable to the same router), or pass --host.",
      );
    }
  }

  return {
    token,
    tokenPath: tokenFilePath(env),
    port,
    portFallback: explicitPort === undefined ? DEFAULT_PORT_FALLBACK : 0,
    hosts,
    tailscaleIp,
    lanIps,
    advertisedHost: advertise(hosts, tailscaleIp, lanIps),
    name: hostname(),
    notes,
  };
}

/**
 * The app's entry file. The build carries no address and no token, only an on switch:
 * set EXPO_PUBLIC_TAPLINE_ENABLED=1 in development and test builds, never in store builds.
 */
export function connectSnippet(): string {
  return [
    `import 'react-native-tapline/register'; // first line of the entry file`,
    `import { startTapline } from 'react-native-tapline';`,
    ``,
    `startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });`,
  ].join("\n");
}

/** For Expo Router apps: `app/+native-intent.ts`, so pairing links don't open a "not found" screen. */
export function nativeIntentSnippet(): string {
  return [
    `import { isTaplineLink } from 'react-native-tapline';`,
    ``,
    `export function redirectSystemPath({ path }: { path: string; initial: boolean }) {`,
    `  return isTaplineLink(path) ? null : path;`,
    `}`,
  ].join("\n");
}
