import { describe, expect, it } from "vitest";
import { KEYCHAIN_SERVICE, securityKeychain, type ProcRunner } from "../src/vault.js";

// PR 12 CodeRabbit: the macOS keychain through `security -i`, whose input line is at most 4095 bytes. A fake `security` that
// enforces that limit the way the real one fails: a longer line stores nothing, and the exit code still says 0.

const LIMIT = 4095;

interface FakeSecurity {
  run: ProcRunner;
  entries: Map<string, Buffer>;
  lines: string[];
  argv: string[][];
  /** Make the nth `-i` add (1-based) store nothing, as a failure the exit code doesn't show. */
  dropAdd: number | null;
  adds: number;
}

function fakeSecurity(): FakeSecurity {
  const state: FakeSecurity = {
    entries: new Map(),
    lines: [],
    argv: [],
    dropAdd: null,
    adds: 0,
    run: async (_command, args, input) => {
      state.argv.push(args);
      if (args[0] === "-i") {
        for (const line of input.split("\n")) {
          if (line === "") continue;
          state.lines.push(line);
          if (Buffer.byteLength(line) > LIMIT) continue; // split by the real tool: nothing valid is stored
          const hex = /-X ([0-9a-f]+)$/.exec(line)?.[1];
          const account = /-a "((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
          if (hex === undefined || account === undefined) continue;
          state.adds += 1;
          if (state.dropAdd === state.adds) continue;
          state.entries.set(account.replace(/\\(.)/g, "$1"), Buffer.from(hex, "hex"));
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      const account = args[args.indexOf("-a") + 1] ?? "";
      if (args[0] === "delete-generic-password") return { code: state.entries.delete(account) ? 0 : 44, stdout: "", stderr: "" };
      const found = state.entries.get(account);
      if (found === undefined) return { code: 44, stdout: "", stderr: "not found" };
      // `-w` prints plain text for printable data and hex otherwise
      const text = found.toString("utf8");
      return { code: 0, stdout: `${/^[\x20-\x7e]*$/.test(text) ? text : found.toString("hex")}\n`, stderr: "" };
    },
  };
  return state;
}

const bigVault = (entries: number): string =>
  JSON.stringify({ version: 2, vault: Object.fromEntries(Array.from({ length: entries }, (_, i) => [`entry_${i}`, { kind: "account", username: `user${i}@example.test`, password: `p${i}-${"x".repeat(40)}` }])) });

describe("the keychain keeps a vault of any size (PR 12 CodeRabbit)", () => {
  const account = "/Users/me/vault.json";

  it("a vault of tens of kilobytes round-trips, and no input line goes over the limit", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const json = bigVault(300);
    expect(Buffer.byteLength(json)).toBeGreaterThan(30_000);
    await keychain.write(account, json);
    expect(await keychain.read(account)).toBe(json);
    expect(Math.max(...fake.lines.map((l) => Buffer.byteLength(l)))).toBeLessThanOrEqual(LIMIT);
    // the data is on stdin only
    expect(fake.argv.flat().join(" ")).not.toContain("user1@example");
    expect(fake.lines.every((l) => l.includes(`-s "${KEYCHAIN_SERVICE}"`))).toBe(true);
  });

  it("a vault that fits stays one entry holding the UTF-8 JSON, the form the spec fixes", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const json = JSON.stringify({ version: 2, vault: { a: { kind: "note", text: "small" } } });
    await keychain.write(account, json);
    expect([...fake.entries.keys()]).toEqual([account]);
    expect(fake.entries.get(account)?.toString("utf8")).toBe(json);
  });

  it("text with multi-byte characters survives being cut into chunks", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const json = JSON.stringify({ version: 2, vault: { a: { kind: "note", text: "شارع المثال ".repeat(1200) } } });
    await keychain.write(account, json);
    expect(await keychain.read(account)).toBe(json);
  });

  it("writing a smaller vault over a large one leaves one entry, and a large one over a small one reads back", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await keychain.write(account, bigVault(300));
    expect(fake.entries.size).toBeGreaterThan(2);
    const small = JSON.stringify({ version: 2, vault: {} });
    await keychain.write(account, small);
    expect([...fake.entries.keys()]).toEqual([account]);
    expect(await keychain.read(account)).toBe(small);
    const large = bigVault(120);
    await keychain.write(account, large);
    expect(await keychain.read(account)).toBe(large);
    const larger = bigVault(200);
    await keychain.write(account, larger);
    expect(await keychain.read(account)).toBe(larger);
    // no chunk of an older write is left behind: the manifest and exactly its chunks
    const manifest = JSON.parse(fake.entries.get(account)?.toString("utf8") ?? "{}") as { tapline_chunks?: { n: number } };
    expect(fake.entries.size).toBe(1 + (manifest.tapline_chunks?.n ?? -1));
  });

  it("a write that loses a chunk throws and leaves the old vault readable", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const old = bigVault(100);
    await keychain.write(account, old);
    fake.adds = 0;
    fake.dropAdd = 3;
    await expect(keychain.write(account, bigVault(150))).rejects.toThrow(/keychain didn't keep/);
    expect(await keychain.read(account)).toBe(old);
  });

  it("a path so long that no chunk fits is refused in words", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await expect(keychain.write(`/${"d".repeat(4000)}/vault.json`, bigVault(50))).rejects.toThrow(/too long/);
    expect(fake.lines).toEqual([]);
  });
});
