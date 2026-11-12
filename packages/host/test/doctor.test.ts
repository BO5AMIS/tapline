import { describe, expect, it } from "vitest";
import { tokenFilePath } from "../src/config.js";
import { formatDoctor, needsAPerson, runDoctor, type CheckResult, type DoctorDeps } from "../src/doctor.js";

interface Reply {
  code: number;
  stdout?: string;
  stderr?: string;
}

const WIN_TAILSCALE = "C:\\Program Files\\Tailscale\\tailscale.exe";

const SERVE_OK = JSON.stringify({
  TCP: { "8443": { HTTPS: true } },
  Web: {
    "mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8081" } } },
  },
});

const STATUS_OK = JSON.stringify({ Self: { DNSName: "mac.tail1234.ts.net." } });

const HEALTHY: Record<string, Reply> = {
  "tailscale version": { code: 0, stdout: "1.76.0\n" },
  "tailscale ip -4": { code: 0, stdout: "100.101.102.103\n" },
  "tailscale status --json": { code: 0, stdout: STATUS_OK },
  "tailscale serve status --json": { code: 0, stdout: SERVE_OK },
  powershell: { code: 0, stdout: "" },
};

function fakeRun(replies: Record<string, Reply>, calls: string[] = []): DoctorDeps["run"] {
  return async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(replies).find((k) => line.startsWith(k));
    if (key === undefined) return { code: -1, stdout: "", stderr: `${command}: not found` };
    const reply = replies[key] as Reply;
    return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
}

const ENV: NodeJS.ProcessEnv = { TAPLINE_HOME: "/fake/.tapline" };

function deps(overrides: Partial<DoctorDeps> = {}, replies: Record<string, Reply> = HEALTHY): Partial<DoctorDeps> {
  return {
    run: fakeRun(replies),
    platform: "win32",
    nodeVersion: "20.11.0",
    env: ENV,
    fileExists: (path) => path === tokenFilePath(ENV),
    portFree: async () => true,
    lanIps: () => ["192.168.1.20"],
    hostDir: null,
    gitStatus: async () => null,
    ...overrides,
  };
}

function byName(results: CheckResult[], name: string): CheckResult {
  const found = results.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no check named ${name}: ${results.map((r) => r.name).join(", ")}`);
  return found;
}

describe("runDoctor", () => {
  it("passes everything on a healthy Windows setup, firewall included", async () => {
    const results = await runDoctor(deps());
    expect(results.map((r) => r.status)).toEqual(Array(9).fill("pass"));
    expect(results.map((r) => r.name)).toEqual([
      "Node.js",
      "Wi-Fi or LAN address",
      "Tailscale CLI",
      "Tailscale running",
      "MagicDNS name",
      "Token",
      "Ports 7210-7219",
      "Windows firewall",
      "Metro over https",
    ]);
    expect(byName(results, "Tailscale running").detail).toContain("100.101.102.103");
    expect(byName(results, "MagicDNS name").detail).toContain("mac.tail1234.ts.net");
    expect(byName(results, "MagicDNS name").detail).not.toContain("ts.net.");
    expect(byName(results, "Ports 7210-7219").detail).toContain("10");
  });

  it("leaves out the firewall check on darwin", async () => {
    const results = await runDoctor(deps({ platform: "darwin" }));
    expect(results).toHaveLength(8);
    expect(results.some((r) => r.name === "Windows firewall")).toBe(false);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails Node below 20 with a fix", async () => {
    const results = await runDoctor(deps({ nodeVersion: "18.19.0" }));
    const node = byName(results, "Node.js");
    expect(node.status).toBe("fail");
    expect(node.detail).toContain("18.19.0");
    expect(node.fix).toBeDefined();
    expect(byName(await runDoctor(deps({ nodeVersion: "v22.1.0" })), "Node.js").status).toBe("pass");
  });

  it("falls back to the Program Files Tailscale on Windows", async () => {
    const replies: Record<string, Reply> = {};
    for (const [key, reply] of Object.entries(HEALTHY)) {
      replies[key.startsWith("tailscale") ? key.replace("tailscale", WIN_TAILSCALE) : key] = reply;
    }
    const results = await runDoctor(deps({}, replies));
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails without a Wi-Fi or LAN address, and says to join the phone's Wi-Fi", async () => {
    const lan = byName(await runDoctor(deps({ lanIps: () => [] })), "Wi-Fi or LAN address");
    expect(lan.status).toBe("fail");
    expect(lan.fix).toMatch(/same Wi-Fi as the phone/);
    expect(byName(await runDoctor(deps()), "Wi-Fi or LAN address").detail).toContain("192.168.1.20");
  });

  it("only warns when Tailscale is missing (optional for a phone on the same Wi-Fi), without crashing the dependent checks", async () => {
    const results = await runDoctor(deps({}, { powershell: { code: 0 } }));
    const cli = byName(results, "Tailscale CLI");
    expect(cli.status).toBe("warn");
    expect(cli.fix).toMatch(/tailscale/i);
    expect(byName(results, "Tailscale running").status).toBe("warn");
    expect(byName(results, "MagicDNS name").status).toBe("warn");
    expect(byName(results, "Metro over https").status).toBe("warn");
    expect(byName(results, "Token").status).toBe("pass");
  });

  it("warns when Tailscale gives no 100.x address", async () => {
    const results = await runDoctor(
      deps({}, { ...HEALTHY, "tailscale ip -4": { code: 1, stderr: "Tailscale is stopped." } }),
    );
    const running = byName(results, "Tailscale running");
    expect(running.status).toBe("warn");
    expect(running.fix).toMatch(/sign in/i);

    const odd = await runDoctor(deps({}, { ...HEALTHY, "tailscale ip -4": { code: 0, stdout: "192.168.1.5\n" } }));
    expect(byName(odd, "Tailscale running").status).toBe("warn");
  });

  it("warns when MagicDNS has no name", async () => {
    const results = await runDoctor(
      deps({}, { ...HEALTHY, "tailscale status --json": { code: 0, stdout: JSON.stringify({ Self: {} }) } }),
    );
    expect(byName(results, "MagicDNS name").status).toBe("warn");
    const garbage = await runDoctor(deps({}, { ...HEALTHY, "tailscale status --json": { code: 0, stdout: "nope" } }));
    expect(byName(garbage, "MagicDNS name").status).toBe("warn");
  });

  it("warns when the token file does not exist, and never reads it", async () => {
    const results = await runDoctor(deps({ fileExists: () => false }));
    const token = byName(results, "Token");
    expect(token.status).toBe("warn");
    expect(token.detail).toMatch(/first run/i);
  });

  it("warns when every port is taken, passes with some free", async () => {
    const taken = await runDoctor(deps({ portFree: async () => false }));
    const ports = byName(taken, "Ports 7210-7219");
    expect(ports.status).toBe("warn");
    expect(ports.fix).toBeDefined();

    const some = await runDoctor(deps({ portFree: async (_host, port) => port >= 7215 }));
    const partial = byName(some, "Ports 7210-7219");
    expect(partial.status).toBe("pass");
    expect(partial.detail).toContain("5");
  });

  it("probes 127.0.0.1 on every port in the range", async () => {
    const probed: string[] = [];
    await runDoctor(
      deps({
        portFree: async (host, port) => {
          probed.push(`${host}:${port}`);
          return true;
        },
      }),
    );
    expect(probed).toEqual(Array.from({ length: 10 }, (_, i) => `127.0.0.1:${7210 + i}`));
  });

  it("warns with the New-NetFirewallRule command when the Windows rule is missing", async () => {
    const calls: string[] = [];
    const results = await runDoctor(
      deps({ run: fakeRun({ ...HEALTHY, powershell: { code: 1, stderr: "No MSFT_NetFirewallRule objects found" } }, calls) }),
    );
    const firewall = byName(results, "Windows firewall");
    expect(firewall.status).toBe("warn");
    expect(firewall.fix).toContain(
      'New-NetFirewallRule -DisplayName "Tapline" -Direction Inbound -Protocol TCP -LocalPort 7210-7219 -RemoteAddress LocalSubnet,100.64.0.0/10 -Action Allow',
    );
    const ps = calls.find((c) => c.startsWith("powershell"));
    expect(ps).toContain("-NoProfile -Command");
    expect(ps).toContain("Get-NetFirewallRule -DisplayName Tapline");
  });

  it("passes Metro over https and names the URL when an https port proxies to 8081", async () => {
    const results = await runDoctor(deps());
    const metro = byName(results, "Metro over https");
    expect(metro.status).toBe("pass");
    expect(metro.detail).toContain("https://mac.tail1234.ts.net:8443");

    const localhost = JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: { "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:8081/" } } } },
    });
    const second = await runDoctor(deps({}, { ...HEALTHY, "tailscale serve status --json": { code: 0, stdout: localhost } }));
    expect(byName(second, "Metro over https").status).toBe("pass");
    expect(byName(second, "Metro over https").detail).toContain("https://mac.tail1234.ts.net");
  });

  it("warns when nothing serves Metro, with the serve command as a fix", async () => {
    const other = JSON.stringify({
      TCP: { "8443": { HTTPS: true } },
      Web: { "mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    });
    for (const stdout of ["{}", other]) {
      const results = await runDoctor(deps({}, { ...HEALTHY, "tailscale serve status --json": { code: 0, stdout } }));
      const metro = byName(results, "Metro over https");
      expect(metro.status).toBe("warn");
      expect(metro.fix).toContain("tapline dev");
      expect(metro.fix).toContain("tailscale serve --bg --https=8443 http://127.0.0.1:8081");
    }
  });

  it("warns without crashing on garbage or unexpected serve JSON", async () => {
    for (const stdout of ["not json", "[1,2]", "null", '{"Web": 5}', ""]) {
      const results = await runDoctor(deps({}, { ...HEALTHY, "tailscale serve status --json": { code: 0, stdout } }));
      const metro = byName(results, "Metro over https");
      expect(metro.status).toBe("warn");
      expect(metro.detail).toContain("couldn't read tailscale serve status");
    }
  });

  it("never throws: a run that rejects becomes a warning or failure with the error text", async () => {
    const results = await runDoctor(
      deps({
        run: async () => {
          throw new Error("boom");
        },
        portFree: async () => {
          throw new Error("probe broke");
        },
        fileExists: () => {
          throw new Error("disk broke");
        },
      }),
    );
    expect(results.length).toBe(9);
    expect(results.some((r) => r.status === "pass")).toBe(true); // Node.js
    for (const r of results.filter((x) => x.name !== "Node.js" && x.name !== "Wi-Fi or LAN address")) {
      expect(r.status).not.toBe("pass");
    }
    expect(byName(results, "Tailscale CLI").detail).toContain("boom");
    expect(byName(results, "Token").detail).toContain("disk broke");
    expect(byName(results, "Ports 7210-7219").detail).toContain("probe broke");
  });

  it("warns when the host runs from a git work tree with uncommitted changes, and counts conflicts", async () => {
    const results = await runDoctor(deps({ hostDir: "/work/tapline/packages/host/dist", gitStatus: async () => " M src/a.ts\nUU src/b.ts\n?? x\n" }));
    const warning = byName(results, "Host version");
    expect(warning.status).toBe("warn");
    expect(warning.detail).toContain("3 uncommitted changes (1 in conflict)");
    expect(warning.fix).toContain("npm install -g tapline-host@<version>");
  });

  it("says nothing for a clean tree, an installed copy, no git, or a git that fails", async () => {
    const names = async (overrides: Partial<DoctorDeps>): Promise<string[]> => (await runDoctor(deps(overrides))).map((r) => r.name);
    expect(await names({ hostDir: "/work/tapline/packages/host/dist", gitStatus: async () => "" })).not.toContain("Host version");
    expect(await names({ hostDir: "/work/tapline/packages/host/dist", gitStatus: async () => null })).not.toContain("Host version");
    expect(
      await names({ hostDir: "/usr/lib/node_modules/tapline-host/dist", gitStatus: async () => " M dotfile\n" }),
    ).not.toContain("Host version");
    expect(
      await names({
        hostDir: "/work/dist",
        gitStatus: async () => {
          throw new Error("git broke");
        },
      }),
    ).not.toContain("Host version");
  });

  it("lists what needs a person: pairing until a phone has connected, and the firewall rule when it is missing", async () => {
    const unpaired = deps({ fileExists: (path) => path === tokenFilePath(ENV) });
    const results = await runDoctor(unpaired);
    const items = needsAPerson(results, unpaired);
    expect(items).toHaveLength(1);
    expect(items[0]).toContain("Pair the phone");
    expect(items[0]).toContain("EXPO_PUBLIC_TAPLINE_ENABLED=1");

    const noRule = deps({ fileExists: () => true }, { ...HEALTHY, powershell: { code: 1, stderr: "no rule" } });
    const missing = needsAPerson(await runDoctor(noRule), noRule);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("firewall");

    const settled = deps({ fileExists: () => true });
    expect(needsAPerson(await runDoctor(settled), settled)).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(/[0-9a-f]{32}/); // never a token
  });

  it("works with real defaults without throwing", async () => {
    const results = await runDoctor();
    expect(results.length).toBeGreaterThanOrEqual(7);
    expect(byName(results, "Node.js").status).toBe("pass");
  }, 60_000);
});

describe("formatDoctor", () => {
  it("prints a line per check, indented fix lines and an all-good summary", () => {
    const text = formatDoctor([
      { name: "Node.js", status: "pass", detail: "v20.11.0" },
      { name: "Token", status: "pass", detail: "found" },
    ]);
    expect(text.split("\n")).toEqual(["✓ Node.js: v20.11.0", "✓ Token: found", "All good."]);
  });

  it("marks warnings and failures, lists fixes and counts problems and warnings", () => {
    const results: CheckResult[] = [
      { name: "Tailscale CLI", status: "fail", detail: "not found", fix: "Install Tailscale from https://tailscale.com" },
      { name: "Token", status: "warn", detail: "not created yet", fix: "It is created on first run" },
      { name: "Ports", status: "warn", detail: "all taken" },
      { name: "Node.js", status: "pass", detail: "v20" },
    ];
    const lines = formatDoctor(results).split("\n");
    expect(lines).toEqual([
      "✗ Tailscale CLI: not found",
      "  fix: Install Tailscale from https://tailscale.com",
      "! Token: not created yet",
      "  fix: It is created on first run",
      "! Ports: all taken",
      "✓ Node.js: v20",
      "1 problem, 2 warnings.",
    ]);
  });

  it("ends with a Needs a person block when something is pending, and has none otherwise", () => {
    const results: CheckResult[] = [{ name: "Node.js", status: "pass", detail: "v20" }];
    expect(formatDoctor(results, ["Pair the phone."])).toBe("✓ Node.js: v20\nAll good.\n\nNeeds a person:\n- Pair the phone.");
    expect(formatDoctor(results)).not.toContain("Needs a person");
    expect(formatDoctor(results, [])).not.toContain("Needs a person");
  });

  it("says 0 problems when there are only warnings", () => {
    const text = formatDoctor([{ name: "Token", status: "warn", detail: "x" }]);
    expect(text.split("\n").at(-1)).toBe("0 problems, 1 warning.");
  });

  it("indents every line of a multi-line fix", () => {
    const text = formatDoctor([{ name: "A", status: "fail", detail: "d", fix: "one\ntwo" }]);
    expect(text.split("\n").slice(0, 3)).toEqual(["✗ A: d", "  fix: one", "       two"]);
  });
});
