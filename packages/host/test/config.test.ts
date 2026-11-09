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
  resolveConfig,
  screenshotMode,
  tokenFilePath,
} from "../src/config.js";

const dirs: string[] = [];
function tempEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "tapline-test-"));
  dirs.push(dir);
  return { TAPLINE_HOME: join(dir, ".tapline"), ...extra };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    expect(config.hosts).toContain(config.tailscaleIp === null ? "127.0.0.1" : config.tailscaleIp);
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

describe("app snippets", () => {
  it("turns Tapline on with a build switch and carries no address or token", () => {
    const snippet = connectSnippet();
    expect(snippet.split("\n")[0]).toContain("@tapline/react-native/register");
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
