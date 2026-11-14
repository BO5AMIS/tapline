import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, openProtected, realPathOf, securityKeychain, VaultOpenError, type Dpapi, type ProcRunner } from "../src/vault.js";

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
  /** Every write and delete in order: `add <account>` or `del <account>`. */
  ops: string[];
}

function fakeSecurity(): FakeSecurity {
  const state: FakeSecurity = {
    entries: new Map(),
    lines: [],
    argv: [],
    dropAdd: null,
    adds: 0,
    ops: [],
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
          state.ops.push(`add ${account.replace(/\\(.)/g, "$1")}`);
          if (state.dropAdd === state.adds) continue;
          state.entries.set(account.replace(/\\(.)/g, "$1"), Buffer.from(hex, "hex"));
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      const account = args[args.indexOf("-a") + 1] ?? "";
      if (args[0] === "delete-generic-password") state.ops.push(`del ${account}`);
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
    // no chunk of an older write is left behind: the manifest and exactly its chunks, #1 to #n
    const manifest = JSON.parse(fake.entries.get(account)?.toString("utf8") ?? "{}") as { chunks?: number };
    expect(fake.entries.size).toBe(1 + (manifest.chunks ?? -1));
  });

  it("a write that loses a chunk throws, and what is left never reads back as a partial vault", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const old = bigVault(100);
    await keychain.write(account, old);
    fake.adds = 0;
    fake.dropAdd = 3;
    await expect(keychain.write(account, bigVault(150).replace(/user/g, "usr"))).rejects.toThrow(/keychain didn't keep/);
    // the spec's order overwrites chunks in place, so the old manifest may sit over new chunks: it reads whole or not at all
    const outcome = await keychain.read(account).then((text) => text, () => "closed");
    expect([old, "closed"]).toContain(outcome);
  });

  it("a path so long that no chunk fits is refused in words", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await expect(keychain.write(`/${"d".repeat(4000)}/vault.json`, bigVault(50))).rejects.toThrow(/too long/);
    expect(fake.lines).toEqual([]);
  });
});

describe("the chunked form of §20.2 (AGENT-TOOLS 1.14.1 item 6)", () => {
  const account = "/Users/me/vault.json";
  const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
  const noDpapi: Dpapi = {
    protect: async () => {
      throw new Error("not on this system");
    },
    unprotect: async () => {
      throw new Error("not on this system");
    },
  };
  const chunkCount = (fake: FakeSecurity): number => (JSON.parse(fake.entries.get(account)?.toString("utf8") ?? "{}") as { chunks: number }).chunks;

  it("a larger vault is chunk items at <realpath>#1, #2, … and a main item holding {chunks, sha256} of the whole JSON", async () => {
    const fake = fakeSecurity();
    const json = bigVault(300);
    await securityKeychain(fake.run).write(account, json);
    const manifest = JSON.parse(fake.entries.get(account)?.toString("utf8") ?? "{}") as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["chunks", "sha256"]);
    expect(manifest["sha256"]).toBe(sha(json));
    const n = manifest["chunks"] as number;
    expect(n).toBeGreaterThan(1);
    expect([...fake.entries.keys()].sort()).toEqual([account, ...Array.from({ length: n }, (_, i) => `${account}#${i + 1}`)].sort());
    // the chunks are plain pieces of the JSON: joined, they are the whole of it
    const joined = Array.from({ length: n }, (_, i) => fake.entries.get(`${account}#${i + 1}`)?.toString("utf8") ?? "").join("");
    expect(joined).toBe(json);
  });

  it("writes chunks #1…#n first, then the manifest, then deletes the stale chunks #n+1… of an earlier, longer vault", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await keychain.write(account, bigVault(300));
    const before = chunkCount(fake);
    fake.ops.length = 0;
    await keychain.write(account, bigVault(120));
    const n = chunkCount(fake);
    expect(n).toBeLessThan(before);
    const adds = Array.from({ length: n }, (_, i) => `add ${account}#${i + 1}`);
    const stale = Array.from({ length: before - n }, (_, i) => `del ${account}#${n + 1 + i}`);
    const writes = fake.ops.filter((op) => op.startsWith("add "));
    expect(writes).toEqual([...adds, `add ${account}`]);
    // every add comes before the first delete, and the deletes are exactly the stale chunks
    const firstDelete = fake.ops.findIndex((op) => op.startsWith("del "));
    expect(fake.ops.slice(0, firstDelete)).toEqual([...adds, `add ${account}`]);
    expect(fake.ops.slice(firstDelete).sort()).toEqual([...stale].sort());
    expect([...fake.entries.keys()].length).toBe(1 + n);
  });

  it("a vault that shrinks to the single form leaves no chunk behind", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await keychain.write(account, bigVault(300));
    const small = JSON.stringify({ version: 2, vault: {} });
    await keychain.write(account, small);
    expect([...fake.entries.keys()]).toEqual([account]);
    expect(await keychain.read(account)).toBe(small);
  });

  it("a missing chunk fails closed: nothing is returned, and the words say it is incomplete", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await keychain.write(account, bigVault(300));
    fake.entries.delete(`${account}#2`);
    await expect(keychain.read(account)).rejects.toThrow(/incomplete/);
  });

  it("a checksum mismatch fails closed", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    await keychain.write(account, bigVault(300));
    const one = fake.entries.get(`${account}#1`)?.toString("utf8") ?? "";
    fake.entries.set(`${account}#1`, Buffer.from(one.replace("entry_0", "entry_X"), "utf8"));
    await expect(keychain.read(account)).rejects.toThrow(/incomplete/);
  });

  it("the reader joins whatever chunks are there, whatever size the writer chose", async () => {
    const fake = fakeSecurity();
    const json = bigVault(40);
    const size = 700;
    const pieces = Array.from({ length: Math.ceil(json.length / size) }, (_, i) => json.slice(i * size, (i + 1) * size));
    pieces.forEach((piece, i) => fake.entries.set(`${account}#${i + 1}`, Buffer.from(piece, "utf8")));
    fake.entries.set(account, Buffer.from(JSON.stringify({ chunks: pieces.length, sha256: sha(json) }), "utf8"));
    expect(await securityKeychain(fake.run).read(account)).toBe(json);
  });

  it("a broken chunked vault makes the file unopenable with a doctor message, and no partial values", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const dir = mkdtempSync(join(tmpdir(), "tl-vault-"));
    const file = join(dir, "vault.json");
    writeFileSync(file, JSON.stringify({ version: 2, protected: "keychain" }));
    const real = realPathOf(file);
    await keychain.write(real, bigVault(300));
    fake.entries.delete(`${real}#3`);
    const error = await openProtected(file, { protected: "keychain" }, { platform: "darwin", dpapi: noDpapi, keychain }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VaultOpenError);
    expect((error as VaultOpenError).message).toMatch(/incomplete/);
    expect((error as VaultOpenError).message).not.toContain("user1@example");
  });
});

describe("chunks that look like hex (PR 12 Codex cycle 3, finding 5)", () => {
  const account = "/Users/me/vault.json";
  const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

  it("a printable chunk such as \"41\" repeated is read as the text it is, not as hex", async () => {
    const fake = fakeSecurity();
    const text = "41".repeat(60);
    fake.entries.set(`${account}#1`, Buffer.from(text, "utf8"));
    fake.entries.set(account, Buffer.from(JSON.stringify({ chunks: 1, sha256: sha(text) }), "utf8"));
    expect(await securityKeychain(fake.run).read(account)).toBe(text);
  });

  it("a write of hex-looking text round-trips through chunks (the read-back check accepts both readings)", async () => {
    const fake = fakeSecurity();
    const keychain = securityKeychain(fake.run);
    const text = "41".repeat(4000);
    await keychain.write(account, text);
    expect(await keychain.read(account)).toBe(text);
  });

  it("a mix of hex-looking and ordinary chunks: the manifest's checksum chooses the reading of each", async () => {
    const fake = fakeSecurity();
    const parts = ["41".repeat(30), "plain text, not hex ", "4a4b".repeat(10), "7b7d", "end"];
    parts.forEach((part, i) => fake.entries.set(`${account}#${i + 1}`, Buffer.from(part, "utf8")));
    const whole = parts.join("");
    fake.entries.set(account, Buffer.from(JSON.stringify({ chunks: parts.length, sha256: sha(whole) }), "utf8"));
    expect(await securityKeychain(fake.run).read(account)).toBe(whole);
  });

  it("more than 8 ambiguous chunks: raw-all and decoded-all are tried, and nothing else", async () => {
    const fake = fakeSecurity();
    const parts = Array.from({ length: 12 }, () => "41".repeat(8));
    parts.forEach((part, i) => fake.entries.set(`${account}#${i + 1}`, Buffer.from(part, "utf8")));
    const raw = parts.join("");
    fake.entries.set(account, Buffer.from(JSON.stringify({ chunks: 12, sha256: sha(raw) }), "utf8"));
    expect(await securityKeychain(fake.run).read(account)).toBe(raw);
    // a mixed truth (one chunk really was hex of text, the rest plain) is out of reach with 12 ambiguous chunks: fail closed, in words
    const mixed = parts.map((p, i) => (i === 3 ? "A".repeat(8) : p)).join("");
    expect(mixed).not.toBe(raw);
    fake.entries.set(account, Buffer.from(JSON.stringify({ chunks: 12, sha256: sha(mixed) }), "utf8"));
    await expect(securityKeychain(fake.run).read(account)).rejects.toThrow(/incomplete/);
  });
});
