import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, HOST_FACTS_TOOL, type Runtime } from "../src/runtime.js";
import type { Keychain, VaultDeps } from "../src/vault.js";

// PR 12 Codex cycle 4, finding 2 (AGENT-TOOLS 1.14 §20.3): redaction is cumulative for the session. A value that was loaded once is
// scrubbed until the host process ends; only the current values can be typed. Every value is made up; the keychain is a fake.

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const OLD = "Old-Pa55-word-for-test";
const NEW = "New-Pa55-word-for-test";
const vaultJson = (password: string): string =>
  JSON.stringify({ version: 2, vault: { tester: { kind: "account", username: "qa-user-name-1", password, apps: ["com.example.a"] } } });

async function start(initial: string): Promise<{ runtime: Runtime; set(json: string): void; facts(): Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), "tapline-cumulative-"));
  dirs.push(home);
  const accounts = join(home, "accounts.json");
  const maps = join(home, "maps");
  mkdirSync(maps);
  writeFileSync(accounts, JSON.stringify({ version: 2, protected: "keychain" }));
  let current = initial;
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
  return {
    runtime,
    set: (json) => {
      current = json;
    },
    facts: async () => {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/api/${HOST_FACTS_TOOL}`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtime.config.token}`, "x-agent-client": "schedule-x" },
        body: "{}",
      });
      await response.json();
    },
  };
}

describe("a vault reload keeps scrubbing what it replaced", () => {
  it("scrubs the old and the new value after a reload; only the new one can be typed", async () => {
    const w = await start(vaultJson(OLD));
    expect(w.runtime.host.redactOut(OLD)).not.toContain(OLD);
    w.set(vaultJson(NEW));
    await w.facts();
    expect(w.runtime.host.redactOut(`late answer ${OLD} and ${NEW}`)).not.toMatch(/Pa55/);
    expect(w.runtime.host.redactOut(OLD.slice(0, 14))).not.toContain(OLD.slice(0, 14));
    const store = w.runtime.live.accounts();
    if (store?.store == null) throw new Error("no store");
    expect(store.store.redact(OLD)).not.toContain(OLD);
    const typed = store.store.resolve("tester", "password", "com.example.a");
    expect(JSON.stringify(typed)).toContain(NEW);
    expect(JSON.stringify(typed)).not.toContain(OLD);
  });

  it("does the same for the account values of a version 1 file", async () => {
    const home = mkdtempSync(join(tmpdir(), "tapline-cumulative-v1-"));
    dirs.push(home);
    const accounts = join(home, "accounts.json");
    const maps = join(home, "maps");
    mkdirSync(maps);
    const write = (password: string): void => writeFileSync(accounts, JSON.stringify({ version: 1, accounts: { tester: { username: "qa-user-name-1", password } } }));
    write(OLD);
    const gitProbe = { insideWorkTree: async () => false, ignored: async () => false };
    const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, api: true, accounts, maps, gitProbe });
    runtimes.push(runtime);
    write(NEW);
    await fetch(`http://127.0.0.1:${runtime.port}/api/${HOST_FACTS_TOOL}`, { method: "POST", headers: { authorization: `Bearer ${runtime.config.token}` }, body: "{}" });
    expect(runtime.host.redactOut(`${OLD} ${NEW}`)).not.toMatch(/Pa55/);
  });

  it("keeps every earlier value over several reloads, and an unchanged vault adds nothing", async () => {
    const w = await start(vaultJson(OLD));
    await w.facts();
    await w.facts();
    w.set(vaultJson(NEW));
    await w.facts();
    const THIRD = "Third-Pa55-word-for-test";
    w.set(vaultJson(THIRD));
    await w.facts();
    for (const value of [OLD, NEW, THIRD]) expect(w.runtime.host.redactOut(`x ${value} y`)).not.toContain(value);
  });
});
