import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, HOST_FACTS_TOOL, type Runtime } from "../src/runtime.js";
import type { Keychain, VaultDeps } from "../src/vault.js";

// PR 12 Codex cycle 5, finding 1: the current and the retired values are matched together against the ORIGINAL text, so a shared
// prefix, suffix or middle never lets the current scrubber eat part of an old secret before it can be recognized. Made-up values.

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const vaultJson = (password: string): string =>
  JSON.stringify({ version: 2, vault: { tester: { kind: "account", username: "qa-user-name-1", password, apps: ["com.example.a"] } } });

async function rotate(oldPw: string, newPw: string): Promise<Runtime> {
  const home = mkdtempSync(join(tmpdir(), "tapline-overlap-"));
  dirs.push(home);
  const accounts = join(home, "accounts.json");
  const maps = join(home, "maps");
  mkdirSync(maps);
  writeFileSync(accounts, JSON.stringify({ version: 2, protected: "keychain" }));
  let current = vaultJson(oldPw);
  const keychain: Keychain = {
    async read() {
      return current;
    },
    async write(_account, json) {
      current = json;
    },
  };
  const vaultDeps: VaultDeps = { platform: "darwin", dpapi: { protect: async (d) => Buffer.from(d), unprotect: async (b) => Buffer.from(b) }, keychain };
  const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, api: true, accounts, maps, vaultDeps });
  runtimes.push(runtime);
  current = vaultJson(newPw);
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/${HOST_FACTS_TOOL}`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.config.token}`, "x-agent-client": "schedule-x" },
    body: "{}",
  });
  await response.json();
  return runtime;
}

const TOKEN = "<tester's password>";

describe("overlapping old and new secrets after a reload", () => {
  it("the exact example: a shared 12+ character prefix leaves nothing of the old password", async () => {
    const r = await rotate("prefix-shared-OLD-super-secret-tail", "prefix-shared-NEW-super-secret-tail");
    expect(r.host.redactOut("echo prefix-shared-OLD-super-secret-tail end")).toBe(`echo ${TOKEN} end`);
    expect(r.host.redactOut("echo prefix-shared-NEW-super-secret-tail end")).toBe(`echo ${TOKEN} end`);
  });

  it("a shared suffix", async () => {
    const r = await rotate("OLD-aaaa-bbbb-shared-suffix-value", "NEW-cccc-dddd-shared-suffix-value");
    expect(r.host.redactOut("x OLD-aaaa-bbbb-shared-suffix-value y")).toBe(`x ${TOKEN} y`);
    expect(r.host.redactOut("x NEW-cccc-dddd-shared-suffix-value y")).toBe(`x ${TOKEN} y`);
  });

  it("a shared middle", async () => {
    const r = await rotate("aaaa-OLD-shared-middle-section-zzzz", "bbbb-NEW-shared-middle-section-yyyy");
    expect(r.host.redactOut("x aaaa-OLD-shared-middle-section-zzzz y")).toBe(`x ${TOKEN} y`);
    expect(r.host.redactOut("x bbbb-NEW-shared-middle-section-yyyy y")).toBe(`x ${TOKEN} y`);
  });

  it("the new value inside the old one", async () => {
    const r = await rotate("lead-in-NEW-secret-value-trailing", "NEW-secret-value");
    expect(r.host.redactOut("x lead-in-NEW-secret-value-trailing y")).toBe(`x ${TOKEN} y`);
  });

  it("the old value inside the new one", async () => {
    const r = await rotate("OLD-secret-value-12", "lead-in-OLD-secret-value-12-trailing");
    expect(r.host.redactOut("x lead-in-OLD-secret-value-12-trailing y")).toBe(`x ${TOKEN} y`);
    expect(r.host.redactOut("x OLD-secret-value-12 y")).toBe(`x ${TOKEN} y`);
  });
});
