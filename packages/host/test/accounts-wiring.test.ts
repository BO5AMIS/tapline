import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { GitProbe } from "../src/accounts.js";
import { parseCli, runtimeOptionsOf } from "../src/cli.js";
import { runDoctor, type CheckResult, type DoctorDeps } from "../src/doctor.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

// AGENT-TOOLS 1.13 §18.6: `--accounts FILE` reaches the runtime, the tools and `doctor`.

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-accounts-wiring-"));
  dirs.push(dir);
  return dir;
}

const textOf = (result: CallToolResult): string => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

function accountsFile(): string {
  const file = join(tmp(), "accounts.json");
  writeFileSync(file, JSON.stringify({ version: 1, accounts: { tester2: { username: "tester2@example.com", password: "fake-pass-9137", apps: ["com.example.demo"] } } }));
  return file;
}

const INSIDE: GitProbe = { insideWorkTree: async () => true, ignored: async () => false };
const OUTSIDE: GitProbe = { insideWorkTree: async () => false, ignored: async () => false };

describe("--accounts", () => {
  it("is a command line option for mcp and host", () => {
    const { values } = parseCli(["mcp", "--accounts", "/somewhere/accounts.json"]);
    expect(runtimeOptionsOf(values, {}).accounts).toBe("/somewhere/accounts.json");
    expect(runtimeOptionsOf(parseCli(["mcp"]).values, {})).not.toHaveProperty("accounts");
  });

  it("a file in a git repo starts the server with no accounts, logs why, and every use says it", async () => {
    const file = accountsFile();
    const lines: string[] = [];
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: tmp() }, log: (m) => lines.push(m), accounts: file, gitProbe: INSIDE });
    runtimes.push(runtime);
    const blocked = `accounts file is inside the git repo at ${file} and not ignored; move it or add it to .gitignore.`;
    expect(lines).toContain(blocked);
    const used = await runtime.toolsFor(undefined).typeText({ text: "${account.username}", account: "tester2" });
    // With no app connected the first answer also carries the "needs a person" note, which is not ours.
    expect(textOf(used).split("\n")[0]).toBe(`Error bad_params: ${blocked}`);
    expect(textOf(used)).not.toContain("Note: accounts file");
  });

  it("a usable file loads: an unknown name is not_found with the names, and no app means not_connected", async () => {
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: tmp() }, log: () => undefined, accounts: accountsFile(), gitProbe: OUTSIDE });
    runtimes.push(runtime);
    const answer = await runtime.toolsFor(undefined).typeText({ text: "${account.username}", account: "tester2" });
    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toMatch(/^Error not_connected/);
  });

  it("a bad file stops the server with a plain message that doesn't quote the file", async () => {
    const file = join(tmp(), "accounts.json");
    writeFileSync(file, '{"version": 1, "accounts": {"a": {"password": "fake-pass-9137" ');
    const error = await createRuntime({ port: 0, host: "127.0.0.1", viewer: "off", env: { TAPLINE_HOME: tmp() }, log: () => undefined, accounts: file, gitProbe: OUTSIDE }).catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain("isn't valid JSON");
    expect(String((error as Error).message)).not.toContain("fake-pass-9137");
  });
});

const BASE: Partial<DoctorDeps> = {
  run: async () => ({ code: -1, stdout: "", stderr: "" }),
  platform: "linux",
  nodeVersion: "20.11.0",
  env: { TAPLINE_HOME: "/fake/.tapline" },
  fileExists: () => true,
  portFree: async () => true,
  lanIps: () => ["192.168.1.20"],
  hostDir: null,
  gitStatus: async () => null,
};

function accountsCheck(results: CheckResult[]): CheckResult | undefined {
  return results.find((r) => r.name === "Test accounts");
}

describe("doctor", () => {
  it("says nothing about accounts without --accounts", async () => {
    expect(accountsCheck(await runDoctor(BASE))).toBeUndefined();
  });

  it("lists the names when the file loads, never a value", async () => {
    const check = accountsCheck(await runDoctor({ ...BASE, accountsFile: accountsFile(), gitProbe: OUTSIDE }));
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 account: tester2.");
    expect(check?.detail).toContain("a \"show password\" toggle shows it");
    expect(check?.detail).toContain("outside the folders the agent may read");
    expect(JSON.stringify(check)).not.toContain("fake-pass-9137");
  });

  it("fails with the git message when the file sits in a repo", async () => {
    const file = accountsFile();
    const check = accountsCheck(await runDoctor({ ...BASE, accountsFile: file, gitProbe: INSIDE }));
    expect(check?.status).toBe("fail");
    expect(check?.detail).toBe(`accounts file is inside the git repo at ${file} and not ignored; move it or add it to .gitignore.`);
  });

  it("fails on a value under 3 characters, without quoting it", async () => {
    const file = join(tmp(), "accounts.json");
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { a: { username: "ab", password: "qz" } } }));
    const check = accountsCheck(await runDoctor({ ...BASE, accountsFile: file, gitProbe: OUTSIDE }));
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("at least 3 characters");
    expect(check?.detail).not.toContain('"qz"');
  });

  it("fails on a file that is missing", async () => {
    const check = accountsCheck(await runDoctor({ ...BASE, accountsFile: join(tmp(), "nope.json"), gitProbe: OUTSIDE }));
    expect(check?.status).toBe("fail");
  });
});
