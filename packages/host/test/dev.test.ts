import { describe, expect, it } from "vitest";
import { setUpDevServe, type DevDeps } from "../src/dev.js";

type Call = { command: string; args: string[] };

function fakeTailscale(options: { installed?: boolean; serve?: unknown; dns?: string; serveFails?: boolean } = {}) {
  const calls: Call[] = [];
  const deps: DevDeps = {
    platform: "linux",
    run: async (command, args) => {
      calls.push({ command, args });
      if (options.installed === false) return { code: -1, stdout: "", stderr: "not found" };
      if (args[0] === "version") return { code: 0, stdout: "1.90.0\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: options.dns ?? "my-pc.tail1234.ts.net." } }), stderr: "" };
      if (args[0] === "serve" && args[1] === "status") return { code: 0, stdout: JSON.stringify(options.serve ?? {}), stderr: "" };
      if (args[0] === "serve") return options.serveFails ? { code: 1, stdout: "", stderr: "serve failed: HTTPS disabled" } : { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
  return { deps, calls };
}

describe("tapline dev", () => {
  it("serves Metro over https on a free port and says how to use it", async () => {
    const { deps, calls } = fakeTailscale();
    const result = await setUpDevServe({}, deps);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://my-pc.tail1234.ts.net:8443");
    expect(calls.some((c) => c.args.join(" ") === "serve --bg --https=8443 http://127.0.0.1:8081")).toBe(true);
    const text = result.lines.join("\n");
    expect(text).toContain("EXPO_PACKAGER_PROXY_URL=https://my-pc.tail1234.ts.net:8443");
    expect(text).toContain("Enter URL manually");
  });

  it("reuses an existing entry for the same Metro port", async () => {
    const serve = { Web: { "my-pc.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8081" } } } } };
    const { deps, calls } = fakeTailscale({ serve });
    const result = await setUpDevServe({}, deps);
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.args[0] === "serve" && c.args[1] === "--bg")).toBe(false);
    expect(result.lines.join("\n")).toContain("already");
  });

  it("refuses a port that already serves something else", async () => {
    const serve = { Web: { "my-pc.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } } } };
    const { deps, calls } = fakeTailscale({ serve });
    const result = await setUpDevServe({}, deps);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("http://127.0.0.1:3773");
    expect(result.lines.join("\n")).toContain("--https-port");
    expect(calls.some((c) => c.args[1] === "--bg")).toBe(false);
  });

  it("uses the ports it's given, and stops", async () => {
    const { deps, calls } = fakeTailscale();
    expect((await setUpDevServe({ metroPort: 8082, httpsPort: 9443 }, deps)).url).toBe("https://my-pc.tail1234.ts.net:9443");
    expect(calls.some((c) => c.args.join(" ") === "serve --bg --https=9443 http://127.0.0.1:8082")).toBe(true);
    const stopped = await setUpDevServe({ httpsPort: 9443, stop: true }, deps);
    expect(stopped.ok).toBe(true);
    expect(calls.at(-1)?.args.join(" ")).toBe("serve --https=9443 off");
  });

  it("explains missing Tailscale or a failed serve", async () => {
    const missing = await setUpDevServe({}, fakeTailscale({ installed: false }).deps);
    expect(missing.ok).toBe(false);
    expect(missing.lines.join("\n")).toContain("Tailscale");
    const failed = await setUpDevServe({}, fakeTailscale({ serveFails: true }).deps);
    expect(failed.ok).toBe(false);
    expect(failed.lines.join("\n")).toContain("HTTPS disabled");
  });
});
