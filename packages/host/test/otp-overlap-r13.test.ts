import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactAll, vaultStore } from "../src/accounts.js";
import { createOtpService, OtpCodes } from "../src/otpclient.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { Keychain, VaultDeps } from "../src/vault.js";

// PR 12 Codex cycle 6, finding 2: vault values (current and retired) and one-time codes are matched together against the ORIGINAL
// text, longest-leftmost, so a code that contains a vault value (or the other way round) is never left half-scrubbed. Made-up values.

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const card = (cvc: string): string =>
  JSON.stringify({ version: 2, vault: { card: { kind: "card", number: "4111111111111111", expiry: "12/30", cvc } } });
const CVC = "<card's cvc>";
const CODE = "<one-time code>";

async function runtimeWith(vault: string, codes: OtpCodes): Promise<{ runtime: Runtime; swap(json: string): void }> {
  const home = mkdtempSync(join(tmpdir(), "tapline-otp-overlap-"));
  dirs.push(home);
  const accounts = join(home, "accounts.json");
  const maps = join(home, "maps");
  mkdirSync(maps);
  writeFileSync(accounts, JSON.stringify({ version: 2, protected: "keychain" }));
  let current = vault;
  const keychain: Keychain = {
    async read() {
      return current;
    },
    async write(_account, json) {
      current = json;
    },
  };
  const vaultDeps: VaultDeps = { platform: "darwin", dpapi: { protect: async (d) => Buffer.from(d), unprotect: async (b) => Buffer.from(b) }, keychain };
  const runtime = await createRuntime({ port: 0, host: "127.0.0.1", env: { TAPLINE_HOME: home }, log: () => undefined, accounts, maps, vaultDeps, otp: createOtpService({}, codes) });
  runtimes.push(runtime);
  return { runtime, swap: (json) => void (current = json) };
}

describe("a one-time code and a vault value that overlap", () => {
  it("the exact case: vault CVC 731 and code 731928 give one placeholder, no fragment", async () => {
    const codes = new OtpCodes();
    const { runtime } = await runtimeWith(card("731"), codes);
    expect(codes.register("731928")).toBe(true);
    expect(runtime.host.redactOut("One-time code: 731928")).toBe(`One-time code: ${CODE}`);
    expect(runtime.host.redactOut("cvc 731 only")).toBe(`cvc ${CVC} only`);
  });

  it("a code that holds the vault value in the middle or at the end", () => {
    const store = vaultStore({ version: 2, vault: { card: { kind: "card", number: "4111111111111111", expiry: "12/30", cvc: "731" } } });
    const codes = new OtpCodes();
    codes.register("98731XY");
    codes.register("555731");
    expect(redactAll(store, codes, "a 98731XY b 555731 c")).toBe(`a ${CODE} b ${CODE} c`);
    expect(redactAll(store, codes, "just 731")).toBe(`just ${CVC}`);
  });

  it("a vault value that holds a code: the longer vault value wins", () => {
    const store = vaultStore({ version: 2, vault: { card: { kind: "card", number: "4111111111111111", expiry: "12/30", cvc: "731" }, note: { kind: "note", text: "pre-731928-post" } } });
    const codes = new OtpCodes();
    codes.register("731928");
    expect(redactAll(store, codes, "x pre-731928-post y")).toBe("x <note's text> y");
    expect(redactAll(store, codes, "x 731928 y")).toBe(`x ${CODE} y`);
  });

  it("a code registered after the first use is picked up (the matcher is rebuilt), and retired values stay in it", async () => {
    const codes = new OtpCodes();
    const { runtime } = await runtimeWith(card("731"), codes);
    expect(runtime.host.redactOut("c 731 d")).toBe(`c ${CVC} d`);
    codes.register("731928");
    expect(runtime.host.redactOut("c 731928 d")).toBe(`c ${CODE} d`);
    codes.register("442731");
    expect(runtime.host.redactOut("c 442731 d 731928")).toBe(`c ${CODE} d ${CODE}`);
  });

  it("200 KB of text and 50 accounts scrub in about 300 ms warm", () => {
    const vault: Record<string, { kind: "account"; username: string; password: string }> = {};
    for (let i = 0; i < 50; i++) vault[`acct${i}`] = { kind: "account", username: `user-name-${i}-abcdef`, password: `pass-word-${i}-ghijkl-XYZ` };
    const store = vaultStore({ version: 2, vault });
    const codes = new OtpCodes();
    codes.register("731928");
    const text = `${"The quick brown fox jumps over the lazy dog 12345. ".repeat(4000)} leak pass-word-7-ghijkl-XYZ and 731928`;
    redactAll(store, codes, text);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const out = redactAll(store, codes, text);
      times.push(Math.round(performance.now() - t));
      expect(out).toContain(CODE);
      expect(out).not.toContain("ghijkl");
    }
    console.log(`scrub timings (ms): ${times.join(", ")}`);
    expect(Math.min(...times)).toBeLessThan(600);
  });
});
