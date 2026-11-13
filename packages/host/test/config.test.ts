import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectSnippet,
  hostUrl,
  loadOrCreateToken,
  nativeIntentSnippet,
  reachableHost,
  lanAddresses,
  resolveConfig,
  screenshotMode,
  viewerMode,
  tokenFilePath,
} from "../src/config.js";

const dirs: string[] = [];
function tempEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "tapline-test-"));
  dirs.push(dir);
  return { TAPLINE_HOME: join(dir, ".tapline"), ...extra };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("token", () => {
  it("generates 32 hex chars once and persists them", () => {
    const env = tempEnv();
    const token = loadOrCreateToken(env);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(tokenFilePath(env), "utf8").trim()).toBe(token);
    expect(loadOrCreateToken(env)).toBe(token);
  });

  it("replaces a token file that is too short", () => {
    const env = tempEnv();
    loadOrCreateToken(env);
    writeFileSync(tokenFilePath(env), "abc\n");
    expect(loadOrCreateToken(env)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("resolveConfig", () => {
  it("defaults to port 7210, moving up to 7219 when taken", async () => {
    const config = await resolveConfig({ env: tempEnv() });
    expect(config.port).toBe(7210);
    expect(config.portFallback).toBe(9);
    expect(config.hosts).toContain("127.0.0.1");
    expect(hostUrl(config, 7212)).toBe(`ws://${config.advertisedHost}:7212/`);
  });

  it("reads TAPLINE_PORT and lets --port win; an explicit port has no fallback", async () => {
    const fromEnv = await resolveConfig({ env: tempEnv({ TAPLINE_PORT: "8123" }) });
    expect(fromEnv.port).toBe(8123);
    expect(fromEnv.portFallback).toBe(0);
    const fromFlag = await resolveConfig({ port: "9000", env: tempEnv({ TAPLINE_PORT: "8123" }) });
    expect(fromFlag.port).toBe(9000);
    expect(fromFlag.portFallback).toBe(0);
  });

  it("names the computer for the pairing prompt", async () => {
    const config = await resolveConfig({ env: tempEnv() });
    expect(config.name).toBe(hostname());
  });

  it("rejects a bad port", async () => {
    await expect(resolveConfig({ port: "abc", env: tempEnv() })).rejects.toThrow(/Invalid port/);
  });

  it("--host overrides the bind addresses", async () => {
    const config = await resolveConfig({ host: "0.0.0.0", env: tempEnv() });
    expect(config.hosts).toEqual(["0.0.0.0"]);
    expect(config.advertisedHost).toBe(config.tailscaleIp ?? "127.0.0.1");
  });

  it("listens on the Wi-Fi/LAN address and gives it to the app (v1: a test phone on the same network)", async () => {
    const interfaces = {
      "vEthernet (WSL)": [{ address: "172.20.0.1", netmask: "255.255.240.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: null }],
      "Wi-Fi": [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:01", internal: false, cidr: null }],
      Ethernet: [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:02", internal: false, cidr: null }],
      Tailscale: [{ address: "100.101.102.103", netmask: "255.192.0.0", family: "IPv4" as const, mac: "00:00:00:00:00:03", internal: false, cidr: null }],
    };
    const config = await resolveConfig({ env: tempEnv(), interfaces });
    expect(config.lanIps).toEqual(["192.168.1.20", "10.0.0.5"]);
    expect(config.hosts.slice(0, 2)).toEqual(["192.168.1.20", "10.0.0.5"]);
    expect(config.hosts).toContain("127.0.0.1");
    expect(config.hosts).not.toContain("172.20.0.1");
    expect(config.advertisedHost).toBe("192.168.1.20");
  });

  it("with no network address at all, listens on 127.0.0.1 and says why", async () => {
    const config = await resolveConfig({ env: tempEnv(), interfaces: {} });
    if (config.tailscaleIp === null) {
      expect(config.hosts).toEqual(["127.0.0.1"]);
      expect(config.notes.join(" ")).toMatch(/same Wi-Fi as the phone/);
    }
  });
});

describe("lanAddresses", () => {
  it("keeps private IPv4 on real adapters, Wi-Fi first", () => {
    const entry = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: null });
    expect(lanAddresses({ Ethernet: [entry("10.1.2.3")], "Wi-Fi": [entry("192.168.0.9")], lo: [entry("127.0.0.1", true)], docker0: [entry("172.17.0.1")], public: [entry("8.8.8.8")] })).toEqual(["192.168.0.9", "10.1.2.3"]);
  });

  it("puts IPv6 addresses in brackets", () => {
    expect(hostUrl({ advertisedHost: "::1" }, 7210)).toBe("ws://[::1]:7210/");
    expect(hostUrl({ advertisedHost: "fd7a:115c:a1e0::1" }, 7211)).toBe("ws://[fd7a:115c:a1e0::1]:7211/");
  });

  it("after listening, falls back to an address that did bind", () => {
    const config = { advertisedHost: "100.1.2.3" };
    expect(reachableHost(config, [{ host: "100.1.2.3" }, { host: "127.0.0.1" }])).toBe("100.1.2.3");
    expect(reachableHost(config, [{ host: "127.0.0.1" }])).toBe("127.0.0.1");
    expect(reachableHost(config, [{ host: "0.0.0.0" }])).toBe("100.1.2.3");
  });

  it("advertises an address the host actually listens on", async () => {
    const loopback = await resolveConfig({ host: "127.0.0.1", env: tempEnv() });
    expect(loopback.advertisedHost).toBe("127.0.0.1");
    const lan = await resolveConfig({ host: "192.168.1.20,127.0.0.1", env: tempEnv() });
    expect(lan.advertisedHost).toBe("192.168.1.20");
  });
});

describe("screenshotMode", () => {
  it("is inline unless --screenshots or TAPLINE_SCREENSHOTS says file", () => {
    expect(screenshotMode(undefined, {})).toBe("inline");
    expect(screenshotMode("file", {})).toBe("file");
    expect(screenshotMode(undefined, { TAPLINE_SCREENSHOTS: "file" })).toBe("file");
    expect(screenshotMode("inline", { TAPLINE_SCREENSHOTS: "file" })).toBe("inline");
  });
  it("rejects anything else, naming the choices", () => {
    expect(() => screenshotMode("files", {})).toThrow(/inline.*file/);
  });
});

describe("viewerMode", () => {
  it("is local unless --viewer or TAPLINE_VIEWER says remote or off", () => {
    expect(viewerMode(undefined, {})).toBe("local");
    expect(viewerMode("remote", {})).toBe("remote");
    expect(viewerMode(undefined, { TAPLINE_VIEWER: "off" })).toBe("off");
    expect(viewerMode("local", { TAPLINE_VIEWER: "remote" })).toBe("local");
    expect(() => viewerMode("public", {})).toThrow(/local, remote or off/);
  });
});

describe("app snippets", () => {
  it("turns Tapline on with a build switch and carries no address or token", () => {
    const snippet = connectSnippet();
    expect(snippet.split("\n")[0]).toContain("react-native-tapline/register");
    expect(snippet).toContain("startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });");
    expect(snippet).not.toMatch(/TOKEN|_URL|ws:\/\//);
  });

  it("tells Expo Router to leave pairing links to Tapline", () => {
    const snippet = nativeIntentSnippet();
    expect(snippet).toContain("isTaplineLink");
    expect(snippet).toContain("export function redirectSystemPath");
    expect(snippet).toContain("? null : path");
  });
});
