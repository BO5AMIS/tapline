import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAccounts } from "../src/accounts.js";
import { protectVaultFile, type Dpapi, type Keychain, type VaultDeps } from "../src/vault.js";

// PR 12 CodeRabbit: `vault protect` checks what it will write before it replaces the plain file.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tapline-vprotect-"));
  dirs.push(dir);
  return dir;
};

const USER = "qa-user-name-1";
const PASS = "Pa55-word-for-test";
const CODE = "840213";

/** Stores what it is given as it is: the encryption isn't what these tests are about. */
function fakeDeps(): VaultDeps & { stored: string[] } {
  const stored: string[] = [];
  const dpapi: Dpapi = {
    async protect(data) {
      stored.push(data.toString("utf8"));
      return Buffer.from(data);
    },
    async unprotect(blob) {
      return Buffer.from(blob);
    },
  };
  const keychain: Keychain = {
    async read() {
      return null;
    },
    async write() {
      throw new Error("not used");
    },
  };
  return { platform: "win32", dpapi, keychain, stored };
}

const outside = { insideWorkTree: async () => false, ignored: async () => false };

describe("vault protect keeps the passcode of a version 1 account (PR 12 CodeRabbit)", () => {
  it("moves it into a phone entry of its own, so it is stored, scrubbed and still untyped", async () => {
    const dir = tmp();
    const file = join(dir, "accounts.json");
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { tester2: { username: USER, password: PASS, passcode: CODE } } }));
    const deps = fakeDeps();
    expect((await protectVaultFile(file, deps)).ok).toBe(true);
    expect(JSON.parse(deps.stored[0] ?? "{}")).toEqual({
      version: 2,
      vault: { tester2: { kind: "account", username: USER, password: PASS }, tester2_phone: { kind: "phone", passcode: CODE } },
    });
    const loaded = await loadAccounts(file, outside, deps);
    expect(loaded.store?.redact(`entered ${CODE} and ${PASS}`)).not.toContain(CODE);
    expect(loaded.store?.redact(`entered ${CODE} and ${PASS}`)).not.toContain(PASS);
  });
});

describe("vault protect refuses a file that wouldn't load, and leaves it plain (PR 12 CodeRabbit)", () => {
  it("a version 1 account name a version 2 vault can't have", async () => {
    const dir = tmp();
    const file = join(dir, "accounts.json");
    const before = JSON.stringify({ version: 1, accounts: { "qa-user": { username: USER, password: PASS } } });
    writeFileSync(file, before);
    const deps = fakeDeps();
    const done = await protectVaultFile(file, deps);
    expect(done.ok).toBe(false);
    const message = (done as { message: string }).message;
    expect(message).toContain("qa-user");
    expect(message).not.toContain(USER);
    expect(message).not.toContain(PASS);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(deps.stored).toEqual([]);
  });

  it("a version 2 file with an entry that has a too-short secret, without quoting it", async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "vault.json");
    const before = JSON.stringify({ version: 2, vault: { login: { kind: "account", username: USER, password: "ab" } } });
    writeFileSync(file, before);
    const deps = fakeDeps();
    const done = await protectVaultFile(file, deps);
    expect(done.ok).toBe(false);
    expect((done as { message: string }).message).toContain("login");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(file)).toBe(true);
    expect(deps.stored).toEqual([]);
  });

  it("a good version 1 file still protects", async () => {
    const file = join(tmp(), "accounts.json");
    writeFileSync(file, JSON.stringify({ version: 1, accounts: { tester_2: { username: USER, password: PASS } } }));
    expect((await protectVaultFile(file, fakeDeps())).ok).toBe(true);
  });
});
